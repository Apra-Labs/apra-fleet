// Keyword index for SqliteProvider.query().
//
// Layout (all in kb.sqlite, next to the legacy entries_fts):
//   entries_kw        fts5 over the NORMALIZED text (kb-normalize.ts) of
//                     title, summary, content, tags, symbols and source_files,
//                     rowid = entries.rowid. Ranked with per-column bm25
//                     weights (KW_WEIGHTS).
//   kb_index_pending  rowids whose entries_kw row is out of date.
//   kb_index_meta     key/value metadata; kw_version is the index version.
//
// Why a pending queue instead of FTS triggers that write entries_kw directly:
// the indexed text is a JS normalization of the entry, which a plain SQL
// trigger cannot compute. Plain-SQL triggers on entries (insert, delete, and
// update OF the indexed columns only -- so a use_count bump never enqueues)
// record the rowid, and every keyword read first drains the queue. Every
// write path (capture, promote, demote, bible import, discard, ...) therefore
// stays in step without each one knowing about the index, and an older build
// writing the same kb.sqlite still enqueues its writes (the triggers are part
// of the schema), so this build re-indexes them on its next read.
//
// Versioning: kb_index_meta.kw_version must equal KB_KEYWORD_INDEX_VERSION.
// A KB built before this index existed (0.4.5 and older) has no meta row; a
// KB indexed by an older normalizer has a different one. Either way
// ensureKeywordIndex() rebuilds the index from entries on open, inside one
// BEGIN IMMEDIATE transaction that re-checks the version after taking the
// write lock, so two processes opening the same kb.sqlite never both rebuild.
// No manual step is ever needed after an upgrade.
//
// Rollback: the legacy external-content entries_fts and its entries_ai/ad/au
// triggers are kept, populated and in step. An older build re-runs CREATE ...
// IF NOT EXISTS for exactly those on open and keeps answering from them; it
// never touches entries_kw. AUDN candidate lookup still reads entries_fts.

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { orJoinFtsTerms } from './audn.js';
import { KB_NORMALIZER_VERSION, normalizeForIndex, normalizeQueryTermList, normalizeTokens } from './kb-normalize.js';

/** Bumped when the entries_kw layout changes. */
export const KB_KEYWORD_SCHEMA_VERSION = 1;
/** The version a ready index carries in kb_index_meta.kw_version. */
export const KB_KEYWORD_INDEX_VERSION = `kw${KB_KEYWORD_SCHEMA_VERSION}-norm${KB_NORMALIZER_VERSION}`;

export const KW_COLUMNS = ['title', 'summary', 'content', 'tags', 'symbols', 'source_files'] as const;
type KwColumn = (typeof KW_COLUMNS)[number];

/**
 * bm25 column weights. Measured, not guessed (docs/kb-recall-measurements.md):
 * a normalized path or identifier splits into generic parts (src, servic,
 * knowledg, kb, provid) that most queries contain, so a heavy weight on
 * source_files lifted entries that merely touch a file above the entry the
 * query was about. source_files is weighted like body text, symbols at the
 * title's weight. Applied at query time only (bm25 arguments), so changing a
 * weight needs no index rebuild.
 */
export const KW_WEIGHTS: Record<KwColumn, number> = {
  title: 2, summary: 1, content: 1, tags: 1, symbols: 2, source_files: 1,
};
const KW_BM25 = `bm25(entries_kw, ${KW_COLUMNS.map(c => KW_WEIGHTS[c]).join(', ')})`;

/**
 * Most distinct normalized terms a free-text keyword search ORs together. A
 * long query (a pasted bead description of several hundred chars) otherwise
 * ORs 100+ terms into one MATCH; the earliest terms are kept, since callers
 * put the subject first. A query with fewer distinct terms is unaffected, and
 * discrete-term (fts_terms) searches are never bounded.
 */
export const MAX_QUERY_KEYWORD_TERMS = 32;

