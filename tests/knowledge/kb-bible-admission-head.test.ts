import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import { kbExport } from '../../src/tools/kb-export.js';
import { computeFileHashBatch, computeHeadFileHashBatch, KbHeadHashError } from '../../src/services/knowledge/file-hash.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// Bible admission (kb_export scope=project and kb_bible_commit) compares each
// stored basis with the cited file's content at the work tree's HEAD commit,
// never the file on disk. An uncommitted edit must not flip the verdict either
// way, the digest must equal the one capture stored, and a folder that is not
// a git work tree is refused with a typed error rather than hashed from disk.
//
// FALSIFICATION: pointing filterProjectBibleCandidates back at
// computeFileHashBatch (on-disk hashing) makes both dirty-tree cases fail: the
// entry matching HEAD is skipped (its file is dirty on disk) and the entry
// matching only the dirty edit is admitted.
//
// Every repo lives under one temp root removed in afterEach.

const BASE = { baseBranch: 'main', baseCommit: 'b'.repeat(40) };

let root: string;
let repo: string;
let provider: SqliteProvider;

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.local', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), body);
}

function commitAll(msg: string): void {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '--no-verify', '--allow-empty', '-m', msg]);
}

async function confirmedCiting(title: string, files: string[]): Promise<string> {
  const input: KBEntryInput = {
    type: 'knowledge', title, summary: 'Summary of ' + title, content: 'Content of ' + title,
    source_files: files, symbols: ['sym' + title.replace(/\W/g, '')], tags: [], content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: false, author: 'test', source: 'doer', confidence: 'INFERRED',
  };
  const { id } = await provider.capture(input);
  await provider.promote(id, 'test fixture: verified');
  await provider.promote(id, 'test fixture: verified');
  return id;
}

function bibleIds(): string[] {
  const p = path.join(repo, '.fleet', 'kb-canonical.json');
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf-8')).entries.map((e: { id: string }) => e.id).sort();
}

/**
 * clean: captured on a clean tree, then its file is edited WITHOUT committing
 * (HEAD still matches the basis). dirtyOnly: captured against an uncommitted
 * edit (the basis matches only the dirty file, never HEAD).
 */
async function seedDirtyTree(): Promise<{ clean: string; dirtyOnly: string }> {
  write('src/clean.ts', 'export const clean = 1;\n');
  write('src/dirty.ts', 'export const dirty = 1;\n');
  commitAll('seed sources');
  const clean = await confirmedCiting('Clean capture', ['src/clean.ts']);
  write('src/dirty.ts', 'export const dirty = 2; // uncommitted\n');
  const dirtyOnly = await confirmedCiting('Dirty-only capture', ['src/dirty.ts']);
  write('src/clean.ts', 'export const clean = 2; // uncommitted\n');
  return { clean, dirtyOnly };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-admission-head-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '--quiet', '-b', 'main']);
  provider = new SqliteProvider(path.join(root, 'kb.sqlite'), repo);
  await provider.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider, global: provider, projectSlug: 'test',
  } as any);
});

