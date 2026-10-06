import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import { kbDemote } from '../../src/tools/kb-demote.js';
import { kbImport } from '../../src/tools/kb-import.js';
import { kbSessionPrime } from '../../src/tools/kb-session-prime.js';
import {
  getMemberBibleView,
  memberBibleViewLoadCount,
  memberBiblePath,
  resetMemberBibleViews,
} from '../../src/services/knowledge/member-bible-view.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput, KBEntry } from '../../src/services/knowledge/types.js';

// Does a demotion actually CROSS CLONES? kb_demote lowers trust here;
// kb_bible_commit records the tombstone; this file proves the other side --
// that another clone importing that bible applies the demotion, that the
// member bible view and the cold seed stop surfacing the entry, and above all
// that NOTHING ELSE is demoted along the way.
//
// Real everything: TWO SqliteProviders over TWO real temp git checkouts, the
// real kb_demote / kb_bible_commit / kb_import / kb_session_prime handlers, and
// the real bible FILE kb_bible_commit wrote. The only vi.spyOn is
// getKbProviders, the seam that points the handlers at this test's providers
// instead of the host's KB -- the same seam
// tests/knowledge/kb-bible-tombstones.test.ts uses. Nothing under test is
// mocked.
//
// THE BINDING RULE OF THIS EPIC, and the reason scenario 1 asserts two halves:
// absence from the bible is NEVER evidence of demotion. A clone legitimately
// holds CONFIRMED rows that were never exported (local-only promotions,
// basis_mismatch refusals). Entry X exists only to be the row that must come
// through an import BYTE-UNCHANGED.
//
// FALSIFICATION (verified by actually making each edit and re-running):
//   - make importBibleEntries demote local CONFIRMED rows merely MISSING from
//     the bible -> scenario 1's X assertions fail (X comes back INFERRED with a
//     demotion note).
//   - drop the `if (!row) return false` guard in applyBibleDemotion so a
//     tombstone upserts -> scenario 3 fails (the ghost id gains a row).
//   - replace isStrictlyBefore with `true` in applyBibleDemotion -> scenario 2
//     fails (the re-promoted row is demoted anyway).
//   - drop the excludeTombstonedEntries call in member-bible-view's buildView
//     -> the HAND-EDITED-FILE member-view test fails (the view lists gone-1).
//     Note which test that is, and which it is NOT: after a normal
//     kb_bible_commit the bible carries no entry for the demoted id at all, so
//     the first member-view test below cannot guard the exclusion -- what it
//     guards is that the rewritten file is re-read instead of the cached slot.
//     The hand-edited case is the only one where the exclusion is observable.
//   - replace the cold seed's live-CONFIRMED predicate with `true` -> cold-seed
//     cases 1-4 (and the all-cases read) fail at once.
//   - drop the cold seed's tombstone filter -> cold-seed case 5 fails.
//
// All temp state lives under one root removed in afterEach; nothing is written
// outside it.
//
// ASCII only.

const BASE = { baseBranch: 'main', baseCommit: 'b'.repeat(40) };
const DEMOTE_REASON = 'the cited behaviour did not hold on the case checked this round';
// The note applyBibleDemotion appends. Pinned as a literal (not imported from
// the provider) so a silent change to the recorded reason has to be made twice.
const BIBLE_NOTE = (author: string) => '\n[Demoted: demoted in the project bible -- ' + author + ']';

interface Tombstone { id: string; demoted_at: string }
interface BibleFile {
  version?: number;
  entries: { id: string }[];
  demotions?: Tombstone[];
}

let root: string;
let cloneA: string;
let cloneB: string;
let providerA: SqliteProvider;
let providerB: SqliteProvider;

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A real bare-origin + clone pair, so kb_bible_commit can actually commit. */
function makeCheckout(name: string): string {
  const origin = path.join(root, name + '.git');
  const clone = path.join(root, name);
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
  return clone;
}

function makeInput(over: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge', title: 'T', summary: 'Summary', content: 'Content body.',
    source_files: ['src/a.ts'], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: false, author: 'test-agent', source: 'doer', confidence: 'INFERRED',
    ...over,
  };
}

