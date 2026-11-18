import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  loadQueries, loadEvalProvider, runEval, formatReport, providerRank, legacyRank,
  recallAtK, meanReciprocalRank, firstHitRank, missingExpectedIds, type EvalReport,
} from '../helpers/kb-recall-eval.js';
// @ts-expect-error plain .mjs (query-set provenance)
import { REAL } from '../../scripts/kb-recall-queries-real.mjs';
// @ts-expect-error plain .mjs (query-set provenance)
import { AUTHORED } from '../../scripts/kb-recall-queries-authored.mjs';
// @ts-expect-error plain .mjs
import { leakage, LEAKAGE_CAP } from '../../scripts/kb-recall-leakage.mjs';
import { loadBareBibleEntries } from '../helpers/kb-recall-eval.js';

// Keyword recall eval on the BARE bible (what a fresh clone's keyword search
// ranks): recall@5 and MRR@5 per query source, for the provider's keyword
// read and for the 0.4.4/0.4.5 keyword read (the legacy entries_fts index of
// the same kb.sqlite). Numbers and how they were chosen:
// docs/kb-recall-measurements.md.
//
// Floors. The 0.4.4/0.4.5 keyword read scores 0.8103 real / 0.7085 authored
// MRR@5 on this set (0.7984 / 0.7097 in the original 0.4.4 measurement, taken
// on a slightly different eval KB); the normalized, reweighted read scores
// 0.8345 / 0.8295. Each floor sits just under the measured value, and above
// the old read, so a ranking regression fails here.
const BARE_REAL_MRR_FLOOR = 0.83;
const BARE_AUTHORED_MRR_FLOOR = 0.82;
const BARE_REAL_RECALL_FLOOR = 0.9;
const LEGACY_REAL_MRR = 0.8103;
const LEGACY_AUTHORED_MRR = 0.7085;

let ctx: Awaited<ReturnType<typeof loadEvalProvider>>;
let report: EvalReport;
let legacy: EvalReport;

beforeAll(async () => {
  ctx = await loadEvalProvider();
  const queries = loadQueries();
  report = await runEval('keyword', providerRank(ctx.provider), queries);
  const old = legacyRank(ctx.dbFile);
  try {
    legacy = await runEval('0.4.5 keyword read', old.rank, queries);
  } finally {
    old.close();
  }
  console.log(formatReport(report));
  console.log(formatReport(legacy));
}, 120_000);
afterAll(() => ctx?.cleanup());

describe('recall metrics', () => {
  it('computes recall@5 and MRR on a hand-built ranking (hits at 1, 3, none)', () => {
    const ranks = [firstHitRank(['a', 'b'], ['a']), firstHitRank(['x', 'y', 'b'], ['b']), firstHitRank(['x'], ['z'])];
    expect(ranks).toEqual([1, 3, null]);
    expect(recallAtK(ranks)).toBeCloseTo(2 / 3);
    expect(meanReciprocalRank(ranks)).toBeCloseTo((1 + 1 / 3) / 3);
  });

  it('a hit beyond rank 5 does not count', () => {
    expect(firstHitRank(['a', 'b', 'c', 'd', 'e', 'f'], ['f'])).toBeNull();
  });
});

describe('KB recall eval set', () => {
  it('carries the real recorded queries, each with its provenance', () => {
    const real = loadQueries().filter(q => q.source === 'real');
    expect(real.length).toBeGreaterThanOrEqual(40);
    for (const q of real) {
      expect(q.provenance, `no provenance on ${q.id}`).toMatch(/^recorded kb_query, agent session [0-9a-f]{8} at \d{4}-\d\d-\d\dT/);
      expect(q.expected.length).toBeGreaterThan(0);
    }
  });

  it('matches its source lists: every real and authored query comes from the scripts', () => {
    const realQueries = new Set((REAL as Array<{ query: string }>).map(r => r.query));
    const authored = new Set(Object.values(AUTHORED as Record<string, string>));
    for (const q of loadQueries()) {
      if (q.source === 'real') expect(realQueries.has(q.query), q.id).toBe(true);
      if (q.source === 'authored') expect(authored.has(q.query), q.id).toBe(true);
    }
  });

  it('imports every bare-bible entry (rejected === 0) and every labelled id exists', () => {
    expect(ctx.counts.rejected).toBe(0);
    expect(missingExpectedIds(ctx.provider, loadQueries())).toEqual([]);
  });

  it('keeps every authored query under the leakage cap against its target title+summary', () => {
    const byId = new Map((loadBareBibleEntries() as Array<{ id: string; title: string; summary: string }>).map(e => [e.id, e]));
    for (const q of loadQueries()) {
      if (q.source === 'real') continue;
      const targets = q.expected.map(id => byId.get(id));
      for (const t of targets) expect(t, `no entry for ${q.id}`).toBeDefined();
      expect(Math.min(...targets.map(t => leakage(q.query, t!))), `query ${q.id} leaks the answer`).toBeLessThanOrEqual(LEAKAGE_CAP);
    }
  });
});

describe('bare bible keyword ranking', () => {
  it('the 0.4.5 keyword read measures the recorded baseline, below every floor', () => {
    expect(legacy.bySource.real.mrr).toBeCloseTo(LEGACY_REAL_MRR, 3);
    expect(legacy.bySource.authored.mrr).toBeCloseTo(LEGACY_AUTHORED_MRR, 3);
    expect(legacy.bySource.real.mrr).toBeLessThan(BARE_REAL_MRR_FLOOR);
    expect(legacy.bySource.authored.mrr).toBeLessThan(BARE_AUTHORED_MRR_FLOOR);
  });

  it('keyword MRR@5 on the bare bible stays at or above the floor and above the 0.4.4/0.4.5 read', () => {
    expect(report.bySource.real.mrr).toBeGreaterThanOrEqual(BARE_REAL_MRR_FLOOR);
    expect(report.bySource.real.recallAt5).toBeGreaterThanOrEqual(BARE_REAL_RECALL_FLOOR);
    expect(report.bySource.authored.mrr).toBeGreaterThanOrEqual(BARE_AUTHORED_MRR_FLOOR);
    expect(report.bySource.real.mrr).toBeGreaterThan(legacy.bySource.real.mrr);
    expect(report.bySource.authored.mrr).toBeGreaterThan(legacy.bySource.authored.mrr);
  });
});
