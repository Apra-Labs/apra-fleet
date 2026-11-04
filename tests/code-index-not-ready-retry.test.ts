import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// E-CODE-INDEX-NOT-READY carries machine-readable retry guidance:
//   - every not-ready state (building, missing, interrupted, inconsistent,
//     codebase-memory, and an index that changed under a call) yields a
//     numeric retry_after_ms (0 + retry_will_help:false when retrying alone
//     cannot help);
//   - while an analyze is live the detail also carries its progress (phase,
//     elapsed time, last log line, line count), read from the same status.json
//     and analyze.log code_status reports;
//   - the one-line 'E-CODE-INDEX-NOT-READY: problem Remediation: fix' message
//     is unchanged;
//   - while a build runs the wait comes from the folder's last build time;
//   - through a real McpServer + Client pair the TEXT of the error result
//     carries that detail, because a client may give its model nothing else
//     (Claude Code does); structuredContent repeats it for programs;
//   - the role prompts tell agents to wait once, retry once, then fall back,
//     and never to poll code_status in a loop.
//
// Isolation: tests/setup.ts points APRA_FLEET_DATA_DIR at a per-run temp dir,
// so the stubbed status.json / analyze.log (codeIndexDir) never land in the
// real user profile, and each one written here is removed in afterAll; the
// registry is the isolated test registry; recordUsage is mocked; the
// automatic-build scheduler is mocked so no gitnexus child process is ever
// spawned. Temp repos live under one scratch dir removed in afterAll.

const scheduleOutcome = vi.hoisted(() => ({ value: { started: true } as Record<string, unknown> }));
vi.mock('../src/tools/code-intelligence-telemetry.js', () => ({ recordUsage: vi.fn() }));
vi.mock('../src/tools/code-index-heal.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/tools/code-index-heal.js')>();
  return { ...actual, scheduleIndexBuild: () => scheduleOutcome.value };
});

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAllTools } from '../src/services/tool-registry.js';
import { memberToolScope } from '../src/services/tool-scope.js';
import { addAgent } from '../src/services/registry.js';
import { codeIndexDir } from '../src/tools/code-intelligence-reindex.js';
import {
  CodeIntelError,
  RETRY_AFTER_BUILDING_MS,
  codeIndexReadiness,
  ensureGitNexusIndexReady,
  indexChangedDuringCallError,
  indexNotReadyError,
} from '../src/tools/code-intelligence-readiness.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

const AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'apra-fleet-se', 'apra-pm', 'agents');
const ONE_LINE = /^E-CODE-INDEX-NOT-READY: [^\n]+ Remediation: [^\n]+$/;

let scratch: string;
const repos: Record<string, string> = {};
const indexDirs: string[] = [];
const members: Record<string, string> = {};
const clients: Client[] = [];

function gitRepo(name: string): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

/** A live analyze recorded for `repo`: status.json naming this (alive) process, plus its log. */
function stubLiveAnalyze(repo: string, lines: string[]): void {
  const dir = codeIndexDir(repo);
  fs.mkdirSync(dir, { recursive: true });
  indexDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'analyze.log'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    repo, pid: process.pid, started: new Date(Date.now() - 5000).toISOString(), lockHeld: false,
    lastLine: lines[lines.length - 1], lineCount: lines.length, phase: 'running', result: null, exitCode: null,
  }));
}

/** The folder's last build took `ms`: recorded on the live run's status.json as spawnAnalyze does. */
function recordPreviousBuild(repo: string, ms: number | undefined, startedMsAgo: number): void {
  const file = path.join(codeIndexDir(repo), 'status.json');
  const status = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  status.previousBuildMs = ms;
  status.started = new Date(Date.now() - startedMsAgo).toISOString();
  fs.writeFileSync(file, JSON.stringify(status));
}

function data(err: CodeIntelError): Record<string, unknown> {
  expect(err).toBeInstanceOf(CodeIntelError);
  expect(err.code).toBe('E-CODE-INDEX-NOT-READY');
  expect(err.message).toMatch(ONE_LINE);
  expect(err.structuredContent, 'E-CODE-INDEX-NOT-READY must carry structuredContent').toBeTruthy();
  const sc = err.structuredContent as Record<string, unknown>;
  expect(typeof sc.retry_after_ms).toBe('number');
  expect(sc.code).toBe('E-CODE-INDEX-NOT-READY');
  expect(sc.retry_will_help).toBe((sc.retry_after_ms as number) > 0);
  return sc;
}

function thrown(fn: () => unknown): CodeIntelError {
  try {
    fn();
  } catch (e) {
    return e as CodeIntelError;
  }
  throw new Error('expected a throw');
}

