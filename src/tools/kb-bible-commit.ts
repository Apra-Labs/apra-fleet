import { z } from 'zod';
import { KB_REMOVED_SCOPE_KEYS_SHAPE } from '../services/knowledge/kb-removed-scope-keys.js';
import fs from 'node:fs';
import path from 'node:path';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { resolveKbAnchor, type KbAnchor } from '../services/knowledge/kb-self.js';
import { filterProjectBibleCandidates, hasCarriedBasis, selectLegacyBibleBackfill } from '../services/knowledge/bible-basis-filter.js';
import { logWarn } from '../utils/log-helpers.js';
import { requireSqliteProject } from '../services/knowledge/require-sqlite-project.js';
import { TOMBSTONE_DEMOTED, clampBibleTimeToNow, standingAgainstTombstone, type BibleTombstone } from '../services/knowledge/bible-import.js';
import { bibleBytesBlobId } from '../services/knowledge/bible-blob-id.js';
import { memberLacksKbMaintainer } from '../services/knowledge/kb-maintainer-grant.js';
import {
  asciiSafeStringify,
  assertNoDuplicateBibleIds,
  BIBLE_FORMAT_VERSION,
  bibleContentChanged,
  commitBiblePath,
  compareById,
  isGitRepo,
  readBibleDocument,
  requireLocalFolder,
  toCanonicalEntry,
  withSourceFileHashes,
  type CanonicalBible,
  type CanonicalEntry,
} from './kb-export.js';

// kb_bible_commit: the kb_maintainer commits one review round's confirmations
// to the bible, merging at ENTRY level: the given ids are added or replaced,
// and every entry already in <self>/.fleet/kb-canonical.json is kept UNLESS
// this (the maintainer's) KB holds it as superseded or invalidated -- those
// are removed, and each removal (id + reason) is listed in the response and in
// the commit message. Removal runs at every call, also with no ids. An entry
// in the file but absent from the DB is never dropped, nor is one the DB holds
// as CONFIRMED and current. That keeps a retry after a rejected push safe: the
// engine resets to the new remote HEAD (which may carry another clone's
// entries, unknown to this DB) and calls this again with the same ids -- the
// result holds both sets with no manual merge.
//
// A merely STALE entry (freshness sweep: its cited files moved) is NOT removed:
// the owner decision names only superseded and invalidated, and staleness can
// clear on its own (see SqliteProvider.getRetirementReasons).
//
// kb_export is untouched by this: it stays additive-only.
//
// Legacy backfill: an entry already in the bible with no source_file_hashes
// (carried over from a v1/v2 bible) gains the STORED basis this KB holds for
// the same id, when that basis passes the bible admission predicate at HEAD and
// the KB entry cites exactly the bible entry's source_files
// (selectLegacyBibleBackfill). Only source_file_hashes is added; id, text,
// confidence and every other field stay as they are, and an entry that does not
// qualify is kept unchanged (never dropped). A backfill is a change: the bible
// is rewritten at the current format version and committed, and the response
// and the commit message report the number of backfilled entries.
//
// Provenance records the sprint's TARGET BASE branch and the base commit the
// entries were verified against, as given by the caller -- never the HEAD of
// the working folder, which is typically a feature branch.
//
// The commit is local, pathspec-scoped to the bible file, with the pm-kb
// identity (shared with kb_export). It is NEVER pushed.
//
// Trust anchor: when called from a FULL or kb_maintainer session, the blob id
// of every bible this writes is recorded in the per-repo KB DB, which is what
// lets a member session without the grant import that bible (kb-import.ts).

