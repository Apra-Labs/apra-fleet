// Keyword-ranking ablation for the KB recall eval (docs/kb-recall-measurements.md).
//
// Re-implements the keyword read of KbKeywordIndex (kb-index.ts) over a copy
// of an eval KB's entries in an in-memory database, with each ranking factor
// switchable on its own: bm25 column weights, the extra columns (symbols,
// source_files, recall_cues, error_signatures), stemming, identifier
// splitting (camel/snake/kebab/path), the compact identifier token and the
// trigram fold-in. With every factor at its production value the result must
// equal the real provider's keyword-only result -- the eval asserts that, so
// the ablation measures the production code path and not a re-derivation of
// it. '0.4.4' is the 0.4.4 keyword read: the raw unicode61 entries_fts over
// title, summary, content and tags, default bm25, query words OR-joined.
//
// Used by tests/knowledge/kb-recall-eval.test.ts (the table is printed when
// APRA_KB_EVAL_ABLATION=1). Pure test tooling: nothing here is product code.

import { DatabaseSync } from 'node:sqlite';
import { orJoinFtsTerms } from '../../src/services/knowledge/audn.js';
import {
  KW_COLUMNS, KW_WEIGHTS, MAX_QUERY_KEYWORD_TERMS, TRI_BM25, trigramMatch,
} from '../../src/services/knowledge/kb-index.js';
import { splitIdentifier, stem } from '../../src/services/knowledge/kb-normalize.js';

type Column = (typeof KW_COLUMNS)[number];

/** The bm25 column weights before the bare-bible fix (the factor named as the cause). */
export const PRE_FIX_KW_WEIGHTS: Record<Column, number> = {
  title: 5, summary: 3, content: 1, tags: 1, symbols: 4, source_files: 4, recall_cues: 4, error_signatures: 4,
};

export interface AblationVariant {
  name: string;
  /** bm25 weight per column (default KW_WEIGHTS). 'equal' = every column 1. */
  weights?: Record<Column, number> | 'equal';
  /** Index only 0.4.4's columns (title, summary, content, tags). */
  legacyColumns?: boolean;
  stem?: boolean;
  split?: boolean;
  compact?: boolean;
  trigram?: boolean;
  /** The 0.4.4 keyword read (every other field ignored). */
  v044?: boolean;
}

const SEGMENT_SPLIT = /[^\p{L}\p{M}\p{N}_-]+/u;
const ARRAY_COLUMNS = new Set(['tags', 'symbols', 'source_files', 'recall_cues', 'error_signatures']);

/** normalizeTokens (kb-normalize.ts) with each step switchable. */
function tokens(text: string, v: AblationVariant): string[] {
  const out: string[] = [];
  for (const segment of text.normalize('NFKC').split(SEGMENT_SPLIT)) {
    if (!segment) continue;
    const parts = v.split === false
      ? segment.split(/[_-]+/).filter(Boolean).map(s => s.toLowerCase())
      : splitIdentifier(segment);
    if (parts.length === 0) continue;
    const seg: string[] = [];
    if (v.compact !== false && parts.length > 1) seg.push(parts.join(''));
    for (const p of parts) {
      const s = v.stem === false ? p : stem(p);
      if (!seg.includes(s)) seg.push(s);
    }
    out.push(...seg);
  }
  return out;
}

function arrayText(raw: unknown): string {
  try {
    const v = JSON.parse((raw as string) || '[]');
    return Array.isArray(v) ? v.filter(x => typeof x === 'string').join(' ') : '';
  } catch {
    return '';
  }
}

export interface AblationQuery { id: string; query: string }

/**
 * Ranked entry ids per query for each variant. Reads the CONFIRMED, current
 * (not superseded, not stale) entries of the KB at dbFile -- the rows the
 * eval's keyword-only read can return -- and never writes to it.
 */
export function runKeywordAblation(
  dbFile: string, queries: AblationQuery[], variants: AblationVariant[], limit = 20,
): Map<string, Record<string, string[]>> {
  const src = new DatabaseSync(dbFile, { readOnly: true });
  const entries = src.prepare(
    "SELECT rowid AS rid, * FROM entries WHERE superseded_at IS NULL AND stale = 0 AND confidence = 'CONFIRMED'",
  ).all() as Array<Record<string, unknown> & { rid: number }>;
  src.close();
  const byRid = new Map(entries.map(e => [e.rid, e]));
  const out = new Map<string, Record<string, string[]>>();
  for (const v of variants) {
    const db = new DatabaseSync(':memory:');
    try {
      out.set(v.name, v.v044 ? rankV044(db, entries, byRid, queries, limit) : rankVariant(db, entries, byRid, queries, v, limit));
    } finally {
      db.close();
    }
  }
  return out;
}

