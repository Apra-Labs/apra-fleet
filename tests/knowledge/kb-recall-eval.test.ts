import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  DEFAULT_CONFIGS, loadQueries, loadEvalEntries, loadEvalProvider, runEval, formatReport,
  recallAtK, meanReciprocalRank, firstHitRank, missingExpectedIds, writeReportFile, type EvalReport,
  keywordConfig, hybridConfig, MODEL_EMBED_TIMEOUT_MS,
} from '../helpers/kb-recall-eval.js';
// @ts-expect-error plain .mjs shared with scripts/gen-kb-recall-eval.mjs
import { leakage, LEAKAGE_CAP } from '../../scripts/kb-recall-leakage.mjs';

// Recall@5 / MRR over the labelled eval set. The numbers are printed on every
// run (npm test) for each config: keyword-only (always), hybrid with the
// default embedding model and hybrid with an alternative model (each printed
// as SKIPPED with the reason when the model is not available locally -- npm
// test never downloads one; point APRA_KB_EVAL_MODELS_DIR at a models folder,
// or set APRA_KB_EVAL_ALLOW_DOWNLOAD=1 for a manual run, to measure them).

const MISS_QUERY_ID = 'real-miss-resource-not-accessible';
let ctx: Awaited<ReturnType<typeof loadEvalProvider>>;
const reports: EvalReport[] = [];

beforeAll(async () => {
  ctx = await loadEvalProvider();
  const queries = loadQueries();
  for (const cfg of DEFAULT_CONFIGS) {
    const report = await runEval(cfg, ctx.provider, queries);
    reports.push(report);
    console.log(formatReport(report));
  }
  console.log(`[kb-recall-eval] report file: ${writeReportFile(reports)}`);
}, 180_000 + 2 * MODEL_EMBED_TIMEOUT_MS);
afterAll(() => ctx?.cleanup());

describe('recall metrics', () => {
  it('computes recall@5 and MRR on a hand-built ranking (hits at 1, 3, none)', () => {
    const ranks = [
      firstHitRank(['a', 'b'], ['a']),
      firstHitRank(['x', 'y', 'b'], ['b']),
      firstHitRank(['x', 'y'], ['zzz']),
    ];
    expect(ranks).toEqual([1, 3, null]);
    expect(recallAtK(ranks)).toBeCloseTo(2 / 3, 10);
    expect(meanReciprocalRank(ranks)).toBeCloseTo((1 + 1 / 3 + 0) / 3, 10);
  });

  it('a hit beyond rank 5 does not count', () => {
    expect(firstHitRank(['1', '2', '3', '4', '5', 'a'], ['a'])).toBeNull();
  });
});

