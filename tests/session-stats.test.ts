import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// session_stats end-to-end over real HTTP: the real createHttpTransport, the
// real registerAllTools per session, a real MCP SDK client for the member's
// AGENT session (?member=<uuid>, no origin marker), and the real client
// connectFleetMember(..., { origin: 'engine' }) path for the ENGINE session
// that reads session_stats. Only the kb_query / code_status handlers are
// mocked (so no KB or code index is opened); counting happens in the shared
// registry wrapper, so it is exercised for real.

vi.mock('../src/tools/kb-query.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/tools/kb-query.js')>();
  return { ...actual, kbQuery: vi.fn(async () => '{"results":[]}') };
});
vi.mock('../src/tools/code-intelligence.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/tools/code-intelligence.js')>();
  return {
    ...actual,
    resolveCodeSelf: vi.fn(() => ({ repo: '/tmp/session-stats-work', remoteUrl: undefined })),
    handleCodeStatus: vi.fn(async () => ({ readiness: 'missing' })),
  };
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpTransport, type HttpTransportHandle } from '../src/services/http-transport.js';
import { registerAllTools } from '../src/services/tool-registry.js';
import { addAgent } from '../src/services/registry.js';
import { fleetEvents } from '../src/services/event-bus.js';
import { sessionRegistry } from '../src/services/session-registry.js';
import { localWorkspaceId } from '../src/services/token-issuer.js';
import { MEMBER_ALLOWED_TOOLS } from '../src/services/member-tool-allowlist.js';
import { resetMemberCallCounts } from '../src/services/member-call-counts.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
// @ts-expect-error plain .mjs workspace package
import { connectFleetMember } from '../packages/apra-fleet-client/src/client/server-resolution.mjs';

const RECONNECT = { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 };

let handle: HttpTransportHandle;
let memberId: string;
let otherMemberId: string;
const clients: Client[] = [];
const engineSessions: Array<{ close(): Promise<void> }> = [];

beforeEach(async () => {
  backupAndResetRegistry();
  resetMemberCallCounts();
  const agent = makeTestAgent({ friendlyName: 'session-stats-member', workFolder: '/tmp/session-stats-work' });
  addAgent(agent);
  memberId = agent.id;
  const other = makeTestAgent({ friendlyName: 'session-stats-other', workFolder: '/tmp/session-stats-other' });
  addAgent(other);
  otherMemberId = other.id;
  handle = await createHttpTransport({ registerTools: registerAllTools, preferredPort: 0 });
});

afterEach(async () => {
  for (const c of clients.splice(0)) { try { await c.close(); } catch { /* ignore */ } }
  for (const s of engineSessions.splice(0)) { try { await s.close(); } catch { /* ignore */ } }
  try { await handle.close(); } catch { /* ignore */ }
  fleetEvents.removeAllListeners();
  sessionRegistry.unregister(localWorkspaceId(), memberId);
  sessionRegistry.unregister(localWorkspaceId(), otherMemberId);
  resetMemberCallCounts();
  restoreRegistry();
});

/** The member's AGENT session: ?member=<uuid>, no origin marker. */
async function agentSession(id: string): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
  url.searchParams.set('member', id);
  const client = new Client({ name: 'session-stats-agent', version: '1.0.0' }, { capabilities: {} });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(url, { reconnectionOptions: RECONNECT }));
  return client;
}

/** An ENGINE-origin session via the real client path memberCall uses. */
async function engineSession(id: string) {
  const s = await connectFleetMember(id, {
    env: {},
    origin: 'engine',
    checkRunningInstance: async () => ({ running: true, url: `http://127.0.0.1:${handle.port}/mcp`, pid: process.pid }),
  });
  engineSessions.push(s);
  return s as { url: string; mcpClient: { callTool(n: string, a: unknown): Promise<{ isError?: boolean; content: Array<{ text: string }> }> } };
}

