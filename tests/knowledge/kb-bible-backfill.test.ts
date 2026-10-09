import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbBibleCommit, bibleCommitMessage } from '../../src/tools/kb-bible-commit.js';
import { BIBLE_FORMAT_VERSION } from '../../src/tools/kb-export.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// Legacy-bible backfill at kb_bible_commit: an entry carried over from a v2
// bible (no source_file_hashes) gains the STORED basis the maintainer KB holds
// for the same id when that basis passes the bible admission predicate at HEAD
// and the KB entry cites the same files. Id-preserving (only
// source_file_hashes is added), never drops an entry, counts as a change (one
// commit, current format version) and is idempotent.

const BIBLE_REL = '.fleet/kb-canonical.json';
const REASON = 'confirmed for test: basis verified in fixture';
const BASE = { baseBranch: 'main', baseCommit: '0123456789abcdef0123456789abcdef01234567' };

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.local', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Default title',
    summary: 'Default summary',
    content: 'Default content body.',
    source_files: ['src/a.ts'],
    symbols: [],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'test-agent',
    source: 'doer',
    confidence: 'INFERRED',
    ...overrides,
  };
}

let tmpDir: string;
let provider: SqliteProvider;

const biblePath = () => path.join(tmpDir, BIBLE_REL);
const readBible = () => JSON.parse(fs.readFileSync(biblePath(), 'utf-8'));
const commitCount = () => Number(git(tmpDir, ['rev-list', '--count', 'HEAD']).trim());
const byId = (bible: { entries: Array<{ id: string }> }, id: string) => bible.entries.find(e => e.id === id) as any;

function writeSrc(rel: string, body = rel): void {
  fs.mkdirSync(path.dirname(path.join(tmpDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, rel), 'export const x = ' + JSON.stringify(body) + ';\n');
}

/** A v2 bible entry (no source_file_hashes) as an older writer produced it. */
function legacyEntry(id: string, title: string, files: string[]): Record<string, unknown> {
  return {
    id, type: 'knowledge', title, summary: 'Bible text of ' + title, symbols: [],
    source_files: files, confidence: 'CONFIRMED', updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function writeV2Bible(entries: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(biblePath()), { recursive: true });
  fs.writeFileSync(biblePath(), JSON.stringify({
    version: 2, provenance: { commit: null, branch: null, entry_count: entries.length }, entries,
  }, null, 2) + '\n');
}

async function confirmed(title: string, files: string[]): Promise<string> {
  const { id } = await provider.capture(makeInput({ title, summary: 'KB text of ' + title, source_files: files }));
  await provider.promote(id, REASON);
  return id;
}

async function commitBible(): Promise<any> {
  return JSON.parse(await kbBibleCommit({ ids: [], ...BASE }, { folder: tmpDir }));
}

let tmpBefore: string[];
const tmpListing = () => fs.readdirSync(os.tmpdir()).filter(n => !n.startsWith('kb-bible-backfill-')).sort();

beforeEach(async () => {
  tmpBefore = tmpListing();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-backfill-'));
  git(tmpDir, ['init', '--quiet']);
  writeSrc('src/a.ts');
  writeSrc('src/b.ts');
  writeSrc('src/c.ts');
  git(tmpDir, ['add', '-A']);
  git(tmpDir, ['commit', '-m', 'seed', '--quiet']);

  provider = new SqliteProvider(':memory:', tmpDir);
  await provider.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider, global: provider, projectSlug: 'test',
  } as any);
});

afterEach(() => {
  provider.close();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Nothing left behind outside the fixture's own temp dir.
  expect(tmpListing()).toEqual(tmpBefore);
});

