import { describe, it, expect, vi, afterAll } from 'vitest';

// Regression replay of the incident "code_impact served a corrupt answer after
// a background re-index": an existing, READY index one commit behind HEAD; a
// code_impact call whose freshness check starts the background reindex (the
// real scheduler and analyze runner, against a FAKE `npx`); then lookups of a
// symbol whose name exists unchanged while that analyze is still rewriting the
// index in place; then a lookup after it finished.
//
// The fake analyze takes no lock file and leaves meta.json looking complete
// until its final write -- exactly what the readiness check sees on hosts
// where the gitnexus lock is a socket (Linux/Windows), and what an analyze
// that rewrites an existing index looks like before its meta write. While it
// runs, the fake gitnexus child answers from the half-written index: a
// confident HIGH answer, for the right name or for an unrelated symbol.
//
// Isolation: the gitnexus MCP child is a mocked Client (nothing real is
// spawned for it); the analyze is the fake npx script under a sandbox bin dir
// first on PATH; the fleet data dir (status.json, analyze.log) and
// GITNEXUS_HOME are inside one sandbox removed in afterAll, which also fails
// the file if any spawned analyze is still alive.

const sandbox = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-replay-')));
  const data = path.join(root, 'data');
  const gnHome = path.join(root, 'gitnexus-home');
  fs.mkdirSync(data);
  fs.mkdirSync(gnHome);
  fs.mkdirSync(path.join(root, 'bin'));
  process.env.APRA_FLEET_DATA_DIR = data;
  process.env.GITNEXUS_HOME = gnHome;
  return { root, data, gnHome, bin: path.join(root, 'bin') };
});

const mockCallTool = vi.hoisted(() => vi.fn());
const clientCtor = vi.hoisted(() => vi.fn());

vi.mock('../src/services/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/registry.js')>();
  return { ...actual, getAgent: () => ({ codeIntelProvider: 'gitnexus' }) };
});
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class MockClient {
    constructor() { clientCtor(); }
    connect = vi.fn(async () => undefined);
    callTool = mockCallTool;
    close = vi.fn(async () => undefined);
  }
  return { Client: MockClient };
});
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  class MockTransport {}
  return { StdioClientTransport: MockTransport };
});

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { handleCodeImpact, handleCodeContext } from '../src/tools/code-intelligence.js';
import { codeIndexReadiness } from '../src/tools/code-intelligence-readiness.js';
import { codeIndexDir } from '../src/tools/code-intelligence-reindex.js';

const isWin = process.platform === 'win32';
const realPath = process.env.PATH ?? '';

// The fake analyze: no lock file; marks itself mid-write (a test-only marker
// the fake child reads), keeps meta.json untouched (complete-looking) while
// "writing", then stamps the new meta and exits.
const FAKE_NPX = `#!/bin/sh
echo "Analyzing repository"
mkdir -p .gitnexus
touch .gitnexus/fake-midwrite
echo "Writing graph"
sleep 2
printf '{"lastCommit":"%s","indexedAt":"%s"}' "$(git rev-parse HEAD)" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > .gitnexus/meta.json
rm -f .gitnexus/fake-midwrite
echo "Indexed ok"
`;

const pids = new Set<number>();

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
}

/** gitnexus impact / context payloads as the child returns them. */
function impactResult(name: string, risk = 'HIGH'): unknown {
  const payload = { target: { id: `Function:src/x.ts:${name}`, name, type: 'Function', filePath: 'src/x.ts' }, direction: 'upstream', impactedCount: 9, risk };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) + '\n\n---\n**Next:** Review d=1 items first.' }] };
}
function contextResult(name: string): unknown {
  return { content: [{ type: 'text', text: JSON.stringify({ status: 'found', symbol: { uid: `Function:src/x.ts:${name}`, name, filePath: 'src/x.ts' } }) }] };
}

/** Outcome of one code_* call: the result, or the typed error it threw. */
type Outcome = { ok: true; result: Record<string, unknown> } | { ok: false; error: Error & { code?: string } };
async function outcome(p: Promise<unknown>): Promise<Outcome> {
  try { return { ok: true, result: (await p) as Record<string, unknown> }; } catch (e) { return { ok: false, error: e as Error & { code?: string } }; }
}

/** The symbol a result is about, and its risk/confidence, read the way a caller would. */
function answer(o: Outcome): { name?: string; risk?: string; flagged: boolean } {
  if (!o.ok) return { flagged: false };
  const text = (o.result.content as Array<{ text: string }>)[0].text.split('\n\n---\n')[0];
  const p = JSON.parse(text) as { target?: { name?: string }; symbol?: { name?: string }; risk?: string };
  return { name: p.target?.name ?? p.symbol?.name, risk: p.risk, flagged: o.result.resolution_mismatch !== undefined && o.result.confidence === 'LOW' };
}

async function waitFor(fn: () => boolean, ms = 15000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function collectPids(): void {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(sandbox.data, 'code-index', fs.readdirSync(path.join(sandbox.data, 'code-index'))[0], 'status.json'), 'utf8')) as { pid?: number };
    if (s.pid) pids.add(s.pid);
  } catch { /* no run recorded */ }
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