afterEach(() => {
  provider.close();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('bible admission reads cited files at HEAD, not the work tree', () => {
  it('kb_bible_commit: a dirty edit does not change the verdict', async () => {
    const { clean, dirtyOnly } = await seedDirtyTree();

    const r = JSON.parse(await kbBibleCommit({ ids: [clean, dirtyOnly], ...BASE }, { folder: repo }));

    expect(r.merged).toEqual([clean]);
    expect(r.skipped).toEqual([{ id: dirtyOnly, reason: 'basis_mismatch' }]);
    expect(bibleIds()).toEqual([clean]);
    // The work tree is left as it was: the dirty edits are still uncommitted.
    expect(git(repo, ['status', '--porcelain', '--', 'src']).trimEnd().split('\n').sort())
      .toEqual([' M src/clean.ts', ' M src/dirty.ts']);
  });

  it('kb_export: a dirty edit does not change the verdict', async () => {
    const { clean, dirtyOnly } = await seedDirtyTree();

    await kbExport({}, { folder: repo });

    expect(bibleIds()).toEqual([clean]);
    expect(bibleIds()).not.toContain(dirtyOnly);
  });

  it('committing the edit flips the verdict: the dirty-only entry is admitted, the clean one is not', async () => {
    const { clean, dirtyOnly } = await seedDirtyTree();
    commitAll('commit the edits');

    const r = JSON.parse(await kbBibleCommit({ ids: [clean, dirtyOnly], ...BASE }, { folder: repo }));

    expect(r.merged).toEqual([dirtyOnly]);
    expect(r.skipped).toEqual([{ id: clean, reason: 'basis_mismatch' }]);
  });

  it('a file absent at HEAD (untracked) is a mismatch even though it exists on disk', async () => {
    commitAll('empty seed');
    write('src/untracked.ts', 'export const u = 1;\n');
    const id = await confirmedCiting('Untracked', ['src/untracked.ts']);

    const r = JSON.parse(await kbBibleCommit({ ids: [id], ...BASE }, { folder: repo }));

    expect(r.merged).toEqual([]);
    expect(r.skipped).toEqual([{ id, reason: 'basis_mismatch' }]);
  });
});

describe('HEAD digest equals the stored basis digest', () => {
  it('an entry captured on a clean tree has a basis equal to the HEAD blob ids, and is admitted', async () => {
    write('src/a.ts', 'export const a = 1;\n');
    write('nested/dir/b.ts', 'export const b = 1;\r\n');
    commitAll('seed');
    const id = await confirmedCiting('Clean', ['src/a.ts', 'nested/dir/b.ts']);

    const basis = provider.getSourceFileBases([id]).get(id)!;
    const head = await computeHeadFileHashBatch(['src/a.ts', 'nested/dir/b.ts'], { cwd: repo });
    expect(head['src/a.ts']?.hash).toBe(basis['src/a.ts']);
    expect(head['nested/dir/b.ts']?.hash).toBe(basis['nested/dir/b.ts']);
    expect(head['src/a.ts']?.hash).toBe(git(repo, ['rev-parse', 'HEAD:src/a.ts']).trim());

    const r = JSON.parse(await kbBibleCommit({ ids: [id], ...BASE }, { folder: repo }));
    expect(r.merged).toEqual([id]);
  });

  it('computeHeadFileHashBatch resolves paths relative to a subdirectory cwd, like computeFileHashBatch', async () => {
    write('pkg/src/x.ts', 'export const x = 1;\n');
    commitAll('seed');
    const cwd = path.join(repo, 'pkg');

    const head = await computeHeadFileHashBatch(['src/x.ts', 'src/missing.ts'], { cwd });
    const disk = await computeFileHashBatch(['src/x.ts'], { cwd });

    expect(head['src/x.ts']?.hash).toBe(disk['src/x.ts']?.hash);
    expect(head['src/missing.ts']).toBeNull();
  });

  it('an unborn HEAD maps every file to null (nothing is committed)', async () => {
    write('src/a.ts', 'export const a = 1;\n');
    const head = await computeHeadFileHashBatch(['src/a.ts'], { cwd: repo });
    expect(head).toEqual({ 'src/a.ts': null });
  });
});

describe('a folder that is not a git work tree is refused, never hashed from disk', () => {
  it('kb_bible_commit and kb_export throw KbHeadHashError (E-BIBLE-BASIS-NOT-GIT) and write nothing', async () => {
    write('src/a.ts', 'export const a = 1;\n');
    const id = await confirmedCiting('No git', ['src/a.ts']);
    fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true });

    const commitErr = await kbBibleCommit({ ids: [id], ...BASE }, { folder: repo }).catch(e => e);
    expect(commitErr).toBeInstanceOf(KbHeadHashError);
    expect(commitErr.code).toBe('E-BIBLE-BASIS-NOT-GIT');
    expect(String(commitErr.message)).toMatch(/Remediation:/);

    await expect(kbExport({}, { folder: repo })).rejects.toBeInstanceOf(KbHeadHashError);
    expect(fs.existsSync(path.join(repo, '.fleet', 'kb-canonical.json'))).toBe(false);
  });

  it('computeHeadFileHashBatch throws even for an empty list outside git', async () => {
    const plain = fs.mkdtempSync(path.join(root, 'plain-'));
    await expect(computeHeadFileHashBatch([], { cwd: plain })).rejects.toMatchObject({ code: 'E-BIBLE-BASIS-NOT-GIT' });
  });
});