describe('kb_bible_commit legacy backfill', () => {
  it('attaches the stored basis to exactly the KB-held, HEAD-matching legacy entries; ids, count and text unchanged; one commit', async () => {
    // K = 2 legacy entries the KB holds with a basis matching HEAD.
    const k1 = await confirmed('Claim one', ['src/a.ts']);
    const k2 = await confirmed('Claim two', ['src/b.ts', 'src/a.ts']);
    // One the KB holds, but whose cited file changed after its basis was stored.
    const drifted = await confirmed('Drifted claim', ['src/c.ts']);
    // One the KB holds with a different source_files set than the bible entry.
    const otherFiles = await confirmed('Different files', ['src/a.ts', 'src/c.ts']);
    writeSrc('src/c.ts', 'changed after capture');
    // N = 5 legacy entries; one the KB does not hold at all.
    const legacy = [
      legacyEntry(k1, 'Claim one', ['src/a.ts']),
      legacyEntry(k2, 'Claim two', ['src/a.ts', 'src/b.ts']),
      legacyEntry(drifted, 'Drifted claim', ['src/c.ts']),
      legacyEntry(otherFiles, 'Different files', ['src/a.ts']),
      legacyEntry('zz-not-in-kb', 'Unknown to this KB', ['src/a.ts']),
    ];
    writeV2Bible(legacy);
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'v2 bible and the drifted file', '--quiet']);
    const before = commitCount();

    const res = await commitBible();

    expect(res.backfilled).toBe(2);
    expect(res.committed).toBe(true);
    expect(res.merged).toEqual([]);
    expect(res.removed).toEqual([]);
    const bible = readBible();
    expect(bible.version).toBe(BIBLE_FORMAT_VERSION);
    expect(bible.entries.map((e: { id: string }) => e.id).sort()).toEqual(legacy.map(e => e.id as string).sort());
    expect(bible.provenance.entry_count).toBe(legacy.length);
    const withHashes = bible.entries.filter((e: Record<string, unknown>) => e.source_file_hashes).map((e: { id: string }) => e.id).sort();
    expect(withHashes).toEqual([k1, k2].sort());
    const bases = provider.getSourceFileBases([k1, k2]);
    for (const id of [k1, k2]) {
      const written = byId(bible, id);
      expect(written.source_file_hashes).toEqual(bases.get(id));
      // Only source_file_hashes was added: the bible text is kept, not the KB text.
      const { source_file_hashes: _h, ...rest } = written;
      expect(rest).toEqual(legacy.find(e => e.id === id));
    }
    expect(commitCount()).toBe(before + 1);
    expect(git(tmpDir, ['log', '-1', '--format=%B'])).toContain('backfill source_file_hashes on 2 knowledge bible entries');
  });

  it('an entry whose cited file changed after its basis was stored keeps no hashes and is still present', async () => {
    const drifted = await confirmed('Drifted claim', ['src/c.ts']);
    const k1 = await confirmed('Claim one', ['src/a.ts']);
    writeSrc('src/c.ts', 'changed after capture');
    writeV2Bible([legacyEntry(drifted, 'Drifted claim', ['src/c.ts']), legacyEntry(k1, 'Claim one', ['src/a.ts'])]);
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'drift', '--quiet']);

    const res = await commitBible();

    expect(res.backfilled).toBe(1);
    const entry = byId(readBible(), drifted);
    expect(entry).toBeDefined();
    expect(entry.source_file_hashes).toBeUndefined();
  });

  it('a second call right after reports 0 backfilled and makes no commit (idempotent)', async () => {
    const k1 = await confirmed('Claim one', ['src/a.ts']);
    writeV2Bible([legacyEntry(k1, 'Claim one', ['src/a.ts'])]);
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'v2 bible', '--quiet']);

    const first = await commitBible();
    expect(first.backfilled).toBe(1);
    expect(first.committed).toBe(true);
    const afterFirst = commitCount();
    const bytes = fs.readFileSync(biblePath(), 'utf-8');

    const second = await commitBible();

    expect(second.backfilled).toBe(0);
    expect(second.committed).toBe(false);
    expect(commitCount()).toBe(afterFirst);
    expect(fs.readFileSync(biblePath(), 'utf-8')).toBe(bytes);
  });

  it('nothing to backfill (no KB-held legacy entry): no write, no commit, backfilled 0', async () => {
    writeV2Bible([legacyEntry('zz-not-in-kb', 'Unknown', ['src/a.ts'])]);
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'v2 bible', '--quiet']);
    const before = commitCount();
    const bytes = fs.readFileSync(biblePath(), 'utf-8');

    const res = await commitBible();

    expect(res).toMatchObject({ backfilled: 0, committed: false, entry_count: 1 });
    expect(commitCount()).toBe(before);
    expect(fs.readFileSync(biblePath(), 'utf-8')).toBe(bytes);
  });

  it('a backfill alongside a merge is reported in the same commit', async () => {
    const k1 = await confirmed('Claim one', ['src/a.ts']);
    const fresh = await confirmed('Fresh claim', ['src/b.ts']);
    writeV2Bible([legacyEntry(k1, 'Claim one', ['src/a.ts'])]);
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'v2 bible', '--quiet']);

    const res = JSON.parse(await kbBibleCommit({ ids: [fresh], ...BASE }, { folder: tmpDir }));

    expect(res).toMatchObject({ merged: [fresh], backfilled: 1, committed: true, entry_count: 2 });
    const msg = git(tmpDir, ['log', '-1', '--format=%B']);
    expect(msg).toContain('commit 1 confirmed entries to the knowledge bible');
    expect(msg).toContain('Backfilled source_file_hashes on 1 existing entries.');
  });
});

describe('bibleCommitMessage with a backfill count', () => {
  it('keeps the pre-existing messages when nothing was backfilled', () => {
    expect(bibleCommitMessage(2, [], 5)).toBe('chore(kb): commit 2 confirmed entries to the knowledge bible -- 5 total');
    expect(bibleCommitMessage(0, [{ id: 'x', reason: 'superseded' }], 4, 0))
      .toBe('chore(kb): remove 1 superseded/invalidated entries from the knowledge bible -- 4 total\n\nRemoved:\n- x (superseded)');
  });

  it('a backfill-only commit has its own subject; with removals the count follows the removal list', () => {
    expect(bibleCommitMessage(0, [], 7, 3)).toBe('chore(kb): backfill source_file_hashes on 3 knowledge bible entries -- 7 total');
    expect(bibleCommitMessage(0, [{ id: 'x', reason: 'invalidated' }], 6, 2)).toBe(
      'chore(kb): remove 1 superseded/invalidated entries from the knowledge bible -- 6 total\n\nRemoved:\n- x (invalidated)'
      + '\n\nBackfilled source_file_hashes on 2 existing entries.');
  });
});
