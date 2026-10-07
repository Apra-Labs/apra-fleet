import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// apra-fleet-b4g.137: a code_* call from a ?member=<uuid> MCP session is
// attributed in usage.jsonl (memberId + sessionId). Real HTTP transport, real
// registerAllTools, real MCP client; only handleCodeQuery is stubbed so no
// code index (or analyze) is needed -- resolveCodeSelf and recordUsage are the
// real ones. usage.jsonl lives under FLEET_DIR (APRA_FLEET_DATA_DIR, a temp dir
// set by tests/setup.ts), asserted below, so nothing is written outside it.
// Reverting the telemetry change (recordUsage ignoring its attribution
// argument, or the registry not passing it) makes the attribution test fail.

vi.mock('../src/tools/code-intelligence.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/tools/code-intelligence.js')>();
  return { ...actual, handleCodeQuery: vi.fn(async () => ({ content: [{ type: 'text', text: 'stub' }] })) };
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpTransport, type HttpTransportHandle } from '../src/services/http-transport.js';
import { registerAllTools } from '../src/services/tool-registry.js';
import { getTokenIssuer, localWorkspaceId } from '../src/services/token-issuer.js';
import { sessionRegistry } from '../src/services/session-registry.js';
import { addAgent } from '../src/services/registry.js';
import { fleetEvents } from '../src/services/event-bus.js';
import { FLEET_DIR } from '../src/paths.js';
import { USAGE_LOG_PATH } from '../src/tools/code-intelligence-telemetry.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

const RECONNECT = { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 };

let handle: HttpTransportHandle | undefined;
let client: Client | undefined;
let memberId: string;
let repoDir: string;

beforeEach(() => {
  backupAndResetRegistry();
  repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-attr-repo-')));
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  const agent = makeTestLocalAgent({ friendlyName: 'usage-attr-member', workFolder: repoDir });
  addAgent(agent);
  memberId = agent.id;
});

afterEach(async () => {
  try { await client?.close(); } catch { /* ignore */ }
  try { await handle?.close(); } catch { /* ignore */ }
  client = undefined; handle = undefined;
  fleetEvents.removeAllListeners();
  sessionRegistry.unregister(localWorkspaceId(), memberId);
  sessionRegistry.unregister(getTokenIssuer().workspaceId(), memberId);
  restoreRegistry();
  fs.rmSync(repoDir, { recursive: true, force: true });
});

async function connect(member?: string): Promise<Client> {
  handle = await createHttpTransport({ registerTools: registerAllTools, preferredPort: 0 });
  const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
  if (member) url.searchParams.set('member', member);
  const c = new Client({ name: 'usage-attr-client', version: '1.0.0' }, { capabilities: {} });
  await c.connect(new StreamableHTTPClientTransport(url, { reconnectionOptions: RECONNECT }));
  client = c;
  return c;
}

function rowsFor(target: string): Array<Record<string, unknown>> {
  let raw = '';
  try { raw = fs.readFileSync(USAGE_LOG_PATH, 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.target === target);
}

describe('code tool usage attribution over a member MCP session', () => {
  it('writes usage.jsonl only inside the isolated data dir', () => {
    expect(path.resolve(USAGE_LOG_PATH).startsWith(path.resolve(process.env.APRA_FLEET_DATA_DIR!))).toBe(true);
    expect(path.resolve(USAGE_LOG_PATH).startsWith(path.resolve(FLEET_DIR))).toBe(true);
    expect(path.resolve(USAGE_LOG_PATH).startsWith(path.resolve(os.homedir(), '.apra-fleet'))).toBe(false);
  });

  it('after a code_query from a member session the last row names the member id and the session id', async () => {
    const c = await connect(memberId);
    const target = `member-attribution-${Date.now()}`;
    await c.callTool({ name: 'code_query', arguments: { query: target } });
    await vi.waitFor(() => expect(rowsFor(target).length).toBe(1));
    const row = rowsFor(target).at(-1)!;
    expect(row).toMatchObject({ tool: 'code_query', target, repo: repoDir, memberId });
    expect(typeof row.sessionId).toBe('string');
    expect((row.sessionId as string).length).toBeGreaterThan(0);
    // the session id is the MCP session's own id
    expect(row.sessionId).toBe((c as unknown as { transport?: { sessionId?: string } }).transport?.sessionId);
  });

  it('a FULL (non-member) session still writes a valid, unattributed row', async () => {
    const c = await connect();
    const target = `full-attribution-${Date.now()}`;
    await c.callTool({ name: 'code_query', arguments: { query: target } });
    await vi.waitFor(() => expect(rowsFor(target).length).toBe(1));
    const row = rowsFor(target).at(-1)!;
    expect(Object.keys(row).sort()).toEqual(['repo', 'target', 'tool', 'ts']);
  });
});
