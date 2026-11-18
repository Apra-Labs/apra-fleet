import path from 'node:path';
import type { SQLInputValue } from 'node:sqlite';

/**
 * kb_query's cited filter (request fields `files` and `symbols`): a HARD
 * filter, not a ranking signal. An entry is kept only when its source_files
 * cite one of `files` (exactly, or a file under a given directory) or its
 * symbols name one of `symbols` (exact match). Both given: either match keeps
 * the entry. Ranking inside the filtered set stays the keyword ranking (or
 * newest first when there is no query text).
 */
export interface CitedFilter {
  files?: string[];
  symbols?: string[];
}

/** The kb_query request fields of the cited filter, as a KB server lists them in its capabilities (query_filters). */
export const CITED_FILTER_FIELDS = ['files', 'symbols'] as const;
export type CitedFilterField = typeof CITED_FILTER_FIELDS[number];

/** Thrown for a files value that names no path inside the repository ('', '.', '/'). */
export class CitedFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CitedFilterError';
  }
}

/**
 * Normalise a path for the cited filter: forward slashes, no leading './',
 * no repeated or trailing '/'. An absolute path under `repoRoot` becomes
 * repo-relative; any other absolute path is kept as given (it then only
 * matches a source_files value stored with that same absolute path).
 */
export function normalizeCitedPath(p: string, repoRoot?: string): string {
  let f = p.trim().replace(/\\/g, '/');
  if (repoRoot) {
    const root = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    // A Windows root may differ only in letter case between callers.
    const windows = /^[A-Za-z]:\//.test(root);
    const head = windows ? f.slice(0, root.length).toLowerCase() : f.slice(0, root.length);
    const same = windows ? root.toLowerCase() : root;
    if (root && head === same && (f.length === root.length || f[root.length] === '/')) {
      f = f.slice(root.length + 1);
    }
  }
  f = f.replace(/\/{2,}/g, '/');
  while (f.startsWith('./')) f = f.slice(2);
  if (f === '.') f = '';
  return f.replace(/\/+$/, '');
}

/** True when the filter names at least one file or symbol. */
export function hasCitedFilter(filter: CitedFilter | undefined): filter is CitedFilter {
  return Boolean(filter?.files?.length || filter?.symbols?.length);
}

/**
 * The normalised filter: paths normalised and de-duplicated, symbols trimmed
 * and de-duplicated. Throws CitedFilterError when a files value names no path
 * inside the repository (it would otherwise match every entry, or none).
 */
export function normalizeCitedFilter(filter: CitedFilter, repoRoot?: string): { files: string[]; symbols: string[] } {
  const files: string[] = [];
  for (const raw of filter.files ?? []) {
    const f = normalizeCitedPath(raw, repoRoot);
    if (f === '') {
      throw new CitedFilterError(`files: "${raw}" names no file or directory inside the repository; pass repo-relative paths such as src/app.ts or src/services.`);
    }
    if (!files.includes(f)) files.push(f);
  }
  const symbols: string[] = [];
  for (const raw of filter.symbols ?? []) {
    const s = raw.trim();
    if (s !== '' && !symbols.includes(s)) symbols.push(s);
  }
  return { files, symbols };
}

// A stored source_files value, normalised in SQL the way normalizeCitedPath
// treats a caller's path, but only partly: backslashes to '/' and one leading
// './' dropped. Other non-canonical stored forms (repeated '/', more than one
// leading './') are not matched.
const STORED_PATH_SQL = "(CASE WHEN substr(replace(sf.value, char(92), '/'), 1, 2) = './' "
  + "THEN substr(replace(sf.value, char(92), '/'), 3) ELSE replace(sf.value, char(92), '/') END)";

/**
 * The SQL condition (over the entries alias `e`) for a normalised filter.
 * A file f matches a stored path equal to f, or one under f/ (directory
 * prefix); with `repoRoot` the same is checked for the absolute form, so an
 * entry captured with an absolute path is found by its repo-relative one.
 */
export function citedFilterSql(
  filter: { files: string[]; symbols: string[] },
  repoRoot?: string,
): { condition: string; params: SQLInputValue[] } | null {
  const ors: string[] = [];
  const params: SQLInputValue[] = [];
  if (filter.files.length) {
    const root = repoRoot ? repoRoot.replace(/\\/g, '/').replace(/\/+$/, '') : '';
    const fileOrs: string[] = [];
    for (const f of filter.files) {
      const forms = root && !path.isAbsolute(f) && !/^[A-Za-z]:\//.test(f) ? [f, `${root}/${f}`] : [f];
      for (const form of forms) {
        fileOrs.push(`${STORED_PATH_SQL} = ? OR substr(${STORED_PATH_SQL}, 1, ?) = ?`);
        params.push(form, form.length + 1, form + '/');
      }
    }
    ors.push(`EXISTS (SELECT 1 FROM json_each(e.source_files) sf WHERE ${fileOrs.join(' OR ')})`);
  }
  if (filter.symbols.length) {
    ors.push(`EXISTS (SELECT 1 FROM json_each(e.symbols) sy WHERE sy.value IN (${filter.symbols.map(() => '?').join(',')}))`);
    params.push(...filter.symbols);
  }
  if (ors.length === 0) return null;
  return { condition: `(${ors.join(' OR ')})`, params };
}

/**
 * The same rule in JS, for entries a provider returned: the backstop that
 * keeps the filter a guarantee of kb_query whichever store answered.
 */
export function entryCites(
  e: { source_files?: string[]; symbols?: string[] },
  filter: { files: string[]; symbols: string[] },
  repoRoot?: string,
): boolean {
  if (filter.symbols.length && (e.symbols ?? []).some(s => filter.symbols.includes(s))) return true;
  if (filter.files.length) {
    for (const stored of e.source_files ?? []) {
      const s = normalizeCitedPath(stored, repoRoot);
      if (filter.files.some(f => s === f || s.startsWith(f + '/'))) return true;
    }
  }
  return false;
}
