import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  DEFAULT_CONFIGS, loadQueries, loadEvalEntries, loadEvalProvider, runEval, formatReport,
  recallAtK, meanReciprocalRank, firstHitRank, missingExpectedIds, writeReportFile, type EvalReport,
} from '../helpers/kb-recall-eval.js';
// @ts-expect-error plain .mjs shared with scripts/gen-kb-recall-eval.mjs
import { leakage, LEAKAGE_CAP } from '../../scripts/kb-recall-leakage.mjs';

// Recall@5 / MRR over the labelled eval set. The numbers are printed on every
// run (npm test) so the D2 recall changes can be compared against this baseline.

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
}, 180_000);
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

  it('evaluates and reports the Resource-not-accessible query (top-5 assertion belongs to the hybrid lane)', () => {
    const miss = reports[0].perQuery.find(p => p.id === MISS_QUERY_ID);
    expect(miss).toBeDefined();
    console.log(`[kb-recall-eval] ${MISS_QUERY_ID}: push+pr entry rank=${miss!.rank ?? 'not in top 5'}`);
    // The labelled entry exists in the eval KB, so a null rank is a true miss
    // (measured, not an artifact); any rank is acceptable at this stage.
    expect(ctx.provider.hasEntry('eval-fixture-vcs-scope-push-pr')).toBe(true);
    expect(miss!.rank === null || (Number.isInteger(miss!.rank) && miss!.rank >= 1 && miss!.rank <= 5)).toBe(true);
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
