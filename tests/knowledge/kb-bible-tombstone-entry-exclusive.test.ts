import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import { commitWorkTree } from '../helpers/commit-work-tree.js';

// kb_bible_commit keeps bible entries and tombstones EXCLUSIVE, end to end
// against a REAL temp git repository, a REAL SqliteProvider and the REAL
// handler. The only vi.spyOn points getKbProviders at this test's provider
// (the seam tests/knowledge/kb-bible-withdrawn-precedence.test.ts uses). Every
// assertion about the bible reads the file back from disk.
//
// FALSIFICATION (checked): with the change reverted in
// src/tools/kb-bible-commit.ts (no demoted-tombstone gate on ids, no
// exclusivity heal), the stale-trust test and the null-trust test fail -- the
// id is merged and its tombstone cleared instead of skipped demoted_tombstone
// -- and the heal test fails because removed lacks {id, reason: tombstoned}
// and the entry stays next to its tombstone. The re-promotion test and the
// repo-bible test pass either way (they guard behaviour that must not change).
//
// All temp repos live under one root removed in afterEach. ASCII only.

const BIBLE_REL = '.fleet/kb-canonical.json';
const PAST = '2000-01-01T00:00:00.000Z';
const A098 = 'a098caf8-263f-4b72-b5a7-55fc3d290a07';

interface Tombstone { id: string; at: string; reason: string }
interface BibleFile {
  version?: number;
  provenance?: { commit: string | null; branch: string | null; entry_count: number };
  entries: Array<{ id: string } & Record<string, unknown>>;
  demotions?: Tombstone[];
}

let root: string;
let clone: string;
let provider: SqliteProvider;

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function head(): string { return git(clone, ['rev-parse', 'HEAD']).trim(); }
function base(commit: string) { return { baseBranch: 'main', baseCommit: commit }; }
function biblePath(): string { return path.join(clone, BIBLE_REL); }
function readBible(): BibleFile { return JSON.parse(fs.readFileSync(biblePath(), 'utf-8')) as BibleFile; }

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge', title: 'T', summary: 'Summary', content: 'Content body.',
    source_files: ['src/a.ts'], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: false, author: 'test-agent', source: 'doer', confidence: 'INFERRED',
    ...overrides,
  };
}

async function confirmedCiting(title: string, file: string): Promise<string> {
  fs.mkdirSync(path.dirname(path.join(clone, file)), { recursive: true });
  fs.writeFileSync(path.join(clone, file), 'export const ' + title.toLowerCase() + ' = 1;\n');
  commitWorkTree(clone);
  const { id } = await provider.capture(makeInput({
    title, summary: 'Summary of ' + title, symbols: ['sym' + title], source_files: [file],
  }));
  await provider.promote(id, 'test fixture: verified');
  await provider.promote(id, 'test fixture: verified');
  return id;
}

function commitBibleFile(msg: string): void {
  git(clone, ['add', BIBLE_REL]);
  git(clone, ['commit', '--quiet', '-m', msg]);
}

/** Entry for `id` taken from a normal commit, then the file rewritten with a hand-made tombstone. */
async function bibleWithTombstone(id: string, tombstone: Tombstone, keepEntry: boolean): Promise<string> {
  await kbBibleCommit({ ids: [id], ...base(head()) }, { folder: clone });
  const doc = readBible();
  if (!keepEntry) {
    doc.entries = doc.entries.filter(e => e.id !== id);
    doc.provenance!.entry_count = doc.entries.length;
  }
  doc.demotions = [tombstone];
  fs.writeFileSync(biblePath(), JSON.stringify(doc, null, 2) + '\n');
  commitBibleFile('bible with tombstone');
  return head();
}

function expectDisjoint(): void {
  const doc = readBible();
  const entryIds = new Set(doc.entries.map(e => e.id));
  for (const d of doc.demotions ?? []) expect(entryIds.has(d.id)).toBe(false);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-exclusive-'));
  const origin = path.join(root, 'origin.git');
  clone = path.join(root, 'clone');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, clone], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(clone, ['config', 'user.name', 'test']);
  git(clone, ['config', 'user.email', 'test@example.invalid']);
  git(clone, ['config', 'commit.gpgsign', 'false']);
  git(clone, ['checkout', '--quiet', '-B', 'main']);
  fs.writeFileSync(path.join(clone, 'README.md'), 'seed\n');
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