function writeSrc(clone: string, rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(clone, rel)), { recursive: true });
  fs.writeFileSync(path.join(clone, rel), body);
}

/**
 * The two checkouts are clones of ONE repository, so a file an entry cites
 * exists in both. This matters, not just for realism: the capture basis check
 * runs on the import side too, so a bible entry citing a file absent from the
 * importing checkout is REJECTED rather than imported, and the clone would
 * never hold the row a tombstone is supposed to demote.
 */
function writeSrcBothClones(rel: string, body: string): void {
  writeSrc(cloneA, rel, body);
  writeSrc(cloneB, rel, body);
}

/**
 * A live CONFIRMED entry citing `file`, captured after the file exists so its
 * recorded basis matches and kb_bible_commit will admit it. Two promotes: the
 * ladder is UNVERIFIED -> INFERRED -> CONFIRMED.
 */
async function confirmedCiting(
  provider: SqliteProvider, clone: string, title: string, file: string, id?: string,
): Promise<string> {
  writeSrcBothClones(file, 'export const ' + title.toLowerCase() + ' = 1;\n');
  const input = makeInput({
    title, summary: 'Summary of ' + title, symbols: ['sym' + title], source_files: [file],
  });
  const captured = id
    ? await provider.capture(input, { preferredId: id })
    : await provider.capture(input);
  await provider.promote(captured.id, 'test fixture: verified');
  await provider.promote(captured.id, 'test fixture: verified');
  return captured.id;
}

function db(provider: SqliteProvider): any {
  return (provider as any).getDb();
}

function row(provider: SqliteProvider, id: string): {
  confidence: string; content: string; promoted_at: string | null;
  demoted_at: string | null; created_at: string; author: string;
} | undefined {
  return db(provider)
    .prepare('SELECT confidence, content, promoted_at, demoted_at, created_at, author FROM entries WHERE id = ?')
    .get(id);
}

function rowCount(provider: SqliteProvider): number {
  return (db(provider).prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number }).c;
}

/** Pin a row's clock fields, so ordering never depends on wall-clock resolution. */
function setTimes(provider: SqliteProvider, id: string, over: { created_at?: string; promoted_at?: string | null }): void {
  if (over.created_at !== undefined) {
    db(provider).prepare('UPDATE entries SET created_at = ? WHERE id = ?').run(over.created_at, id);
  }
  if (over.promoted_at !== undefined) {
    db(provider).prepare('UPDATE entries SET promoted_at = ? WHERE id = ?').run(over.promoted_at, id);
  }
}

function biblePathOf(clone: string): string {
  return path.join(clone, '.fleet', 'kb-canonical.json');
}

function readBible(clone: string): BibleFile {
  return JSON.parse(fs.readFileSync(biblePathOf(clone), 'utf-8')) as BibleFile;
}

/** The git-merge step: A's committed bible arrives in B's checkout. */
function mergeBibleIntoB(): void {
  fs.mkdirSync(path.dirname(biblePathOf(cloneB)), { recursive: true });
  fs.copyFileSync(biblePathOf(cloneA), biblePathOf(cloneB));
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-tombstone-import-'));
  cloneA = makeCheckout('clone-a');
  cloneB = makeCheckout('clone-b');

  providerA = new SqliteProvider(path.join(root, 'kb-a.sqlite'), cloneA);
  providerB = new SqliteProvider(path.join(root, 'kb-b.sqlite'), cloneB);
  await providerA.init();
  await providerB.init();

  // ONE seam, dispatching on the folder the handler resolved -- so kb_demote
  // and kb_bible_commit act on clone A's KB and kb_import on clone B's, exactly
  // as two separate machines would.
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockImplementation(async (folder: string) => {
    const provider = path.resolve(folder) === path.resolve(cloneA) ? providerA : providerB;
    return { project: provider, global: provider, projectSlug: 'test' } as any;
  });
});

