import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import { bibleLockPath } from '../../src/services/knowledge/bible-file-lock.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import { commitWorkTree } from '../helpers/commit-work-tree.js';

// The bible write queue across PROCESSES: two server processes committing
// different entries to one bible at the same moment must never both report
// committed: true while one entry is lost; and a lock left by a killed process
// must not block the next writer. The writers are real child processes running
// the BUILT server (tests/fixtures/kb-bible-commit-child.mjs, dist/), each with
// its own KB data dir, against one real git checkout. Everything lives under
// one sandbox removed in afterEach.

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CHILD = path.join(REPO_ROOT, 'tests', 'fixtures', 'kb-bible-commit-child.mjs');
const DIST_MARKER = path.join(REPO_ROOT, 'dist', 'tools', 'kb-bible-commit.js');
const BIBLE_REL = '.fleet/kb-canonical.json';
const BASE = { baseBranch: 'main', baseCommit: 'a'.repeat(40) };

let sandbox: string;
let repo: string;
let gitconfig: string;
let savedGitEnv: Array<[string, string | undefined]>;
const children: ChildProcess[] = [];

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function childEnv(dataDir: string): NodeJS.ProcessEnv {
  return { ...process.env, APRA_FLEET_DATA_DIR: dataDir, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' };
}

/** Run the child to completion and parse its one JSON line. */
function runChild(args: string[], dataDir: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, ...args], { env: childEnv(dataDir), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.push(child);
    let out = '';
    let err = '';
    child.stdout!.on('data', (d) => { out += d; });
    child.stderr!.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error('child ' + args[0] + ' exited ' + code + ': ' + err));
      else {
        try { resolve(JSON.parse(out.trim().split('\n').pop()!)); } catch (e) { reject(new Error('bad child output: ' + out + err)); }
      }
    });
  });
}

function writeSource(name: string): string {
  const rel = 'src/' + name + '.ts';
  fs.writeFileSync(path.join(repo, rel), 'export const ' + name + ' = 1;\n');
  commitWorkTree(repo, 'add ' + name);
  return rel;
}

beforeAll(() => {
  if (!fs.existsSync(DIST_MARKER)) {
    throw new Error('dist/ not built (missing ' + DIST_MARKER + '). Run "npm run build" before "npm test".');
  }
});

beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-xproc-')));
  gitconfig = path.join(sandbox, '.gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = KB Test\n\temail = kb@test.invalid\n[commit]\n\tgpgsign = false\n');
  savedGitEnv = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].map(k => [k, process.env[k]]);
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  repo = path.join(sandbox, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  execFileSync('git', ['init', '--quiet', '-b', 'main', repo]);
  commitWorkTree(repo, 'seed');
});

afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  vi.restoreAllMocks();
  for (const [k, v] of savedGitEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('kb_bible_commit across processes', () => {
  it('two processes committing different entries at once: never committed: true for a lost entry', async () => {
    const dataA = path.join(sandbox, 'data-a');
    const dataB = path.join(sandbox, 'data-b');
    const relA = writeSource('alpha');
    const relB = writeSource('beta');
    const { id: idA } = await runChild(['setup', repo, relA], dataA);
    const { id: idB } = await runChild(['setup', repo, relB], dataB);

    const startAt = String(Date.now() + 1500);
    const [ra, rb] = await Promise.all([
      runChild(['commit', repo, idA, startAt], dataA),
      runChild(['commit', repo, idB, startAt], dataB),
    ]);

    const committedIds = new Set(JSON.parse(git(['show', 'HEAD:' + BIBLE_REL])).entries.map((e: { id: string }) => e.id));
    for (const [r, id] of [[ra, idA], [rb, idB]] as const) {
      expect(r.merged).toEqual([id]);
      if (r.committed) expect(committedIds.has(id), 'committed: true but ' + id + ' is not in the committed bible').toBe(true);
      else expect(typeof r.not_committed_reason).toBe('string');
    }
    // With the lock both land.
    expect([ra.committed, rb.committed]).toEqual([true, true]);
    expect(committedIds).toEqual(new Set([idA, idB]));
    expect(git(['status', '--porcelain'])).toBe('');
    expect(fs.existsSync(bibleLockPath(path.join(repo, BIBLE_REL)))).toBe(false);
  }, 60_000);

  it('a lock left by a killed process is recovered by the next writer', async () => {
    const biblePath = path.join(repo, BIBLE_REL);
    const holder = spawn(process.execPath, [CHILD, 'hold', biblePath], {
      env: childEnv(path.join(sandbox, 'data-hold')), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    children.push(holder);
    const pid = await new Promise<number>((resolve, reject) => {
      let out = '';
      holder.stdout!.on('data', (d) => {
        out += d;
        if (out.includes('\n')) resolve(JSON.parse(out.trim()).held);
      });
      holder.on('exit', (code) => reject(new Error('holder exited early: ' + code)));
    });
    expect(pid).toBe(holder.pid);
    expect(JSON.parse(fs.readFileSync(bibleLockPath(biblePath), 'utf-8')).pid).toBe(pid);
    const exited = new Promise(resolve => holder.once('exit', resolve));
    holder.kill('SIGKILL');
    await exited;
    expect(fs.existsSync(bibleLockPath(biblePath))).toBe(true);

    const provider = new SqliteProvider(path.join(sandbox, 'kb.sqlite'), repo);
    await provider.init();
    try {
      vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
        project: provider, global: provider, projectSlug: 'test',
      } as any);
      const rel = writeSource('gamma');
      const { id } = await provider.capture({
        type: 'knowledge', title: 'gamma is a constant', summary: 'gamma is a plain exported constant.',
        content: 'gamma is a plain exported constant.', source_files: [rel], symbols: ['gamma'],
        tags: [], content_hash: '', content_hash_type: 'sha256', flagged_for_review: false,
        author: 'test-agent', source: 'doer', confidence: 'INFERRED',
      });
      await provider.promote(id, 'test fixture: verified');
      await provider.promote(id, 'test fixture: verified');

      const started = Date.now();
      const r = JSON.parse(await kbBibleCommit({ ids: [id], ...BASE }, { folder: repo }));
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(r.committed).toBe(true);
      expect(r.not_committed_reason).toBeUndefined();
      expect(fs.existsSync(bibleLockPath(biblePath))).toBe(false);
    } finally {
      provider.close();
    }
  }, 60_000);
});
