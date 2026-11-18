import { z } from 'zod';
import { KB_REMOVED_SCOPE_KEYS_SHAPE } from '../services/knowledge/kb-removed-scope-keys.js';
import fs from 'node:fs';
import path from 'node:path';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { resolveKbAnchor, type KbAnchor } from '../services/knowledge/kb-self.js';
import { filterProjectBibleCandidates, hasCarriedBasis, selectLegacyBibleBackfill } from '../services/knowledge/bible-basis-filter.js';
import { logWarn } from '../utils/log-helpers.js';
import { isSqliteProject } from '../services/knowledge/require-sqlite-project.js';
import {
  TOMBSTONE_DEMOTED, TOMBSTONE_WITHDRAWN, parseBibleDocument, standingAgainstTombstone, type BibleTombstone,
} from '../services/knowledge/bible-import.js';
import { bibleBytesBlobId, commitResolves, readCommittedBibleBlob } from '../services/knowledge/bible-blob-id.js';
import { isRepoRelativePath } from '../services/knowledge/bible-basis-filter.js';
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
//
// Withdrawals: a reviewer's judgement that a bible entry no longer holds,
// carried by the branch as a tombstone {id, at, reason: "withdrawn", note,
// evidence_files}. The entry leaves `entries`, but the LOCAL row is never
// changed -- other clones (and this one) apply it only once the branch merges
// and the merged base bible is imported. Because the local row keeps no
// demoted_at, the every-call demotion rule below can never turn an unmerged
// withdrawal into a "demoted" tombstone on a later, unrelated commit (on this
// branch or on another one that still carries the entry).
//
// A withdrawn tombstone in the file (branch-added or merged from the base)
// also blocks merging that id through ids (skip reason withdrawn_tombstone):
// the local row is usually still CONFIRMED, so a merge would silently undo the
// withdrawal. Only restore_ids lifts a branch-added one.
//
// A withdrawn tombstone also outranks a demotion: a demoted_ids id with a
// withdrawn tombstone in the file is skipped (withdrawn_tombstone), the
// every-call demotion rule passes over it, and a demoted tombstone never
// overwrites a withdrawn one in the tombstone merge. Otherwise the demoted
// tombstone would replace the withdrawal and a later ids re-promotion (which
// clears demoted tombstones) would erase it -- a route around restore_ids.
//
// A demoted tombstone in the file blocks merging that id through ids unless the
// local trust time is strictly after the tombstone's at (skip reason
// demoted_tombstone, tombstone kept; a null trust time stands withdrawn).
// And an id is never written as both an entry and a tombstone: on every call
// that reaches the write path, an id found in both loses its entry (removed,
// reason tombstoned) -- this heals a file that already holds both.
//
// Base-bible gate: a demoted tombstone (demoted_ids or the every-call rule) is
// written only for an id the bible at baseCommit carries, as an entry or as a
// tombstone. A locally demoted entry this branch added is dropped from entries
// with no tombstone; an unreadable or unresolvable base writes no new demoted
// tombstone at all (fail closed).
//
// Restores: restore_ids undoes a tombstone THIS BRANCH added -- one the bible at
// baseCommit does not carry -- and re-adds the base bible's entry for that id
// byte-identical when the base has one. A tombstone the base already carries
// (merged history) is never removed here; anything else is a no-op.
//
// Under the http KB provider the entry merge is skipped (bible_skipped), but
// withdrawals and restores still write the tombstone half of
// .fleet/kb-canonical.json, creating a tombstone-only v3 bible when absent and
// keeping any existing entries byte-identical.

/** Minimum withdrawal note length, measured after whitespace is collapsed. */
export const MIN_WITHDRAWAL_NOTE_LENGTH = 20;

/** Every whitespace run becomes one space, then trim: the stored note. */
export function collapseWithdrawalNote(note: string): string {
  return (note ?? '').replace(/\s+/g, ' ').trim();
}

const withdrawalSchema = z.object({
  id: z.string().min(1).describe('Id of the bible entry being withdrawn.'),
  note: z.string()
    .refine(n => collapseWithdrawalNote(n).length >= MIN_WITHDRAWAL_NOTE_LENGTH, {
      message: 'note must be at least ' + MIN_WITHDRAWAL_NOTE_LENGTH + ' characters after whitespace is collapsed',
    })
    .describe('Why the entry no longer holds -- at least 20 characters after whitespace is collapsed. Stored collapsed in the tombstone.'),
  evidence_files: z.array(z.string().min(1).refine(isRepoRelativePath, {
    message: 'evidence_files must be repo-relative paths (no absolute path, no ".." segment)',
  })).min(1)
    .describe('At least one repo-relative file the judgement was checked against; an absolute path or a ".." segment is refused.'),
});

