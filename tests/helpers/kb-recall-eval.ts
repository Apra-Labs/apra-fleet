import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { importBibleEntries } from '../../src/services/knowledge/bible-import.js';

// KB recall evaluation harness: loads the checked-in bible (plus eval-only
// fixture entries) into a temp SqliteProvider, runs labelled queries and
// computes recall@K and MRR. Configurations are pluggable so later lanes can
// add hybrid / alternative-embedding-model configs.

export const EVAL_DIR = path.resolve(__dirname, '../fixtures/kb-recall-eval');
export const BIBLE_PATH = path.resolve(__dirname, '../../.fleet/kb-canonical.json');
export const RECALL_K = 5;

export interface EvalQuery { id: string; query: string; expected: string[]; source: string }

/** A ranker returns ranked entry ids for a query. */
export interface EvalConfig {
  name: string;
  /** Prepare the config against a freshly loaded provider. */
  setup(provider: SqliteProvider): Promise<(query: string) => Promise<string[]>>;
}

export const keywordConfig: EvalConfig = {
  name: 'keyword-only (embedding.model none)',
  async setup(provider) {
    return async (query: string) => {
      const r = await provider.query({ query, limit: 20, confidence: ['CONFIRMED'] });
      return r.results.map(e => e.id);
    };
  },
};

export const DEFAULT_CONFIGS: EvalConfig[] = [keywordConfig];

export function loadQueries(): EvalQuery[] {
  return JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'queries.json'), 'utf-8')).queries;
}

export function loadEvalEntries(): unknown[] {
  const bible = JSON.parse(fs.readFileSync(BIBLE_PATH, 'utf-8')).entries as unknown[];
  const extra = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'extra-entries.json'), 'utf-8')).entries as unknown[];
  return [...bible, ...extra];
}

/** 1-based rank of the first expected id within the top `k`, or null. */
export function firstHitRank(ranked: string[], expected: string[], k = RECALL_K): number | null {
  const idx = ranked.slice(0, k).findIndex(id => expected.includes(id));
  return idx === -1 ? null : idx + 1;
}

/** ranks: per-query 1-based hit rank within top-K, or null for a miss. */
export function recallAtK(ranks: Array<number | null>): number {
  if (ranks.length === 0) return 0;
  return ranks.filter(r => r !== null).length / ranks.length;
}

export function meanReciprocalRank(ranks: Array<number | null>): number {
  if (ranks.length === 0) return 0;
  return ranks.reduce<number>((s, r) => s + (r === null ? 0 : 1 / r), 0) / ranks.length;
}

export interface EvalReport {
  config: string;
  queries: number;
  recallAt5: number;
  mrr: number;
  perQuery: Array<{ id: string; rank: number | null }>;
}

export interface EvalImportCounts { imported: number; skipped: number; linked: number; rejected: number }

export async function loadEvalProvider(): Promise<{ provider: SqliteProvider; dir: string; counts: EvalImportCounts; cleanup: () => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-recall-eval-'));
  const provider = new SqliteProvider(path.join(dir, 'kb.sqlite'));
  await provider.init();
  const res = await importBibleEntries(provider, loadEvalEntries(), { verbatim: true });
  const counts: EvalImportCounts = { imported: res.imported, skipped: res.skipped, linked: res.linked, rejected: res.rejected };
  return {
    provider, dir, counts,
    cleanup: () => { provider.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

export async function runEval(config: EvalConfig, provider: SqliteProvider, queries: EvalQuery[]): Promise<EvalReport> {
  const rank = await config.setup(provider);
  const perQuery: EvalReport['perQuery'] = [];
  for (const q of queries) perQuery.push({ id: q.id, rank: firstHitRank(await rank(q.query), q.expected) });
  const ranks = perQuery.map(p => p.rank);
  return { config: config.name, queries: queries.length, recallAt5: recallAtK(ranks), mrr: meanReciprocalRank(ranks), perQuery };
}

export function formatReport(r: EvalReport): string {
  return `[kb-recall-eval] config="${r.config}" queries=${r.queries} recall@5=${r.recallAt5.toFixed(4)} MRR=${r.mrr.toFixed(4)}`;
}

/** Labelled expected ids that are not present in the eval KB (a missing label can never hit). */
export function missingExpectedIds(provider: SqliteProvider, queries: EvalQuery[]): string[] {
  return [...new Set(queries.flatMap(q => q.expected))].filter(id => !provider.hasEntry(id));
}

/**
 * Writes the reports as JSON so a later lane can read the numbers even when the
 * vitest reporter hides console output. Default location is the OS temp dir
 * (nothing is written into the repo); override with APRA_KB_RECALL_REPORT.
 */
export function writeReportFile(reports: EvalReport[]): string {
  const file = process.env.APRA_KB_RECALL_REPORT || path.join(os.tmpdir(), 'apra-kb-recall-eval', 'report.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2) + '\n');
  return file;
}