type Stats = { member_id: string; since: string; kb: number; code: number; total: number; tools: Record<string, number> };

async function readStats(id: string): Promise<Stats> {
  const s = await engineSession(id);
  const r = await s.mcpClient.callTool('session_stats', {});
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0].text) as Stats;
}

async function agentCalls(client: Client, kb: number, code: number): Promise<void> {
  for (let i = 0; i < kb; i++) {
    const r = await client.callTool({ name: 'kb_query', arguments: { query: `q${i}` } });
    expect(r.isError).toBeFalsy();
  }
  for (let i = 0; i < code; i++) {
    const r = await client.callTool({ name: 'code_status', arguments: {} });
    expect(r.isError).toBeFalsy();
  }
}

describe('session_stats: per-member kb_/code_ call counts', () => {
  it('session_stats is in the shared member allowlist and listed on a member session', async () => {
    expect(MEMBER_ALLOWED_TOOLS).toContain('session_stats');
    const names = (await (await agentSession(memberId)).listTools()).tools.map(t => t.name);
    expect(names).toContain('session_stats');
  });

  it('the engine session URL carries origin=engine', async () => {
    const s = await engineSession(memberId);
    expect(new URL(s.url).searchParams.get('origin')).toBe('engine');
  });

  it("an agent member session's N kb/code calls are read back as N by a separate engine-origin session", async () => {
    const before = await readStats(memberId);
    expect(before).toMatchObject({ member_id: memberId, kb: 0, code: 0, total: 0 });
    const agent = await agentSession(memberId);
    await agentCalls(agent, 3, 2);
    // a second agent session of the same member aggregates into the same counts
    await agentCalls(await agentSession(memberId), 1, 0);
    const after = await readStats(memberId);
    expect(after).toMatchObject({ member_id: memberId, kb: 4, code: 2, total: 6, tools: { kb_query: 4, code_status: 2 } });
    expect(after.since).toBe(before.since);
    // another member's counts are separate
    expect(await readStats(otherMemberId)).toMatchObject({ kb: 0, code: 0, total: 0 });
  });

  it('kb/code calls made through an engine-origin session do not change the count', async () => {
    const agent = await agentSession(memberId);
    await agentCalls(agent, 2, 1);
    const engine = await engineSession(memberId);
    for (let i = 0; i < 3; i++) {
      expect((await engine.mcpClient.callTool('kb_query', { query: 'engine' })).isError).toBeFalsy();
      expect((await engine.mcpClient.callTool('code_status', {})).isError).toBeFalsy();
    }
    const stats = await readStats(memberId);
    expect(stats).toMatchObject({ kb: 2, code: 1, total: 3 });
  });

  it('non-counted tools (version, session_stats) do not change the count', async () => {
    const agent = await agentSession(memberId);
    await agent.callTool({ name: 'version', arguments: {} });
    await agent.callTool({ name: 'session_stats', arguments: {} });
    expect(await readStats(memberId)).toMatchObject({ kb: 0, code: 0, total: 0 });
  });

  it("a member session may not read another member's stats", async () => {
    const agent = await agentSession(memberId);
    const r = await agent.callTool({ name: 'session_stats', arguments: { member_id: otherMemberId } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text: string }>)[0].text).toMatch(/E-FORBIDDEN/);
  });

  it('leaves no open session, registry entry or listening server behind', async () => {
    const agent = await agentSession(memberId);
    await agentCalls(agent, 1, 1);
    await readStats(memberId);
    for (const c of clients.splice(0)) await c.close();
    for (const e of engineSessions.splice(0)) await e.close();
    // Agent client close() does not DELETE the session; engine sessions do.
    // Close the server and prove it releases everything.
    await handle.close();
    expect(handle.httpServer.listening).toBe(false);
    expect(handle.sessions.size).toBe(0);
    expect(sessionRegistry.get(localWorkspaceId(), memberId)).toBeUndefined();
  });
});
