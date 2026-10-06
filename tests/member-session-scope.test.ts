import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// End-to-end member session tool scoping over real HTTP: the real
// createHttpTransport, the real registerAllTools per session, and a real MCP
// SDK client. The registry is the isolated test registry (tests/setup.ts points
// APRA_FLEET_DATA_DIR at a temp dir; backupAndResetRegistry/restoreRegistry
// leave it as found). Tool lists are asserted per session KIND:
//   - registered ?member=, no channel cap  -> MEMBER_ALLOWED_TOOLS
//   - registered ?member=, claude/channel  -> MEMBER_ALLOWED_TOOLS + MEMBER_CHANNEL_TOOLS
//   - valid member JWT, no ?member=        -> MEMBER_ALLOWED_TOOLS (not full)
//   - no identity                          -> every registered tool
//   - unregistered ?member=                -> HTTP 403 at initialize
//
// kbQuery is mocked only so the kb_query call opens no KB; it records the
// session member id the real registry handed it.

const seenMemberIds = vi.hoisted(() => [] as Array<string | undefined>);

vi.mock('../src/tools/kb-query.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/tools/kb-query.js')>();
  const { getSessionMemberId } = await import('../src/services/tool-scope.js');
  return {
    ...actual,
    kbQuery: vi.fn(async () => {
      seenMemberIds.push(getSessionMemberId());
      return '{"results":[]}';
    }),
  };
});

import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpTransport, type HttpTransportHandle } from '../src/services/http-transport.js';
import { registerAllTools } from '../src/services/tool-registry.js';
import { getTokenIssuer, localWorkspaceId } from '../src/services/token-issuer.js';
import { sessionRegistry } from '../src/services/session-registry.js';
import { registerPending, __clearAllPending } from '../src/services/pending-responses.js';
import { addAgent } from '../src/services/registry.js';
import { sendMessage } from '../src/tools/send-message.js';
import { fleetEvents } from '../src/services/event-bus.js';
import { MEMBER_ALLOWED_TOOLS, MEMBER_CHANNEL_TOOLS, MEMBER_MAINTAINER_TOOLS, REGISTERED_TOOL_NAMES } from '../src/services/member-tool-allowlist.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

const RECONNECT = { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 };

const handles: HttpTransportHandle[] = [];
const clients: Client[] = [];
let memberId: string;

beforeEach(() => {
  backupAndResetRegistry();
  const agent = makeTestAgent({ friendlyName: 'scope-e2e-member', workFolder: '/tmp/scope-e2e-work' });
  addAgent(agent);
  memberId = agent.id;
  seenMemberIds.length = 0;
});

afterEach(async () => {
  for (const c of clients.splice(0)) { try { await c.close(); } catch { /* ignore */ } }
  for (const h of handles.splice(0)) { try { await h.close(); } catch { /* ignore */ } }
  fleetEvents.removeAllListeners();
  sessionRegistry.unregister(localWorkspaceId(), memberId);
  sessionRegistry.unregister(getTokenIssuer().workspaceId(), memberId);
  __clearAllPending();
  restoreRegistry();
});

async function startServer(): Promise<HttpTransportHandle> {
  const handle = await createHttpTransport({ registerTools: registerAllTools, preferredPort: 0 });
  handles.push(handle);
  return handle;
}

async function connect(
  port: number,
  opts: { member?: string; channel?: boolean; bearer?: string; params?: Record<string, string> } = {},
): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  if (opts.member) url.searchParams.set('member', opts.member);
  for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v);
  const client = new Client(
    { name: 'scope-e2e-client', version: '1.0.0' },
    { capabilities: opts.channel ? { experimental: { 'claude/channel': {} } } : {} },
  );
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(url, {
    reconnectionOptions: RECONNECT,
    ...(opts.bearer ? { requestInit: { headers: { Authorization: `Bearer ${opts.bearer}` } } } : {}),
  }));
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map(t => t.name).sort();
}

const sorted = (xs: Iterable<string>) => [...xs].sort();

/** Call a tool and report whether it failed as an unknown tool. */
async function callFailsAsUnknownTool(client: Client, name: string, args: Record<string, unknown>): Promise<boolean> {
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = ((result.content as Array<{ text?: string }>)?.[0]?.text ?? '');
    return result.isError === true && /not found|unknown tool/i.test(text);
  } catch (err) {
    return /not found|unknown tool/i.test(String((err as Error).message));
  }
}

function postInitializeRaw(port: number, member: string): Promise<number> {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
  });
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: `/mcp?member=${encodeURIComponent(member)}`,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject);
    req.end(body);
  });
}

