import path from 'node:path';
import { computeHeadFileHashBatch } from './file-hash.js';
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
// Comparison is against the content of each cited file AT THE WORK TREE'S
// HEAD COMMIT (git cat-file on HEAD:<path>, see computeHeadFileHashBatch), not
// the file on disk: the work tree routinely differs from HEAD (uncommitted
// edits, an agent mid-task), and the bible describes the committed branch, so
// an uncommitted edit must never flip the verdict either way. The digest is the
// git blob id -- the same one the provider stored as the basis (git
// hash-object of the file at capture time), so an entry captured on a clean
// tree matches HEAD. A file absent at HEAD is a mismatch. A repoPath that is
// not inside a git work tree throws KbHeadHashError (no disk fallback).

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
 * Hash every basis file once (one batch, content at repoPath's HEAD commit)
 * and return the entries that pass qualifiesForProjectBible, preserving input
 * order. Throws KbHeadHashError when repoPath is not inside a git work tree.
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
  if (entries.length === 0) return [];
  const currentHashes = await computeHeadFileHashBatch([...fileSet], { cwd: repoPath });
  return entries.filter(e => qualifiesForProjectBible(e, basisById.get(e.id), currentHashes));
}

/** The minimal bible-entry shape the legacy backfill reads. */
export interface BibleFileEntry {
  id: string;
  source_files: string[];
  source_file_hashes?: Record<string, string>;
}

/** True when a bible entry carries a non-empty source_file_hashes map. */
export function hasCarriedBasis(entry: BibleFileEntry): boolean {
  const h = entry.source_file_hashes;
  return !!h && typeof h === 'object' && !Array.isArray(h) && Object.keys(h).length > 0;
}

function sameFileSet(a: string[], b: string[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const f of sa) if (!sb.has(f)) return false;
  return true;
}

// Legacy-bible backfill (kb_bible_commit).
//
// A bible entry written before format v3 carries no source_file_hashes, so a
// clone importing it can only give it a local freshness-only basis and it is
// never re-published. When the bible writer's own KB holds the SAME id with a
// stored, verified basis, that basis can be attached to the bible entry. The
// rule is the admission predicate itself (qualifiesForProjectBible, cited files
// read at HEAD): nothing is re-hashed into the basis and no second rule is
// invented. One extra guard: the KB entry must cite exactly the bible entry's
// source_files, so the attached basis describes the files the bible entry
// cites and nothing else. A local freshness-only basis (from kb_import) reads
// as no basis (SqliteProvider.getSourceFileBases), so it never backfills.

/**
 * The bible entries that gain a basis: for each entry in `bibleEntries` with
 * no carried source_file_hashes whose id is in `kbEntries` (the writer KB's
 * live entries) with the same source_files set and a stored basis passing
 * qualifiesForProjectBible at repoPath's HEAD, the id mapped to that stored
 * basis. Entries that do not qualify are simply absent from the result (the
 * caller keeps them unchanged; nothing is ever dropped). Hashes the candidate
 * basis files once; with no candidate nothing is hashed (so no git check).
 * Throws KbHeadHashError when there are candidates and repoPath is not inside
 * a git work tree.
 */
export async function selectLegacyBibleBackfill<K extends BibleCandidate>(
  bibleEntries: BibleFileEntry[],
  kbEntries: K[],
  basisById: Map<string, Record<string, string> | null>,
  repoPath: string,
): Promise<Map<string, Record<string, string>>> {
  const kbById = new Map<string, K>();
  for (const e of kbEntries) kbById.set(e.id, e);
  const candidates: BibleCandidate[] = [];
  for (const b of bibleEntries) {
    if (hasCarriedBasis(b)) continue;
    const kb = kbById.get(b.id);
    if (!kb || !basisById.get(b.id)) continue;
    if (!sameFileSet(kb.source_files, b.source_files)) continue;
    candidates.push({ id: b.id, confidence: kb.confidence, source_files: b.source_files });
  }
  const out = new Map<string, Record<string, string>>();
  if (candidates.length === 0) return out;
  const passing = await filterProjectBibleCandidates(candidates, basisById, repoPath);
  for (const c of passing) out.set(c.id, basisById.get(c.id)!);
  return out;
}
