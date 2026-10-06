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
// to the bible. Unlike kb_export (which regenerates the WHOLE bible from the
// DB), this merges at ENTRY level: every entry already in
// <self>/.fleet/kb-canonical.json is kept, only the given ids are added or
// replaced, and an entry in the file but absent from the DB is never dropped.
// That is what makes a retry after a rejected push safe: the engine resets to
// the new remote HEAD (which may carry another clone's entries) and calls this
// again with the same ids -- the result holds both sets with no manual merge.
//
// Provenance records the sprint's TARGET BASE branch and the base commit the
// entries were verified against, as given by the caller -- never the HEAD of
// the working folder, which is typically a feature branch.
//
// The commit is local, pathspec-scoped to the bible file, with the pm-kb
// identity (shared with kb_export). It is NEVER pushed.

export const kbBibleCommitSchema = z.object({
  ids: z.array(z.string().min(1))
    .describe('Ids of the entries confirmed this round. Each must be a live (non-stale, non-superseded) CONFIRMED entry in this repository\'s KB whose recorded file basis still matches the files on disk (the same rule kb_export applies); any other id is skipped and reported in skipped (reason not_confirmed_or_unknown or basis_mismatch). An empty list makes no commit.'),
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

export interface KbBibleCommitSkip {
  id: string;
  reason: 'not_confirmed_or_unknown' | 'basis_mismatch' | 'not_demoted_or_unknown';
}

export interface KbBibleCommitResult {
  path: string;
  merged: string[];
  /** Ids admitted from demoted_ids: removed from entries, tombstoned. */
  demoted: string[];
  skipped: KbBibleCommitSkip[];
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

  if (requested.length === 0 && requestedDemotions.length === 0) {
    return done({
      merged: [], demoted: [], skipped: [],
      entry_count: readBibleDocument(outPath)?.entries.length ?? 0, committed: false,
    });
  }

  const providers = await getKbProviders(repoPath, resolved.remoteUrl);
  const project = requireSqliteProject(providers.project, 'kb_bible_commit');
  const confirmedEntries = await project.list({ confidence: ['CONFIRMED'] });
  const requestedSet = new Set(requested);
  // ONE admission rule with kb_export (scope=project): a CONFIRMED id is
  // admitted only if it passes the shared bible basis predicate.
  const requestedConfirmed = confirmedEntries.filter(e => requestedSet.has(e.id));
  const qualifying = await filterProjectBibleCandidates(
    requestedConfirmed,
    project.getSourceFileBases(requestedConfirmed.map(e => e.id)),
    repoPath,
  );
  const qualifyingIds = new Set(qualifying.map(e => e.id));
  const confirmedIds = new Set(requestedConfirmed.map(e => e.id));
  const confirmed = new Map<string, CanonicalEntry>();
  for (const e of qualifying) confirmed.set(e.id, toCanonicalEntry(e));

  const merged: string[] = [];
  const skipped: KbBibleCommitSkip[] = [];
  for (const id of requested) {
    if (qualifyingIds.has(id)) merged.push(id);
    else if (confirmedIds.has(id)) {
      // An id already in the bible keeps its existing entry: the merge never drops entries.
      logWarn('kb_bible_commit', 'skipping ' + id + ': basis_mismatch (cited files changed, missing, or basis absent)');
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
  const existingDoc = readBibleDocument(outPath);
  if (existingDoc === null && fs.existsSync(outPath)) {
    throw new Error('kb_bible_commit: existing bible is not a readable bible file, refusing to overwrite it: ' + outPath);
  }
  const existing = existingDoc?.entries ?? null;

  if (merged.length === 0 && admittedDemotions.length === 0) {
    return done({ merged, demoted, skipped, entry_count: existing?.length ?? 0, committed: false });
  }

  const byId = new Map<string, CanonicalEntry>();
  for (const e of existing ?? []) byId.set(e.id, e);
  for (const id of merged) byId.set(id, confirmed.get(id)!);
  // An admitted demotion REMOVES the entry -- the only path by which this tool
  // drops one, and only on an explicit demoted_ids instruction.
  for (const id of demoted) byId.delete(id);
  const entries = Array.from(byId.values()).sort(compareById);

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
    return done({ merged, demoted, skipped, entry_count: entries.length, committed: false });
  }

  const bible: CanonicalBible = {
    version: 2,
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
    const demotedClause = demoted.length > 0 ? ', ' + demoted.length + ' demoted' : '';
    const message = 'chore(kb): commit ' + merged.length + ' confirmed entries to the knowledge bible'
      + demotedClause + ' -- ' + entries.length + ' total';
    try {
      commitBiblePath(repoPath, outPath, message);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error('kb_bible_commit: bible written but the local commit failed: ' + reason);
    }
    committed = true;
  }

  return done({ merged, demoted, skipped, entry_count: entries.length, committed });
}
