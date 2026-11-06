import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import { commitWorkTree } from '../helpers/commit-work-tree.js';

// PR 790 judge F5: after a failed local git commit, kb_bible_commit has left
// the bible written but uncommitted. A retry with the same ids finds nothing
// new to merge; it must still commit the pending write (committed: true, clean
// tree), and a call with nothing new over a clean bible still reports
// committed: false. Real git: the first commit is forced to fail by a failing
// pre-commit hook. Everything lives under one sandbox removed in afterEach.

const BASE = { baseBranch: 'main', baseCommit: 'a'.repeat(40) };
const BIBLE_REL = '.fleet/kb-canonical.json';

let sandbox: string;
let repo: string;
let provider: SqliteProvider;
let savedGitEnv: Array<[string, string | undefined]>;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const bibleStatus = () => git(['status', '--porcelain', '--', BIBLE_REL]).trim();
const hookPath = () => path.join(repo, '.git', 'hooks', 'pre-commit');

function failCommits(): void {
  fs.mkdirSync(path.dirname(hookPath()), { recursive: true });
  fs.writeFileSync(hookPath(), '#!/bin/sh\necho "pre-commit: rejected by test" >&2\nexit 1\n', { mode: 0o755 });
}

async function confirmed(name: string): Promise<string> {
  fs.writeFileSync(path.join(repo, 'src', name + '.ts'), 'export const ' + name + ' = 1;\n');
  commitWorkTree(repo, 'add ' + name);
  const { id } = await provider.capture({
    type: 'knowledge', title: name + ' is a constant', summary: name + ' is a plain exported constant.',
    content: name + ' is a plain exported constant.', source_files: ['src/' + name + '.ts'], symbols: [name],
    tags: [], content_hash: '', content_hash_type: 'sha256', flagged_for_review: false,
    author: 'test-agent', source: 'doer', confidence: 'INFERRED',
  });
  await provider.promote(id, 'test fixture: verified');
  await provider.promote(id, 'test fixture: verified');
  return id;
}

beforeEach(async () => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-pending-')));
  const gitconfig = path.join(sandbox, '.gitconfig');
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

afterEach(() => {
  vi.restoreAllMocks();
  provider.close();
  for (const [k, v] of savedGitEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('kb_bible_commit: a retry after a failed local commit commits the pending write (F5)', () => {
  it('first commit fails on a pre-commit hook; the retry returns committed: true and leaves the bible clean', async () => {
    const seeded = await confirmed('alpha');
    expect(JSON.parse(await kbBibleCommit({ ids: [seeded], ...BASE }, { folder: repo })).committed).toBe(true);
    const id = await confirmed('beta');
    const headBefore = git(['rev-parse', 'HEAD']).trim();

    failCommits();
    await expect(kbBibleCommit({ ids: [id], ...BASE }, { folder: repo }))
      .rejects.toThrow(/the local commit failed/);
    expect(bibleStatus()).not.toBe('');
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(headBefore);

    // A retry while the hook still fails reports the failure explicitly.
    await expect(kbBibleCommit({ ids: [id], ...BASE }, { folder: repo }))
      .rejects.toThrow(/pending write from an earlier call and committing it failed again/);

    fs.rmSync(hookPath());
    const r = JSON.parse(await kbBibleCommit({ ids: [id], ...BASE }, { folder: repo }));
    expect(r.merged).toEqual([id]);
    expect(r.committed).toBe(true);
    expect(bibleStatus()).toBe('');
    expect(git(['log', '-1', '--format=%B']).trim()).toMatch(/pending knowledge bible write/);
    const committedIds = JSON.parse(git(['show', 'HEAD:' + BIBLE_REL])).entries.map((e: { id: string }) => e.id).sort();
    expect(committedIds).toEqual([seeded, id].sort());
  });

  it('a call with nothing new over a clean bible still returns committed: false', async () => {
    const id = await confirmed('gamma');
    expect(JSON.parse(await kbBibleCommit({ ids: [id], ...BASE }, { folder: repo })).committed).toBe(true);
    const head = git(['rev-parse', 'HEAD']).trim();
    const again = JSON.parse(await kbBibleCommit({ ids: [id], ...BASE }, { folder: repo }));
    expect(again.committed).toBe(false);
    const empty = JSON.parse(await kbBibleCommit({ ids: [], ...BASE }, { folder: repo }));
    expect(empty.committed).toBe(false);
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(head);
    expect(bibleStatus()).toBe('');
  });
});