afterEach(() => {
  providerA.close();
  providerB.close();
  resetMemberBibleViews();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a demotion crosses clones through the committed bible', () => {
  it('scenario 1: B applies the tombstone to Y, and the never-exported X is byte-unchanged', async () => {
    // --- clone A publishes Y ---
    const y = await confirmedCiting(providerA, cloneA, 'Ypsilon', 'src/y.ts');
    const keep = await confirmedCiting(providerA, cloneA, 'Kappa', 'src/k.ts');
    await kbBibleCommit({ ids: [y, keep], ...BASE }, { folder: cloneA });

    // --- clone B holds Y (from that earlier bible) and a local-only X ---
    mergeBibleIntoB();
    const firstImport = JSON.parse(await kbImport({ skip_sweep: true }, { folder: cloneB }));
    expect(firstImport.imported).toBe(2);
    // Nothing was demoted on a bible that carries no tombstones.
    expect(firstImport.demoted).toBe(0);
    expect(row(providerB, y)!.confidence).toBe('CONFIRMED');

    const x = await confirmedCiting(providerB, cloneB, 'Xi', 'src/x.ts');
    expect(row(providerB, x)!.confidence).toBe('CONFIRMED');
    // X is LOCAL ONLY: it is in no bible, and must never be.
    expect(readBible(cloneB).entries.map(e => e.id)).not.toContain(x);

    // B's copy of Y was promoted (here: created) BEFORE A withdrew trust. Pinned
    // rather than left to the wall clock, so the ordering this scenario turns on
    // cannot flake on millisecond resolution.
    setTimes(providerB, y, { created_at: '2020-01-01T00:00:00.000Z', promoted_at: null });

    const xBefore = row(providerB, x)!;

    // --- clone A demotes Y and commits the tombstone ---
    await kbDemote({ id: y, reason: DEMOTE_REASON }, { folder: cloneA });
    const commit = JSON.parse(await kbBibleCommit({ ids: [], demoted_ids: [y], ...BASE }, { folder: cloneA }));
    expect(commit.demoted).toEqual([y]);
    const tombstoneAt = readBible(cloneA).demotions![0].demoted_at;
    expect(readBible(cloneA).demotions).toEqual([{ id: y, demoted_at: tombstoneAt }]);
    expect(readBible(cloneA).entries.map(e => e.id)).toEqual([keep]);

    // --- B imports A's bible ---
    mergeBibleIntoB();
    const report = JSON.parse(await kbImport({ skip_sweep: true }, { folder: cloneB }));

    // HALF ONE: Y is demoted, with the TOMBSTONE's timestamp, not now().
    const yAfter = row(providerB, y)!;
    expect(yAfter.confidence).toBe('INFERRED');
    expect(yAfter.demoted_at).toBe(tombstoneAt);
    expect(yAfter.content.endsWith(BIBLE_NOTE(yAfter.author))).toBe(true);

    // HALF TWO: X was never in the bible and carries no tombstone. Every field a
    // demotion would have touched is identical. THIS is the never-infer-from-
    // absence guard: make import demote rows merely missing from the bible and
    // this block fails.
    const xAfter = row(providerB, x)!;
    expect(xAfter.confidence).toBe('CONFIRMED');
    expect(xAfter.content).toBe(xBefore.content);
    expect(xAfter.promoted_at).toBe(xBefore.promoted_at);
    expect(xAfter.demoted_at).toBe(xBefore.demoted_at);
    expect(xAfter.demoted_at).toBeNull();

    // The count reports rows CHANGED: Y only.
    expect(report.demoted).toBe(1);
  });

  it('scenario 2: a row re-promoted AFTER the tombstone stays CONFIRMED', async () => {
    const y = await confirmedCiting(providerA, cloneA, 'Ypsilon', 'src/y.ts');
    await kbBibleCommit({ ids: [y], ...BASE }, { folder: cloneA });
    mergeBibleIntoB();
    await kbImport({ skip_sweep: true }, { folder: cloneB });

    await kbDemote({ id: y, reason: DEMOTE_REASON }, { folder: cloneA });
    await kbBibleCommit({ ids: [], demoted_ids: [y], ...BASE }, { folder: cloneA });
    const tombstoneAt = readBible(cloneA).demotions![0].demoted_at;

    // B re-promoted its copy AFTER A withdrew trust: newer evidence wins.
    const later = new Date(Date.parse(tombstoneAt) + 60_000).toISOString();
    setTimes(providerB, y, { promoted_at: later });

    mergeBibleIntoB();
    const report = JSON.parse(await kbImport({ skip_sweep: true }, { folder: cloneB }));

    const after = row(providerB, y)!;
    expect(after.confidence).toBe('CONFIRMED');
    expect(after.demoted_at).toBeNull();
    expect(after.content).not.toContain('[Demoted:');
    expect(report.demoted).toBe(0);
  });

  it('scenario 3: a tombstoned id with no row in B creates no row in B', async () => {
    const y = await confirmedCiting(providerA, cloneA, 'Ypsilon', 'src/y.ts');
    await kbBibleCommit({ ids: [y], ...BASE }, { folder: cloneA });
    await kbDemote({ id: y, reason: DEMOTE_REASON }, { folder: cloneA });
    await kbBibleCommit({ ids: [], demoted_ids: [y], ...BASE }, { folder: cloneA });
    expect(readBible(cloneA).demotions!.map(d => d.id)).toEqual([y]);

    // B never imported the earlier bible, so it has no row for y at all.
    const before = rowCount(providerB);
    expect(row(providerB, y)).toBeUndefined();

    mergeBibleIntoB();
    const report = JSON.parse(await kbImport({ skip_sweep: true }, { folder: cloneB }));

    expect(row(providerB, y)).toBeUndefined();
    expect(rowCount(providerB)).toBe(before);
    expect(report.demoted).toBe(0);
  });

  it('scenario 4: the demoted count is the number of rows actually demoted', async () => {
    const one = await confirmedCiting(providerA, cloneA, 'Alpha', 'src/alpha.ts');
    const two = await confirmedCiting(providerA, cloneA, 'Beta', 'src/beta.ts');
    const three = await confirmedCiting(providerA, cloneA, 'Gamma', 'src/gamma.ts');
    await kbBibleCommit({ ids: [one, two, three], ...BASE }, { folder: cloneA });
    mergeBibleIntoB();
    await kbImport({ skip_sweep: true }, { folder: cloneB });

    // A demotes all THREE. B holds all three, but re-promoted `three` later.
    for (const id of [one, two, three]) {
      await kbDemote({ id, reason: DEMOTE_REASON }, { folder: cloneA });
    }
    await kbBibleCommit({ ids: [], demoted_ids: [one, two, three], ...BASE }, { folder: cloneA });
    const stones = readBible(cloneA).demotions!;
    expect(stones).toHaveLength(3);

    const atOf = (id: string) => stones.find(s => s.id === id)!.demoted_at;
    setTimes(providerB, one, { created_at: '2020-01-01T00:00:00.000Z', promoted_at: null });
    setTimes(providerB, two, { created_at: '2020-01-01T00:00:00.000Z', promoted_at: null });
    setTimes(providerB, three, { promoted_at: new Date(Date.parse(atOf(three)) + 60_000).toISOString() });

    mergeBibleIntoB();
    const report = JSON.parse(await kbImport({ skip_sweep: true }, { folder: cloneB }));

    // THREE tombstones read, TWO rows changed.
    expect(report.demoted).toBe(2);
    expect(row(providerB, one)!.confidence).toBe('INFERRED');
    expect(row(providerB, two)!.confidence).toBe('INFERRED');
    expect(row(providerB, three)!.confidence).toBe('CONFIRMED');
  });
});

