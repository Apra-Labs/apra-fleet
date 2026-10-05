import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Typed code_* errors end to end through a REAL McpServer + MCP Client pair
// (in-memory transport) and the real registerAllTools per session, so the
// assertion is on the envelope a caller actually receives:
//   E-CODE-INDEX-NOT-READY -- the (self) folder has no index, or the index is
//                             still being built;
//   E-CODE-INTEL-DISABLED  -- provider 'none'; an error result, never ok.
// Each error text carries exactly one 'Remediation:' clause.
//
// Isolation: the registry is the isolated test registry; each member pins
// its provider (codeIntelProvider), so the real global code-intel config is
// never consulted; recordUsage is mocked (no telemetry written); the
// pre-flight check throws before any gitnexus child process could be
// spawned. isReindexRunning is wrapped so one test can mark a repo as having
// a background reindex in flight without spawning one. Temp repos live under
// one scratch dir removed in afterAll.

const reindexRunning = vi.hoisted(() => new Set<string>());
vi.mock('../src/tools/code-intelligence-telemetry.js', () => ({ recordUsage: vi.fn() }));
vi.mock('../src/tools/code-intelligence-reindex.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/tools/code-intelligence-reindex.js')>();
  return { ...actual, isReindexRunning: (repo: string) => reindexRunning.has(repo) || actual.isReindexRunning(repo) };
});

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAllTools } from '../src/services/tool-registry.js';
import { memberToolScope } from '../src/services/tool-scope.js';
import { addAgent } from '../src/services/registry.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

const CODE_TOOLS: Array<[string, Record<string, unknown>]> = [
  ['code_graph', { symbol: 'foo' }],
  ['code_impact', { target: 'foo', direction: 'upstream' }],
  ['code_query', { query: 'foo' }],
  ['code_context', { name: 'foo' }],
  ['code_map', {}],
  ['code_flow', { name: 'foo' }],
  ['code_tests', { symbol: 'foo' }],
];

let scratch: string;
const members: Record<string, string> = {};
const folders: Record<string, string> = {};
const clients: Client[] = [];

function gitRepo(name: string): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function register(key: string, provider: 'gitnexus' | 'none', workFolder: string): void {
  const agent = makeTestLocalAgent({ friendlyName: `code-typed-${key}`, workFolder, codeIntelProvider: provider });
  addAgent(agent);
  members[key] = agent.id;
  folders[key] = workFolder;
}

async function connectAs(key: string): Promise<Client> {
  const server = new McpServer({ name: 'typed-errors-test', version: '0.0.0' }, { capabilities: { logging: {} } });
  await registerAllTools(server, memberToolScope(members[key], false));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'typed-errors-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const text = ((result.content as Array<{ text?: string }>) ?? []).map(c => c.text ?? '').join('\n');
  return { isError: result.isError === true, text };
}

function remediationCount(text: string): number {
  return text.split('Remediation:').length - 1;
}

beforeAll(() => {
  backupAndResetRegistry();
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-typed-errors-')));
  register('missing', 'gitnexus', gitRepo('missing'));
  const building = gitRepo('building');
  fs.mkdirSync(path.join(building, '.gitnexus'));
  // A live analyze: the lock file names this (alive) process.
  fs.writeFileSync(path.join(building, '.gitnexus', 'analyze.lock'), JSON.stringify({ pid: process.pid, token: 't' }));
  register('building', 'gitnexus', building);
  register('reindexing', 'gitnexus', gitRepo('reindexing'));
  register('off', 'none', gitRepo('off'));
});

afterEach(async () => {
  reindexRunning.clear();
  for (const c of clients.splice(0)) { try { await c.close(); } catch { /* ignore */ } }
});

afterAll(() => {
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('E-CODE-INDEX-NOT-READY', () => {
  it('is returned when the (self) folder has no index', async () => {
    const out = await call(await connectAs('missing'), 'code_query', { query: 'foo' });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`E-CODE-INDEX-NOT-READY: No gitnexus code index found for '${folders.missing}'.`);
    // tests/setup.ts fakes the self-heal start: the message says a build started, never "run npx".
    expect(out.text).toContain('An index build was started automatically. Remediation: Retry the same call in a minute or so');
    expect(out.text).not.toMatch(/npx/);
    expect(remediationCount(out.text)).toBe(1);
  });

  it('is returned when the index is still being built (analyze lock held, no meta.json yet)', async () => {
    const out = await call(await connectAs('building'), 'code_query', { query: 'foo' });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`E-CODE-INDEX-NOT-READY: The gitnexus code index for '${folders.building}' is still being built.`);
    expect(out.text).toContain('Remediation: Retry the same call in a minute or so');
    expect(out.text).not.toMatch(/npx/);
    expect(remediationCount(out.text)).toBe(1);
  });

  it('is returned as building while a background reindex for the repo is in flight', async () => {
    reindexRunning.add(folders.reindexing);
    const out = await call(await connectAs('reindexing'), 'code_query', { query: 'foo' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/E-CODE-INDEX-NOT-READY: .* is still being built\./);
    expect(remediationCount(out.text)).toBe(1);
  });

  it('applies to every code_* tool', async () => {
    const client = await connectAs('missing');
    for (const [tool, args] of CODE_TOOLS) {
      const out = await call(client, tool, args);
      expect(out.isError, `${tool}: ${out.text}`).toBe(true);
      expect(out.text, tool).toMatch(/E-CODE-INDEX-NOT-READY/);
      expect(remediationCount(out.text), tool).toBe(1);
    }
  });
});

describe('E-CODE-INTEL-DISABLED', () => {
  it('every code_* tool returns an error result (never ok) when code intelligence is off', async () => {
    const client = await connectAs('off');
    for (const [tool, args] of CODE_TOOLS) {
      const out = await call(client, tool, args);
      expect(out.isError, `${tool} must be an error result: ${out.text}`).toBe(true);
      expect(out.text, tool).toContain(`E-CODE-INTEL-DISABLED: Code intelligence is disabled (provider 'none'), so ${tool} cannot be answered.`);
      expect(remediationCount(out.text), tool).toBe(1);
    }
  });
});
