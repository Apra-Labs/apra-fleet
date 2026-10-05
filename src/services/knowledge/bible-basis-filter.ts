import path from 'node:path';
import { computeFileHashBatch } from './file-hash.js';
import type { FileHashResult } from './file-hash.js';

/**
 * A cited/basis path must stay inside the exported repo: relative, with no
 * '..' segment and no POSIX, drive-letter or UNC root. Anything else is never
 * hashed and never qualifies (the bible only describes this tree).
 */
export function isRepoRelativePath(file: string): boolean {
  if (typeof file !== 'string' || file.length === 0) return false;
  if (path.posix.isAbsolute(file) || path.win32.isAbsolute(file) || /^[A-Za-z]:/.test(file)) return false;
  return !file.split(/[\\/]+/).includes('..');
}

// Project-scope bible qualification (kb_export, scope=project).
//
// The committed project bible (.fleet/kb-canonical.json) must only ever gain
// entries that describe the tree being exported. A member-local KB can hold
// CONFIRMED entries captured against files that exist only on that member's
// branch (or that have since changed); publishing those would leak claims about
// code the exported tree does not contain.
//
// HASH BASIS. The per-file basis is the entry's source_file_hashes map
// (file -> hash), written at capture time by SqliteProvider for every entry
// type. KBEntry.content_hash is NOT used: it is only populated for
// context-cache entries, so keying on it would exclude nearly every entry.
//
// Comparison is against the files ON DISK under repoPath, hashed with the same
// computeFileHashBatch the provider used to store the basis, anchored at
// { cwd: repoPath }. kb_export runs on the checkout being exported (in a sprint,
// right after Final Review on the sprint branch), where the working tree equals
// branch HEAD, so on-disk hashes are the branch-HEAD hashes.

/** The minimal entry shape the predicate reads. */
export interface BibleCandidate {
  id: string;
  confidence: string;
  source_files: string[];
}

/**
 * True when an entry qualifies for the project bible:
 *  - confidence is CONFIRMED (callers already exclude superseded/stale rows);
 *  - it cites at least one source file;
 *  - its stored basis is non-empty (null/empty/unparseable basis never matches);
 *  - every cited source file has a key in the basis;
 *  - every cited and basis path is repo-relative (isRepoRelativePath);
 *  - every basis hash equals that file's current hash (a missing file -- a
 *    null/absent current hash -- is a mismatch).
 * Same comparison semantics as SqliteProvider.basisFullyMatches, plus the
 * source_files coverage check.
 */
export function qualifiesForProjectBible(
  entry: BibleCandidate,
  basis: Record<string, string> | null | undefined,
  currentHashes: Record<string, Pick<FileHashResult, 'hash'> | null | undefined>,
): boolean {
  if (entry.confidence !== 'CONFIRMED') return false;
  if (!Array.isArray(entry.source_files) || entry.source_files.length === 0) return false;
  if (!basis || typeof basis !== 'object') return false;
  const basisFiles = Object.keys(basis);
  if (basisFiles.length === 0) return false;
  for (const file of entry.source_files) {
    if (!isRepoRelativePath(file)) return false;
    if (!Object.prototype.hasOwnProperty.call(basis, file)) return false;
  }
  for (const file of basisFiles) {
    if (!isRepoRelativePath(file)) return false;
    const current = currentHashes[file];
    if (!current || typeof basis[file] !== 'string' || current.hash !== basis[file]) return false;
  }
  return true;
}

/**
 * Hash every basis file once (one batch, anchored at repoPath) and return the
 * entries that pass qualifiesForProjectBible, preserving input order.
 */
export async function filterProjectBibleCandidates<T extends BibleCandidate>(
  entries: T[],
  basisById: Map<string, Record<string, string> | null>,
  repoPath: string,
): Promise<T[]> {
  const fileSet = new Set<string>();
  for (const e of entries) {
    const basis = basisById.get(e.id);
    if (basis) for (const f of Object.keys(basis)) if (isRepoRelativePath(f)) fileSet.add(f);
  }
  const currentHashes = fileSet.size > 0
    ? await computeFileHashBatch([...fileSet], { cwd: repoPath })
    : {};
  return entries.filter(e => qualifiesForProjectBible(e, basisById.get(e.id), currentHashes));
}
