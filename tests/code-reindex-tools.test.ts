import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// code_reindex / code_status end to end against a FAKE `npx` (placed first on
// PATH inside a temp sandbox) -- no real gitnexus analyze ever runs. The fake
// prints lines, holds an analyze.lock, writes meta.json and exits, per
// FAKE_MODE. The data dir is a sandbox (APRA_FLEET_DATA_DIR, set before any
// import via vi.hoisted) so nothing is written outside it.

const sandbox = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-reindex-')));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  process.env.APRA_FLEET_DATA_DIR = data;
  return { root, data, bin: path.join(root, 'bin') };
});

const providerRef = vi.hoisted(() => ({ name: 'gitnexus' }));
vi.mock('../src/services/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/registry.js')>();
  return { ...actual, getAgent: () => ({ codeIntelProvider: providerRef.name }) };
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { handleCodeReindex, handleCodeStatus } from '../src/tools/code-intelligence.js';
import { codeStatus } from '../src/tools/code-intelligence-reindex.js';
import { codeIndexReadiness } from '../src/tools/code-intelligence-readiness.js';

const isWin = process.platform === 'win32';
const realPath = process.env.PATH ?? '';
const pids = new Set<number>();
function realCodeIndex(): string[] {
  const d = path.join(os.homedir(), '.apra-fleet', 'data', 'code-index');
  try { return fs.readdirSync(d).sort(); } catch { return []; }
}
const realCodeIndexBefore = realCodeIndex();
let repo: string;
let head: string;
let n = 0;

// Like the real gitnexus, a run WITHOUT --index-only injects AI-context files
// into the work tree (an AGENTS.md / CLAUDE.md block plus skills folders).
// The fake writes no .gitnexus/.gitignore, so the fleet's own git exclude
// entry is what keeps .gitnexus/ out of git status.
const FAKE_NPX = `#!/bin/sh
mkdir -p .gitnexus
case " $* " in
  *" --index-only "*) ;;
  *)
    printf '<!-- gitnexus:start -->\\n# GitNexus\\n<!-- gitnexus:end -->\\n' >> AGENTS.md
    printf '<!-- gitnexus:start -->\\n# GitNexus\\n<!-- gitnexus:end -->\\n' >> CLAUDE.md
    mkdir -p .agents/skills/gitnexus-cli .claude/skills/gitnexus
    echo skill > .agents/skills/gitnexus-cli/SKILL.md
    echo skill > .claude/skills/gitnexus/SKILL.md
    ;;
esac
case "$FAKE_MODE" in
  index)
    echo "Analyzing repository"
    printf '{"pid":%s,"token":"t","hostname":"h"}' $$ > .gitnexus/analyze.lock
    echo "Parsing files"
    sleep 1
    printf '{"lastCommit":"%s"}' "$(git rev-parse HEAD)" > .gitnexus/meta.json
    rm -f .gitnexus/analyze.lock
    echo "Indexed ok"
    ;;
  uptodate) echo "Already up to date"; ;;
  notfound) echo "npm error 404 Not Found - GET https://registry.npmjs.org/gitnexus"; exit 1 ;;
esac
`;

function newRepo(): string {
  const dir = path.join(sandbox.root, `repo${n++}`);
  fs.mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  return dir;
}

/** Commits tracked AGENTS.md + CLAUDE.md, as a target repo with agent docs has. */
function seedAgentDocs(dir: string): void {
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Target agents\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Target claude\n');
  execFileSync('git', ['add', 'AGENTS.md', 'CLAUDE.md'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'docs'], { cwd: dir });
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function porcelain(dir: string): string {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' });
}

function logOf(dir: string): string {
  const d = path.join(sandbox.data, 'code-index');
  const slug = fs.readdirSync(d)[0];
  return fs.readFileSync(path.join(d, slug, 'analyze.log'), 'utf8');
}

async function waitFor<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(() => {
  fs.mkdirSync(sandbox.bin);
  fs.writeFileSync(path.join(sandbox.bin, 'npx'), FAKE_NPX, { mode: 0o755 });
  process.env.PATH = sandbox.bin + path.delimiter + realPath;
});

afterAll(() => {
  collectPids();
  process.env.PATH = realPath;
  delete process.env.FAKE_MODE;
  let leaked = 0;
  for (const pid of pids) {
    try { process.kill(pid, 0); leaked++; try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } catch { /* gone */ }
  }
  fs.rmSync(sandbox.root, { recursive: true, force: true });
  expect(leaked).toBe(0);
});

function collectPids(): void {
  const d = path.join(sandbox.data, 'code-index');
  if (!fs.existsSync(d)) return;
  for (const slug of fs.readdirSync(d)) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(d, slug, 'status.json'), 'utf8')) as { pid?: number };
      if (st.pid) pids.add(st.pid);
    } catch { /* no status */ }
  }
}

