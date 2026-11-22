import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import { releaseFileDataDir } from '../helpers/file-kb-data-dir.js';

// kb_bible_commit builds the new bible from the bible COMMITTED at HEAD, never
// from the work-tree .fleet/kb-canonical.json, and records as trusted only the
// blob it committed. A doer sharing the maintainer folder could otherwise
// hand-edit the work-tree bible before the call and have the edit merged,
// committed and trusted without review. Real temp git repo, real SqliteProvider.
//
// FALSIFICATION: making kbBibleCommit read its base from the work-tree file
// again (readBibleDocument(outPath)) puts the fake entry in the committed
// bible; recording the blob of the written bytes regardless of the commit
// records a blob when nothing was committed.

const fileDataDir = await vi.hoisted(async () =>
  (await import('../helpers/file-kb-data-dir.js')).claimFileDataDir('kb-bible-commit-worktree-drift'));
afterAll(() => releaseFileDataDir(fileDataDir));

const BIBLE_REL = '.fleet/kb-canonical.json';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let root: string;
let clone: string;
let provider: SqliteProvider;

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge', title: 'Default title', summary: 'Default summary', content: 'Default content body.',
    source_files: ['src/a.ts'], symbols: ['defaultSymbol'], tags: [], content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: false, author: 'test-agent', source: 'doer', confidence: 'INFERRED', ...overrides,
  };
}

async function confirmed(title: string): Promise<string> {
  const { id } = await provider.capture(makeInput({ title, summary: 'Summary of ' + title, symbols: ['sym' + title] }));
  await provider.promote(id, 'test fixture: verified');
  await provider.promote(id, 'test fixture: verified');
  return id;
}

const FAKE = {
  id: 'kb-fake-hand-edit', type: 'knowledge', title: 'Hand-made claim', summary: 'never reviewed',
  symbols: [], source_files: ['src/a.ts'], confidence: 'CONFIRMED', updated_at: '2026-01-01T00:00:00.000Z',
};

function bibleAt(ref: string): { entries: { id: string }[] } {
  return JSON.parse(git(clone, ['show', ref + ':' + BIBLE_REL]));
}

/** Add the fake CONFIRMED entry to the work-tree bible only (never committed). */
function handEditWorkTreeBible(): void {
  const p = path.join(clone, BIBLE_REL);
  const doc = JSON.parse(fs.readFileSync(p, 'utf-8'));
  doc.entries.push(FAKE);
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
}

function trustedBlobs(): string[] {
  return ((provider as any).getDb().prepare('SELECT blob_id FROM trusted_bible_blobs ORDER BY blob_id').all() as { blob_id: string }[])
    .map(r => r.blob_id);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-commit-drift-'));
  clone = path.join(root, 'clone');
  fs.mkdirSync(clone);
  git(clone, ['init', '--quiet', '-b', 'main']);
  git(clone, ['config', 'user.name', 'test']);
  git(clone, ['config', 'user.email', 'test@example.invalid']);
  git(clone, ['config', 'commit.gpgsign', 'false']);
  fs.mkdirSync(path.join(clone, 'src'), { recursive: true });
  fs.writeFileSync(path.join(clone, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.mkdirSync(path.join(clone, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(clone, BIBLE_REL), JSON.stringify({
    version: 3, provenance: { branch: 'main' },
    entries: [{ id: 'kb-existing-1', type: 'knowledge', title: 'Existing', summary: 's', symbols: [],
      source_files: ['src/a.ts'], confidence: 'CONFIRMED', updated_at: '2026-01-01T00:00:00.000Z' }],
  }, null, 2) + '\n');
  git(clone, ['add', '-A']);
  git(clone, ['commit', '--quiet', '-m', 'seed']);

  provider = new SqliteProvider(path.join(root, 'kb.sqlite'), clone);
  await provider.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider, global: provider, projectSlug: 'test',
  } as any);
});

afterEach(() => {
  provider.close();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('kb_bible_commit ignores a hand-edited work-tree bible', () => {
  it('a fake CONFIRMED entry added to the work-tree bible never reaches the committed bible', async () => {
    const real = await confirmed('Real queued claim');
    handEditWorkTreeBible();
    const before = git(clone, ['rev-parse', 'HEAD']);

    const r = JSON.parse(await kbBibleCommit({ ids: [real], baseBranch: 'main', baseCommit: before }, { folder: clone }));
    expect(r.committed).toBe(true);
    expect(r.merged).toEqual([real]);

    const committedIds = bibleAt('HEAD').entries.map(e => e.id);
    expect(committedIds).toEqual(['kb-existing-1', real].sort());
    expect(committedIds).not.toContain(FAKE.id);
    // The work-tree file was overwritten with exactly what was committed.
    expect(fs.readFileSync(path.join(clone, BIBLE_REL), 'utf-8')).toBe(git(clone, ['show', 'HEAD:' + BIBLE_REL]) + '\n');
    expect(git(clone, ['status', '--porcelain', '--', BIBLE_REL])).toBe('');
  });

  it('the trusted blob recorded is git\'s blob id of the committed bible at the new HEAD', async () => {
    const real = await confirmed('Trusted claim');
    handEditWorkTreeBible();
    // The hand-edited bytes' blob id, as git would store them.
    const editedBlob = git(clone, ['hash-object', '--no-filters', BIBLE_REL]);
    expect(trustedBlobs()).toEqual([]);

    const r = JSON.parse(await kbBibleCommit(
      { ids: [real], baseBranch: 'main', baseCommit: git(clone, ['rev-parse', 'HEAD']) }, { folder: clone },
    ));
    expect(r.committed).toBe(true);

    const headBlob = git(clone, ['rev-parse', 'HEAD:' + BIBLE_REL]);
    expect(trustedBlobs()).toEqual([headBlob]);
    expect(provider.isTrustedBibleBlob(editedBlob)).toBe(false);
  });

  it('records no trusted blob when the call commits nothing, even with a hand-edited work tree', async () => {
    handEditWorkTreeBible();
    const before = git(clone, ['rev-parse', 'HEAD']);
    // An id that is not in the KB: nothing to merge, nothing to commit.
    const r = JSON.parse(await kbBibleCommit({ ids: ['kb-unknown'], baseBranch: 'main', baseCommit: before }, { folder: clone }));
    expect(r.committed).toBe(false);
    expect(r.skipped).toEqual([{ id: 'kb-unknown', reason: 'not_confirmed_or_unknown' }]);
    expect(git(clone, ['rev-parse', 'HEAD'])).toBe(before);
    expect(trustedBlobs()).toEqual([]);
  });
});
