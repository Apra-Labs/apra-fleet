import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import http from 'node:http';
import { createHttpTransport, HttpTransportHandle } from '../src/services/http-transport.js';
import { fleetEvents } from '../src/services/event-bus.js';
import { getOrCreateKey } from '../src/services/jwt.js';
import { getTokenIssuer } from '../src/services/token-issuer.js';
import { sessionRegistry } from '../src/services/session-registry.js';
import { addAgent } from '../src/services/registry.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { reportStatus, reportStatusSchema } from '../src/tools/report-status.js';

function noop(_server: McpServer): void {
  // no tools registered in these tests
}

function makeClient(port: number): Client {
  return new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
}

function makeTransport(port: number): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 } }
  );
}

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

// ---------------------------------------------------------------------------
// (a) Server binds to 127.0.0.1 only
// ---------------------------------------------------------------------------
describe('(a) server binds to 127.0.0.1', () => {
  it('address is 127.0.0.1', async () => {
    const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);
    const addr = handle.httpServer.address() as net.AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
    expect(addr.port).toBeGreaterThan(0);
  });

  it('url reflects 127.0.0.1', async () => {
    const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });
});

// ---------------------------------------------------------------------------
// (l) APRA_FLEET_HOST makes the bind address configurable (apra-fleet-fnz.4/us9.6)
// ---------------------------------------------------------------------------
describe('(l) APRA_FLEET_HOST configures the bind address', () => {
  // src/paths.ts reads process.env.APRA_FLEET_HOST ONCE at module load time
  // (same eager-evaluation shape as jwt.ts's KEY_PATH) -- vi.resetModules()
  // + a dynamic re-import is required for the env var to actually take
  // effect, a plain env var set after import would silently no-op.
  afterEach(() => {
    delete process.env.APRA_FLEET_HOST;
    vi.resetModules();
  });

  it('binds to 0.0.0.0 when APRA_FLEET_HOST=0.0.0.0 is set before the module loads', async () => {
    process.env.APRA_FLEET_HOST = '0.0.0.0';
    vi.resetModules();
    const { createHttpTransport: createHttpTransportFresh } = await import('../src/services/http-transport.js');

    const handle = await createHttpTransportFresh({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);
    const addr = handle.httpServer.address() as net.AddressInfo;
    expect(addr.address).toBe('0.0.0.0');
    // Same-machine callers still use loopback regardless of bind host --
    // 0.0.0.0 accepts loopback connections too.
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('defaults to 127.0.0.1 when APRA_FLEET_HOST is unset', async () => {
    delete process.env.APRA_FLEET_HOST;
    vi.resetModules();
    const { createHttpTransport: createHttpTransportFresh } = await import('../src/services/http-transport.js');

    const handle = await createHttpTransportFresh({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);
    const addr = handle.httpServer.address() as net.AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
  });

  it('treats an empty/whitespace-only APRA_FLEET_HOST as unset (falls back to 127.0.0.1)', async () => {
    process.env.APRA_FLEET_HOST = '   ';
    vi.resetModules();
    const { createHttpTransport: createHttpTransportFresh } = await import('../src/services/http-transport.js');

    const handle = await createHttpTransportFresh({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);
    const addr = handle.httpServer.address() as net.AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
  });
});

// ---------------------------------------------------------------------------
// (b) Two clients connect concurrently with separate sessions
// ---------------------------------------------------------------------------
describe('(b) two concurrent clients get separate sessions', () => {
  it('sessions map has two entries after both clients connect', async () => {
    const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);

    const c1 = makeClient(handle.port);
    const c2 = makeClient(handle.port);
    clients.push(c1, c2);

    await Promise.all([
      c1.connect(makeTransport(handle.port)),
      c2.connect(makeTransport(handle.port)),
    ]);

    expect(handle.sessions.size).toBe(2);
    const ids = [...handle.sessions.keys()];
    expect(ids[0]).not.toBe(ids[1]);
  });
});

// ---------------------------------------------------------------------------
// (c) Event bus emit reaches BOTH connected clients as logging notifications
// ---------------------------------------------------------------------------
describe('(c) event bus broadcasts to all sessions', () => {
  it('credential:stored reaches both clients', async () => {
    const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);

    // Track GET /mcp requests (standalone SSE streams from clients)
    let sseGetCount = 0;
    handle.httpServer.on('request', (req) => {
      if (req.method === 'GET' && req.url === '/mcp') sseGetCount++;
    });

    const c1 = makeClient(handle.port);
    const c2 = makeClient(handle.port);
    clients.push(c1, c2);

    const received1: unknown[] = [];
    const received2: unknown[] = [];

    c1.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      received1.push(n.params.data);
    });
    c2.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      received2.push(n.params.data);
    });

    await Promise.all([
      c1.connect(makeTransport(handle.port)),
      c2.connect(makeTransport(handle.port)),
    ]);

    // Wait for both standalone GET SSE streams to be established
    const deadline = Date.now() + 3000;
    while (sseGetCount < 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(sseGetCount).toBeGreaterThanOrEqual(2);

    fleetEvents.emit('credential:stored', { name: 'my-cred' });

    // Allow notification to propagate
    await new Promise(resolve => setTimeout(resolve, 300));

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
    expect((received1[0] as { event: string }).event).toBe('credential:stored');
    expect((received2[0] as { event: string }).event).toBe('credential:stored');
  });
});

