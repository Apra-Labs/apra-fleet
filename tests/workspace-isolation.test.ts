/**
 * Workspace isolation tests (apra-fleet-2xs.2, rescoped per
 * docs/hub-spoke-master-plan.md section 3 / apra-fleet-us9.2).
 *
 * workspace_id is the HARD security boundary. These tests prove that
 * cross-workspace leakage is actually blocked -- not just that the happy
 * path works:
 *   (a) JWT claim schema: workspace_id is required, project_id is an
 *       optional non-security label.
 *   (b) Local token issuer: stable one-machine-one-workspace derivation,
 *       issue/verify roundtrip, pluggable seam.
 *   (c) Session registry: (workspace_id, member_id) composite keying.
 *   (d) send_message: sender-workspace == target-workspace enforcement.
 *   (e) HTTP transport: event broadcast scoped to the local workspace;
 *       a session authenticated with a foreign workspace token receives
 *       nothing.
 *   (f) URL ?member= fallback: identity unified on the member UUID.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sign, verify, type JwtClaims } from '../src/services/jwt.js';
import {
  localWorkspaceId,
  getTokenIssuer,
  setTokenIssuer,
  resetTokenIssuer,
  type TokenIssuer,
} from '../src/services/token-issuer.js';
import { sessionRegistry, type SessionState } from '../src/services/session-registry.js';
import { sendMessage } from '../src/tools/send-message.js';
import { createHttpTransport, HttpTransportHandle } from '../src/services/http-transport.js';
import { fleetEvents } from '../src/services/event-bus.js';
import { addAgent } from '../src/services/registry.js';
import { backupAndResetRegistry, restoreRegistry, makeTestLocalAgent } from './test-helpers.js';

function noopTools(_server: McpServer): void {
  // no tools needed
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    member_id: 'member-' + Math.random().toString(36).slice(2),
    workspace_id: localWorkspaceId(),
    role: 'doer',
    work_folder: '',
    server: null,
    status: 'online',
    ...overrides,
  };
}

/** Fake McpServer whose inner .server.notification is observable. */
function makeFakeServer(): { fake: McpServer; notification: ReturnType<typeof vi.fn> } {
  const notification = vi.fn().mockResolvedValue(undefined);
  const fake = { server: { notification } } as unknown as McpServer;
  return { fake, notification };
}

// Track registry entries created by each test so afterEach can clean the
// module-level singleton.
const registered: Array<{ workspace_id: string; member_id: string }> = [];
function track(state: SessionState): SessionState {
  registered.push({ workspace_id: state.workspace_id, member_id: state.member_id });
  return state;
}

afterEach(() => {
  for (const { workspace_id, member_id } of registered.splice(0)) {
    sessionRegistry.unregister(workspace_id, member_id);
  }
  resetTokenIssuer();
});