afterAll(async () => {
  collectPids();
  // A failed run can stop mid-replay with the fake analyze still sleeping:
  // give it time to finish on its own before treating it as leaked.
  const t0 = Date.now();
  while ([...pids].some(alive) && Date.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 100));
  process.env.PATH = realPath;
  delete process.env.GITNEXUS_HOME;
  let leaked = 0;
  for (const pid of pids) {
    try { process.kill(pid, 0); leaked++; try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } catch { /* gone */ }
  }
  fs.rmSync(sandbox.root, { recursive: true, force: true });
  expect(leaked).toBe(0);
});

describe.skipIf(isWin)('replay: background reindex over an existing index', () => {
  it('never yields a confident answer from the half-rewritten index', { timeout: 30000 }, async () => {
    fs.writeFileSync(path.join(sandbox.bin, 'npx'), FAKE_NPX, { mode: 0o755 });
    process.env.PATH = sandbox.bin + path.delimiter + realPath;

    // An existing, ready index built at the previous commit; HEAD is one ahead.
    const repo = path.join(sandbox.root, 'repo');
    fs.mkdirSync(path.join(repo, '.gitnexus'), { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'one');
    const indexed = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'two');
    const head = git(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, '.gitnexus', 'meta.json'), JSON.stringify({ lastCommit: indexed, indexedAt: '2026-01-01T00:00:00.000Z' }));
    expect(codeIndexReadiness('gitnexus', repo)).toEqual({ ready: true });

    const midWrite = (): boolean => fs.existsSync(path.join(repo, '.gitnexus', 'fake-midwrite'));
    // The fake gitnexus child: answers correctly from a settled index; from a
    // half-written one it answers HIGH -- about an unrelated symbol for
    // code_context, and about the right NAME (wrong data) for code_impact.
    mockCallTool.mockImplementation(async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      if (name === 'context') return contextResult(midWrite() ? 'claimBeadsBatched' : String(args.name));
      return impactResult(String(args.target));
    });

    const outcomes: Array<[string, string, Outcome]> = [];
    const self = { repo, memberId: 'm' };

    // 1. A lookup on the ready-but-behind index answers and starts the background reindex.
    const first = await outcome(handleCodeImpact({ target: 'runUninstall', direction: 'upstream' }, self));
    outcomes.push(['runUninstall', 'before', first]);
    expect(first.ok).toBe(true);
    expect((first as { result: Record<string, unknown> }).result.indexedCommit).toBe(indexed);
    expect(JSON.stringify(first)).toContain('A background re-index has been started.');
    await waitFor(midWrite);
    collectPids();

    // 2. The SAME name, looked up while the analyze rewrites the index in place.
    // GATE ASSERTION: reverting the consistency gate (the live-analyze fence
    // in codeIndexReadiness, which makes a complete-looking index under a live
    // analyze 'building') makes `expect(during.ok).toBe(false)` below fail --
    // the call is then answered, ok === true, from the half-written index.
    const during = await outcome(handleCodeImpact({ target: 'runUninstall', direction: 'upstream' }, self));
    outcomes.push(['runUninstall', 'during', during]);
    expect(during.ok).toBe(false);
    expect((during as { error: Error & { code?: string } }).error.code).toBe('E-CODE-INDEX-NOT-READY');
    expect((during as { error: Error }).error.message).toContain('is still being built');

    // 3. A code_context lookup mid-write: not ready (or, at worst, flagged).
    const duringCtx = await outcome(handleCodeContext({ name: 'runUninstall' }, self));
    outcomes.push(['runUninstall', 'during-context', duringCtx]);
    expect(duringCtx.ok ? answer(duringCtx).flagged : (duringCtx as { error: { code?: string } }).error.code === 'E-CODE-INDEX-NOT-READY').toBe(true);

    // 4. After the analyze finished: served from the new index, by a fresh child.
    const statusPath = path.join(codeIndexDir(repo), 'status.json');
    await waitFor(() => !midWrite() && fs.existsSync(statusPath) && (JSON.parse(fs.readFileSync(statusPath, 'utf8')) as { phase?: string }).phase === 'done');
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as { result?: string; indexedCommit?: string };
    expect(status).toMatchObject({ result: 'indexed', indexedCommit: head });
    const childrenBefore = clientCtor.mock.calls.length;
    const after = await outcome(handleCodeImpact({ target: 'runUninstall', direction: 'upstream' }, self));
    outcomes.push(['runUninstall', 'after', after]);
    expect(after.ok).toBe(true);
    expect((after as { result: Record<string, unknown> }).result.indexedCommit).toBe(head);
    expect(clientCtor.mock.calls.length).toBe(childrenBefore + 1);

    // Invariant over the whole replay: no result names a different symbol than
    // requested unless it is flagged LOW, and nothing unflagged is about another symbol.
    for (const [requested, phase, o] of outcomes) {
      if (!o.ok) continue;
      const a = answer(o);
      if (a.name !== requested) expect(a.flagged, `${phase}: ${a.name} returned for ${requested}`).toBe(true);
      if (a.flagged) expect(a.risk === undefined || a.risk === 'UNKNOWN', phase).toBe(true);
    }
  });
});
