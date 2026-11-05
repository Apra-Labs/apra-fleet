import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import { kbDemote } from '../../src/tools/kb-demote.js';
import { bibleLockPath } from '../../src/services/knowledge/bible-file-lock.js';
import { FLEET_DIR } from '../../src/paths.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import { commitWorkTree } from '../helpers/commit-work-tree.js';

// Integration test for the kb_bible_commit fixes of PR 790's follow-up lane,
// run in ONE temp git repository with one bible, step after step:
//   1. demote then re-promote from a poorer row keeps content and cues (F1);
//   2. a re-merge over a prior bible value holding a secret shape scrubs it (F6);
//   3. a first commit forced to fail, then a retry, commits and leaves git clean (F5);
//   4. two server processes writing at once: both entries land, or the loser
//      reports committed: false -- never committed: true for a lost entry.
// Every assertion reads the bible back from disk or from git HEAD. All files
// live under one sandbox; the user's KB data dir is checked untouched.

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CHILD = path.join(REPO_ROOT, 'tests', 'fixtures', 'kb-bible-commit-child.mjs');
const DIST_MARKER = path.join(REPO_ROOT, 'dist', 'tools', 'kb-bible-commit.js');
const BIBLE_REL = '.fleet/kb-canonical.json';
const BASE = { baseBranch: 'main', baseCommit: 'a'.repeat(40) };
const RICH_CONTENT = 'The module loader evaluates alpha lazily, so a direct import of beta from a test '
  + 'file reaches the getter before alpha has initialised; import alpha first in the test setup.';
const RICH_CUES = ['why does beta throw at load', 'beta ReferenceError in tests'];
// Built by concatenation: no token-shaped literal lives in this repository.
const SECRET = 'npm' + '_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

let sandbox: string;
let repo: string;
let gitconfig: string;
let provider: SqliteProvider;
let savedGitEnv: Array<[string, string | undefined]>;
let userKbBefore: string[];
let richId: string;

const userKbListing = (): string[] => {
  const dir = path.join(FLEET_DIR, 'knowledge');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
};
const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
const biblePath = () => path.join(repo, BIBLE_REL);
const headBible = () => JSON.parse(git(['show', 'HEAD:' + BIBLE_REL]));
const headEntry = (id: string) => headBible().entries.find((e: { id: string }) => e.id === id);
const hookPath = () => path.join(repo, '.git', 'hooks', 'pre-commit');

function writeSource(name: string): string {
  const rel = 'src/' + name + '.ts';
  fs.writeFileSync(path.join(repo, rel), 'export const ' + name + ' = 1;\n');
  commitWorkTree(repo, 'add ' + name);
  return rel;
}

async function confirmed(name: string, summary: string): Promise<string> {
  const rel = writeSource(name);
  const { id } = await provider.capture({
    type: 'learning', title: name + ' lesson title', summary, content: summary,
    source_files: [rel], symbols: [name], tags: [], content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: false, author: 'test-agent', source: 'doer', confidence: 'INFERRED',
  });
  await provider.promote(id, 'test fixture: verified');
  await provider.promote(id, 'test fixture: verified');
  return id;
}

function runChild(args: string[], dataDir: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, ...args], {
      env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout!.on('data', (d) => { out += d; });
    child.stderr!.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error('child ' + args[0] + ' exited ' + code + ': ' + err));
      else {
        try { resolve(JSON.parse(out.trim().split('\n').pop()!)); } catch { reject(new Error('bad child output: ' + out + err)); }
      }
    });
  });
}

beforeAll(async () => {
  if (!fs.existsSync(DIST_MARKER)) {
    throw new Error('dist/ not built (missing ' + DIST_MARKER + '). Run "npm run build" before "npm test".');
  }
  userKbBefore = userKbListing();
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-lane-')));
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
  provider = new SqliteProvider(path.join(sandbox, 'kb.sqlite'), repo);
  await provider.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider, global: provider, projectSlug: 'test',
  } as any);
});

