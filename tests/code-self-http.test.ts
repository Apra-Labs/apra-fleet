import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// code (self) end to end over REAL HTTP: the real createHttpTransport, the
// real registerAllTools per session, a real MCP SDK client per session. No
// code_* request carries a repo argument; the folder a call is answered from
// is the calling session's own --
//   MEMBER session (?member=<uuid>) -> that member's registered work folder
//   FULL session (no identity)      -> the server working folder
//
// Two registered local members get separate temp git repos, each holding a
// DISTINCT fake index file; a fake provider ('fake-http-index', pinned per
// member via codeIntelProvider, and as the global provider for the FULL
// session) answers code_query purely from <params.repo>/.fake-code-index.json,
// so "which index answered" is the observable. While the two members query, an
// execute_prompt is marked in flight for member alpha only -- under the old
// inFlightAgents.size === 1 heuristic, beta's call would have been resolved
// as alpha's, so that regression turns the two-member test red.
//
// Isolation: the registry is the isolated test registry
// (backupAndResetRegistry/restoreRegistry); the global code-intel config read
// (~/.apra-fleet/data/code-intelligence/config.json) is intercepted so the
// real home config is never read for it; recordUsage is mocked (no
// telemetry written); every typed-error case throws before any provider
// child process could be spawned. All temp folders live under one scratch dir
// removed in afterAll, and the suite asserts nothing is left behind.

const recordUsageSpy = vi.hoisted(() => vi.fn());
vi.mock('../src/tools/code-intelligence-telemetry.js', () => ({ recordUsage: recordUsageSpy }));
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const readFile = (async (p: unknown, ...rest: unknown[]) => {
    if (typeof p === 'string' && p.replace(/\\/g, '/').endsWith('code-intelligence/config.json')) {
      return JSON.stringify({ provider: 'fake-http-index' });
    }
    return (actual.readFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
  }) as typeof actual.readFile;
  return { ...actual, default: { ...actual, readFile }, readFile };
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpTransport, type HttpTransportHandle } from '../src/services/http-transport.js';
import { registerAllTools } from '../src/services/tool-registry.js';
import { addAgent } from '../src/services/registry.js';
import { inFlightAgents } from '../src/tools/execute-prompt.js';
import { PROVIDERS, type CodeIntelligenceProvider } from '../src/tools/code-intelligence.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry, memberSecretRequestInit } from './test-helpers.js';

const RECONNECT = { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 };
const INDEX_FILE = '.fake-code-index.json';
const CODE_TOOLS = ['code_graph', 'code_impact', 'code_query', 'code_context', 'code_map', 'code_flow', 'code_tests'];
// Tools that manage the index itself; they exist in tools/list but are not provider queries.
const INDEX_TOOLS = ['code_reindex', 'code_status'];
const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// Answers ONLY from the index file inside params.repo -- the folder the
// server resolved for the calling session.
async function answerFromIndex(params: Record<string, unknown>): Promise<unknown> {
  const index = JSON.parse(fs.readFileSync(path.join(String(params.repo), INDEX_FILE), 'utf-8')) as { owner: string };
  return { content: [{ type: 'text', text: JSON.stringify({ answeredFrom: index.owner }) }] };
}
const fakeIndexProvider = Object.fromEntries(
  ['graph', 'impact', 'query', 'context', 'map', 'flow', 'tests'].map(m => [m, answerFromIndex]),
) as unknown as CodeIntelligenceProvider;

let scratch: string;
let tmpBaseline: string[];
let handle: HttpTransportHandle;
const clients: Client[] = [];
const members: Record<string, string> = {};
const folders: Record<string, string> = {};

function gitRepo(name: string, indexOwner?: string): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (indexOwner) fs.writeFileSync(path.join(dir, INDEX_FILE), JSON.stringify({ owner: indexOwner }));
  return dir;
}

function register(key: string, workFolder: string, codeIntelProvider: string): void {
  const agent = makeTestLocalAgent({ friendlyName: `code-self-http-${key}`, workFolder, codeIntelProvider: codeIntelProvider as never });
  addAgent(agent);
  members[key] = agent.id;
  folders[key] = workFolder;
}

async function connect(member?: string): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
  if (member) url.searchParams.set('member', member);
  const client = new Client({ name: 'code-self-http', version: '1.0.0' }, { capabilities: {} });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(url, { reconnectionOptions: RECONNECT, requestInit: memberSecretRequestInit() }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const text = ((result.content as Array<{ text?: string }>) ?? []).map(c => c.text ?? '').join('\n');
  return { isError: result.isError === true, text };
}

/** The index that answered an ok code_query: the provider result is JSON inside the tool text. */
function answeredFrom(text: string): string {
  const providerResult = JSON.parse(text) as { content: Array<{ text: string }> };
  return (JSON.parse(providerResult.content[0].text) as { answeredFrom: string }).answeredFrom;
}

function remediationCount(text: string): number {
  return text.split('Remediation:').length - 1;
}

function tmpEntries(): string[] {
  return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('code-self-http-'));
}

