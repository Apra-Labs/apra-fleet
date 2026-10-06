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
import { fleetEvents } from '../src/services/event-bus.js';
import { MEMBER_ALLOWED_TOOLS, MEMBER_CHANNEL_TOOLS, REGISTERED_TOOL_NAMES } from '../src/services/member-tool-allowlist.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, memberSecretHeaders, memberSecretRequestInit } from './test-helpers.js';

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
  opts: { member?: string; channel?: boolean; bearer?: string } = {},
): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  if (opts.member) url.searchParams.set('member', opts.member);
  const client = new Client(
    { name: 'scope-e2e-client', version: '1.0.0' },
    { capabilities: opts.channel ? { experimental: { 'claude/channel': {} } } : {} },
  );
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(url, {
    reconnectionOptions: RECONNECT,
    requestInit: opts.bearer ? { headers: { Authorization: `Bearer ${opts.bearer}` } } : memberSecretRequestInit(),
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
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(body), ...memberSecretHeaders() },
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