export const kbBibleCommitSchema = z.object({
  ids: z.array(z.string().min(1))
    .describe('Ids of the entries confirmed this round. Each must be a live (non-stale, non-superseded) CONFIRMED entry in this repository\'s KB whose recorded file basis still matches the cited files at the repo\'s HEAD commit (the same rule kb_export applies; uncommitted edits are ignored); any other id is skipped and reported in skipped (reason not_confirmed_or_unknown, no_source_files for a CONFIRMED entry citing no source file, or basis_mismatch). Independently of the ids, every bible entry this KB holds as superseded or invalidated is removed and reported in removed; an empty list with no such entry makes no commit.'),
  demoted_ids: z.array(z.string().min(1)).optional()
    .describe('Ids demoted this round (kb_demote). Each must name a local entry that HAS a demoted_at and is now below CONFIRMED; any other id is skipped and reported in skipped with reason not_demoted_or_unknown. An admitted id is REMOVED from entries and recorded as an explicit tombstone {id, at, reason: "demoted"} in the bible demotions array, so other clones can apply the demotion instead of inferring it from an absence. Independently, every call does the same for each bible entry this KB holds as demoted, unless that bible entry was promoted after the local demotion (another clone re-promoted it). Re-admitting the same id through ids (a re-promotion) clears its tombstone.'),
  baseBranch: z.string().min(1)
    .describe('The sprint\'s target base branch (the branch the work merges into). Written to provenance.branch.'),
  baseCommit: z.string().min(1)
    .describe('The base commit the entries were verified against. Written to provenance.commit.'),
  // Removed pre-redesign scope keys: declared only so a caller still passing one
  // is refused with E-SCOPE-KEY-REMOVED instead of silently re-scoped.
  ...KB_REMOVED_SCOPE_KEYS_SHAPE,
});

export type KbBibleCommitInput = z.infer<typeof kbBibleCommitSchema>;

/**
 * Why a requested id was not merged:
 *  - not_confirmed_or_unknown: not a live CONFIRMED entry in this KB;
 *  - no_source_files: CONFIRMED but cites no source file, so it has no basis
 *    that could ever be checked (retrying cannot change this);
 *  - basis_mismatch: CONFIRMED and cites files, but its recorded basis does not
 *    match those files at HEAD (can clear once the files or the basis agree);
 *  - not_demoted_or_unknown: named in demoted_ids, but the local entry is
 *    unknown, was never demoted, or is CONFIRMED again.
 */
export type KbBibleCommitSkipReason =
  'not_confirmed_or_unknown' | 'no_source_files' | 'basis_mismatch' | 'not_demoted_or_unknown';

export interface KbBibleCommitSkip {
  id: string;
  reason: KbBibleCommitSkipReason;
}

/** Why a bible entry was removed: the maintainer KB holds it as retired. */
export type KbBibleCommitRemovalReason = 'superseded' | 'invalidated';

export interface KbBibleCommitRemoval {
  id: string;
  reason: KbBibleCommitRemovalReason;
}

export interface KbBibleCommitResult {
  path: string;
  merged: string[];
  /** Ids admitted from demoted_ids: removed from entries, tombstoned. */
  demoted: string[];
  skipped: KbBibleCommitSkip[];
  removed: KbBibleCommitRemoval[];
  /** ENTRIES only -- a tombstone is not an entry. */
  entry_count: number;
  /** How many existing bible entries gained source_file_hashes (legacy backfill). */
  backfilled: number;
  committed: boolean;
}