function rankVariant(
  db: DatabaseSync, entries: Array<Record<string, unknown> & { rid: number }>,
  byRid: Map<number, Record<string, unknown>>, queries: AblationQuery[], v: AblationVariant, limit: number,
): Record<string, string[]> {
  const cols: Column[] = v.legacyColumns ? ['title', 'summary', 'content', 'tags'] : [...KW_COLUMNS];
  db.exec(`CREATE VIRTUAL TABLE kw USING fts5(${cols.join(', ')}, tokenize = 'unicode61')`);
  db.exec("CREATE VIRTUAL TABLE entries_tri USING fts5(title, symbols, source_files, tokenize = 'trigram')");
  const ins = db.prepare(`INSERT INTO kw(rowid, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`);
  const insTri = db.prepare('INSERT INTO entries_tri(rowid, title, symbols, source_files) VALUES (?, ?, ?, ?)');
  for (const e of entries) {
    ins.run(e.rid, ...cols.map(c => tokens(ARRAY_COLUMNS.has(c) ? arrayText(e[c]) : String(e[c] ?? ''), v).join(' ')));
    insTri.run(e.rid, String(e.title ?? ''), arrayText(e.symbols), arrayText(e.source_files));
  }
  const w = v.weights === 'equal' ? null : (v.weights ?? KW_WEIGHTS);
  const bm25 = w ? `bm25(kw, ${cols.map(c => w[c]).join(', ')})` : 'bm25(kw)';
  const kwStmt = db.prepare(`SELECT rowid AS rid, ${bm25} AS s FROM kw WHERE kw MATCH ?`);
  const triStmt = db.prepare(`SELECT rowid AS rid, ${TRI_BM25} AS s FROM entries_tri WHERE entries_tri MATCH ?`);
  const res: Record<string, string[]> = {};
  for (const q of queries) {
    const match = orJoinFtsTerms(Array.from(new Set(tokens(q.query, v))).slice(0, MAX_QUERY_KEYWORD_TERMS));
    const hits = new Map<number, { ks: number | null; ts: number | null }>();
    if (match) for (const h of kwStmt.all(match) as Array<{ rid: number; s: number }>) hits.set(h.rid, { ks: h.s, ts: null });
    const tri = v.trigram === false ? '' : trigramMatch({ query: q.query });
    if (tri) {
      for (const h of triStmt.all(tri) as Array<{ rid: number; s: number }>) {
        const x = hits.get(h.rid);
        if (x) x.ts = h.s; else hits.set(h.rid, { ks: null, ts: h.s });
      }
    }
    // Same order as KbKeywordIndex.rankedSearch: keyword hits first, by kw
    // bm25, then trigram bm25, then created_at DESC.
    const created = (rid: number) => String(byRid.get(rid)!.created_at ?? '');
    res[q.id] = [...hits.entries()].sort(([ra, a], [rb, b]) => {
      if ((a.ks === null) !== (b.ks === null)) return a.ks === null ? 1 : -1;
      if (a.ks !== b.ks) return a.ks! - b.ks!;
      if (a.ts !== b.ts) {
        if (a.ts === null) return 1;
        if (b.ts === null) return -1;
        return a.ts - b.ts;
      }
      return created(rb).localeCompare(created(ra));
    }).slice(0, limit).map(([rid]) => String(byRid.get(rid)!.id));
  }
  return res;
}

function rankV044(
  db: DatabaseSync, entries: Array<Record<string, unknown> & { rid: number }>,
  byRid: Map<number, Record<string, unknown>>, queries: AblationQuery[], limit: number,
): Record<string, string[]> {
  db.exec('CREATE VIRTUAL TABLE fts USING fts5(title, summary, content, tags)');
  const ins = db.prepare('INSERT INTO fts(rowid, title, summary, content, tags) VALUES (?, ?, ?, ?, ?)');
  for (const e of entries) ins.run(e.rid, String(e.title ?? ''), String(e.summary ?? ''), String(e.content ?? ''), String(e.tags ?? '[]'));
  const stmt = db.prepare('SELECT rowid AS rid FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?');
  const res: Record<string, string[]> = {};
  for (const q of queries) {
    const match = orJoinFtsTerms(q.query.match(/[A-Za-z0-9_]+/g) ?? []);
    res[q.id] = match ? (stmt.all(match, limit) as Array<{ rid: number }>).map(r => String(byRid.get(r.rid)!.id)) : [];
  }
  return res;
}

/** The single-factor ablation the measurements doc reports. */
export const ABLATION_VARIANTS: AblationVariant[] = [
  { name: 'current (production weights)' },
  { name: 'pre-fix weights (5,3,1,1,4,4,4,4)', weights: PRE_FIX_KW_WEIGHTS },
  { name: 'pre-fix, source_files weight 1', weights: { ...PRE_FIX_KW_WEIGHTS, source_files: 1 } },
  { name: 'pre-fix, symbols weight 1', weights: { ...PRE_FIX_KW_WEIGHTS, symbols: 1 } },
  { name: 'equal weights (every column 1)', weights: 'equal' },
  { name: 'pre-fix, 0.4.4 columns only', weights: PRE_FIX_KW_WEIGHTS, legacyColumns: true },
  { name: 'pre-fix, no stemming', weights: PRE_FIX_KW_WEIGHTS, stem: false },
  { name: 'pre-fix, no identifier split', weights: PRE_FIX_KW_WEIGHTS, split: false },
  { name: 'pre-fix, no compact identifier token', weights: PRE_FIX_KW_WEIGHTS, compact: false },
  { name: 'pre-fix, no trigram', weights: PRE_FIX_KW_WEIGHTS, trigram: false },
  { name: '0.4.4 keyword read', v044: true },
];