describe('kb_bible_commit: ids merge gated by a demoted tombstone (sqlite)', () => {
  it('skips demoted_tombstone when the local trust time is at or before the tombstone', async () => {
    const id = await confirmedCiting('Alpha', 'src/alpha.ts');
    // at == the row's trust time: the boundary (not strictly after) stands withdrawn.
    // (A future at would be clamped to now when the file is read.)
    const tomb: Tombstone = { id, at: provider.getBibleTrustTimes([id]).get(id)!, reason: 'demoted' };
    const baseSha = await bibleWithTombstone(id, tomb, false);
    const bytes = fs.readFileSync(biblePath());

    const r = JSON.parse(await kbBibleCommit({ ids: [id], ...base(baseSha) }, { folder: clone }));
    expect(r.merged).toEqual([]);
    expect(r.skipped).toEqual([{ id, reason: 'demoted_tombstone' }]);
    expect(readBible().entries.map(e => e.id)).toEqual([]);
    expect(readBible().demotions).toEqual([tomb]);
    expect(fs.readFileSync(biblePath()).equals(bytes)).toBe(true);
    expectDisjoint();
  });

  it('skips demoted_tombstone when the row has no bible trust time (imported, never promoted here)', async () => {
    const id = await confirmedCiting('Beta', 'src/beta.ts');
    // Trust that came from a bible: no local promotion time, no carried updated_at.
    (provider as any).getDb()
      .prepare("UPDATE entries SET promoted_at = NULL, bible_updated_at = NULL, source = 'import' WHERE id = ?").run(id);
    expect(provider.getBibleTrustTimes([id]).get(id)).toBeNull();
    // The tombstone is long in the past: only the null trust time can stop the merge.
    const tomb: Tombstone = { id, at: PAST, reason: 'demoted' };
    const baseSha = await bibleWithTombstone(id, tomb, false);

    const r = JSON.parse(await kbBibleCommit({ ids: [id], ...base(baseSha) }, { folder: clone }));
    expect(r.merged).toEqual([]);
    expect(r.skipped).toEqual([{ id, reason: 'demoted_tombstone' }]);
    expect(readBible().entries.map(e => e.id)).toEqual([]);
    expect(readBible().demotions).toEqual([tomb]);
    expectDisjoint();
  });

  it('merges a real re-promotion (trust strictly after the tombstone) and clears the tombstone', async () => {
    const id = await confirmedCiting('Gamma', 'src/gamma.ts');
    const tomb: Tombstone = { id, at: PAST, reason: 'demoted' };
    const baseSha = await bibleWithTombstone(id, tomb, false);
    expect(Date.parse(provider.getBibleTrustTimes([id]).get(id)!)).toBeGreaterThan(Date.parse(PAST));

    const r = JSON.parse(await kbBibleCommit({ ids: [id], ...base(baseSha) }, { folder: clone }));
    expect(r.merged).toEqual([id]);
    expect(r.skipped).toEqual([]);
    expect(readBible().entries.map(e => e.id)).toEqual([id]);
    expect((readBible().demotions ?? []).some(d => d.id === id)).toBe(false);
    expectDisjoint();
  });
});

describe('kb_bible_commit: an id held as both entry and tombstone is healed (sqlite)', () => {
  it('keeps only the tombstone on a call with no ids, and again on a call with an unrelated id', async () => {
    const id = await confirmedCiting('Delta', 'src/delta.ts');
    const other = await confirmedCiting('Epsilon', 'src/epsilon.ts');
    const tomb: Tombstone = { id, at: provider.getBibleTrustTimes([id]).get(id)!, reason: 'demoted' };
    const baseSha = await bibleWithTombstone(id, tomb, true);
    expect(readBible().entries.map(e => e.id)).toEqual([id]);
    const before = head();

    const r = JSON.parse(await kbBibleCommit({ ids: [], ...base(baseSha) }, { folder: clone }));
    expect(r.removed).toContainEqual({ id, reason: 'tombstoned' });
    expect(r.committed).toBe(true);
    expect(head()).not.toBe(before);
    expect(git(clone, ['log', '-1', '--format=%B']).includes(id + ' (tombstoned)')).toBe(true);
    expect(readBible().entries.map(e => e.id)).toEqual([]);
    expect(readBible().demotions).toEqual([tomb]);
    expectDisjoint();

    // The same broken state again, healed through a call naming an unrelated id.
    const doc = readBible();
    doc.entries = [{ id, title: 'stale copy' } as any];
    doc.provenance!.entry_count = 1;
    fs.writeFileSync(biblePath(), JSON.stringify(doc, null, 2) + '\n');
    commitBibleFile('bible holds both again');
    const r2 = JSON.parse(await kbBibleCommit({ ids: [other], ...base(baseSha) }, { folder: clone }));
    expect(r2.merged).toEqual([other]);
    expect(r2.removed).toContainEqual({ id, reason: 'tombstoned' });
    expect(r2.committed).toBe(true);
    expect(readBible().entries.map(e => e.id)).toEqual([other]);
    expect(readBible().demotions).toEqual([tomb]);
    expectDisjoint();
  });
});

describe('the committed repo bible', () => {
  it('holds a098caf8 only as a tombstone and keeps entry and tombstone ids disjoint', () => {
    const repoBible = path.resolve(__dirname, '..', '..', BIBLE_REL);
    const doc = JSON.parse(fs.readFileSync(repoBible, 'utf-8')) as BibleFile;
    const entryIds = new Set(doc.entries.map(e => e.id));
    const tombIds = (doc.demotions ?? []).map(d => d.id);
    for (const t of tombIds) expect(entryIds.has(t)).toBe(false);
    expect(tombIds).toContain(A098);
    expect(entryIds.has(A098)).toBe(false);
  });
});