describe('KB recall eval set', () => {
  it('has at least one query per CONFIRMED bible entry plus the scope-error case', () => {
    const queries = loadQueries();
    const labelled = new Set(queries.flatMap(q => q.expected));
    const confirmed = (loadEvalEntries() as Array<{ id: string; confidence: string }>).filter(e => e.confidence === 'CONFIRMED');
    expect(confirmed.length).toBeGreaterThanOrEqual(129);
    for (const e of confirmed) expect(labelled.has(e.id), `no query for ${e.id}`).toBe(true);
    expect(queries.some(q => /Resource not accessible by integration/i.test(q.query))).toBe(true);
  });

  it('runs keyword-only and produces numbers above a regression floor', () => {
    expect(reports.length).toBeGreaterThan(0);
    const r = reports[0];
    expect(r.queries).toBeGreaterThanOrEqual(131);
    expect(Number.isFinite(r.recallAt5)).toBe(true);
    expect(Number.isFinite(r.mrr)).toBe(true);
    expect(r.recallAt5).toBeGreaterThanOrEqual(FLOOR_RECALL);
    expect(r.mrr).toBeGreaterThanOrEqual(FLOOR_MRR);
  });

  // Scope-error case (owner notes): the query carrying 'Resource not
  // accessible by integration', sent with error_text, MUST return the push+pr
  // entry within the top 5. Asserted in the keyword-only configuration, which
  // always runs (error_text is matched against error_signatures through the
  // normalized FTS index), and in the hybrid configuration when its model is
  // available. Note: this full query also carries the error in its free text
  // and the entry's summary quotes it, so on its own this assertion survives
  // dropping error_text (measured: rank 1 either way); the falsifiable
  // error_text check is the situation-only test below, where dropping
  // error_text, or no longer indexing error_signatures, makes it fail.
  it('scope-error query with error_text returns the push+pr entry in the top 5 (keyword-only and hybrid)', async () => {
    expect(ctx.provider.hasEntry('eval-fixture-vcs-scope-push-pr')).toBe(true);
    const query = loadQueries().find(q => q.id === MISS_QUERY_ID)!;
    expect(query.error_text).toBe('Resource not accessible by integration');

    const kw = reports.find(r => r.config === keywordConfig.name)!;
    const kwRank = kw.perQuery.find(p => p.id === MISS_QUERY_ID)!.rank;
    console.log(`[kb-recall-eval] ${MISS_QUERY_ID}: keyword-only push+pr rank=${kwRank ?? 'not in top 5'}`);
    expect(kwRank).not.toBeNull();
    expect(kwRank!).toBeLessThanOrEqual(5);

    const hy = reports.find(r => r.config === hybridConfig.name)!;
    if (hy.skipped === undefined) {
      const hyRank = hy.perQuery.find(p => p.id === MISS_QUERY_ID)!.rank;
      console.log(`[kb-recall-eval] ${MISS_QUERY_ID}: hybrid push+pr rank=${hyRank ?? 'not in top 5'}`);
      expect(hyRank).not.toBeNull();
      expect(hyRank!).toBeLessThanOrEqual(5);
    } else {
      console.log(`[kb-recall-eval] ${MISS_QUERY_ID}: hybrid not asserted (${hy.skipped})`);
    }
  });

  // The error_text path on its own: the same situation with the error moved
  // OUT of the query text and sent only as error_text. Falsifiability: drop
  // error_text from this call (the second read below) and the entry falls
  // from rank 1 to rank 5; stop indexing error_signatures (kb-index.ts
  // KW_COLUMNS, which the error list's column filter reads) and the
  // rank-1 assertion fails.
  it('error_text lifts the scope-error entry to rank 1 over the same situation without it', async () => {
    const q = loadQueries().find(x => x.id === MISS_QUERY_ID)!;
    const situation = q.query.replace(q.error_text!, '').replace(/[:\s]+$/, '').trim();
    expect(situation).not.toMatch(/Resource not accessible/i);
    const ranked = async (withError: boolean) => (await ctx.provider.query({
      query: situation,
      ...(withError ? { error_text: q.error_text } : {}),
      limit: 20, confidence: ['CONFIRMED'], disable_lists: ['semantic'],
    })).results.map(e => e.id);
    const withRank = firstHitRank(await ranked(true), q.expected);
    const withoutRank = firstHitRank(await ranked(false), q.expected);
    console.log(`[kb-recall-eval] ${MISS_QUERY_ID} situation-only: with error_text rank=${withRank ?? 'miss'}, without rank=${withoutRank ?? 'miss'}`);
    // Measured: rank 1 with error_text, rank 5 without it.
    expect(withRank).toBe(1);
    expect(withoutRank === null || withoutRank > withRank!).toBe(true);
  });

  it('reports every config: metrics, or a skip line with the reason', () => {
    expect(reports.map(r => r.config)).toEqual(DEFAULT_CONFIGS.map(c => c.name));
    for (const r of reports) {
      if (r.skipped !== undefined) expect(r.skipped.length).toBeGreaterThan(0);
      else expect(r.perQuery.length).toBe(r.queries);
    }
    // keyword-only never skips.
    expect(reports[0].skipped).toBeUndefined();
  });

  it('imports every eval entry (rejected === 0) and every labelled expected id exists', () => {
    expect(ctx.counts.rejected).toBe(0);
    expect(missingExpectedIds(ctx.provider, loadQueries())).toEqual([]);
  });

  it('keeps every query under the leakage cap against its target title+summary', () => {
    const byId = new Map((loadEvalEntries() as Array<{ id: string; title: string; summary: string }>).map(e => [e.id, e]));
    for (const q of loadQueries()) {
      const target = byId.get(q.expected[0]);
      expect(target, `no entry for ${q.id}`).toBeDefined();
      expect(leakage(q.query, target!), `query ${q.id} leaks the answer`).toBeLessThanOrEqual(LEAKAGE_CAP);
    }
  });
});

// Floors are set after measuring the keyword baseline (see bead close note).
const FLOOR_RECALL = 0.80; // measured keyword baseline 0.8550 (non-leaking queries)
const FLOOR_MRR = 0.70; // measured keyword baseline 0.7520