beforeAll(async () => {
  tmpBaseline = tmpEntries();
  backupAndResetRegistry();
  PROVIDERS['fake-http-index'] = fakeIndexProvider;
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-self-http-')));
  folders.server = gitRepo('server', 'server');
  register('alpha', gitRepo('alpha', 'alpha'), 'fake-http-index');
  register('beta', gitRepo('beta', 'beta'), 'fake-http-index');
  register('deleted', gitRepo('deleted', 'deleted'), 'fake-http-index');
  fs.rmSync(folders.deleted, { recursive: true, force: true });
  const plain = path.join(scratch, 'plain');
  fs.mkdirSync(plain);
  register('plain', plain, 'fake-http-index');
  register('noindex', gitRepo('noindex'), 'gitnexus');
  register('off', gitRepo('off'), 'none');
  handle = await createHttpTransport({ registerTools: registerAllTools, preferredPort: 0 });
}, 30_000);

afterEach(() => {
  inFlightAgents.clear();
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const c of clients.splice(0)) { try { await c.close(); } catch { /* ignore */ } }
  try { await handle?.close(); } catch { /* ignore */ }
  delete PROVIDERS['fake-http-index'];
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
  // No leftover temp folders after the suite.
  expect(tmpEntries()).toEqual(tmpBaseline);
});

describe('code (self) over HTTP: each session is answered from its own folder', () => {
  it('two MEMBER sessions on one server: each code_query is answered from that member\'s own index, even with one member in flight', async () => {
    const alpha = await connect(members.alpha);
    const beta = await connect(members.beta);
    // The old heuristic resolved EVERY code call to the single in-flight member.
    inFlightAgents.add(members.alpha);

    const a = await call(alpha, 'code_query', { query: 'widget' });
    const b = await call(beta, 'code_query', { query: 'widget' });

    expect(a.isError, a.text).toBe(false);
    expect(b.isError, b.text).toBe(false);
    expect(answeredFrom(a.text)).toBe('alpha');
    expect(answeredFrom(b.text)).toBe('beta');
  });

  it('a FULL session\'s code_query is answered from the server working folder\'s index', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(folders.server);
    const full = await connect();
    const out = await call(full, 'code_query', { query: 'widget' });
    expect(out.isError, out.text).toBe(false);
    expect(answeredFrom(out.text)).toBe('server');
  });

  it('no code_* tool in tools/list exposes repo or repo_path (member and FULL sessions)', async () => {
    for (const client of [await connect(members.alpha), await connect()]) {
      const tools = (await client.listTools()).tools.filter(t => t.name.startsWith('code_'));
      expect(tools.map(t => t.name).sort()).toEqual([...CODE_TOOLS, ...INDEX_TOOLS].sort());
      for (const tool of tools) {
        const props = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
        expect(props, tool.name).not.toContain('repo');
        expect(props, tool.name).not.toContain('repo_path');
        expect(props, tool.name).not.toContain('repo_remote_url');
      }
    }
  });
});

describe('code (self) over HTTP: typed errors, each with exactly one remediation', () => {
  it('E-SELF-NO-WORKFOLDER when the member work folder was deleted (no fallback to the server folder)', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(folders.server);
    const out = await call(await connect(members.deleted), 'code_query', { query: 'x' });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`E-SELF-NO-WORKFOLDER: The member 'code-self-http-deleted' work folder '${folders.deleted}' does not exist`);
    expect(remediationCount(out.text)).toBe(1);
  });

  it('E-SELF-NOT-A-REPO when the member work folder is not a git repository', async () => {
    const out = await call(await connect(members.plain), 'code_query', { query: 'x' });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`E-SELF-NOT-A-REPO: The member 'code-self-http-plain' work folder '${folders.plain}' is not a git repository.`);
    expect(remediationCount(out.text)).toBe(1);
  });

  it('E-CODE-INDEX-NOT-READY when the member folder has no index', async () => {
    const out = await call(await connect(members.noindex), 'code_query', { query: 'x' });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`E-CODE-INDEX-NOT-READY: No gitnexus code index found for '${folders.noindex}'.`);
    expect(remediationCount(out.text)).toBe(1);
  });

  it('E-CODE-INTEL-DISABLED when the provider is none -- an error result on every code_* tool, never ok', async () => {
    const off = await connect(members.off);
    for (const tool of CODE_TOOLS) {
      const out = await call(off, tool, tool === 'code_impact' ? { target: 'x', direction: 'upstream' } : { query: 'x', symbol: 'x', name: 'x' });
      expect(out.isError, `${tool} must never be ok: ${out.text}`).toBe(true);
      expect(out.text, tool).toContain('E-CODE-INTEL-DISABLED');
      expect(remediationCount(out.text), tool).toBe(1);
    }
  });
});

describe('code (self): the in-flight heuristic is gone from production source', () => {
  it('no file under src/ mentions getActiveMemberId or inFlightAgents.size === 1', () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (/test/i.test(entry.name)) continue;
        const text = fs.readFileSync(full, 'utf-8');
        if (text.includes('getActiveMemberId') || text.includes('inFlightAgents.size === 1')) hits.push(path.relative(SRC_DIR, full));
      }
    };
    walk(SRC_DIR);
    expect(hits).toEqual([]);
  });
});