// ---------------------------------------------------------------------------
// (a) JWT claim schema
// ---------------------------------------------------------------------------
describe('(a) JWT workspace_id claim', () => {
  it('roundtrips workspace_id through sign/verify', () => {
    const token = sign({
      member_id: 'uuid-1',
      workspace_id: 'ws-abc123',
      role: 'doer',
      work_folder: '/tmp/w',
    });
    const claims = verify(token);
    expect(claims).not.toBeNull();
    expect(claims!.workspace_id).toBe('ws-abc123');
    expect(claims!.member_id).toBe('uuid-1');
    expect(claims!.project_id).toBeUndefined();
  });

  it('carries project_id as an optional passthrough label when present', () => {
    const token = sign({
      member_id: 'uuid-1',
      workspace_id: 'ws-abc123',
      role: 'doer',
      work_folder: '/tmp/w',
      project_id: 'grouping-label',
    });
    const claims = verify(token);
    expect(claims!.project_id).toBe('grouping-label');
  });

  it('REJECTS legacy tokens that carry project_id but no workspace_id', () => {
    // Simulate a pre-rescope token: signed with the same local key, but with
    // the old claim shape. It must not verify -- workspace_id is required.
    const legacy = sign({
      member_id: 'uuid-1',
      project_id: 'default',
      role: 'doer',
      work_folder: '/tmp/w',
    } as unknown as JwtClaims);
    expect(verify(legacy)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (b) Local token issuer
// ---------------------------------------------------------------------------
describe('(b) local token issuer', () => {
  it('derives a stable, ws-prefixed workspace id (one machine == one workspace)', () => {
    const a = localWorkspaceId();
    const b = localWorkspaceId();
    expect(a).toBe(b);
    expect(a).toMatch(/^ws-[0-9a-f]{16}$/);
    expect(getTokenIssuer().workspaceId()).toBe(a);
  });

  it('issues tokens whose workspace_id claim equals the issuer workspace', () => {
    const issuer = getTokenIssuer();
    const token = issuer.issue({ member_id: 'uuid-2', role: 'doer', work_folder: '/tmp/w' });
    const claims = issuer.verify(token);
    expect(claims).not.toBeNull();
    expect(claims!.workspace_id).toBe(issuer.workspaceId());
    expect(claims!.member_id).toBe('uuid-2');
  });

  it('is pluggable: setTokenIssuer swaps the active issuer without other changes', () => {
    const fake: TokenIssuer = {
      workspaceId: () => 'ws-hub-issued',
      issue: () => 'fake-token',
      verify: () => null,
    };
    setTokenIssuer(fake);
    expect(getTokenIssuer().workspaceId()).toBe('ws-hub-issued');
    resetTokenIssuer();
    expect(getTokenIssuer().workspaceId()).toBe(localWorkspaceId());
  });
});

// ---------------------------------------------------------------------------
// (c) Session registry composite keying
// ---------------------------------------------------------------------------
describe('(c) session registry keyed on (workspace_id, member_id)', () => {
  it('the same member_id in two workspaces produces two independent entries', () => {
    const s1 = track(makeSession({ member_id: 'shared-id', workspace_id: 'ws-one', status: 'online' }));
    const s2 = track(makeSession({ member_id: 'shared-id', workspace_id: 'ws-two', status: 'idle' }));
    sessionRegistry.register(s1);
    sessionRegistry.register(s2);

    expect(sessionRegistry.get('ws-one', 'shared-id')!.status).toBe('online');
    expect(sessionRegistry.get('ws-two', 'shared-id')!.status).toBe('idle');

    sessionRegistry.setStatus('ws-one', 'shared-id', 'busy');
    expect(sessionRegistry.get('ws-one', 'shared-id')!.status).toBe('busy');
    expect(sessionRegistry.get('ws-two', 'shared-id')!.status).toBe('idle');
  });

  it('get() with the wrong workspace returns undefined (indistinguishable from not connected)', () => {
    const s = track(makeSession({ member_id: 'lonely', workspace_id: 'ws-one' }));
    sessionRegistry.register(s);
    expect(sessionRegistry.get('ws-other', 'lonely')).toBeUndefined();
  });

  it('list(workspace_id) only returns sessions in that workspace', () => {
    sessionRegistry.register(track(makeSession({ member_id: 'a', workspace_id: 'ws-one' })));
    sessionRegistry.register(track(makeSession({ member_id: 'b', workspace_id: 'ws-one' })));
    sessionRegistry.register(track(makeSession({ member_id: 'c', workspace_id: 'ws-two' })));

    const one = sessionRegistry.list('ws-one').map(s => s.member_id).sort();
    expect(one).toEqual(['a', 'b']);
    expect(sessionRegistry.list('ws-two').map(s => s.member_id)).toEqual(['c']);
  });

  it('unregister is workspace-scoped and does not touch the other workspace entry', () => {
    sessionRegistry.register(track(makeSession({ member_id: 'dup', workspace_id: 'ws-one' })));
    sessionRegistry.register(track(makeSession({ member_id: 'dup', workspace_id: 'ws-two' })));
    sessionRegistry.unregister('ws-one', 'dup');
    expect(sessionRegistry.get('ws-one', 'dup')).toBeUndefined();
    expect(sessionRegistry.get('ws-two', 'dup')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// (d) send_message workspace enforcement
// ---------------------------------------------------------------------------
describe('(d) send_message enforces sender-workspace == target-workspace', () => {
  it('BLOCKS a send to a member connected in a different workspace', async () => {
    const { fake, notification } = makeFakeServer();
    sessionRegistry.register(track(makeSession({
      member_id: 'foreign-member',
      workspace_id: 'ws-foreign',
      server: fake,
    })));

    // Sender defaults to the local workspace -- ws-foreign is out of reach.
    const result = JSON.parse(await sendMessage({ member_id: 'foreign-member', content: 'hi' }));
    expect(result.error).toBe('member not connected or no MCP session');
    expect(notification).not.toHaveBeenCalled();
    // The foreign session's status must be untouched.
    expect(sessionRegistry.get('ws-foreign', 'foreign-member')!.status).toBe('online');
  });

  it('delivers to a member in the SENDER workspace and marks it busy', async () => {
    const { fake, notification } = makeFakeServer();
    sessionRegistry.register(track(makeSession({
      member_id: 'local-member',
      workspace_id: localWorkspaceId(),
      server: fake,
    })));

    const result = JSON.parse(await sendMessage({ member_id: 'local-member', content: 'task' }));
    expect(result.ok).toBe(true);
    expect(result.msgid).toBeTruthy();
    expect(notification).toHaveBeenCalledTimes(1);
    expect(notification.mock.calls[0][0].params.content).toBe('task');
    expect(sessionRegistry.get(localWorkspaceId(), 'local-member')!.status).toBe('busy');
  });

  it('an explicit senderWorkspaceId scopes the lookup to that workspace', async () => {
    const { fake, notification } = makeFakeServer();
    sessionRegistry.register(track(makeSession({
      member_id: 'foreign-member-2',
      workspace_id: 'ws-foreign',
      server: fake,
    })));

    const ok = JSON.parse(await sendMessage({ member_id: 'foreign-member-2', content: 'x' }, 'ws-foreign'));
    expect(ok.ok).toBe(true);
    expect(notification).toHaveBeenCalledTimes(1);

    const blocked = JSON.parse(await sendMessage({ member_id: 'foreign-member-2', content: 'x' }, 'ws-other'));
    expect(blocked.error).toBe('member not connected or no MCP session');
    expect(notification).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// (e) + (f) HTTP transport: broadcast scoping and URL-fallback identity
// ---------------------------------------------------------------------------
describe('(e) event broadcast is scoped to the local workspace', () => {
  const handles: HttpTransportHandle[] = [];
  const clients: Client[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      try { await client.close(); } catch { /* ignore */ }
    }
    fleetEvents.removeAllListeners();
    for (const handle of handles.splice(0)) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  });

  function makeTransport(port: number, opts: { token?: string; member?: string } = {}): StreamableHTTPClientTransport {
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    if (opts.member) url.searchParams.set('member', opts.member);
    return new StreamableHTTPClientTransport(url, {
      reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
      ...(opts.token ? { requestInit: { headers: { Authorization: `Bearer ${opts.token}` } } } : {}),
    });
  }

  async function waitForSseStreams(handle: HttpTransportHandle, count: number, getCount: () => number): Promise<void> {
    const deadline = Date.now() + 3000;
    while (getCount() < count && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  it('a session authenticated with a FOREIGN workspace token receives NO local events', async () => {
    const handle = await createHttpTransport({ registerTools: noopTools, preferredPort: 0 });
    handles.push(handle);

    let sseGetCount = 0;
    handle.httpServer.on('request', (req) => {
      if (req.method === 'GET' && req.url?.startsWith('/mcp')) sseGetCount++;
    });

    // Foreign token: valid signature (same local key), foreign workspace_id.
    const foreignToken = sign({
      member_id: 'foreign-uuid',
      workspace_id: 'ws-someone-else',
      role: 'doer',
      work_folder: '',
    });
    registered.push({ workspace_id: 'ws-someone-else', member_id: 'foreign-uuid' });

    const localClient = new Client({ name: 'local-pm', version: '1.0.0' }, { capabilities: {} });
    const foreignClient = new Client({ name: 'foreign-member', version: '1.0.0' }, { capabilities: {} });
    clients.push(localClient, foreignClient);

    const localReceived: unknown[] = [];
    const foreignReceived: unknown[] = [];
    localClient.setNotificationHandler(LoggingMessageNotificationSchema, (n) => { localReceived.push(n.params.data); });
    foreignClient.setNotificationHandler(LoggingMessageNotificationSchema, (n) => { foreignReceived.push(n.params.data); });

    await Promise.all([
      localClient.connect(makeTransport(handle.port)),
      foreignClient.connect(makeTransport(handle.port, { token: foreignToken })),
    ]);
    await waitForSseStreams(handle, 2, () => sseGetCount);

    // The foreign session registered under ITS workspace, not the local one.
    expect(sessionRegistry.get('ws-someone-else', 'foreign-uuid')).toBeDefined();
    expect(sessionRegistry.get(localWorkspaceId(), 'foreign-uuid')).toBeUndefined();

    fleetEvents.emit('credential:stored', { name: 'local-secret' });
    await new Promise(resolve => setTimeout(resolve, 300));

    // Local (unauthenticated, same-machine trust boundary) session sees it...
    expect(localReceived).toHaveLength(1);
    expect((localReceived[0] as { event: string }).event).toBe('credential:stored');
    // ...the foreign-workspace session does NOT.
    expect(foreignReceived).toHaveLength(0);
  });

  it('a session authenticated with a LOCAL workspace token receives local events', async () => {
    const handle = await createHttpTransport({ registerTools: noopTools, preferredPort: 0 });
    handles.push(handle);

    let sseGetCount = 0;
    handle.httpServer.on('request', (req) => {
      if (req.method === 'GET' && req.url?.startsWith('/mcp')) sseGetCount++;
    });

    const token = getTokenIssuer().issue({ member_id: 'local-uuid', role: 'doer', work_folder: '' });
    registered.push({ workspace_id: localWorkspaceId(), member_id: 'local-uuid' });

    const client = new Client({ name: 'local-member', version: '1.0.0' }, { capabilities: {} });
    clients.push(client);
    const received: unknown[] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => { received.push(n.params.data); });

    await client.connect(makeTransport(handle.port, { token }));
    await waitForSseStreams(handle, 1, () => sseGetCount);

    expect(sessionRegistry.get(localWorkspaceId(), 'local-uuid')).toBeDefined();

    fleetEvents.emit('task:completed', { taskId: 't-1', status: 'ok' });
    await new Promise(resolve => setTimeout(resolve, 300));

    expect(received).toHaveLength(1);
    expect((received[0] as { event: string }).event).toBe('task:completed');
  });
});

describe('(f) URL ?member= fallback keys identity on the member UUID', () => {
  const handles: HttpTransportHandle[] = [];
  const clients: Client[] = [];

  beforeEach(() => {
    backupAndResetRegistry();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      try { await client.close(); } catch { /* ignore */ }
    }
    fleetEvents.removeAllListeners();
    for (const handle of handles.splice(0)) {
      try { await handle.close(); } catch { /* ignore */ }
    }
    restoreRegistry();
  });

  function makeTransport(port: number, member: string): StreamableHTTPClientTransport {
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    url.searchParams.set('member', member);
    return new StreamableHTTPClientTransport(url, {
      reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
    });
  }

  it('registers the session under the member UUID when the param is the UUID', async () => {
    const agent = makeTestLocalAgent({ friendlyName: 'uuid-param-member' });
    addAgent(agent);
    registered.push({ workspace_id: localWorkspaceId(), member_id: agent.id });

    const handle = await createHttpTransport({ registerTools: noopTools, preferredPort: 0 });
    handles.push(handle);

    const client = new Client({ name: 'member-client', version: '1.0.0' }, { capabilities: {} });
    clients.push(client);
    await client.connect(makeTransport(handle.port, agent.id));

    const session = sessionRegistry.get(localWorkspaceId(), agent.id);
    expect(session).toBeDefined();
    expect(session!.member_id).toBe(agent.id);
    expect(session!.workspace_id).toBe(localWorkspaceId());
  });

  it('resolves a legacy friendly-name param to the member UUID', async () => {
    const agent = makeTestLocalAgent({ friendlyName: 'legacy-name-member' });
    addAgent(agent);
    registered.push({ workspace_id: localWorkspaceId(), member_id: agent.id });

    const handle = await createHttpTransport({ registerTools: noopTools, preferredPort: 0 });
    handles.push(handle);

    const client = new Client({ name: 'member-client', version: '1.0.0' }, { capabilities: {} });
    clients.push(client);
    await client.connect(makeTransport(handle.port, 'legacy-name-member'));

    // Registered under the UUID -- NOT under the friendly name.
    expect(sessionRegistry.get(localWorkspaceId(), agent.id)).toBeDefined();
    expect(sessionRegistry.get(localWorkspaceId(), 'legacy-name-member')).toBeUndefined();
  });
});
