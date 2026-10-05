import { z } from 'zod';
import { KB_REMOVED_SCOPE_KEYS_SHAPE } from '../services/knowledge/kb-removed-scope-keys.js';
import fs from 'node:fs';
import path from 'node:path';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { resolveKbAnchor, type KbAnchor } from '../services/knowledge/kb-self.js';
import { filterProjectBibleCandidates } from '../services/knowledge/bible-basis-filter.js';
import { logWarn } from '../utils/log-helpers.js';
import { requireSqliteProject } from '../services/knowledge/require-sqlite-project.js';
import {
  asciiSafeStringify,
  bibleContentChanged,
  commitBiblePath,
  compareById,
  isGitRepo,
  readBibleEntries,
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
  reason: 'not_confirmed_or_unknown' | 'basis_mismatch';
}

export interface KbBibleCommitResult {
  path: string;
  merged: string[];
  skipped: KbBibleCommitSkip[];
  entry_count: number;
  committed: boolean;
}

export async function kbBibleCommit(input: KbBibleCommitInput, anchor?: KbAnchor): Promise<string> {
  const resolved = resolveKbAnchor(anchor);
  const repoPath = requireLocalFolder(resolved.folder, 'kb_bible_commit');
  const outPath = path.join(repoPath, '.fleet', 'kb-canonical.json');

  const requested = Array.from(new Set(input.ids));
  const done = (r: Omit<KbBibleCommitResult, 'path'>): string => JSON.stringify({ path: outPath, ...r });

  if (requested.length === 0) {
    return done({ merged: [], skipped: [], entry_count: readBibleEntries(outPath)?.length ?? 0, committed: false });
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

  // A bible file that exists but cannot be parsed must not be overwritten: its
  // entries are unknown, and writing over it would drop all of them.
  const existing = readBibleEntries(outPath);
  if (existing === null && fs.existsSync(outPath)) {
    throw new Error('kb_bible_commit: existing bible is not a readable bible file, refusing to overwrite it: ' + outPath);
  }

  if (merged.length === 0) {
    return done({ merged, skipped, entry_count: existing?.length ?? 0, committed: false });
  }

  const byId = new Map<string, CanonicalEntry>();
  for (const e of existing ?? []) byId.set(e.id, e);
  for (const id of merged) byId.set(id, confirmed.get(id)!);
  const entries = Array.from(byId.values()).sort(compareById);

  // Entries unchanged is a no-op: no rewrite, no commit (provenance alone never
  // counts as a change, matching kb_export).
  if (existing !== null && asciiSafeStringify(existing) === asciiSafeStringify(entries)) {
    return done({ merged, skipped, entry_count: entries.length, committed: false });
  }

  const bible: CanonicalBible = {
    version: 2,
    provenance: {
      commit: input.baseCommit,
      branch: input.baseBranch,
      entry_count: entries.length,
    },
    entries,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, asciiSafeStringify(bible) + '\n', 'utf-8');

  let committed = false;
  if (isGitRepo(repoPath) && bibleContentChanged(repoPath, outPath)) {
    const message = 'chore(kb): commit ' + merged.length + ' confirmed entries to the knowledge bible -- '
      + entries.length + ' total';
    try {
      commitBiblePath(repoPath, outPath, message);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error('kb_bible_commit: bible written but the local commit failed: ' + reason);
    }
    committed = true;
  }

  return done({ merged, skipped, entry_count: entries.length, committed });
}
