// MCP session leak: short-lived clients must release their server session,
// and the server must evict sessions a client abandoned (no open request,
// idle past the bound). Before the fix every short-lived supervisor call left
// one McpServer behind for good, and the fleet server died of heap OOM about
// once a day.
import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHttpTransport, HttpTransportHandle } from '../src/services/http-transport.js';
import { fleetEvents } from '../src/services/event-bus.js';
import { getTokenIssuer } from '../src/services/token-issuer.js';
import { sessionRegistry } from '../src/services/session-registry.js';
import { memberSecretHeaders, memberSecretRequestInit } from './test-helpers.js';
// @ts-expect-error -- plain .mjs module without typings
import { StreamableHttpTransport } from '../packages/apra-fleet-client/src/client/transport.mjs';

const IDLE_MS = 1000;
const handles: HttpTransportHandle[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) {
    try { await c.close(); } catch { /* ignore */ }
  }
  fleetEvents.removeAllListeners();
  for (const h of handles.splice(0)) {
    try { await h.close(); } catch { /* ignore */ }
  }
});

/** A server on an ephemeral port with a manual clock and no background sweep. */
async function startServer(register: (s: McpServer) => void = () => {}) {
  let clock = 1_000_000;
  const handle = await createHttpTransport({
    registerTools: register,
    preferredPort: 0,
    sessionIdleMs: IDLE_MS,
    idleSweepIntervalMs: 60 * 60 * 1000,
    now: () => clock,
  });
  handles.push(handle);
  return { handle, advance: (ms: number) => { clock += ms; } };
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

/** Opens a session with raw fetch: no GET stream, nothing left open. */
async function rawInitialize(url: string, headers: Record<string, string>): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }),
  });
  expect(res.status).toBe(200);
  const sid = res.headers.get('mcp-session-id');
  await res.text();
  expect(sid).toBeTruthy();
  const note = await fetch(url, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...headers, 'mcp-session-id': sid! },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  await note.text();
  return sid!;
}

describe('short-lived fleet-client connections', () => {
  it('close() leaves no server session behind', async () => {
    const { handle } = await startServer();
    for (let i = 0; i < 5; i++) {
      const t = new StreamableHttpTransport(handle.url, { headers: memberSecretHeaders() });
      await t.start();
      expect(t.sessionId).toBeTruthy();
      await t.close();
    }
    await waitFor(() => handle.sessions.size === 0, 'all sessions released');
    expect(handle.sessions.size).toBe(0);
  });

  it('stop() leaves the session open until the idle sweep evicts it', async () => {
    const { handle, advance } = await startServer();
    const t = new StreamableHttpTransport(handle.url, { headers: memberSecretHeaders() });
    await t.start();
    const sid = t.sessionId as string;
    await waitFor(() => (handle.sessions.get(sid)?.openRequests ?? 0) > 0, 'GET stream open');
    t.stop();
    await waitFor(() => handle.sessions.get(sid)?.openRequests === 0, 'GET stream closed on the server');
    expect(handle.sessions.size).toBe(1);

    expect(handle.sweepIdleSessions()).toBe(0); // not idle long enough yet
    advance(IDLE_MS + 1);
    expect(handle.sweepIdleSessions()).toBe(1);
    expect(handle.sessions.size).toBe(0);

    const health = await (await fetch(handle.url.replace('/mcp', '/health'))).json() as { sessions: number; sessionsEvicted: number };
    expect(health.sessions).toBe(0);
    expect(health.sessionsEvicted).toBe(1);
  });
});

describe('idle eviction never takes a live session', () => {
  it('keeps a session whose client holds its GET stream open', async () => {
    const { handle, advance } = await startServer();
    const client = new Client({ name: 'live', version: '1' }, { capabilities: {} });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), { requestInit: memberSecretRequestInit() });
    await client.connect(transport);
    const sid = transport.sessionId as string;
    await waitFor(() => (handle.sessions.get(sid)?.openRequests ?? 0) > 0, 'GET stream open');

    advance(IDLE_MS * 10);
    expect(handle.sweepIdleSessions()).toBe(0);
    expect(handle.sessions.has(sid)).toBe(true);
  });

  it('keeps a session while a long tool call is in flight, evicts it once idle after', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { handle, advance } = await startServer((s) => {
      s.registerTool('slow', { description: 'waits for the test' }, async () => {
        await gate;
        return { content: [{ type: 'text', text: 'done' }] };
      });
    });
    const sid = await rawInitialize(handle.url, memberSecretHeaders());
    const call = fetch(handle.url, {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...memberSecretHeaders(), 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow', arguments: {} } }),
    });
    await waitFor(() => (handle.sessions.get(sid)?.openRequests ?? 0) > 0, 'tool call in flight');

    advance(IDLE_MS * 10);
    expect(handle.sweepIdleSessions()).toBe(0);

    release();
    expect(await (await call).text()).toContain('done');
    await waitFor(() => handle.sessions.get(sid)?.openRequests === 0, 'tool call response closed');
    advance(IDLE_MS + 1);
    expect(handle.sweepIdleSessions()).toBe(1);
    expect(handle.sessions.has(sid)).toBe(false);
  });
});

describe('eviction releases what the session held', () => {
  it('unregisters an abandoned JWT member session from the session registry', async () => {
    const { handle, advance } = await startServer();
    const issuer = getTokenIssuer();
    const memberId = `leak-test-${Date.now()}`;
    const token = issuer.issue({ member_id: memberId, role: 'doer', work_folder: '/tmp/leak' });
    const sid = await rawInitialize(handle.url, { Authorization: `Bearer ${token}` });
    expect(sessionRegistry.get(issuer.workspaceId(), memberId)?.sessionId).toBe(sid);

    advance(IDLE_MS + 1);
    expect(handle.sweepIdleSessions()).toBe(1);
    expect(handle.sessions.has(sid)).toBe(false);
    expect(sessionRegistry.get(issuer.workspaceId(), memberId)).toBeUndefined();

    // A request on the evicted session is told to start over (MCP spec: 404).
    const after = await fetch(handle.url, {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}`, 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    });
    expect(after.status).toBe(404);
    await after.text();
  });
});