afterAll(() => {
  vi.restoreAllMocks();
  provider?.close();
  for (const [k, v] of savedGitEnv ?? []) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('kb_bible_commit lane integration, one repo', () => {
  it('1. demote then re-promote from a poorer row: the entry keeps its original content and cues', async () => {
    richId = await confirmed('alpha', 'alpha must be read before beta, or beta throws a ReferenceError at load.');
    await kbBibleCommit({ ids: [richId], ...BASE }, { folder: repo });
    const enriched = JSON.parse(await kbBibleCommit({
      ids: [], ...BASE, enrich: [{ id: richId, content: RICH_CONTENT, recall_cues: RICH_CUES }],
    }, { folder: repo }));
    expect(enriched.enriched).toEqual([richId]);

    await kbDemote({ id: richId, reason: 'the cited behaviour did not hold on the case checked', evidence_files: ['README.md'] }, { folder: repo });
    expect(JSON.parse(await kbBibleCommit({ ids: [], demoted_ids: [richId], ...BASE }, { folder: repo })).demoted).toEqual([richId]);
    expect(headEntry(richId)).toBeUndefined();

    // The re-promoting clone's row is poorer: no content beyond the summary, no cues.
    (provider as any).getDb()
      .prepare("UPDATE entries SET content = summary, recall_cues = '[]', error_signatures = '[]' WHERE id = ?")
      .run(richId);
    await provider.promote(richId, 'test fixture: re-verified on newer evidence');
    const r = JSON.parse(await kbBibleCommit({ ids: [richId], ...BASE }, { folder: repo }));
    expect(r.merged).toEqual([richId]);
    expect(r.committed).toBe(true);
    expect(headEntry(richId).content).toBe(RICH_CONTENT);
    expect(headEntry(richId).recall_cues).toEqual(RICH_CUES);
  });

  it('2. a re-merge over a prior bible value holding a secret shape leaves no secret in the committed bible', async () => {
    const doc = JSON.parse(fs.readFileSync(biblePath(), 'utf-8'));
    const entry = doc.entries.find((e: { id: string }) => e.id === richId);
    entry.content = RICH_CONTENT + ' The old setup sent ' + SECRET + ' with it.';
    entry.recall_cues = [...RICH_CUES, 'token ' + SECRET];
    fs.writeFileSync(biblePath(), JSON.stringify(doc, null, 2) + '\n');
    commitWorkTree(repo, 'an older writer left a secret in the bible');
    expect(git(['show', 'HEAD:' + BIBLE_REL])).toContain(SECRET);

    const r = JSON.parse(await kbBibleCommit({ ids: [richId], ...BASE }, { folder: repo }));
    expect(r.committed).toBe(true);
    expect(git(['show', 'HEAD:' + BIBLE_REL])).not.toContain(SECRET);
    expect(fs.readFileSync(biblePath(), 'utf-8')).not.toContain(SECRET);
    expect(headEntry(richId).content).toContain('[REDACTED]');
  });

  it('3. a first commit forced to fail, then a retry: committed is true and git status is clean', async () => {
    const id = await confirmed('gamma', 'gamma is a plain exported constant with no lesson body.');
    fs.writeFileSync(hookPath(), '#!/bin/sh\necho "pre-commit: rejected by test" >&2\nexit 1\n', { mode: 0o755 });
    await expect(kbBibleCommit({ ids: [id], ...BASE }, { folder: repo })).rejects.toThrow(/local commit failed/);
    expect(git(['status', '--porcelain', '--', BIBLE_REL]).trim()).not.toBe('');
    fs.rmSync(hookPath());

    const r = JSON.parse(await kbBibleCommit({ ids: [id], ...BASE }, { folder: repo }));
    expect(r.committed).toBe(true);
    expect(git(['status', '--porcelain'])).toBe('');
    expect(headEntry(id)).toBeDefined();
  });

  it('4. two processes writing at once: both entries are present, or the loser reported committed: false', async () => {
    const dataA = path.join(sandbox, 'data-a');
    const dataB = path.join(sandbox, 'data-b');
    const relA = writeSource('delta');
    const relB = writeSource('epsilon');
    const { id: idA } = await runChild(['setup', repo, relA], dataA);
    const { id: idB } = await runChild(['setup', repo, relB], dataB);

    const startAt = String(Date.now() + 1500);
    const results = await Promise.all([
      runChild(['commit', repo, idA, startAt], dataA),
      runChild(['commit', repo, idB, startAt], dataB),
    ]);
    const committedIds = new Set(headBible().entries.map((e: { id: string }) => e.id));
    const pairs: Array<[any, string]> = [[results[0], idA], [results[1], idB]];
    for (const [r, id] of pairs) {
      if (r.committed) expect(committedIds.has(id), 'committed: true but ' + id + ' was lost').toBe(true);
      else expect(r.not_committed_reason).toMatch(/another writer/);
    }
    expect(committedIds.has(idA) || pairs[0][0].committed === false).toBe(true);
    expect(committedIds.has(idB) || pairs[1][0].committed === false).toBe(true);
    // The earlier steps' entries survived the concurrent round.
    expect(committedIds.has(richId)).toBe(true);
  }, 60_000);

  it('5. nothing is left outside the sandbox and no lock or stray file inside the checkout', () => {
    expect(fs.existsSync(bibleLockPath(biblePath()))).toBe(false);
    expect(git(['status', '--porcelain', '--untracked-files=all'])).toBe('');
    expect(userKbListing()).toEqual(userKbBefore);
  });
});