export async function kbBibleCommit(input: KbBibleCommitInput, anchor?: KbAnchor): Promise<string> {
  const resolved = resolveKbAnchor(anchor);
  const repoPath = requireLocalFolder(resolved.folder, 'kb_bible_commit');
  const outPath = path.join(repoPath, '.fleet', 'kb-canonical.json');

  const requested = Array.from(new Set(input.ids));
  // An id named in BOTH lists is a caller bug, and admitting it twice would make
  // the outcome depend on merge order. ids (a confirmation) wins: a re-promoted
  // entry belongs in the bible, and the demotion half is reported as skipped by
  // the normal not_demoted_or_unknown rule below (it is CONFIRMED, not demoted).
  const requestedDemotions = Array.from(new Set(input.demoted_ids ?? []));
  const done = (r: Omit<KbBibleCommitResult, 'path'>): string => JSON.stringify({ path: outPath, ...r });

  // No ids, no demotions and no bible entry that could be removed: nothing to
  // do, and the KB is not opened.
  const existingDoc = readBibleDocument(outPath);
  const existingAtStart = existingDoc?.entries ?? null;
  if (requested.length === 0 && requestedDemotions.length === 0
    && (existingAtStart === null || existingAtStart.length === 0)) {
    return done({
      merged: [], demoted: [], skipped: [], removed: [],
      entry_count: existingAtStart?.length ?? 0, backfilled: 0, committed: false,
    });
  }

  const providers = await getKbProviders(repoPath, resolved.remoteUrl);
  const project = requireSqliteProject(providers.project, 'kb_bible_commit');
  const confirmedEntries = await project.list({ confidence: ['CONFIRMED'] });
  const requestedSet = new Set(requested);
  // ONE admission rule with kb_export (scope=project): a CONFIRMED id is
  // admitted only if it passes the shared bible basis predicate. (With no
  // requested ids this is empty and admission, including its git check, is
  // not run.)
  const requestedConfirmed = confirmedEntries.filter(e => requestedSet.has(e.id));
  const bases = project.getSourceFileBases(requestedConfirmed.map(e => e.id));
  const qualifying = await filterProjectBibleCandidates(requestedConfirmed, bases, repoPath);
  const qualifyingIds = new Set(qualifying.map(e => e.id));
  const confirmedIds = new Set(requestedConfirmed.map(e => e.id));
  const noSourceIds = new Set(requestedConfirmed
    .filter(e => !Array.isArray(e.source_files) || e.source_files.length === 0)
    .map(e => e.id));
  const confirmed = new Map<string, CanonicalEntry>();
  // Format v3: each merged entry carries the exact stored basis it was just
  // admitted against (never re-hashed here).
  const trustTimes = project.getBibleTrustTimes(qualifying.map(e => e.id));
  for (const e of qualifying) confirmed.set(e.id, toCanonicalEntry(e, bases.get(e.id), trustTimes.get(e.id)));

  const merged: string[] = [];
  const skipped: KbBibleCommitSkip[] = [];
  for (const id of requested) {
    if (qualifyingIds.has(id)) merged.push(id);
    else if (noSourceIds.has(id)) {
      // An id already in the bible keeps its existing entry: the merge never drops entries.
      logWarn('kb_bible_commit', 'skipping ' + id + ': no_source_files (a CONFIRMED entry citing no source file has no checkable basis)');
      skipped.push({ id, reason: 'no_source_files' });
    } else if (confirmedIds.has(id)) {
      // An id already in the bible keeps its existing entry: the merge never drops entries.
      logWarn('kb_bible_commit', 'skipping ' + id + ': basis_mismatch (cited files at HEAD changed or absent, or basis absent)');
      skipped.push({ id, reason: 'basis_mismatch' });
    } else skipped.push({ id, reason: 'not_confirmed_or_unknown' });
  }

  // DEMOTION ADMISSION. A tombstone asserts "this clone withdrew trust", so the
  // local row must actually say so: it exists, it carries a demoted_at, and its
  // confidence is now below CONFIRMED. The state is read straight from the row
  // (not through list()) so a demoted entry that has since gone stale can still
  // be tombstoned: other clones' bibles still carry it.
  //
  // Two sources, one rule. A demoted_ids id that does not qualify -- unknown,
  // never demoted, or demoted and since re-promoted -- is skipped with a reason.
  // And on EVERY call, each entry already in the bible that this KB holds as
  // demoted is tombstoned too, named or not: that is what restores a demotion
  // after an older writer (0.4.4) rewrote the bible without its tombstones.
  // Except when the bible entry was promoted AFTER this clone's demotion (same
  // standingAgainstTombstone rule, bible time clamped to now): another clone
  // re-promoted it, and tombstoning it again would undo that re-promotion.
  const bibleEntries = existingDoc?.entries ?? [];
  const bibleIds = bibleEntries.map(e => e.id);
  const demotionState = project.getDemotionState([...requestedDemotions, ...bibleIds]);
  const tombstoneFor = (id: string): BibleTombstone | null => {
    const state = demotionState.get(id);
    if (!state || !state.demoted_at || state.confidence === 'CONFIRMED' || qualifyingIds.has(id)) return null;
    return { id, at: state.demoted_at, reason: TOMBSTONE_DEMOTED };
  };
  const admittedDemotions: BibleTombstone[] = [];
  for (const id of requestedDemotions) {
    const tombstone = tombstoneFor(id);
    if (tombstone) admittedDemotions.push(tombstone);
    else skipped.push({ id, reason: 'not_demoted_or_unknown' });
  }
  const requestedDemotionSet = new Set(requestedDemotions);
  for (const entry of bibleEntries) {
    if (requestedDemotionSet.has(entry.id)) continue;
    const tombstone = tombstoneFor(entry.id);
    if (tombstone && !repromotedAfter(entry, tombstone)) admittedDemotions.push(tombstone);
  }
  const demoted = admittedDemotions.map(d => d.id);

  // A bible file that exists but cannot be parsed must not be overwritten: its
  // entries are unknown, and writing over it would drop all of them.
  if (existingDoc === null && fs.existsSync(outPath)) {
    throw new Error('kb_bible_commit: existing bible is not a readable bible file, refusing to overwrite it: ' + outPath);
  }
  const existing = existingDoc?.entries ?? null;

  // Removals: a bible entry this KB holds as superseded or invalidated. An id
  // unknown to this KB, or known and not retired, is kept. A merged id is never
  // retired (merging requires a live CONFIRMED entry), so the two never clash.
  const retired = project.getRetirementReasons((existing ?? []).map(e => e.id));
  const removed: KbBibleCommitRemoval[] = (existing ?? [])
    .filter(e => retired.has(e.id))
    .map(e => ({ id: e.id, reason: retired.get(e.id)! }))
    .sort(compareById);

  // Legacy backfill: existing entries with no carried basis, not merged (a
  // merged id gets its fresh entry and basis anyway) and not removed. The
  // predicate needs a git work tree; a folder that is not one has nothing
  // backfilled (no disk fallback) rather than failing a removal-only call.
  const mergedSet = new Set(merged);
  const removedSet = new Set(removed.map(r => r.id));
  const legacy = (existing ?? []).filter(e => !hasCarriedBasis(e) && !mergedSet.has(e.id) && !removedSet.has(e.id));
  let backfill = new Map<string, Record<string, string>>();
  if (legacy.length > 0 && isGitRepo(repoPath)) {
    const legacyIds = new Set(legacy.map(e => e.id));
    const kbLegacy = confirmedEntries.filter(e => legacyIds.has(e.id));
    if (kbLegacy.length > 0) {
      backfill = await selectLegacyBibleBackfill(legacy, kbLegacy, project.getSourceFileBases(kbLegacy.map(e => e.id)), repoPath);
    }
  }
  const backfilled = backfill.size;

  if (merged.length === 0 && removed.length === 0 && admittedDemotions.length === 0 && backfilled === 0) {
    return done({ merged, demoted, skipped, removed, entry_count: existing?.length ?? 0, backfilled, committed: false });
  }

  // Duplicate-id guard: an existing file holding one id twice would otherwise
  // be silently collapsed by the id map below (dropping an entry). Refuse
  // before anything is written.
  assertNoDuplicateBibleIds(existing ?? [], 'kb_bible_commit');
  const byId = new Map<string, CanonicalEntry>();
  for (const e of existing ?? []) {
    const basis = backfill.get(e.id);
    byId.set(e.id, basis ? withSourceFileHashes(e, basis) : e);
  }
  for (const r of removed) byId.delete(r.id);
  for (const id of merged) byId.set(id, confirmed.get(id)!);
  // An admitted demotion REMOVES the entry.
  for (const id of demoted) byId.delete(id);
  const entries = Array.from(byId.values()).sort(compareById);
  assertNoDuplicateBibleIds(entries, 'kb_bible_commit');

  // TOMBSTONE MERGE. Tombstones already in the file are PRESERVED (a later
  // commit carrying unrelated ids must not silently resurrect their entries on
  // other clones), the admitted ones are upserted, and an id re-admitted as a
  // CONFIRMED entry has its tombstone CLEARED -- it was re-promoted, so the
  // demotion no longer holds.
  const tombstones = new Map<string, BibleTombstone>();
  for (const d of existingDoc?.demotions ?? []) tombstones.set(d.id, d);
  for (const d of admittedDemotions) tombstones.set(d.id, d);
  for (const id of merged) tombstones.delete(id);
  const demotions = Array.from(tombstones.values()).sort(compareById);

  // Unchanged content is a no-op: no rewrite, no commit (provenance alone never
  // counts as a change, matching kb_export). Both halves count as content.
  const demotionsUnchanged = asciiSafeStringify(existingDoc?.demotions ?? [])
    === asciiSafeStringify(demotions);
  if (existing !== null && demotionsUnchanged
    && asciiSafeStringify(existing) === asciiSafeStringify(entries)) {
    return done({ merged, demoted, skipped, removed, entry_count: entries.length, backfilled, committed: false });
  }

  const bible: CanonicalBible = {
    version: BIBLE_FORMAT_VERSION,
    provenance: {
      commit: input.baseCommit,
      branch: input.baseBranch,
      // Entries only -- a tombstone is not an entry.
      entry_count: entries.length,
    },
    entries,
    // Omitted entirely when there are none, so a bible that never saw a
    // demotion stays byte-identical to one written before the field existed.
    ...(demotions.length > 0 ? { demotions } : {}),
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const written = Buffer.from(asciiSafeStringify(bible) + '\n', 'utf-8');
  fs.writeFileSync(outPath, written);

  let committed = false;
  if (isGitRepo(repoPath) && bibleContentChanged(repoPath, outPath)) {
    const message = bibleCommitMessage(merged.length, removed, entries.length, backfilled, demoted.length);
    try {
      commitBiblePath(repoPath, outPath, message);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error('kb_bible_commit: bible written but the local commit failed: ' + reason);
    }
    committed = true;
  }

  // kb_import trust anchor: record the blob id of the bible just written, so
  // a member session without the kb_maintainer grant may import it once it is
  // committed in (or pulled into) any checkout of this repository. Only the
  // maintainer side records: kb_bible_commit is served to every member
  // session, and a session without the grant merges over whatever its own
  // work-tree bible holds (possibly hand-edited), so its output must not
  // become trusted. A FULL session and the kb_maintainer session record.
  if (!memberLacksKbMaintainer(anchor)) {
    // The id of the exact bytes written (LF, unfiltered), hashed in-process:
    // never `git hash-object` on the path, which would re-read the file and
    // run the checkout's member-configured clean filters.
    project.recordTrustedBibleBlob(await bibleBytesBlobId(repoPath, written), 'kb_bible_commit');
  }

  return done({ merged, demoted, skipped, removed, entry_count: entries.length, backfilled, committed });
}

/** True when the bible entry's own updated_at postdates the local demotion. */
function repromotedAfter(entry: CanonicalEntry, tombstone: BibleTombstone): boolean {
  if (typeof entry.updated_at !== 'string' || entry.updated_at.length === 0) return false;
  return standingAgainstTombstone(clampBibleTimeToNow(entry.updated_at), tombstone.at) === 'repromoted';
}

/**
 * The bible commit message. The subject counts merged, removed and demoted
 * entries; when entries were removed, the body lists each one as
 * '- <id> (<reason>)'. With no removals and no backfill the message is the
 * single pre-existing subject line. A legacy backfill (existing entries that
 * gained source_file_hashes) adds a body line 'Backfilled source_file_hashes on
 * <n> existing entries.'; a backfill-only commit names the count in its own subject.
 */
export function bibleCommitMessage(
  mergedCount: number, removed: KbBibleCommitRemoval[], total: number, backfilled = 0, demotedCount = 0,
): string {
  let head: string;
  if (mergedCount === 0 && removed.length === 0 && backfilled > 0) {
    head = 'chore(kb): backfill source_file_hashes on ' + backfilled + ' knowledge bible entries';
  } else if (removed.length === 0) {
    head = 'chore(kb): commit ' + mergedCount + ' confirmed entries to the knowledge bible';
  } else if (mergedCount === 0) {
    head = 'chore(kb): remove ' + removed.length + ' superseded/invalidated entries from the knowledge bible';
  } else {
    head = 'chore(kb): commit ' + mergedCount + ' confirmed entries to the knowledge bible, remove '
      + removed.length + ' superseded/invalidated';
  }
  const demotedClause = demotedCount > 0 ? ', ' + demotedCount + ' demoted' : '';
  const subject = head + demotedClause + ' -- ' + total + ' total';
  const body: string[] = [];
  if (removed.length > 0) body.push('Removed:\n' + removed.map(r => '- ' + r.id + ' (' + r.reason + ')').join('\n'));
  // A backfill-only subject already names the count.
  if (backfilled > 0 && (mergedCount > 0 || removed.length > 0)) body.push('Backfilled source_file_hashes on ' + backfilled + ' existing entries.');
  if (body.length === 0) return subject;
  return subject + '\n\n' + body.join('\n\n');
}