describe('member session tool scope over HTTP', () => {
  it('a registered ?member= session without the channel capability lists exactly the member allowlist', async () => {
    const handle = await startServer();
    const names = await toolNames(await connect(handle.port, { member: memberId }));
    expect(names).toEqual(sorted(MEMBER_ALLOWED_TOOLS));
  });

  it('an excluded tool is unknown on a member session but listed on a full session', async () => {
    const handle = await startServer();
    const member = await connect(handle.port, { member: memberId });
    expect(await callFailsAsUnknownTool(member, 'execute_command', { member_id: memberId, command: 'echo hi' })).toBe(true);

    const full = await connect(handle.port);
    expect(await toolNames(full)).toContain('execute_command');
  });

  it('refuses an unregistered ?member= uuid with HTTP 403 at initialize', async () => {
    const handle = await startServer();
    expect(await postInitializeRaw(handle.port, '00000000-0000-4000-8000-000000000000')).toBe(403);
    expect(handle.sessions.size).toBe(0);
  });

  it('a session with no ?member= and no JWT lists every registered tool', async () => {
    const handle = await startServer();
    expect(await toolNames(await connect(handle.port))).toEqual(sorted(REGISTERED_TOOL_NAMES));
  });

  it('a kb_* handler observes the calling session member id', async () => {
    const handle = await startServer();
    const member = await connect(handle.port, { member: memberId });
    const result = await member.callTool({ name: 'kb_query', arguments: { query: 'anything' } });
    expect(result.isError).toBeFalsy();
    expect(seenMemberIds).toEqual([memberId]);
  });

  it('a channel-capable member session lists the allowlist plus MEMBER_CHANNEL_TOOLS and can call respond_to_message', async () => {
    const handle = await startServer();
    const member = await connect(handle.port, { member: memberId, channel: true });
    expect(await toolNames(member)).toEqual(sorted([...MEMBER_ALLOWED_TOOLS, ...MEMBER_CHANNEL_TOOLS]));

    const pending = registerPending('scope-e2e-msg', 10_000);
    const result = await member.callTool({ name: 'respond_to_message', arguments: { reply_to: 'scope-e2e-msg', content: 'pong' } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({ ok: true });
    await expect(pending).resolves.toBe('pong');
  });

  it('a member session without the channel capability gets an unknown-tool error for respond_to_message', async () => {
    const handle = await startServer();
    const member = await connect(handle.port, { member: memberId });
    expect(await callFailsAsUnknownTool(member, 'respond_to_message', { reply_to: 'x', content: 'y' })).toBe(true);
  });

  it('a valid member JWT session without ?member= is member-scoped, not full', async () => {
    const handle = await startServer();
    const token = getTokenIssuer().issue({ member_id: memberId, role: 'doer', work_folder: '/tmp/scope-e2e-work' });
    const names = await toolNames(await connect(handle.port, { bearer: token }));
    expect(names).toEqual(sorted(MEMBER_ALLOWED_TOOLS));
    expect(names).not.toContain('execute_prompt');
  });
});

describe('tool-only ?member= sessions leave the session registry alone', () => {
  const PLACEHOLDER_PID = 424242;

  function registerPlaceholder(): void {
    // What register_member records at launch, before the interactive session connects back.
    sessionRegistry.register({
      member_id: memberId, workspace_id: localWorkspaceId(), role: 'doer',
      work_folder: '/tmp/scope-e2e-work', server: null, pid: PLACEHOLDER_PID, status: 'idle',
    });
  }

  /** Close the session with an HTTP DELETE, which fires the server's onsessionclosed. */
  async function terminate(client: Client, handle: HttpTransportHandle): Promise<void> {
    const before = handle.sessions.size;
    await (client.transport as StreamableHTTPClientTransport).terminateSession();
    expect(handle.sessions.size).toBe(before - 1);
  }

  it('a tool-only connect does not replace a launch placeholder, and its close does not unregister it', async () => {
    registerPlaceholder();
    const placeholder = sessionRegistry.get(localWorkspaceId(), memberId);
    const handle = await startServer();
    const member = await connect(handle.port, { member: memberId });
    // The session works as a member session...
    expect(await toolNames(member)).toEqual(sorted(MEMBER_ALLOWED_TOOLS));
    // ...but the placeholder is untouched: still no server, same pid, no sid.
    const during = sessionRegistry.get(localWorkspaceId(), memberId);
    expect(during).toBe(placeholder);
    expect(during).toMatchObject({ server: null, pid: PLACEHOLDER_PID, status: 'idle' });
    expect(during?.sessionId).toBeUndefined();

    // send_message does not route to the tool-only session.
    const sent = JSON.parse(await sendMessage({ member_id: memberId, content: 'hello' }, localWorkspaceId()));
    expect(sent).toEqual({ error: 'member not connected or no MCP session' });

    await terminate(member, handle);
    expect(sessionRegistry.get(localWorkspaceId(), memberId)).toBe(placeholder);
  });

  it('a tool-only connect with no registry entry registers nothing, and its close leaves nothing', async () => {
    expect(sessionRegistry.get(localWorkspaceId(), memberId)).toBeUndefined();
    const handle = await startServer();
    const member = await connect(handle.port, { member: memberId });
    expect(await toolNames(member)).toEqual(sorted(MEMBER_ALLOWED_TOOLS));
    expect(sessionRegistry.get(localWorkspaceId(), memberId)).toBeUndefined();
    const sent = JSON.parse(await sendMessage({ member_id: memberId, content: 'hello' }, localWorkspaceId()));
    expect(sent).toEqual({ error: 'member not connected or no MCP session' });
    await terminate(member, handle);
    expect(sessionRegistry.get(localWorkspaceId(), memberId)).toBeUndefined();
  });

  it('a channel-capable ?member= session still takes over the placeholder (keeping its pid) and unregisters on close', async () => {
    registerPlaceholder();
    const handle = await startServer();
    const member = await connect(handle.port, { member: memberId, channel: true });
    const live = sessionRegistry.get(localWorkspaceId(), memberId);
    expect(live).toMatchObject({ pid: PLACEHOLDER_PID, status: 'online', channelCapable: true });
    expect(live?.server).not.toBeNull();
    expect(handle.sessions.has(live!.sessionId!)).toBe(true);

    // A tool-only session alongside it neither displaces it nor removes it on close.
    const tool = await connect(handle.port, { member: memberId });
    expect(sessionRegistry.get(localWorkspaceId(), memberId)).toBe(live);
    await terminate(tool, handle);
    expect(sessionRegistry.get(localWorkspaceId(), memberId)).toBe(live);

    await terminate(member, handle);
    expect(sessionRegistry.get(localWorkspaceId(), memberId)).toBeUndefined();
  });
});

describe('member KB write policy: kb_setup / kb_export never, kb_promote / kb_resolve_contradiction only with the kb_maintainer grant', () => {
  const NEVER = ['kb_setup', 'kb_export'];
  const MAINTAINER_ONLY = ['kb_promote', 'kb_resolve_contradiction'];
  const ARGS: Record<string, Record<string, unknown>> = {
    kb_setup: { provider: 'sqlite' },
    kb_export: {},
    kb_promote: { id: 'no-such-entry', reason: 'scope test: never reaches a KB entry' },
    kb_resolve_contradiction: { winnerId: 'no-such-a', loserId: 'no-such-b', evidence: 'scope test' },
  };

  it('a non-maintainer member session neither lists nor can call any of the four (unknown tool)', async () => {
    const handle = await startServer();
    for (const opts of [
      { member: memberId },
      { member: memberId, channel: true },
      // origin=engine alone is not the grant.
      { member: memberId, params: { origin: 'engine' } },
      // The grant is engine-only: kb_maintainer=1 without origin=engine is ignored.
      { member: memberId, params: { kb_maintainer: '1' } },
    ]) {
      const client = await connect(handle.port, opts);
      const names = await toolNames(client);
      for (const t of [...NEVER, ...MAINTAINER_ONLY]) {
        expect(names, `${JSON.stringify(opts)} lists ${t}`).not.toContain(t);
        expect(await callFailsAsUnknownTool(client, t, ARGS[t]), `${JSON.stringify(opts)} ${t}`).toBe(true);
      }
    }
  });

  it('the kb_maintainer member session lists and reaches kb_promote and kb_resolve_contradiction, but still not kb_setup or kb_export', async () => {
    const handle = await startServer();
    const maint = await connect(handle.port, { member: memberId, params: { origin: 'engine', kb_maintainer: '1' } });
    const names = await toolNames(maint);
    expect(names).toEqual(sorted([...MEMBER_ALLOWED_TOOLS, ...MEMBER_MAINTAINER_TOOLS]));
    for (const t of MAINTAINER_ONLY) {
      // Reaches the real handler: it refuses at kb (self) resolution (the
      // test member has no KB identity) -- a handler error, not the SDK's
      // unknown-tool error.
      const result = await maint.callTool({ name: t, arguments: ARGS[t] });
      const text = ((result.content as Array<{ text?: string }>)?.[0]?.text ?? '');
      expect(text, t).toMatch(/^E-SELF-[A-Z-]+: /);
      expect(text, t).not.toMatch(/Tool \S+ not found/);
    }
    for (const t of NEVER) {
      expect(names).not.toContain(t);
      expect(await callFailsAsUnknownTool(maint, t, ARGS[t]), t).toBe(true);
    }
  });

  it('a FULL session still lists all four', async () => {
    const handle = await startServer();
    const names = await toolNames(await connect(handle.port));
    for (const t of [...NEVER, ...MAINTAINER_ONLY]) expect(names).toContain(t);
  });
});
