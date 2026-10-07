import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import { kbDemote } from '../../src/tools/kb-demote.js';
import { kbExport } from '../../src/tools/kb-export.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import { commitWorkTree } from '../helpers/commit-work-tree.js';

// The DEMOTION TOMBSTONE lifecycle of the committed project bible, end to end
// against a REAL temp git repository (bare origin + clone), a REAL
// SqliteProvider and the REAL kb_demote / kb_bible_commit / kb_export handlers.
// Nothing under test is mocked: the only vi.spyOn is getKbProviders, which
// points the handlers at this test's own provider instead of the host's KB --
// the same seam tests/knowledge/kb-bible-commit-admission.test.ts uses.
//
// EVERY assertion reads the COMMITTED FILE back from disk and parses it. A
// tombstone exists to be read by ANOTHER clone, so in-memory state proves
// nothing about it.
//
// FALSIFICATION (these are guard tests, so reverting the behaviour must break
// them -- verified by actually making each edit and re-running):
//   - delete the "preserve existing tombstones" loop in
//     src/tools/kb-bible-commit.ts (the `for (const d of existingDoc?.demotions
//     ?? []) tombstones.set(...)`) -> scenario 3 fails: the unrelated second
//     commit drops the tombstone.
//   - delete the "clear a re-admitted id's tombstone" loop (`for (const id of
//     merged) tombstones.delete(id)`) -> scenario 4 fails: the re-promoted
//     entry comes back while its tombstone stays.
//   - drop the tombstone gate in exportProjectBible -> scenario 6a fails:
//     kb_export silently re-adds a demoted id.
//
// All temp repos live under one root removed in afterEach; nothing is written
// outside it.
//
// ASCII only.

const BIBLE_REL = '.fleet/kb-canonical.json';
const BASE = { baseBranch: 'main', baseCommit: 'a'.repeat(40) };
const DEMOTE_REASON = 'the cited behaviour did not hold on the case checked this round';

interface Tombstone { id: string; demoted_at: string }
interface BibleFile {
  version?: number;
  provenance?: { commit: string | null; branch: string | null; entry_count: number };
  entries: { id: string }[];
  demotions?: Tombstone[];
}

let root: string;
let clone: string;
let provider: SqliteProvider;

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge', title: 'T', summary: 'Summary', content: 'Content body.',
    source_files: ['src/a.ts'], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: false, author: 'test-agent', source: 'doer', confidence: 'INFERRED',
    ...overrides,
  };
}

function writeSrc(rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(clone, rel)), { recursive: true });
  fs.writeFileSync(path.join(clone, rel), body);
  // The bible admission predicate reads cited files at HEAD, so a written
  // source file is committed at once: on disk and at HEAD stay the same.
  commitWorkTree(clone);
}

/** A live CONFIRMED entry citing `file`, captured after the file exists so its basis matches. */
async function confirmedCiting(title: string, file: string): Promise<string> {
  writeSrc(file, 'export const ' + title.toLowerCase() + ' = 1;\n');
  const { id } = await provider.capture(makeInput({
    title, summary: 'Summary of ' + title, symbols: ['sym' + title], source_files: [file],
  }));
  await provider.promote(id, 'test fixture: verified');
  await provider.promote(id, 'test fixture: verified');
  return id;
}

function biblePath(): string {
  return path.join(clone, BIBLE_REL);
}

/** The committed bible, parsed from DISK. */
function readBibleFile(): BibleFile {
  return JSON.parse(fs.readFileSync(biblePath(), 'utf-8')) as BibleFile;
}

function bibleIds(): string[] {
  if (!fs.existsSync(biblePath())) return [];
  return readBibleFile().entries.map(e => e.id).sort();
}

function bibleTombstones(): Tombstone[] {
  if (!fs.existsSync(biblePath())) return [];
  return readBibleFile().demotions ?? [];
}

function db(): any {
  return (provider as any).getDb();
}

/** demoted_at as stored on the LOCAL row -- the value a tombstone must carry. */
function rowDemotedAt(id: string): string | null {
  return (db().prepare('SELECT demoted_at FROM entries WHERE id = ?').get(id) as any).demoted_at;
}