// ---------------------------------------------------------------------------
// (d) Client disconnect removes session from the map
// ---------------------------------------------------------------------------
describe('(d) disconnect removes session', () => {
  it('session is removed when client terminates the session', async () => {
    const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);

    const c1 = makeClient(handle.port);
    clients.push(c1);
    const transport = makeTransport(handle.port);

    await c1.connect(transport);
    expect(handle.sessions.size).toBe(1);

    // Terminate the session via DELETE
    await transport.terminateSession();

    // Allow cleanup to propagate
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(handle.sessions.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (e) Port fallback: when preferred port is busy, starts on random port
// ---------------------------------------------------------------------------
describe('(e) port fallback when preferred port is busy', () => {
  it('starts on OS-assigned port when preferred port is in use', async () => {
    // Occupy a port to force the fallback
    const blocker = net.createServer();
    await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
    const busyPort = (blocker.address() as net.AddressInfo).port;

    try {
      const handle = await createHttpTransport({ registerTools: noop, preferredPort: busyPort });
      handles.push(handle);

      expect(handle.port).not.toBe(busyPort);
      expect(handle.port).toBeGreaterThan(0);
    } finally {
      await new Promise<void>(resolve => blocker.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// (g) /shutdown requires the local admin key
// ---------------------------------------------------------------------------
function postShutdownRaw(port: number, authHeader?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/shutdown',
        method: 'POST',
        headers: authHeader ? { Authorization: authHeader } : {},
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// (h) Stale-close unregister race (apra-fleet-2xs.10)
// ---------------------------------------------------------------------------
describe('(h) stale-close does not clobber a reconnected session', () => {
  const memberId = 'race-member-uuid';

  afterEach(() => {
    const issuer = getTokenIssuer();
    sessionRegistry.unregister(issuer.workspaceId(), memberId);
  });

  it('leaves the newer registry entry intact when the old session closes late', async () => {
    const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);

    const issuer = getTokenIssuer();
    const token = issuer.issue({ member_id: memberId, role: 'doer', work_folder: '/tmp/w' });

    const client = new Client({ name: 'race-client', version: '1.0.0' }, { capabilities: {} });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
      {
        reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      },
    );
    await client.connect(transport);

    const oldSid = sessionRegistry.get(issuer.workspaceId(), memberId)?.sessionId;
    expect(oldSid).toBeDefined();

    // Simulate the member reconnecting under a NEW session before the old
    // session's close event fires -- the registry now points at the new sid.
    sessionRegistry.register({
      member_id: memberId,
      workspace_id: issuer.workspaceId(),
      role: 'doer',
      work_folder: '/tmp/w',
      server: null,
      sessionId: 'reconnected-sid',
      status: 'online',
    });

    // Now the OLD session closes (arrives late).
    await transport.terminateSession();
    await new Promise(resolve => setTimeout(resolve, 150));

    // The registry entry must still be the reconnected session, not deleted
    // by the stale close of the old one.
    const current = sessionRegistry.get(issuer.workspaceId(), memberId);
    expect(current).toBeDefined();
    expect(current?.sessionId).toBe('reconnected-sid');
  });
});

describe('(g) /shutdown requires the local admin key', () => {
  it('rejects requests with no Authorization header', async () => {
    const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);
    const status = await postShutdownRaw(handle.port);
    expect(status).toBe(401);
  });

  it('rejects requests with a wrong bearer token', async () => {
    const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);
    const status = await postShutdownRaw(handle.port, 'Bearer not-the-real-key');
    expect(status).toBe(401);
  });

  it('accepts requests bearing the local admin key', async () => {
    const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);
    const status = await postShutdownRaw(handle.port, `Bearer ${getOrCreateKey()}`);
    expect(status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// (i) JWT auth and ?member= URL-param fallback on /mcp initialize (apra-fleet-2xs.6)
// ---------------------------------------------------------------------------
function postMcpInitializeRaw(
  port: number,
  opts: { authHeader?: string; memberParam?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const qs = opts.memberParam ? `?member=${encodeURIComponent(opts.memberParam)}` : '';
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'raw-test-client', version: '1.0.0' } },
    });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: `/mcp${qs}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(body),
          ...(opts.authHeader ? { Authorization: opts.authHeader } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('(i) JWT auth on /mcp initialize', () => {
  const memberId = 'jwt-auth-test-member';

  afterEach(() => {
    const issuer = getTokenIssuer();
    sessionRegistry.unregister(issuer.workspaceId(), memberId);
  });

  it('rejects an invalid/malformed bearer token with 401 "invalid token"', async () => {
    const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);

    const { status, body } = await postMcpInitializeRaw(handle.port, { authHeader: 'Bearer not-a-real-jwt' });
    expect(status).toBe(401);
    expect(JSON.parse(body)).toEqual({ error: 'invalid token' });
  });

  it('registers the member in sessionRegistry with the workspace_id/role/work_folder carried by a VALID JWT', async () => {
    const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);

    const issuer = getTokenIssuer();
    const token = issuer.issue({ member_id: memberId, role: 'reviewer', work_folder: '/tmp/jwt-work' });

    const client = new Client({ name: 'jwt-client', version: '1.0.0' }, { capabilities: {} });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
      {
        reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      },
    );
    await client.connect(transport);

    const registered = sessionRegistry.get(issuer.workspaceId(), memberId);
    expect(registered).toBeDefined();
    expect(registered?.role).toBe('reviewer');
    expect(registered?.work_folder).toBe('/tmp/jwt-work');
    expect(registered?.status).toBe('online');
    expect(registered?.sessionId).toBeDefined();
  });

  // apra-fleet-eft.74.1: a plain JWT connect-back that does NOT declare the
  // `claude/channel` capability must register with channelCapable falsy, so
  // execute_prompt never interactive-routes to it (the eft.74 wedge).
  it('registers channelCapable=false for a JWT connect-back that does not declare the claude/channel capability', async () => {
    const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);

    const issuer = getTokenIssuer();
    const token = issuer.issue({ member_id: memberId, role: 'doer', work_folder: '/tmp/jwt-work' });

    const client = new Client({ name: 'jwt-no-channel-client', version: '1.0.0' }, { capabilities: {} });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
      {
        reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      },
    );
    await client.connect(transport);

    const registered = sessionRegistry.get(issuer.workspaceId(), memberId);
    expect(registered).toBeDefined();
    expect(registered?.channelCapable).toBeFalsy();
  });

  // apra-fleet-eft.74.1: the explicit opt-in -- a client that declares the
  // provider-branded `claude/channel` experimental capability completes the
  // interactive handshake and registers channelCapable=true.
  it('registers channelCapable=true for a JWT connect-back that declares the claude/channel capability', async () => {
    const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);

    const issuer = getTokenIssuer();
    const token = issuer.issue({ member_id: memberId, role: 'doer', work_folder: '/tmp/jwt-work' });

    const client = new Client(
      { name: 'jwt-channel-client', version: '1.0.0' },
      { capabilities: { experimental: { 'claude/channel': {} } } },
    );
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
      {
        reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      },
    );
    await client.connect(transport);

    const registered = sessionRegistry.get(issuer.workspaceId(), memberId);
    expect(registered).toBeDefined();
    expect(registered?.channelCapable).toBe(true);
  });
});

describe('(j) unauthenticated ?member= URL-param fallback on /mcp initialize', () => {
  afterEach(() => {
    backupAndResetRegistry(); // also clears any agent added by a test below
    restoreRegistry();
  });

  it('registers a member via the URL param with role "doer" under the local workspace when no JWT is present', async () => {
    const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);
    const issuer = getTokenIssuer();

    const client = new Client({ name: 'param-client', version: '1.0.0' }, { capabilities: {} });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp?member=url-param-member-id`),
      { reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 } },
    );
    await client.connect(transport);

    const registered = sessionRegistry.get(issuer.workspaceId(), 'url-param-member-id');
    expect(registered).toBeDefined();
    expect(registered?.role).toBe('doer');
    expect(registered?.status).toBe('online');

    sessionRegistry.unregister(issuer.workspaceId(), 'url-param-member-id');
  });

  it('resolves a legacy friendly-name ?member= param to the registered agent\'s UUID', async () => {
    backupAndResetRegistry();
    const agent = makeTestAgent({ friendlyName: 'legacy-friendly-name', workFolder: '/tmp/legacy-work' });
    addAgent(agent);

    const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
    handles.push(handle);
    const issuer = getTokenIssuer();

    const client = new Client({ name: 'legacy-client', version: '1.0.0' }, { capabilities: {} });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp?member=legacy-friendly-name`),
      { reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 } },
    );
    await client.connect(transport);

    // Registered under the agent's UUID, not the friendly name from the URL.
    const registered = sessionRegistry.get(issuer.workspaceId(), agent.id);
    expect(registered).toBeDefined();
    expect(registered?.work_folder).toBe('/tmp/legacy-work');
    expect(sessionRegistry.get(issuer.workspaceId(), 'legacy-friendly-name')).toBeUndefined();

    sessionRegistry.unregister(issuer.workspaceId(), agent.id);
  });
});

// ---------------------------------------------------------------------------
// (k) report_status closes the busy->online/idle loop end-to-end (apra-fleet-2xs.7)
// ---------------------------------------------------------------------------
function registerReportStatusOnly(server: McpServer): void {
  server.tool(
    'report_status',
    'test-only registration of the real report_status handler',
    reportStatusSchema.shape,
    async (input: any, extra: any) => {
      const text = await reportStatus(input, extra);
      return { content: [{ type: 'text' as const, text }] };
    },
  );
}

describe('(k) report_status closes the busy->online/idle loop over the real MCP wire', () => {
  const memberId = 'report-status-e2e-member';

  afterEach(() => {
    const issuer = getTokenIssuer();
    sessionRegistry.unregister(issuer.workspaceId(), memberId);
  });

  it('a member calling report_status on its OWN connection flips its OWN status via the real extra.sessionId correlation', async () => {
    const handle = await createHttpTransport({ registerTools: registerReportStatusOnly, preferredPort: 0 });
    handles.push(handle);

    const issuer = getTokenIssuer();
    const token = issuer.issue({ member_id: memberId, role: 'doer', work_folder: '/tmp/rs-work' });

    const client = new Client({ name: 'report-status-client', version: '1.0.0' }, { capabilities: {} });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
      {
        reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      },
    );
    await client.connect(transport);

    // Simulate send_message having flipped this member busy already.
    sessionRegistry.setStatus(issuer.workspaceId(), memberId, 'busy');
    expect(sessionRegistry.get(issuer.workspaceId(), memberId)?.status).toBe('busy');

    // The member's OWN session -- the same connection, not a second one --
    // reports it's done, with no member_id parameter at all (there is none
    // in the schema): identity comes entirely from the live MCP session.
    const result = await client.callTool({ name: 'report_status', arguments: { status: 'online' } });
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.member_id).toBe(memberId);
    expect(sessionRegistry.get(issuer.workspaceId(), memberId)?.status).toBe('online');
  });
});
