import { z } from 'zod';
import { KB_REMOVED_SCOPE_KEYS_SHAPE } from '../services/knowledge/kb-removed-scope-keys.js';
import fs from 'node:fs';
import path from 'node:path';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { resolveKbAnchor, type KbAnchor } from '../services/knowledge/kb-self.js';
import { filterProjectBibleCandidates } from '../services/knowledge/bible-basis-filter.js';
import { logWarn } from '../utils/log-helpers.js';
import { requireSqliteProject } from '../services/knowledge/require-sqlite-project.js';
import type { BibleDemotion } from '../services/knowledge/bible-import.js';
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
// Provenance records the sprint's TARGET BASE branch and the base commit the
// entries were verified against, as given by the caller -- never the HEAD of
// the working folder, which is typically a feature branch.
//
// The commit is local, pathspec-scoped to the bible file, with the pm-kb
// identity (shared with kb_export). It is NEVER pushed.

export const kbBibleCommitSchema = z.object({
  ids: z.array(z.string().min(1))
    .describe('Ids of the entries confirmed this round. Each must be a live (non-stale, non-superseded) CONFIRMED entry in this repository\'s KB whose recorded file basis still matches the cited files at the repo\'s HEAD commit (the same rule kb_export applies; uncommitted edits are ignored); any other id is skipped and reported in skipped (reason not_confirmed_or_unknown, no_source_files for a CONFIRMED entry citing no source file, or basis_mismatch). Independently of the ids, every bible entry this KB holds as superseded or invalidated is removed and reported in removed; an empty list with no such entry makes no commit.'),
  demoted_ids: z.array(z.string().min(1)).optional()
    .describe('Ids demoted this round (kb_demote). Each must name a local entry that HAS a demoted_at and is now below CONFIRMED; any other id is skipped and reported in skipped with reason not_demoted_or_unknown. An admitted id is REMOVED from entries and recorded as an explicit tombstone {id, demoted_at} in the bible demotions array, so other clones can apply the demotion instead of inferring it from an absence. Re-admitting the same id through ids (a re-promotion) clears its tombstone.'),
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
      entry_count: existingAtStart?.length ?? 0, committed: false,
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
  for (const e of qualifying) confirmed.set(e.id, toCanonicalEntry(e, bases.get(e.id)));

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
  // confidence is now below CONFIRMED. Anything else -- unknown id, never
  // demoted, or demoted and since re-promoted back to CONFIRMED -- is skipped
  // with a reason and leaves the file untouched for that id. The state is read
  // straight from the row (not through list()) so a demoted entry that has since
  // gone stale can still be tombstoned: other clones' bibles still carry it.
  const demotionState = project.getDemotionState(requestedDemotions);
  const admittedDemotions: BibleDemotion[] = [];
  for (const id of requestedDemotions) {
    const state = demotionState.get(id);
    if (state && state.demoted_at && state.confidence !== 'CONFIRMED' && !qualifyingIds.has(id)) {
      admittedDemotions.push({ id, demoted_at: state.demoted_at });
    } else {
      skipped.push({ id, reason: 'not_demoted_or_unknown' });
    }
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

  if (merged.length === 0 && removed.length === 0 && admittedDemotions.length === 0) {
    return done({ merged, demoted, skipped, removed, entry_count: existing?.length ?? 0, committed: false });
  }

  // Duplicate-id guard: an existing file holding one id twice would otherwise
  // be silently collapsed by the id map below (dropping an entry). Refuse
  // before anything is written.
  assertNoDuplicateBibleIds(existing ?? [], 'kb_bible_commit');
  const byId = new Map<string, CanonicalEntry>();
  for (const e of existing ?? []) byId.set(e.id, e);
  for (const r of removed) byId.delete(r.id);
  for (const id of merged) byId.set(id, confirmed.get(id)!);
  // An admitted demotion REMOVES the entry -- the only path by which this tool
  // drops one, and only on an explicit demoted_ids instruction.
  for (const id of demoted) byId.delete(id);
  const entries = Array.from(byId.values()).sort(compareById);
  assertNoDuplicateBibleIds(entries, 'kb_bible_commit');

  // TOMBSTONE MERGE. Tombstones already in the file are PRESERVED (a later
  // commit carrying unrelated ids must not silently resurrect their entries on
  // other clones), the admitted ones are upserted, and an id re-admitted as a
  // CONFIRMED entry has its tombstone CLEARED -- it was re-promoted, so the
  // demotion no longer holds.
  const tombstones = new Map<string, BibleDemotion>();
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
    return done({ merged, demoted, skipped, removed, entry_count: entries.length, committed: false });
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
  fs.writeFileSync(outPath, asciiSafeStringify(bible) + '\n', 'utf-8');

  let committed = false;
  if (isGitRepo(repoPath) && bibleContentChanged(repoPath, outPath)) {
    const message = bibleCommitMessage(merged.length, removed, entries.length, demoted.length);
    try {
      commitBiblePath(repoPath, outPath, message);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error('kb_bible_commit: bible written but the local commit failed: ' + reason);
    }
    committed = true;
  }

  return done({ merged, demoted, skipped, removed, entry_count: entries.length, committed });
}

/**
 * The bible commit message. The subject counts merged, removed and demoted
 * entries; when entries were removed, the body lists each one as
 * '- <id> (<reason>)'. With no removals and no demotions the message is the
 * single pre-existing subject line.
 */
export function bibleCommitMessage(
  mergedCount: number, removed: KbBibleCommitRemoval[], total: number, demotedCount = 0,
): string {
  let head: string;
  if (removed.length === 0) {
    head = 'chore(kb): commit ' + mergedCount + ' confirmed entries to the knowledge bible';
  } else if (mergedCount === 0) {
    head = 'chore(kb): remove ' + removed.length + ' superseded/invalidated entries from the knowledge bible';
  } else {
    head = 'chore(kb): commit ' + mergedCount + ' confirmed entries to the knowledge bible, remove '
      + removed.length + ' superseded/invalidated';
  }
  const demotedClause = demotedCount > 0 ? ', ' + demotedCount + ' demoted' : '';
  const subject = head + demotedClause + ' -- ' + total + ' total';
  if (removed.length === 0) return subject;
  return subject + '\n\nRemoved:\n' + removed.map(r => '- ' + r.id + ' (' + r.reason + ')').join('\n');
}