describe('the member bible view stops listing a tombstoned entry', () => {
  it('after the commit the LOCAL view omits Y, and the new bible is read rather than the cached slot', async () => {
    const y = await confirmedCiting(providerA, cloneA, 'Ypsilon', 'src/y.ts');
    const keep = await confirmedCiting(providerA, cloneA, 'Kappa', 'src/k.ts');
    await kbBibleCommit({ ids: [y, keep], ...BASE }, { folder: cloneA });

    const viewPath = memberBiblePath(cloneA);
    const before = await getMemberBibleView({ folder: cloneA });
    expect((await before.list({})).map((e: KBEntry) => e.id).sort()).toEqual([y, keep].sort());
    expect(memberBibleViewLoadCount(viewPath)).toBe(1);
    // A second read with the file untouched must NOT rebuild -- otherwise the
    // rebuild asserted below would prove nothing about the cache.
    await getMemberBibleView({ folder: cloneA });
    expect(memberBibleViewLoadCount(viewPath)).toBe(1);
    const statBefore = fs.statSync(viewPath);

    // A demotes Y and commits the tombstone: the bible file is REWRITTEN.
    await kbDemote({ id: y, reason: DEMOTE_REASON }, { folder: cloneA });
    await kbBibleCommit({ ids: [], demoted_ids: [y], ...BASE }, { folder: cloneA });
    expect(readBible(cloneA).demotions!.map(d => d.id)).toEqual([y]);

    // WHAT FORCES THE RELOAD: the view caches a slot keyed on (mtimeMs, size)
    // of the bible file and rebuilds when EITHER differs. SIZE is the signal
    // that can be relied on -- recording a tombstone drops a whole entry object
    // and adds a small {id, demoted_at}, so the file length necessarily
    // changes, whereas two writes landing inside the filesystem's timestamp
    // granularity can share one mtimeMs (observed on ext4). Asserted, not
    // assumed, so a future change that preserved the byte length would be
    // caught here rather than silently serving a stale view:
    const statAfter = fs.statSync(viewPath);
    expect(statAfter.size).not.toBe(statBefore.size);

    const after = await getMemberBibleView({ folder: cloneA });
    expect(memberBibleViewLoadCount(viewPath)).toBe(2); // a REBUILD, not the cached slot

    const listed = (await after.list({})).map((e: KBEntry) => e.id);
    expect(listed).toEqual([keep]);
    expect(listed).not.toContain(y);
  });

  it('the tombstone is honoured even when the bible still carries the entry (hand-edited file)', async () => {
    // kb_bible_commit normally removes a tombstoned entry, so this is the only
    // way "the file says both" can arise. It must resolve to the DEMOTION: a
    // view that lists a demoted entry is the staleness the tombstone exists to
    // stop.
    const bible = {
      version: 2,
      entries: [
        { id: 'keep-1', type: 'knowledge', title: 'Kept fact', summary: 'A kept summary.', symbols: [], source_files: ['src/k.ts'], confidence: 'CONFIRMED' },
        { id: 'gone-1', type: 'knowledge', title: 'Gone fact', summary: 'A withdrawn summary.', symbols: [], source_files: ['src/k.ts'], confidence: 'CONFIRMED' },
      ],
      demotions: [{ id: 'gone-1', demoted_at: '2026-01-01T00:00:00.000Z' }],
    };
    writeSrc(cloneA, 'src/k.ts', 'export const k = 1;\n');
    fs.mkdirSync(path.dirname(biblePathOf(cloneA)), { recursive: true });
    fs.writeFileSync(biblePathOf(cloneA), JSON.stringify(bible), 'utf-8');

    const view = await getMemberBibleView({ folder: cloneA });
    expect((await view.list({})).map((e: KBEntry) => e.id)).toEqual(['keep-1']);
  });
});