beforeAll(() => {
  backupAndResetRegistry();
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-not-ready-retry-')));
  repos.building = gitRepo('building');
  stubLiveAnalyze(repos.building, ['Scanning repository', 'Parsing files 12/40', 'Parsing files 31/40']);
  repos.missing = gitRepo('missing');
  repos.interrupted = gitRepo('interrupted');
  fs.mkdirSync(path.join(repos.interrupted, '.gitnexus'));
  fs.writeFileSync(path.join(repos.interrupted, '.gitnexus', 'meta.json'), JSON.stringify({ lastCommit: 'abc', incrementalInProgress: true }));
  for (const key of ['building', 'missing']) {
    const agent = makeTestLocalAgent({ friendlyName: `not-ready-${key}`, workFolder: repos[key], codeIntelProvider: 'gitnexus' });
    addAgent(agent);
    members[key] = agent.id;
  }
});

afterEach(async () => {
  scheduleOutcome.value = { started: true };
  for (const c of clients.splice(0)) { try { await c.close(); } catch { /* ignore */ } }
});

afterAll(() => {
  restoreRegistry();
  for (const d of indexDirs) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('E-CODE-INDEX-NOT-READY: retry_after_ms in every state, progress while building', () => {
  it('building (a live analyze recorded in status.json): positive retry_after_ms plus phase, elapsed time and last log line', () => {
    expect(codeIndexReadiness('gitnexus', repos.building)).toEqual({ ready: false, state: 'building' });
    const sc = data(thrown(() => ensureGitNexusIndexReady(repos.building)));
    expect(sc.state).toBe('building');
    expect(sc.build).toBe('running');
    expect(sc.retry_after_ms as number).toBeGreaterThan(0);
    const progress = sc.progress as Record<string, unknown>;
    expect(progress).toBeTruthy();
    expect(progress.phase).toBe('running');
    expect(progress.elapsed_ms as number).toBeGreaterThanOrEqual(4000);
    expect(progress.last_line).toBe('Parsing files 31/40');
    expect(progress.line_count).toBe(3);
  });

  it('the wait for a live build is at least a realistic full rebuild, or what should remain of the last build', () => {
    try {
      expect(data(indexNotReadyError('gitnexus', repos.building, 'building')).retry_after_ms).toBe(RETRY_AFTER_BUILDING_MS);
      expect(RETRY_AFTER_BUILDING_MS).toBeGreaterThanOrEqual(126_000);
      recordPreviousBuild(repos.building, 200_000, 20_000);
      const remaining = data(indexNotReadyError('gitnexus', repos.building, 'building')).retry_after_ms as number;
      expect(remaining).toBeGreaterThan(200_000);
      expect(remaining).toBeLessThanOrEqual(220_000);
      // A small repo is not told to wait minutes, and an overrun still gets a positive wait.
      recordPreviousBuild(repos.building, 4_000, 1_000);
      expect(data(indexNotReadyError('gitnexus', repos.building, 'building')).retry_after_ms).toBe(15_000);
      recordPreviousBuild(repos.building, 100_000, 500_000);
      expect(data(indexNotReadyError('gitnexus', repos.building, 'building')).retry_after_ms).toBe(15_000);
    } finally {
      recordPreviousBuild(repos.building, undefined, 5_000);
    }
  });

  it('building: the message text is unchanged', () => {
    const err = indexNotReadyError('gitnexus', repos.building, 'building');
    expect(err.message).toBe(`E-CODE-INDEX-NOT-READY: The gitnexus code index for '${repos.building}' is still being built. Remediation: Retry the same call in a few minutes (code_status shows the build progress).`);
  });

  it('missing with a build requested: positive retry_after_ms, build requested, message unchanged', () => {
    const sc = data(thrown(() => ensureGitNexusIndexReady(repos.missing)));
    expect(sc).toMatchObject({ state: 'missing', build: 'requested', heal: 'started', retry_will_help: true });
    expect(sc.retry_after_ms as number).toBeGreaterThan(0);
    expect(sc.progress).toBeUndefined();
    const err = indexNotReadyError('gitnexus', repos.missing, 'missing', { started: true } as never);
    expect(err.message).toBe(`E-CODE-INDEX-NOT-READY: No gitnexus code index found for '${repos.missing}'. An index build was requested automatically. Remediation: Retry the same call in a few minutes (code_status shows the build progress).`);
  });

  it('missing with builds disabled or paused: retry_after_ms is 0 and retry_will_help false (retrying alone cannot help)', () => {
    scheduleOutcome.value = { started: false, reason: 'disabled' };
    const sc = data(thrown(() => ensureGitNexusIndexReady(repos.missing)));
    expect(sc).toMatchObject({ state: 'missing', build: 'none', heal: 'disabled', retry_after_ms: 0, retry_will_help: false });
    // No heal attempted at all (assertCodeIndexReady path): also not worth waiting for.
    expect(data(indexNotReadyError('gitnexus', repos.missing, 'missing'))).toMatchObject({ retry_after_ms: 0, retry_will_help: false, build: 'none' });
  });

  it('a build already running or a cooldown: a positive wait', () => {
    expect(data(indexNotReadyError('gitnexus', repos.missing, 'missing', { started: false, reason: 'already-running' } as never)))
      .toMatchObject({ build: 'running', retry_will_help: true });
    const cooldown = data(indexNotReadyError('gitnexus', repos.missing, 'missing', { started: false, reason: 'cooldown' } as never));
    expect(cooldown.retry_after_ms as number).toBeGreaterThan(0);
  });

  it('interrupted: numeric retry_after_ms', () => {
    expect(codeIndexReadiness('gitnexus', repos.interrupted)).toMatchObject({ ready: false, state: 'interrupted' });
    const sc = data(thrown(() => ensureGitNexusIndexReady(repos.interrupted)));
    expect(sc.state).toBe('interrupted');
  });

  it('inconsistent: numeric retry_after_ms and the detail stays in the message', () => {
    const err = indexNotReadyError('gitnexus', repos.missing, 'inconsistent', { started: true } as never, 'registry names commit b, meta.json names a');
    expect(data(err)).toMatchObject({ state: 'inconsistent', build: 'requested' });
    expect(err.message).toContain('(registry names commit b, meta.json names a)');
  });

  it('codebase-memory: numeric retry_after_ms (0: fleet cannot build that index) and the message is unchanged', () => {
    const err = indexNotReadyError('codebase-memory', repos.missing, 'missing');
    expect(data(err)).toMatchObject({ provider: 'codebase-memory', retry_after_ms: 0, retry_will_help: false });
    expect(err.message).toBe(`E-CODE-INDEX-NOT-READY: No codebase-memory code index found for '${repos.missing}'. Remediation: Say "Index this project" to your agent (or run 'codebase-memory-mcp cli index_repository' on the repo), then retry.`);
  });

  it('an index that changed while the call ran: numeric retry_after_ms with state changed', () => {
    for (const after of [{ ready: true } as const, { ready: false, state: 'building' } as const, { ready: false, state: 'missing' } as const]) {
      const sc = data(indexChangedDuringCallError(repos.missing, after));
      expect(sc.state).toBe('changed');
      expect(sc.retry_after_ms as number).toBeGreaterThan(0);
    }
  });
});

describe('E-CODE-INDEX-NOT-READY through a real MCP server and client', () => {
  async function connectAs(key: string): Promise<Client> {
    const server = new McpServer({ name: 'not-ready-retry-test', version: '0.0.0' }, { capabilities: { logging: {} } });
    await registerAllTools(server, memberToolScope(members[key], false));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'not-ready-retry-client', version: '0.0.0' }, { capabilities: {} });
    await client.connect(clientSide);
    clients.push(client);
    return client;
  }

  async function errorText(key: string): Promise<{ text: string; result: Awaited<ReturnType<Client['callTool']>> }> {
    const result = await (await connectAs(key)).callTool({ name: 'code_query', arguments: { query: 'foo' } });
    expect(result.isError, key).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content, key).toHaveLength(1);
    return { text: content[0].text, result };
  }

  it('the text a model receives names the wait, what to do, and the live build progress', async () => {
    const { text } = await errorText('building');
    expect(text).toMatch(ONE_LINE);
    expect(text).toMatch(/\bretry_after_ms=\d{4,}\b/);
    expect(text).toContain('retry_will_help=true');
    expect(text).toContain('build=running');
    expect(text).toContain('state=building');
    expect(text).toContain('Wait retry_after_ms once, retry once, then fall back to text search');
    expect(text).toMatch(/progress: phase=running elapsed_ms=\d+ line_count=3 last_line='Parsing files 31\/40'/);
  });

  it('the text for a requested build has the wait and no progress', async () => {
    const { text } = await errorText('missing');
    expect(text).toMatch(ONE_LINE);
    expect(text).toMatch(/\bretry_after_ms=\d{4,}\b/);
    expect(text).toContain('build=requested');
    expect(text).toContain('heal=started');
    expect(text).not.toContain('progress:');
  });

  it('the text says plainly when waiting will not help', async () => {
    scheduleOutcome.value = { started: false, reason: 'disabled' };
    const { text } = await errorText('missing');
    expect(text).toContain('retry_after_ms=0');
    expect(text).toContain('retry_will_help=false');
    expect(text).toContain('Waiting and retrying will not help');
  });

  it('structuredContent holds the same values as the text', async () => {
    const { text, result } = await errorText('building');
    const sc = result.structuredContent as Record<string, unknown>;
    expect(text).toContain(`retry_after_ms=${sc.retry_after_ms}`);
    expect(sc.progress).toBeTruthy();
  });
});

describe('role prompts: wait once for retry_after_ms, retry once, then fall back', () => {
  for (const file of ['doer.md', 'reviewer.md']) {
    it(`${file} names retry_after_ms, one retry, a fall back, and no code_status polling`, () => {
      const text = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf-8').replace(/\s+/g, ' ');
      expect(text).toContain('E-CODE-INDEX-NOT-READY');
      expect(text).toMatch(/wait (ONCE|once) for (the|its) `retry_after_ms`/);
      expect(text).toMatch(/retry (that call )?(ONCE|once),? (and if it still fails |then )fall back/);
      expect(text).toMatch(/[Nn]ever poll `code_status` in a loop/);
    });
  }
});