beforeEach(() => {
  collectPids();
  fs.rmSync(path.join(sandbox.data, 'code-index'), { recursive: true, force: true });
  repo = newRepo();
});

describe.skipIf(isWin)('code_reindex / code_status with a fake gitnexus', () => {
  it('returns after the first tick, then code_status reports indexed with the commit', async () => {
    process.env.FAKE_MODE = 'index';
    const t0 = Date.now();
    const r = await handleCodeReindex({}, { repo, memberId: 'm' });
    expect(r.outcome).toBe('started');
    if (r.outcome === 'started' && r.pid) pids.add(r.pid);
    expect(Date.now() - t0).toBeLessThan(5000);
    // first tick: not yet finished, the index is not ready
    expect(codeIndexReadiness('gitnexus', repo).ready).toBe(false);

    const done = await waitFor(() => {
      const s = codeStatus(repo, codeIndexReadiness('gitnexus', repo));
      return s.analyze?.phase === 'done' ? s : undefined;
    });
    const viaTool = await handleCodeStatus({}, { repo, memberId: 'm' });
    expect(viaTool).toMatchObject({ ready: true, indexedCommit: head });
    expect(done.analyze.result).toBe('indexed');
    expect(done.ready).toBe(true);
    expect(done.indexedCommit).toBe(head);
  });

  it('analyze.log holds the analyze output', async () => {
    process.env.FAKE_MODE = 'index';
    await handleCodeReindex({}, { repo, memberId: 'm' });
    await waitFor(() => (codeStatus(repo, codeIndexReadiness('gitnexus', repo)).analyze?.phase === 'done' ? true : undefined));
    const log = logOf(repo);
    expect(log).toContain('Analyzing repository');
    expect(log).toContain('Indexed ok');
  });

  it('an Already up to date run reports up-to-date', async () => {
    process.env.FAKE_MODE = 'uptodate';
    const r = await handleCodeReindex({}, { repo, memberId: 'm' });
    expect(r.outcome).toBe('up-to-date');
    const s = await waitFor(() => (codeStatus(repo, codeIndexReadiness('gitnexus', repo)).analyze?.phase === 'done' ? codeStatus(repo, codeIndexReadiness('gitnexus', repo)) : undefined));
    expect(s.analyze?.result).toBe('up-to-date');
  });

  it('missing npx is a typed not-started, never started', async () => {
    const saved = process.env.PATH;
    process.env.PATH = path.join(sandbox.root, 'empty');
    try {
      const r = await handleCodeReindex({}, { repo, memberId: 'm' });
      expect(r).toMatchObject({ outcome: 'not-started', reason: 'npx-not-found' });
    } finally { process.env.PATH = saved; }
  });

  it('missing gitnexus (npx cannot resolve it) is a typed not-started, never started', async () => {
    process.env.FAKE_MODE = 'notfound';
    const r = await handleCodeReindex({}, { repo, memberId: 'm' });
    expect(r).toMatchObject({ outcome: 'not-started', reason: 'gitnexus-not-found' });
  });

  it('a second code_reindex while one runs does not start another analyze', async () => {
    process.env.FAKE_MODE = 'index';
    const first = await handleCodeReindex({}, { repo, memberId: 'm' });
    if (first.outcome === 'started' && first.pid) pids.add(first.pid);
    const second = await handleCodeReindex({}, { repo, memberId: 'm' });
    expect(second.outcome).toBe('already-running');
    await waitFor(() => (codeStatus(repo, codeIndexReadiness('gitnexus', repo)).analyze?.phase === 'done' ? true : undefined));
  });

  it('a code index build leaves the target work tree unchanged (index-only, .gitnexus/ excluded)', async () => {
    seedAgentDocs(repo);
    const before = porcelain(repo);
    expect(before).toBe('');
    process.env.FAKE_MODE = 'index';
    const r = await handleCodeReindex({}, { repo, memberId: 'm' });
    if (r.outcome === 'started' && r.pid) pids.add(r.pid);
    const done = await waitFor(() => (codeStatus(repo, codeIndexReadiness('gitnexus', repo)).analyze?.phase === 'done' ? codeStatus(repo, codeIndexReadiness('gitnexus', repo)) : undefined));
    expect(done.analyze?.result).toBe('indexed');
    expect(fs.existsSync(path.join(repo, '.gitnexus', 'meta.json'))).toBe(true);
    expect(porcelain(repo)).toBe(before);
    expect(fs.existsSync(path.join(repo, '.agents'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8')).not.toContain('gitnexus:start');
    const excl = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: repo, encoding: 'utf8' }).trim();
    const lines = fs.readFileSync(path.resolve(repo, excl), 'utf8').split('\n');
    expect(lines.filter((l) => l === '/.gitnexus/')).toHaveLength(1);
  });

  it('negative control: the fake dirties the repo when run without --index-only', () => {
    seedAgentDocs(repo);
    execFileSync(path.join(sandbox.bin, 'npx'), ['gitnexus', 'analyze'], { cwd: repo, env: { ...process.env, FAKE_MODE: 'uptodate' } });
    const dirty = porcelain(repo);
    expect(dirty).toContain('AGENTS.md');
    expect(dirty).toContain('CLAUDE.md');
    expect(dirty).toContain('.agents/');
  });

  it('codebase-memory: code_reindex starts nothing and the work tree stays unchanged', async () => {
    seedAgentDocs(repo);
    const before = porcelain(repo);
    providerRef.name = 'codebase-memory';
    try {
      const r = await handleCodeReindex({}, { repo, memberId: 'm' });
      expect(r).toMatchObject({ outcome: 'not-started', reason: 'provider-not-supported', provider: 'codebase-memory' });
    } finally { providerRef.name = 'gitnexus'; }
    expect(porcelain(repo)).toBe(before);
    expect(fs.existsSync(path.join(repo, '.gitnexus'))).toBe(false);
  });

  it('a remote member folder is a typed not-started', async () => {
    const r = await handleCodeReindex({}, { repo: '/elsewhere', memberId: 'm', remote: true });
    expect(r).toMatchObject({ outcome: 'not-started', reason: 'remote-member' });
  });
});


describe('client exports and sandbox hygiene', () => {
  it('apra-fleet-client exports code_reindex and code_status', async () => {
    const { ApraFleet } = await import('../packages/apra-fleet-client/src/client/api.mjs');
    expect(typeof ApraFleet.prototype.codeReindex).toBe('function');
    expect(typeof ApraFleet.prototype.codeStatus).toBe('function');
  });

  it('server registers code_reindex/code_status as member-allowed tools', async () => {
    const { REGISTERED_TOOL_NAMES } = await import('../src/services/member-tool-allowlist.js');
    expect(REGISTERED_TOOL_NAMES).toContain('code_reindex');
    expect(REGISTERED_TOOL_NAMES).toContain('code_status');
  });

  it('writes nothing to the real user data dir', () => {
    expect(realCodeIndex()).toEqual(realCodeIndexBefore);
  });

  it('writes only under the sandbox data dir', () => {
    expect(process.env.APRA_FLEET_DATA_DIR).toBe(sandbox.data);
    for (const entry of fs.existsSync(sandbox.data) ? fs.readdirSync(sandbox.data) : []) {
      expect(['code-index', 'logs']).toContain(entry);
    }
  });
});