const SCHEMA_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS entries_kw USING fts5(
    title, summary, content, tags, symbols, source_files
  );
  CREATE TABLE IF NOT EXISTS kb_index_pending (rowid INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS kb_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TRIGGER IF NOT EXISTS entries_kw_ai AFTER INSERT ON entries BEGIN
    INSERT OR IGNORE INTO kb_index_pending(rowid) VALUES (new.rowid);
  END;
  CREATE TRIGGER IF NOT EXISTS entries_kw_ad AFTER DELETE ON entries BEGIN
    INSERT OR IGNORE INTO kb_index_pending(rowid) VALUES (old.rowid);
  END;
  CREATE TRIGGER IF NOT EXISTS entries_kw_au AFTER UPDATE OF title, summary, content, tags, symbols, source_files ON entries BEGIN
    INSERT OR IGNORE INTO kb_index_pending(rowid) VALUES (old.rowid);
    INSERT OR IGNORE INTO kb_index_pending(rowid) VALUES (new.rowid);
  END;
`;

/** A JSON array column (tags, symbols, source_files) as space-joined text. */
function jsonListText(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(x => typeof x === 'string').join(' ') : String(raw);
  } catch {
    return raw;
  }
}

function indexRow(row: Record<string, unknown>): SQLInputValue[] {
  return [
    normalizeForIndex(String(row.title ?? '')),
    normalizeForIndex(String(row.summary ?? '')),
    normalizeForIndex(String(row.content ?? '')),
    normalizeForIndex(jsonListText(row.tags)),
    normalizeForIndex(jsonListText(row.symbols)),
    normalizeForIndex(jsonListText(row.source_files)),
  ];
}

const INSERT_KW = `INSERT INTO entries_kw(rowid, ${KW_COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?)`;
const SELECT_INDEXED = `SELECT rowid, ${KW_COLUMNS.join(', ')} FROM entries`;

export function readKeywordIndexVersion(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT value FROM kb_index_meta WHERE key = 'kw_version'").get() as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Create the keyword-index schema and, when the stored version is missing or
 * different (a KB from before this index, or an older normalizer), rebuild the
 * index from entries. Returns true when this call rebuilt it.
 */
export function ensureKeywordIndex(db: DatabaseSync): boolean {
  db.exec(SCHEMA_SQL);
  if (readKeywordIndexVersion(db) === KB_KEYWORD_INDEX_VERSION) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-check under the write lock: another process may have just rebuilt.
    if (readKeywordIndexVersion(db) === KB_KEYWORD_INDEX_VERSION) {
      db.exec('COMMIT');
      return false;
    }
    db.exec('DELETE FROM entries_kw');
    db.exec('DELETE FROM kb_index_pending');
    const insert = db.prepare(INSERT_KW);
    for (const row of db.prepare(SELECT_INDEXED).iterate() as Iterable<Record<string, unknown>>) {
      insert.run(row.rowid as number, ...indexRow(row));
    }
    db.prepare("INSERT OR REPLACE INTO kb_index_meta(key, value) VALUES ('kw_version', ?)").run(KB_KEYWORD_INDEX_VERSION);
    db.exec('COMMIT');
    return true;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/**
 * Bring entries_kw up to date with every queued rowid. Runs in a SAVEPOINT, so
 * it is atomic whether or not the caller already holds a transaction.
 */
export function drainKeywordIndex(db: DatabaseSync): number {
  const pending = db.prepare('SELECT rowid FROM kb_index_pending').all() as Array<{ rowid: number }>;
  if (pending.length === 0) return 0;
  db.exec('SAVEPOINT kb_kw_drain');
  try {
    const del = db.prepare('DELETE FROM entries_kw WHERE rowid = ?');
    const sel = db.prepare(`${SELECT_INDEXED} WHERE rowid = ?`);
    const insert = db.prepare(INSERT_KW);
    const done = db.prepare('DELETE FROM kb_index_pending WHERE rowid = ?');
    for (const { rowid } of pending) {
      del.run(rowid);
      const row = sel.get(rowid) as Record<string, unknown> | undefined;
      if (row) insert.run(rowid, ...indexRow(row));
      done.run(rowid);
    }
    db.exec('RELEASE kb_kw_drain');
  } catch (err) {
    try {
      db.exec('ROLLBACK TO kb_kw_drain');
      db.exec('RELEASE kb_kw_drain');
    } catch { /* nothing to undo */ }
    throw err;
  }
  return pending.length;
}

/**
 * Distinct normalized terms of a free-text query, in order of first
 * appearance, bounded by MAX_QUERY_KEYWORD_TERMS.
 */
export function boundedQueryTerms(query: string): string[] {
  return Array.from(new Set(normalizeTokens(query))).slice(0, MAX_QUERY_KEYWORD_TERMS);
}

/**
 * The MATCH expression for a keyword read: discrete terms (each term's tokens
 * ANDed, terms ORed, never bounded) or free text (bounded, ORed). Empty when
 * nothing usable remains.
 */
export function keywordMatchExpression(opts: { query?: string; terms?: string[] }): string {
  if (opts.terms?.length) return normalizeQueryTermList(opts.terms);
  return orJoinFtsTerms(boundedQueryTerms(opts.query ?? ''));
}

/**
 * Entry rows matching `match`, best first, filtered by `where` (conditions on
 * alias e, ANDed) and limited. Drains the pending queue first.
 */
export function keywordSearch(
  db: DatabaseSync,
  match: string,
  where: string[],
  params: SQLInputValue[],
  limit: number,
): Record<string, unknown>[] {
  drainKeywordIndex(db);
  const extra = where.length > 0 ? 'AND ' + where.join(' AND ') : '';
  return db.prepare(`
    SELECT e.* FROM entries_kw
    JOIN entries e ON e.rowid = entries_kw.rowid
    WHERE entries_kw MATCH ?
    ${extra}
    ORDER BY ${KW_BM25}, e.rowid
    LIMIT ?
  `).all(match, ...params, limit) as Record<string, unknown>[];
}