describe('the cold seed omits a bible id this clone no longer trusts', () => {
  // The project-bible cold seed fires only for a NON-member session whose KB
  // returns fewer than COLD_KB_MAX top_entries. kbSessionPrime({}) passes no
  // hint_symbols/hint_modules/session_files, so prime() returns NOTHING and the
  // global-append and graph-neighbor blocks are skipped entirely -- the cold
  // seed is the only merge that runs, and no local row is deduped out of it by
  // the existing already-in-top_entries rule.
  const LIVE = 'seed-live';
  const INFERRED = 'seed-inferred';
  const STALE = 'seed-stale';
  const SUPERSEDED = 'seed-superseded';
  const FLAGGED = 'seed-flagged';
  const TOMBSTONED = 'seed-tombstoned';
  const NO_ROW = 'seed-no-local-row';

  function bibleEntry(id: string) {
    return {
      id, type: 'knowledge',
      title: 'Bible entry ' + id,
      summary: 'Bible summary for ' + id,
      symbols: [], source_files: ['src/seed.ts'],
      confidence: 'CONFIRMED', updated_at: '2026-01-01T00:00:00.000Z',
    };
  }

  /** Seed clone B with one local row per case, in the state its name says. */
  async function seedLocalRows(): Promise<void> {
    writeSrc(cloneB, 'src/seed.ts', 'export const seed = 1;\n');
    for (const id of [LIVE, INFERRED, STALE, SUPERSEDED, FLAGGED, TOMBSTONED]) {
      await providerB.capture(makeInput({
        title: 'Local ' + id, summary: 'Local summary for ' + id,
        source_files: ['src/seed.ts'], symbols: [],
      }), { preferredId: id });
    }
    // Everything except INFERRED climbs the ladder to CONFIRMED first; the
    // non-live cases are then put into their state directly, because what the
    // predicate reads is the ROW, not how it got there.
    for (const id of [LIVE, STALE, SUPERSEDED, FLAGGED, TOMBSTONED]) {
      await providerB.promote(id, 'test fixture: verified');
      await providerB.promote(id, 'test fixture: verified');
    }
    db(providerB).prepare('UPDATE entries SET stale = 1 WHERE id = ?').run(STALE);
    db(providerB).prepare('UPDATE entries SET superseded_at = ? WHERE id = ?')
      .run('2026-02-02T00:00:00.000Z', SUPERSEDED);
    db(providerB).prepare('UPDATE entries SET flagged_for_review = 1 WHERE id = ?').run(FLAGGED);

    for (const id of [LIVE, STALE, SUPERSEDED, FLAGGED, TOMBSTONED]) {
      expect(row(providerB, id)!.confidence).toBe('CONFIRMED');
    }
    expect(row(providerB, INFERRED)!.confidence).toBe('INFERRED');
    expect(row(providerB, NO_ROW)).toBeUndefined();
  }

  async function seededIds(): Promise<string[]> {
    const parsed = JSON.parse(await kbSessionPrime({}, { folder: cloneB }));
    return (parsed.top_entries ?? [])
      .filter((e: KBEntry & { via?: string }) => e.via === 'canonical-bible')
      .map((e: KBEntry) => e.id);
  }

  beforeEach(async () => {
    await seedLocalRows();
    fs.mkdirSync(path.dirname(biblePathOf(cloneB)), { recursive: true });
    fs.writeFileSync(biblePathOf(cloneB), JSON.stringify({
      version: 2,
      entries: [LIVE, INFERRED, STALE, SUPERSEDED, FLAGGED, TOMBSTONED, NO_ROW].map(bibleEntry),
      demotions: [{ id: TOMBSTONED, demoted_at: '2026-03-03T00:00:00.000Z' }],
    }), 'utf-8');
  });

  it('case 1: a bible id whose local row is INFERRED is omitted', async () => {
    expect(await seededIds()).not.toContain(INFERRED);
  });

  it('case 2: a bible id whose local row is STALE is omitted', async () => {
    expect(await seededIds()).not.toContain(STALE);
  });

  it('case 3: a bible id whose local row is SUPERSEDED is omitted', async () => {
    expect(await seededIds()).not.toContain(SUPERSEDED);
  });

  it('case 4: a bible id whose local row is FLAGGED FOR REVIEW is omitted', async () => {
    expect(await seededIds()).not.toContain(FLAGGED);
  });

  it('case 5: a TOMBSTONED bible id is omitted even though its local row is live CONFIRMED', async () => {
    // Deliberately the live-CONFIRMED row: this isolates the tombstone rule
    // from the liveness predicate. Only the tombstone can explain the omission.
    expect(row(providerB, TOMBSTONED)!.confidence).toBe('CONFIRMED');
    expect(await seededIds()).not.toContain(TOMBSTONED);
  });

  it('case 6: a bible id whose local row is LIVE CONFIRMED is still seeded', async () => {
    expect(await seededIds()).toContain(LIVE);
  });

  it('case 7: a bible id with NO local row keeps its existing behaviour and is still seeded', async () => {
    expect(await seededIds()).toContain(NO_ROW);
  });

  it('all seven cases in one read: exactly the live-CONFIRMED and the no-local-row ids are seeded', async () => {
    expect((await seededIds()).sort()).toEqual([LIVE, NO_ROW].sort());
  });
});