export const kbBibleCommitSchema = z.object({
  ids: z.array(z.string().min(1))
    .describe('Ids of the entries confirmed this round. Each must be a live (non-stale, non-superseded) CONFIRMED entry in this repository\'s KB whose recorded file basis still matches the cited files at the repo\'s HEAD commit (the same rule kb_export applies; uncommitted edits are ignored); any other id is skipped and reported in skipped (reason not_confirmed_or_unknown, no_source_files for a CONFIRMED entry citing no source file, or basis_mismatch). An id the current bible file carries a withdrawn tombstone for is skipped with reason withdrawn_tombstone and its tombstone kept, unless restore_ids undoes that tombstone in the same call. An id the file carries a demoted tombstone for is merged only when its local trust time is strictly after the tombstone at (a real re-promotion, which clears the tombstone); otherwise it is skipped with reason demoted_tombstone and the tombstone kept. An id found in both entries and demotions loses its entry on every call (removed, reason tombstoned). Independently of the ids, every bible entry this KB holds as superseded or invalidated is removed and reported in removed; an empty list with no such entry makes no commit.'),
  demoted_ids: z.array(z.string().min(1)).optional()
    .describe('Ids demoted this round (kb_demote). Each must name a local entry that HAS a demoted_at and is now below CONFIRMED; any other id is skipped and reported in skipped with reason not_demoted_or_unknown. An id the current bible file carries a withdrawn tombstone for is skipped with reason withdrawn_tombstone and that tombstone is kept unchanged: a demoted tombstone never replaces a withdrawn one (only restore_ids lifts a withdrawal). An admitted id is REMOVED from entries and recorded as an explicit tombstone {id, at, reason: "demoted"} in the bible demotions array, so other clones can apply the demotion instead of inferring it from an absence. Independently, every call does the same for each bible entry this KB holds as demoted, unless that bible entry was promoted after the local demotion (another clone re-promoted it). A demoted tombstone is written only for an id the bible at baseCommit carries (as an entry or a tombstone): an entry this branch added (absent from the base) is removed from entries with no tombstone, and any other demoted_ids id is skipped with reason not_in_base_bible. When baseCommit does not resolve or its bible is unreadable, no new demoted tombstone is written, such demoted_ids ids are skipped with not_in_base_bible, and the result carries base_bible_error with the reason. Re-admitting the same id through ids (a re-promotion) clears its tombstone.'),
  withdrawals: z.array(withdrawalSchema).optional()
    .describe('Bible entries withdrawn this round: [{id, note, evidence_files}]. An id is admitted when the bible already holds an entry for it, or this KB holds it CONFIRMED, not superseded and not a user-directive; any other id is skipped with reason not_withdrawable. An admitted id is removed from entries and recorded as a tombstone {id, at: now, reason: "withdrawn", note, evidence_files}; the local entry is NOT changed (the withdrawal takes effect for clones only once the branch merges). An id also merged through ids, or admitted through demoted_ids, in the same call is skipped (not_withdrawable). Under an http KB provider every well-formed withdrawal is admitted and only the tombstone is written.'),
  restore_ids: z.array(z.string().min(1)).optional()
    .describe('Ids whose tombstone this branch added and should be undone. A tombstone is removed only when the bible at baseCommit carries none for that id; the base bible\'s entry for the id, when it has one, is re-added byte-identical. Any other id is a no-op. Restored ids are reported in restored.'),
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
 *    unknown, was never demoted, or is CONFIRMED again;
 *  - not_withdrawable: named in withdrawals, but neither in the bible's
 *    entries nor a live CONFIRMED non-directive entry in this KB (or merged or
 *    demoted by the same call);
 *  - withdrawn_tombstone: named in ids, but the current bible file carries a
 *    withdrawn tombstone for it (branch-added or merged from the base) that
 *    this call does not restore -- only restore_ids can undo a branch-added
 *    withdrawal, and a merged one is never undone here; or named in
 *    demoted_ids while the file carries a withdrawn tombstone for it (a
 *    demoted tombstone never replaces a withdrawn one);
 *  - demoted_tombstone: named in ids, but the current bible file carries a
 *    demoted tombstone for it and the local trust time is not strictly after
 *    the tombstone's at (or is null: trust that came from a bible). The
 *    tombstone is kept and no entry is added; a strictly later trust time is
 *    a real re-promotion and merges, clearing the tombstone;
 *  - not_in_base_bible: named in demoted_ids and locally demoted, but the bible
 *    at baseCommit carries neither an entry nor a tombstone for it (and the
 *    branch file carries no entry for it to drop), or that bible cannot be read
 *    (baseCommit does not resolve, or its bible is unreadable): no tombstone.
 */
export type KbBibleCommitSkipReason =
  'not_confirmed_or_unknown' | 'no_source_files' | 'basis_mismatch' | 'not_demoted_or_unknown' | 'not_withdrawable'
  | 'withdrawn_tombstone' | 'demoted_tombstone' | 'not_in_base_bible';

export interface KbBibleCommitSkip {
  id: string;
  reason: KbBibleCommitSkipReason;
}

/**
 * Why a bible entry was removed: the maintainer KB holds it as retired
 * (superseded, invalidated), or the file already carried a tombstone for the
 * same id (tombstoned: the tombstone wins, so an id is never both).
 */
export type KbBibleCommitRemovalReason = 'superseded' | 'invalidated' | 'tombstoned';

export interface KbBibleCommitRemoval {
  id: string;
  reason: KbBibleCommitRemovalReason;
}

export interface KbBibleCommitResult {
  path: string;
  merged: string[];
  /**
   * Ids removed from entries as demoted (demoted_ids or the every-call rule).
   * Tombstoned when the bible at baseCommit carries the id; an entry this
   * branch added is removed with no tombstone.
   */
  demoted: string[];
  /** Ids admitted from withdrawals: removed from entries, tombstoned "withdrawn". */
  withdrawn: string[];
  /** Ids from restore_ids whose branch-added tombstone was removed. */
  restored: string[];
  skipped: KbBibleCommitSkip[];
  removed: KbBibleCommitRemoval[];
  /** ENTRIES only -- a tombstone is not an entry. */
  entry_count: number;
  /** How many existing bible entries gained source_file_hashes (legacy backfill). */
  backfilled: number;
  committed: boolean;
  /** True when the call was skipped because the project KB is not SQLite-backed (http). */
  bible_skipped?: true;
  /** Why the call was skipped; present only with bible_skipped. */
  reason?: string;
  /**
   * Why the bible at baseCommit could not be read (baseCommit does not resolve,
   * or its bible does not parse), when a rule needed it (a demotion gate or a
   * restore). Absent when the base was read fine or never needed. The call
   * still fails closed: no new demoted tombstone, no drop, no restore.
   */
  base_bible_error?: string;
}

/** Reason reported when kb_bible_commit is skipped under the http KB provider. */
export const KB_BIBLE_COMMIT_HTTP_SKIP_REASON = 'bible commit is not supported over the http KB provider';

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
  const done = (r: Omit<KbBibleCommitResult, 'path' | 'withdrawn' | 'restored'> & { withdrawn?: string[]; restored?: string[] }): string =>
    JSON.stringify({ path: outPath, ...r, withdrawn: r.withdrawn ?? [], restored: r.restored ?? [] });
  // Withdrawals deduped by id (last wins), note stored collapsed.
  const withdrawalById = new Map<string, { id: string; note: string; evidence_files: string[] }>();
  for (const w of input.withdrawals ?? []) {
    withdrawalById.set(w.id, { id: w.id, note: collapseWithdrawalNote(w.note), evidence_files: [...w.evidence_files] });
  }
  const requestedWithdrawals = Array.from(withdrawalById.values());
  const requestedRestores = Array.from(new Set(input.restore_ids ?? []));
  const hasTombstoneWork = requestedWithdrawals.length > 0 || requestedRestores.length > 0;
  const nowIso = new Date().toISOString();
  const withdrawalTombstone = (w: { id: string; note: string; evidence_files: string[] }): BibleTombstone =>
    ({ id: w.id, at: nowIso, reason: TOMBSTONE_WITHDRAWN, note: w.note, evidence_files: w.evidence_files });

  // No ids, no demotions and no bible entry that could be removed: nothing to
  // do, and the KB is not opened.
  const existingDoc = readBibleDocument(outPath);
  const existingAtStart = existingDoc?.entries ?? null;
  if (requested.length === 0 && requestedDemotions.length === 0 && !hasTombstoneWork
    && (existingAtStart === null || existingAtStart.length === 0)) {
    return done({
      merged: [], demoted: [], skipped: [], removed: [],
      entry_count: existingAtStart?.length ?? 0, backfilled: 0, committed: false,
    });
  }

  const providers = await getKbProviders(repoPath, resolved.remoteUrl);
  const project = providers.project;
  if (!isSqliteProject(project)) {
    // The bible is built from the local SQLite store; over http there is
    // nothing to merge. Skip before any KB read, write, or git commit. The
    // bible file was only read leniently above (readBibleEntries never
    // throws): entry_count reports its size when parseable, and an unparseable
    // file is logged, never thrown over -- the skip is provider-wide.
    if (hasTombstoneWork) {
      return done(await commitTombstonesOnly(
        repoPath, outPath, existingDoc, requestedWithdrawals.map(withdrawalTombstone), requestedRestores, input,
      ));
    }
    if (existingAtStart === null && fs.existsSync(outPath)) {
      logWarn('kb_bible_commit', 'bible file is not readable, reporting entry_count 0 under the http KB provider: ' + outPath);
    }
    return done({
      merged: [], demoted: [], skipped: [], removed: [], entry_count: existingAtStart?.length ?? 0, backfilled: 0, committed: false,
      bible_skipped: true, reason: KB_BIBLE_COMMIT_HTTP_SKIP_REASON,
    });
  }
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

  // RESTORE PLAN, computed before the merge: a withdrawn tombstone in the file
  // blocks an ids merge unless this call restores it (below). Only a tombstone
  // already in the file is restorable, never one added by this call; an id this
  // same call withdraws is dropped from the plan after withdrawal admission.
  const loadBase = baseBibleLoader(repoPath, input.baseCommit);
  const restorePlan = await planRestores(requestedRestores, existingDoc?.demotions ?? [], loadBase);
  const restorableSet = new Set(restorePlan.restored);

  // WITHDRAWN-TOMBSTONE BLOCK. A withdrawal never lowers the local row, so a
  // withdrawn id usually stays CONFIRMED here (on this host, and on any host
  // that has not yet imported the merged base bible). Merging it through ids
  // would silently bring the entry back and clear the withdrawal. So every
  // withdrawn tombstone in the current file -- branch-added or merged from the
  // base -- blocks the merge; only restore_ids can lift a branch-added one.
  // Demoted tombstones keep the re-promotion rule (a merge clears them).
  const withdrawnInFile = new Set((existingDoc?.demotions ?? [])
    .filter(d => d.reason === TOMBSTONE_WITHDRAWN).map(d => d.id));

  // DEMOTED-TOMBSTONE GATE. A demoted tombstone in the file lifts only when the
  // local row's trust is strictly newer than the tombstone (a real
  // re-promotion). A row still CONFIRMED here from before the demotion (or one
  // whose trust came from a bible: null trust time) would otherwise re-add the
  // entry and silently clear the demotion. The RAW nullable trust time is used,
  // never toCanonicalEntry's updated_at fallback.
  const demotedInFile = new Map<string, BibleTombstone>();
  for (const d of existingDoc?.demotions ?? []) if (d.reason === TOMBSTONE_DEMOTED) demotedInFile.set(d.id, d);

  const merged: string[] = [];
  const skipped: KbBibleCommitSkip[] = [];
  for (const id of requested) {
    const demotedTombstone = demotedInFile.get(id);
    if (withdrawnInFile.has(id) && !restorableSet.has(id)) {
      logWarn('kb_bible_commit', 'skipping ' + id + ': withdrawn_tombstone (the bible carries a withdrawn tombstone for it; only restore_ids can undo a branch-added one)');
      skipped.push({ id, reason: 'withdrawn_tombstone' });
    } else if (qualifyingIds.has(id) && demotedTombstone
      && standingAgainstTombstone(trustTimes.get(id) ?? null, demotedTombstone.at) !== 'repromoted') {
      logWarn('kb_bible_commit', 'skipping ' + id + ': demoted_tombstone (the bible carries a demoted tombstone for it and the local trust is not after it)');
      skipped.push({ id, reason: 'demoted_tombstone' });
    } else if (qualifyingIds.has(id)) merged.push(id);
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
  const mergedSet = new Set(merged);

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
  // standingAgainstTombstone rule; a bible time later than now never counts):
  // another clone re-promoted it, and tombstoning it again would undo that
  // re-promotion.
  const bibleEntries = existingDoc?.entries ?? [];
  const bibleIds = bibleEntries.map(e => e.id);
  const demotionState = project.getDemotionState([
    ...requestedDemotions, ...bibleIds, ...requestedWithdrawals.map(w => w.id),
  ]);
  const tombstoneFor = (id: string): BibleTombstone | null => {
    const state = demotionState.get(id);
    if (!state || !state.demoted_at || state.confidence === 'CONFIRMED' || mergedSet.has(id)) return null;
    return { id, at: state.demoted_at, reason: TOMBSTONE_DEMOTED };
  };
  // BASE-BIBLE GATE. A demoted tombstone is meaningful only for an id the
  // bible at baseCommit carries -- as an entry, or already as a tombstone. A
  // tombstone for any other id (one the base bible never had) would land on
  // the base as noise. This does NOT stop a tombstone for an id the base
  // bible carries that was demoted locally because of another branch's
  // claim. An entry THIS branch added (in the file, absent from the base) that
  // is locally demoted is still dropped from entries, but with no tombstone.
  // When the base bible cannot be read (baseCommit does not resolve, or its
  // bible is unreadable) this fails closed: no new demoted tombstone and no
  // drop; tombstones already in the file are kept as they are.
  const bibleIdSet = new Set(bibleIds);
  const gateDemotion = async (t: BibleTombstone): Promise<'tombstone' | 'drop' | 'reject'> => {
    const baseRead = await loadBase();
    if (!baseRead.ok) {
      logWarn('kb_bible_commit', 'no demoted tombstone for ' + t.id + ': ' + baseRead.reason);
      return 'reject';
    }
    if (baseRead.base.entryIds.has(t.id) || baseRead.base.tombstoneIds.has(t.id)) return 'tombstone';
    if (bibleIdSet.has(t.id)) return 'drop';
    logWarn('kb_bible_commit', 'no demoted tombstone for ' + t.id + ': the bible at baseCommit does not carry it');
    return 'reject';
  };
  const admittedDemotions: BibleTombstone[] = [];
  // Locally demoted entries this branch added: dropped from entries, no tombstone.
  const droppedDemotions: string[] = [];
  for (const id of requestedDemotions) {
    // A withdrawn tombstone in the file is never replaced by a demoted one: a
    // demoted tombstone is cleared by a later ids re-promotion, which would
    // route around the rule that only restore_ids lifts a withdrawal.
    if (withdrawnInFile.has(id)) {
      logWarn('kb_bible_commit', 'skipping demotion of ' + id + ': withdrawn_tombstone (the bible carries a withdrawn tombstone for it, which a demoted one never replaces)');
      skipped.push({ id, reason: 'withdrawn_tombstone' });
      continue;
    }
    const tombstone = tombstoneFor(id);
    if (!tombstone) {
      skipped.push({ id, reason: 'not_demoted_or_unknown' });
      continue;
    }
    const verdict = await gateDemotion(tombstone);
    if (verdict === 'tombstone') admittedDemotions.push(tombstone);
    else if (verdict === 'drop') droppedDemotions.push(id);
    else skipped.push({ id, reason: 'not_in_base_bible' });
  }
  // WITHDRAWAL ADMISSION. An id the bible holds as an entry, or one this KB
  // holds CONFIRMED, not superseded and not a directive. The local row is only
  // READ: a withdrawal never changes it (see the header). An id merged or
  // admitted as a demotion by this same call keeps that outcome.
  const namedDemotedSet = new Set([...admittedDemotions.map(d => d.id), ...droppedDemotions]);
  const admittedWithdrawals: BibleTombstone[] = [];
  for (const w of requestedWithdrawals) {
    const state = demotionState.get(w.id);
    const localWithdrawable = !!state && state.confidence === 'CONFIRMED' && !state.superseded
      && state.type !== 'user-directive';
    if (!mergedSet.has(w.id) && !namedDemotedSet.has(w.id) && (bibleIdSet.has(w.id) || localWithdrawable)) {
      admittedWithdrawals.push(withdrawalTombstone(w));
    } else skipped.push({ id: w.id, reason: 'not_withdrawable' });
  }
  const withdrawn = admittedWithdrawals.map(d => d.id);
  const withdrawnSet = new Set(withdrawn);

  const requestedDemotionSet = new Set(requestedDemotions);
  for (const entry of bibleEntries) {
    // A withdrawn tombstone in the file outranks the local demotion: never turn
    // it into a demoted one (see WITHDRAWN-TOMBSTONE BLOCK).
    if (requestedDemotionSet.has(entry.id) || withdrawnSet.has(entry.id) || withdrawnInFile.has(entry.id)) continue;
    const tombstone = tombstoneFor(entry.id);
    if (!tombstone || repromotedAfter(entry, tombstone)) continue;
    const verdict = await gateDemotion(tombstone);
    if (verdict === 'tombstone') admittedDemotions.push(tombstone);
    else if (verdict === 'drop') droppedDemotions.push(entry.id);
  }
  // Both are removed from entries; only admittedDemotions are tombstoned.
  const demoted = [...admittedDemotions.map(d => d.id), ...droppedDemotions];

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

  // RESTORES: planned above; an id this same call withdraws is not restored.
  const restored = restorePlan.restored.filter(id => !withdrawnSet.has(id));
  const restoredSet = new Set(restored);

  // EXCLUSIVITY HEAL. An id is never written as both an entry and a tombstone:
  // a file that already holds both (merged history) keeps only the tombstone.
  // Ids this call re-promotes (merged) or restores clear their tombstone
  // instead, and one already removed as retired needs no second report.
  removed.push(...tombstonedEntryRemovals(
    existing ?? [], existingDoc?.demotions ?? [],
    id => mergedSet.has(id) || restoredSet.has(id) || removedSet.has(id),
  ));
  removed.sort(compareById);

  // Every rule that reads the base bible (demotion gate, restore plan) has run
  // by now: report a failed read in the result, not only in the log.
  const baseBibleError = await loadBase.error();
  const baseErrorField = baseBibleError !== undefined ? { base_bible_error: baseBibleError } : {};

  if (merged.length === 0 && removed.length === 0 && demoted.length === 0 && backfilled === 0
    && withdrawn.length === 0 && restored.length === 0) {
    return done({
      merged, demoted, skipped, removed, entry_count: existing?.length ?? 0, backfilled, committed: false, withdrawn, restored,
      ...baseErrorField,
    });
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
  // An admitted demotion or withdrawal REMOVES the entry.
  for (const id of demoted) byId.delete(id);
  for (const id of withdrawn) byId.delete(id);
  // A restore re-adds the base entry byte-identical (a merged id keeps its fresh entry).
  for (const [id, entry] of restorePlan.baseEntries) if (restoredSet.has(id) && !mergedSet.has(id)) byId.set(id, entry);
  const entries = Array.from(byId.values()).sort(compareById);
  assertNoDuplicateBibleIds(entries, 'kb_bible_commit');

  // TOMBSTONE MERGE. Tombstones already in the file are PRESERVED (a later
  // commit carrying unrelated ids must not silently resurrect their entries on
  // other clones), the admitted ones are upserted, and an id re-admitted as a
  // CONFIRMED entry has its tombstone CLEARED -- it was re-promoted, so the
  // demotion no longer holds.
  const tombstones = new Map<string, BibleTombstone>();
  for (const d of existingDoc?.demotions ?? []) tombstones.set(d.id, d);
  // Defence in depth: a demoted tombstone never overwrites a withdrawn one.
  for (const d of admittedDemotions) {
    if (tombstones.get(d.id)?.reason === TOMBSTONE_WITHDRAWN) continue;
    tombstones.set(d.id, d);
  }
  for (const d of admittedWithdrawals) tombstones.set(d.id, d);
  for (const id of merged) tombstones.delete(id);
  for (const id of restored) tombstones.delete(id);
  const demotions = Array.from(tombstones.values()).sort(compareById);

  // Unchanged content is a no-op: no rewrite, no commit (provenance alone never
  // counts as a change, matching kb_export). Both halves count as content.
  const demotionsUnchanged = asciiSafeStringify(existingDoc?.demotions ?? [])
    === asciiSafeStringify(demotions);
  if (existing !== null && demotionsUnchanged
    && asciiSafeStringify(existing) === asciiSafeStringify(entries)) {
    return done({
      merged, demoted, skipped, removed, entry_count: entries.length, backfilled, committed: false, withdrawn, restored,
      ...baseErrorField,
    });
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
    const message = bibleCommitMessage(
      merged.length, removed, entries.length, backfilled, demoted.length, withdrawn.length, restored.length,
    );
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

  return done({
    merged, demoted, skipped, removed, entry_count: entries.length, backfilled, committed, withdrawn, restored, ...baseErrorField,
  });
}

/** The bible at baseCommit, reduced to what the restore and demotion rules need. */
interface BaseBible {
  entryIds: Set<string>;
  tombstoneIds: Set<string>;
  byId: Map<string, CanonicalEntry>;
}

type BaseBibleRead = { ok: true; base: BaseBible } | { ok: false; reason: string };

/** The memoized base-bible reader, plus the failure of a read that ran (if any). */
type BaseBibleLoader = (() => Promise<BaseBibleRead>) & {
  /** The reason of a failed read, or undefined when it succeeded or never ran. */
  error: () => Promise<string | undefined>;
};

/**
 * A memoized reader of the bible at `baseCommit`: read at most once per call,
 * and only when a rule needs it. A commit with no bible reads as an empty one;
 * a baseCommit that does not resolve, or a bible there that cannot be parsed,
 * is { ok: false, reason } -- each caller fails closed on it, and error()
 * reports it so the tool result can carry base_bible_error.
 */
function baseBibleLoader(repoPath: string, baseCommit: string): BaseBibleLoader {
  let pending: Promise<BaseBibleRead> | null = null;
  const read = async (): Promise<BaseBibleRead> => {
    if (!(await commitResolves(repoPath, baseCommit))) {
      return { ok: false, reason: 'baseCommit ' + baseCommit + ' does not resolve to a commit' };
    }
    let doc: { entries: unknown[]; demotions: BibleTombstone[] };
    try {
      const blob = await readCommittedBibleBlob(repoPath, baseCommit);
      doc = blob === null
        ? { entries: [], demotions: [] }
        : parseBibleDocument(blob.text, baseCommit + ':.fleet/kb-canonical.json', 'kb_bible_commit');
    } catch (err) {
      return { ok: false, reason: 'the bible at baseCommit is not readable: ' + (err instanceof Error ? err.message : String(err)) };
    }
    const byId = new Map<string, CanonicalEntry>();
    for (const e of doc.entries) {
      if (e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string') {
        byId.set((e as CanonicalEntry).id, e as CanonicalEntry);
      }
    }
    return {
      ok: true,
      base: { entryIds: new Set(byId.keys()), tombstoneIds: new Set(doc.demotions.map(d => d.id)), byId },
    };
  };
  const load = (() => (pending ??= read())) as BaseBibleLoader;
  load.error = async () => {
    if (pending === null) return undefined;
    const r = await pending;
    return r.ok ? undefined : r.reason;
  };
  return load;
}

/**
 * Which of `ids` may be restored: those with a tombstone in the current file
 * that the bible at baseCommit does NOT carry (the branch added it), plus the
 * base bible's entry for each restored id when it has one. When baseCommit does
 * not resolve, or its bible cannot be read, nothing is restored (logged): a
 * branch-added tombstone cannot be told from merged history without it.
 */
async function planRestores(
  ids: string[], current: BibleTombstone[], loadBase: () => Promise<BaseBibleRead>,
): Promise<{ restored: string[]; baseEntries: Map<string, CanonicalEntry> }> {
  const restored: string[] = [];
  const baseEntries = new Map<string, CanonicalEntry>();
  if (ids.length === 0) return { restored, baseEntries };
  const baseRead = await loadBase();
  if (!baseRead.ok) {
    logWarn('kb_bible_commit', 'restore_ids ignored: ' + baseRead.reason);
    return { restored, baseEntries };
  }
  const currentIds = new Set(current.map(d => d.id));
  for (const id of ids) {
    if (!currentIds.has(id) || baseRead.base.tombstoneIds.has(id)) {
      logWarn('kb_bible_commit', 'restore of ' + id + ' is a no-op: no branch-added tombstone for it');
      continue;
    }
    restored.push(id);
    const entry = baseRead.base.byId.get(id);
    if (entry) baseEntries.set(id, entry);
  }
  return { restored, baseEntries };
}

/**
 * EXCLUSIVITY HEAL, shared by both provider paths. An id is never written as
 * both an entry and a tombstone: each entry the file already holds a tombstone
 * for (merged history) is dropped and reported as removed 'tombstoned', unless
 * `exempt` says this call clears that tombstone (re-promoted, restored) or
 * already removed the entry for another reason.
 */
function tombstonedEntryRemovals(
  entries: CanonicalEntry[], tombstones: BibleTombstone[], exempt: (id: string) => boolean,
): KbBibleCommitRemoval[] {
  const tombstoneIds = new Set(tombstones.map(d => d.id));
  const removals: KbBibleCommitRemoval[] = [];
  for (const e of entries) {
    if (tombstoneIds.has(e.id) && !exempt(e.id)) {
      logWarn('kb_bible_commit', 'dropping entry ' + e.id + ': tombstoned (the bible holds it as both an entry and a tombstone)');
      removals.push({ id: e.id, reason: 'tombstoned' });
    }
  }
  return removals;
}

/**
 * The http-provider half: no entry merge (bible_skipped stays true), but the
 * withdrawals' tombstones and the restores are written to the bible file,
 * creating a tombstone-only v3 bible when it is absent. Existing entries are
 * kept byte-identical (a restore may re-add the base entry), except that an
 * entry is dropped when the file ends up holding a tombstone for its id: a
 * withdrawn id loses its entry, and one already tombstoned in the file is
 * reported in removed as 'tombstoned' (the same heal as the SQLite path). Every well-formed
 * withdrawal is admitted: there is no local KB to check it against. Never
 * records a trusted blob (that lives in the SQLite KB).
 */
async function commitTombstonesOnly(
  repoPath: string,
  outPath: string,
  existingDoc: { entries: CanonicalEntry[]; demotions: BibleTombstone[] } | null,
  withdrawals: BibleTombstone[],
  restoreIds: string[],
  input: KbBibleCommitInput,
): Promise<Omit<KbBibleCommitResult, 'path'>> {
  if (existingDoc === null && fs.existsSync(outPath)) {
    throw new Error('kb_bible_commit: existing bible is not a readable bible file, refusing to overwrite it: ' + outPath);
  }
  const existingEntries = existingDoc?.entries ?? [];
  const withdrawn = withdrawals.map(w => w.id);
  const withdrawnSet = new Set(withdrawn);
  const loadBase = baseBibleLoader(repoPath, input.baseCommit);
  const plan = await planRestores(
    restoreIds.filter(id => !withdrawnSet.has(id)), existingDoc?.demotions ?? [], loadBase,
  );
  const restored = plan.restored;
  const restoredSet = new Set(restored);
  const baseBibleError = await loadBase.error();
  const removed = tombstonedEntryRemovals(existingEntries, existingDoc?.demotions ?? [], id => restoredSet.has(id))
    .sort(compareById);
  const result = (entryCount: number, committed: boolean): Omit<KbBibleCommitResult, 'path'> => ({
    merged: [], demoted: [], skipped: [], removed, entry_count: entryCount, backfilled: 0, committed,
    bible_skipped: true, reason: KB_BIBLE_COMMIT_HTTP_SKIP_REASON, withdrawn, restored,
    ...(baseBibleError !== undefined ? { base_bible_error: baseBibleError } : {}),
  });

  const tombstones = new Map<string, BibleTombstone>();
  for (const d of existingDoc?.demotions ?? []) tombstones.set(d.id, d);
  for (const d of withdrawals) tombstones.set(d.id, d);
  for (const id of restored) tombstones.delete(id);
  const demotions = Array.from(tombstones.values()).sort(compareById);

  // An id the file ends up tombstoning (withdrawn now, or already tombstoned
  // and not restored) keeps only its tombstone.
  const entries = existingEntries.filter(e => !tombstones.has(e.id));
  const present = new Set(entries.map(e => e.id));
  for (const [id, entry] of plan.baseEntries) {
    if (!present.has(id)) { entries.push(entry); present.add(id); }
  }
  if (plan.baseEntries.size > 0) entries.sort(compareById);
  assertNoDuplicateBibleIds(entries, 'kb_bible_commit');

  const demotionsUnchanged = asciiSafeStringify(existingDoc?.demotions ?? []) === asciiSafeStringify(demotions);
  const entriesUnchanged = asciiSafeStringify(existingEntries) === asciiSafeStringify(entries);
  if (demotionsUnchanged && entriesUnchanged) return result(existingEntries.length, false);

  const bible: CanonicalBible = {
    version: BIBLE_FORMAT_VERSION,
    provenance: { commit: input.baseCommit, branch: input.baseBranch, entry_count: entries.length },
    entries,
    ...(demotions.length > 0 ? { demotions } : {}),
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(asciiSafeStringify(bible) + '\n', 'utf-8'));

  let committed = false;
  if (isGitRepo(repoPath) && bibleContentChanged(repoPath, outPath)) {
    const message = bibleCommitMessage(0, removed, entries.length, 0, 0, withdrawn.length, restored.length);
    try {
      commitBiblePath(repoPath, outPath, message);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error('kb_bible_commit: bible written but the local commit failed: ' + reason);
    }
    committed = true;
  }
  return result(entries.length, committed);
}

/**
 * True when the bible entry's own updated_at postdates the local demotion. An
 * updated_at later than now is NOT a re-promotion: clamping it to now would
 * still put it after every past demoted_at, so a future-dated entry would block
 * the tombstone forever.
 */
function repromotedAfter(entry: CanonicalEntry, tombstone: BibleTombstone, now: Date = new Date()): boolean {
  if (typeof entry.updated_at !== 'string' || entry.updated_at.length === 0) return false;
  const updatedAt = Date.parse(entry.updated_at);
  if (Number.isNaN(updatedAt) || updatedAt > now.getTime()) return false;
  return standingAgainstTombstone(entry.updated_at, tombstone.at) === 'repromoted';
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
  withdrawnCount = 0, restoredCount = 0,
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
  const withdrawnClause = withdrawnCount > 0 ? ', ' + withdrawnCount + ' withdrawn' : '';
  const restoredClause = restoredCount > 0 ? ', ' + restoredCount + ' restored' : '';
  const subject = head + demotedClause + withdrawnClause + restoredClause + ' -- ' + total + ' total';
  const body: string[] = [];
  if (removed.length > 0) body.push('Removed:\n' + removed.map(r => '- ' + r.id + ' (' + r.reason + ')').join('\n'));
  // A backfill-only subject already names the count.
  if (backfilled > 0 && (mergedCount > 0 || removed.length > 0)) body.push('Backfilled source_file_hashes on ' + backfilled + ' existing entries.');
  if (body.length === 0) return subject;
  return subject + '\n\n' + body.join('\n\n');
}