function setPromotedAt(id: string, when: string): void {
  db().prepare('UPDATE entries SET promoted_at = ? WHERE id = ?').run(when, id);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-tombstones-'));
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
  git(clone, ['push', '--quiet', 'origin', 'main']);

  provider = new SqliteProvider(path.join(root, 'kb.sqlite'), clone);
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

describe('bible demotion tombstones', () => {
  it('scenario 1: a CONFIRMED id is admitted and appears in entries with NO tombstone', async () => {
    const id = await confirmedCiting('Alpha', 'src/alpha.ts');

    const r = JSON.parse(await kbBibleCommit({ ids: [id], ...BASE }, { folder: clone }));

    expect(r.merged).toEqual([id]);
    expect(r.demoted).toEqual([]);
    expect(r.committed).toBe(true);
    const onDisk = readBibleFile();
    expect(onDisk.entries.map(e => e.id)).toEqual([id]);
    // Absent, not merely empty: a bible that never saw a demotion is shaped
    // exactly like one written before the field existed.
    expect(onDisk.demotions).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(onDisk, 'demotions')).toBe(false);
    expect(onDisk.provenance!.entry_count).toBe(1);
  });

  it('scenario 2: after kb_demote, demoted_ids removes the entry and records {id, demoted_at} from the LOCAL row', async () => {
    const id = await confirmedCiting('Alpha', 'src/alpha.ts');
    const other = await confirmedCiting('Beta', 'src/beta.ts');
    await kbBibleCommit({ ids: [id, other], ...BASE }, { folder: clone });
    expect(bibleIds()).toEqual([id, other].sort());

    await kbDemote({ id, reason: DEMOTE_REASON }, { folder: clone });
    const localDemotedAt = rowDemotedAt(id);
    expect(localDemotedAt).toBeTruthy();

    const r = JSON.parse(await kbBibleCommit({ ids: [], demoted_ids: [id], ...BASE }, { folder: clone }));

    expect(r.demoted).toEqual([id]);
    expect(r.skipped).toEqual([]);
    expect(r.committed).toBe(true);

    const onDisk = readBibleFile();
    expect(onDisk.entries.map(e => e.id)).toEqual([other]);
    expect(onDisk.demotions).toEqual([{ id, demoted_at: localDemotedAt }]);
    // entry_count counts ENTRIES only -- a tombstone is not an entry.
    expect(onDisk.provenance!.entry_count).toBe(1);
    expect(r.entry_count).toBe(1);
  });

  it('scenario 3 (guard): a later commit carrying only UNRELATED ids preserves the tombstone', async () => {
    const demotedId = await confirmedCiting('Alpha', 'src/alpha.ts');
    await kbBibleCommit({ ids: [demotedId], ...BASE }, { folder: clone });
    await kbDemote({ id: demotedId, reason: DEMOTE_REASON }, { folder: clone });
    await kbBibleCommit({ ids: [], demoted_ids: [demotedId], ...BASE }, { folder: clone });
    const tombstone = bibleTombstones();
    expect(tombstone).toEqual([{ id: demotedId, demoted_at: rowDemotedAt(demotedId) }]);

    // A completely unrelated round: new confirmations, no demoted_ids at all.
    const unrelated = await confirmedCiting('Gamma', 'src/gamma.ts');
    const r = JSON.parse(await kbBibleCommit({ ids: [unrelated], ...BASE }, { folder: clone }));

    expect(r.merged).toEqual([unrelated]);
    const onDisk = readBibleFile();
    expect(onDisk.entries.map(e => e.id)).toEqual([unrelated]);
    expect(onDisk.demotions).toEqual(tombstone);
    // The demoted entry is NOT resurrected by the unrelated round.
    expect(onDisk.entries.map(e => e.id)).not.toContain(demotedId);
  });

  it('scenario 4 (guard): re-promoting a tombstoned id and committing it restores the entry and CLEARS the tombstone', async () => {
    const id = await confirmedCiting('Alpha', 'src/alpha.ts');
    await kbBibleCommit({ ids: [id], ...BASE }, { folder: clone });
    await kbDemote({ id, reason: DEMOTE_REASON }, { folder: clone });
    await kbBibleCommit({ ids: [], demoted_ids: [id], ...BASE }, { folder: clone });
    expect(bibleIds()).toEqual([]);
    expect(bibleTombstones().map(d => d.id)).toEqual([id]);

    // Re-promotion: INFERRED -> CONFIRMED, one tier per call.
    await provider.promote(id, 'test fixture: re-verified on newer evidence');
    const r = JSON.parse(await kbBibleCommit({ ids: [id], ...BASE }, { folder: clone }));

    expect(r.merged).toEqual([id]);
    const onDisk = readBibleFile();
    expect(onDisk.entries.map(e => e.id)).toEqual([id]);
    expect(onDisk.demotions).toBeUndefined();
    expect(bibleTombstones()).toEqual([]);
  });

  it('scenario 5: a never-demoted, an unknown and a still-CONFIRMED id are each skipped BY REASON, leaving the file byte-identical', async () => {
    const kept = await confirmedCiting('Alpha', 'src/alpha.ts');
    await kbBibleCommit({ ids: [kept], ...BASE }, { folder: clone });

    // (a) exists, never demoted (plain INFERRED capture -- no demoted_at).
    writeSrc('src/never.ts', 'export const never = 1;\n');
    const { id: neverDemoted } = await provider.capture(
      makeInput({ title: 'NeverDemoted', source_files: ['src/never.ts'] }),
    );
    // (b) unknown id.
    const unknown = 'kb-no-such-id';
    // (c) demoted and SINCE RE-PROMOTED: it has a demoted_at, but is CONFIRMED
    //     again, so trust is not withdrawn and it must not be tombstoned.
    const reconfirmed = await confirmedCiting('Delta', 'src/delta.ts');
    await kbDemote({ id: reconfirmed, reason: DEMOTE_REASON }, { folder: clone });
    await provider.promote(reconfirmed, 'test fixture: re-verified');
    expect(rowDemotedAt(reconfirmed)).toBeTruthy();

    const before = fs.readFileSync(biblePath());
    const head = git(clone, ['rev-parse', 'HEAD']).trim();

    const r = JSON.parse(await kbBibleCommit(
      { ids: [], demoted_ids: [neverDemoted, unknown, reconfirmed], ...BASE }, { folder: clone },
    ));

    expect(r.demoted).toEqual([]);
    expect(r.skipped).toEqual([
      { id: neverDemoted, reason: 'not_demoted_or_unknown' },
      { id: unknown, reason: 'not_demoted_or_unknown' },
      { id: reconfirmed, reason: 'not_demoted_or_unknown' },
    ]);
    expect(r.committed).toBe(false);
    // Byte-identical on disk, and no commit was made for those ids.
    expect(fs.readFileSync(biblePath()).equals(before)).toBe(true);
    expect(git(clone, ['rev-parse', 'HEAD']).trim()).toBe(head);
    // Scoped to the bible pathspec: the fixture's own untracked src/ files are
    // not what this assertion is about.
    expect(git(clone, ['status', '--porcelain', '--', BIBLE_REL]).trim()).toBe('');
    expect(bibleIds()).toEqual([kept]);
    expect(bibleTombstones()).toEqual([]);
  });

  it('scenario 6a (guard): kb_export does NOT re-add a tombstoned id whose local promotion predates the demotion', async () => {
    const id = await confirmedCiting('Alpha', 'src/alpha.ts');
    await kbBibleCommit({ ids: [id], ...BASE }, { folder: clone });
    await kbDemote({ id, reason: DEMOTE_REASON }, { folder: clone });
    await kbBibleCommit({ ids: [], demoted_ids: [id], ...BASE }, { folder: clone });
    const tombstone = bibleTombstones();
    expect(tombstone.map(d => d.id)).toEqual([id]);

    // The cross-clone case: this clone still holds the row CONFIRMED, but its
    // promotion is OLDER than the demotion the bible records. Both timestamps
    // are pinned rather than raced off the wall clock, which could otherwise
    // land in the same millisecond.
    await provider.promote(id, 'test fixture: local re-promotion');
    setPromotedAt(id, '2000-01-01T00:00:00.000Z');
    const before = fs.readFileSync(biblePath());

    const out = JSON.parse(await kbExport({}, { folder: clone }));

    expect(fs.readFileSync(biblePath()).equals(before)).toBe(true);
    expect(bibleIds()).toEqual([]);
    expect(bibleTombstones()).toEqual(tombstone);
    expect(out.exported).toBe(0);
    expect(out.committed).toBe(false);
  });

  it('scenario 6b: kb_export DOES re-add a tombstoned id promoted after the tombstone, clearing the tombstone', async () => {
    const id = await confirmedCiting('Alpha', 'src/alpha.ts');
    const keep = await confirmedCiting('Beta', 'src/beta.ts');
    await kbBibleCommit({ ids: [id, keep], ...BASE }, { folder: clone });
    await kbDemote({ id, reason: DEMOTE_REASON }, { folder: clone });
    await kbBibleCommit({ ids: [], demoted_ids: [id], ...BASE }, { folder: clone });
    expect(bibleTombstones().map(d => d.id)).toEqual([id]);
    expect(bibleIds()).toEqual([keep]);

    await provider.promote(id, 'test fixture: re-verified on newer evidence');
    setPromotedAt(id, '2099-01-01T00:00:00.000Z');

    const out = JSON.parse(await kbExport({}, { folder: clone }));

    const onDisk = readBibleFile();
    expect(onDisk.entries.map(e => e.id).sort()).toEqual([id, keep].sort());
    expect(onDisk.demotions).toBeUndefined();
    expect(out.exported).toBe(2);
  });

  it('scenario 7: a bible with NO demotions field -- v2 envelope and legacy bare array -- reads and commits unchanged', async () => {
    const seeded = {
      id: 'kb-seeded-1', type: 'knowledge', title: 'Seeded', summary: 's', symbols: [],
      source_files: ['src/seed.ts'], confidence: 'CONFIRMED', updated_at: '2026-01-01T00:00:00.000Z',
    };

    // (a) v2 envelope with no demotions field.
    fs.mkdirSync(path.dirname(biblePath()), { recursive: true });
    fs.writeFileSync(biblePath(), JSON.stringify({
      version: 2, provenance: { commit: null, branch: null, entry_count: 1 }, entries: [seeded],
    }, null, 2) + '\n');
    git(clone, ['add', '-A']);
    git(clone, ['commit', '--quiet', '-m', 'seed v2 bible']);

    const first = await confirmedCiting('Alpha', 'src/alpha.ts');
    const r1 = JSON.parse(await kbBibleCommit({ ids: [first], ...BASE }, { folder: clone }));
    expect(r1.merged).toEqual([first]);
    expect(r1.committed).toBe(true);
    expect(bibleIds()).toEqual([first, 'kb-seeded-1'].sort());
    expect(readBibleFile().demotions).toBeUndefined();

    // (b) legacy BARE ARRAY bible.
    fs.writeFileSync(biblePath(), JSON.stringify([seeded], null, 2) + '\n');
    git(clone, ['add', '-A']);
    git(clone, ['commit', '--quiet', '-m', 'seed legacy bible']);

    const second = await confirmedCiting('Gamma', 'src/gamma.ts');
    const r2 = JSON.parse(await kbBibleCommit({ ids: [second], ...BASE }, { folder: clone }));
    expect(r2.merged).toEqual([second]);
    expect(r2.committed).toBe(true);
    expect(bibleIds()).toEqual([second, 'kb-seeded-1'].sort());
    expect(readBibleFile().demotions).toBeUndefined();
  });

  it('scenario 8: an unreadable (malformed JSON) bible is REFUSED and never overwritten, with or without demoted_ids', async () => {
    const id = await confirmedCiting('Alpha', 'src/alpha.ts');
    await kbBibleCommit({ ids: [id], ...BASE }, { folder: clone });
    await kbDemote({ id, reason: DEMOTE_REASON }, { folder: clone });
    // Captured before the garbage is written: writing its cited file commits.
    const other = await confirmedCiting('Beta', 'src/beta.ts');

    const garbage = '{ this is not valid json';
    fs.writeFileSync(biblePath(), garbage);
    const head = git(clone, ['rev-parse', 'HEAD']).trim();

    await expect(kbBibleCommit({ ids: [], demoted_ids: [id], ...BASE }, { folder: clone }))
      .rejects.toThrow(/not a readable bible file, refusing to overwrite it/);
    expect(fs.readFileSync(biblePath(), 'utf-8')).toBe(garbage);

    await expect(kbBibleCommit({ ids: [other], ...BASE }, { folder: clone }))
      .rejects.toThrow(/not a readable bible file, refusing to overwrite it/);
    expect(fs.readFileSync(biblePath(), 'utf-8')).toBe(garbage);

    // kb_export's project merge refuses the same file rather than regenerating over it.
    await expect(kbExport({}, { folder: clone }))
      .rejects.toThrow(/existing bible is not valid JSON, refusing to overwrite it/);
    expect(fs.readFileSync(biblePath(), 'utf-8')).toBe(garbage);
    // Nothing was committed over the refusals.
    expect(git(clone, ['rev-parse', 'HEAD']).trim()).toBe(head);
  });
});
