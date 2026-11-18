import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { importBibleEntries } from '../../src/services/knowledge/bible-import.js';
import { orJoinFtsTerms } from '../../src/services/knowledge/audn.js';

// KB recall evaluation harness (keyword ranking). Loads a pinned bible into a
// temp SqliteProvider, runs labelled queries through the same provider read
// kb_query uses (CONFIRMED only) and computes recall@5 and MRR@5, overall and
// per query source:
//   real        recorded kb_query traffic, copied verbatim
//               (scripts/kb-recall-queries-real.mjs) -- the headline set;
//   authored    one situation query per CONFIRMED bible entry
//               (scripts/kb-recall-queries-authored.mjs);
//   owner-notes the one owner-reported scope-error case.
// Fixtures (tests/fixtures/kb-recall-eval/) are checked in; the eval never
// regenerates them. Numbers and their history: docs/kb-recall-measurements.md.

export const EVAL_DIR = path.resolve(__dirname, '../fixtures/kb-recall-eval');
/**
 * The BARE bible: a pinned copy of .fleet/kb-canonical.json as committed on
 * 2026-11-10 (178 entries; title, summary, symbols and source_files only --
 * no content). This is what a fresh clone's keyword search ranks. Re-pin it
 * only together with docs/kb-recall-measurements.md and the floors in
 * tests/knowledge/kb-recall-eval.test.ts.
 */
export const BARE_BIBLE_PATH = path.join(EVAL_DIR, 'bible-bare-live.json');
export const RECALL_K = 5;

export interface EvalQuery { id: string; query: string; expected: string[]; source: string; provenance?: string }

export function loadQueries(): EvalQuery[] {
  return JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'queries.json'), 'utf-8')).queries;
}

/** The bare bible plus the extra labelled entry (the owner-reported case). */
export function loadBareBibleEntries(): unknown[] {
  const bible = JSON.parse(fs.readFileSync(BARE_BIBLE_PATH, 'utf-8')).entries as Array<Record<string, unknown>>;
  const extra = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'extra-entries.json'), 'utf-8')).entries as Array<Record<string, unknown>>;
  return [...bible, ...extra];
}

/** 1-based rank of the first expected id within the top `k`, or null. */
export function firstHitRank(ranked: string[], expected: string[], k = RECALL_K): number | null {
  const idx = ranked.slice(0, k).findIndex(id => expected.includes(id));
  return idx === -1 ? null : idx + 1;
}

export function recallAtK(ranks: Array<number | null>): number {
  if (ranks.length === 0) return 0;
  return ranks.filter(r => r !== null).length / ranks.length;
}

export function meanReciprocalRank(ranks: Array<number | null>): number {
  if (ranks.length === 0) return 0;
  return ranks.reduce<number>((s, r) => s + (r === null ? 0 : 1 / r), 0) / ranks.length;
}

export interface SetMetrics { queries: number; recallAt5: number; mrr: number }

/** Cut-offs reported next to recall@5: the candidate member row caps. */
export const RECALL_CAPS = [6, 8] as const;

export interface EvalReport {
  name: string;
  overall: SetMetrics;
  bySource: Record<string, SetMetrics>;
  /** rank: first hit within the top 5; rank20: within the top 20 (for recall at other cut-offs). */
  perQuery: Array<{ id: string; source: string; rank: number | null; rank20: number | null }>;
}

/** Recall within the top `k` for one query source (or every query when source is omitted). */
export function recallAtCap(r: EvalReport, k: number, source?: string): number {
  const rows = r.perQuery.filter(p => source === undefined || p.source === source);
  return recallAtK(rows.map(p => (p.rank20 !== null && p.rank20 <= k ? p.rank20 : null)));
}

export type RankFn = (q: EvalQuery) => Promise<string[]> | string[];

export interface EvalImportCounts { imported: number; skipped: number; linked: number; rejected: number }

export async function loadEvalProvider(entries: unknown[] = loadBareBibleEntries()): Promise<{
  provider: SqliteProvider; dir: string; dbFile: string; counts: EvalImportCounts; cleanup: () => void;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-recall-eval-'));
  const dbFile = path.join(dir, 'kb.sqlite');
  const provider = new SqliteProvider(dbFile);
  await provider.init();
  const res = await importBibleEntries(provider, entries, { verbatim: true });
  return {
    provider, dir, dbFile,
    counts: { imported: res.imported, skipped: res.skipped, linked: res.linked, rejected: res.rejected },
    cleanup: () => { provider.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/** The provider read kb_query's L1 makes (CONFIRMED only), top 20 ids. */
export function providerRank(provider: SqliteProvider): RankFn {
  return async (q) => (await provider.query({ query: q.query, limit: 20, confidence: ['CONFIRMED'] })).results.map(e => e.id);
}

/**
 * The 0.4.4 / 0.4.5 keyword read, run against the legacy entries_fts index of
 * the same kb.sqlite: raw [A-Za-z0-9_] tokens OR-joined, unweighted bm25 over
 * title, summary, content and tags. The baseline the new ranking must beat.
 */
export function legacyRank(dbFile: string): { rank: RankFn; close: () => void } {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const stmt = db.prepare(`
    SELECT e.id FROM entries e
    JOIN entries_fts ON entries_fts.rowid = e.rowid
    WHERE entries_fts MATCH ? AND e.superseded_at IS NULL AND e.stale = 0 AND e.confidence = 'CONFIRMED'
    ORDER BY rank LIMIT 20
  `);
  return {
    rank: (q) => {
      const fts = orJoinFtsTerms(q.query.match(/[A-Za-z0-9_]+/g) ?? []);
      if (!fts) return [];
      return (stmt.all(fts) as Array<{ id: string }>).map(r => r.id);
    },
    close: () => db.close(),
  };
}

export async function runEval(name: string, rank: RankFn, queries: EvalQuery[]): Promise<EvalReport> {
  const perQuery: EvalReport['perQuery'] = [];
  for (const q of queries) {
    const ranked = await rank(q);
    perQuery.push({ id: q.id, source: q.source, rank: firstHitRank(ranked, q.expected), rank20: firstHitRank(ranked, q.expected, 20) });
  }
  const metrics = (ranks: Array<number | null>): SetMetrics => ({ queries: ranks.length, recallAt5: recallAtK(ranks), mrr: meanReciprocalRank(ranks) });
  const bySource: Record<string, SetMetrics> = {};
  for (const src of new Set(queries.map(q => q.source))) {
    bySource[src] = metrics(perQuery.filter((_, i) => queries[i].source === src).map(p => p.rank));
  }
  return { name, overall: metrics(perQuery.map(p => p.rank)), bySource, perQuery };
}

export function formatReport(r: EvalReport): string {
  const line = (label: string, m: SetMetrics) =>
    `[kb-recall-eval] ${label}: queries=${m.queries} recall@5=${m.recallAt5.toFixed(4)} MRR@5=${m.mrr.toFixed(4)}`;
  const caps = (src: string) => RECALL_CAPS.map(k => `R@${k}=${recallAtCap(r, k, src).toFixed(4)}`).join(' ');
  return [
    line(`${r.name} overall`, r.overall),
    ...Object.entries(r.bySource).map(([s, m]) => `${line(`${r.name} ${s}`, m)} ${caps(s)}`),
  ].join('\n');
}

/** Labelled expected ids that are not present in the eval KB (a missing label can never hit). */
export function missingExpectedIds(provider: SqliteProvider, queries: EvalQuery[]): string[] {
  return [...new Set(queries.flatMap(q => q.expected))].filter(id => !provider.hasEntry(id));
}
