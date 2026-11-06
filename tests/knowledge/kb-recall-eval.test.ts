import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import {
  DEFAULT_CONFIGS, loadQueries, loadEvalEntries, loadEvalProvider, runEval, formatReport,
  recallAtK, meanReciprocalRank, firstHitRank, missingExpectedIds, writeReportFile, type EvalReport,
  keywordConfig, modelConfigs, MODEL_PROFILES, MODEL_EMBED_TIMEOUT_MS, modelsRequired, formatTable,
  semanticFloorSweep, formatFloorSweep, NONSENSE_QUERIES,
} from '../helpers/kb-recall-eval.js';
import { BUILTIN_EMBEDDING_PROFILES } from '../../src/services/knowledge/embedding/profiles.js';
// @ts-expect-error plain .mjs shared with scripts/gen-kb-recall-eval.mjs
import { leakage, LEAKAGE_CAP } from '../../scripts/kb-recall-leakage.mjs';

// Recall@5 / MRR over the labelled eval set, overall and per query source:
// REAL (recorded kb_query traffic, verbatim -- the headline set), AUTHORED
// (one situation query per CONFIRMED bible entry) and the owner-reported
// scope-error case. The numbers are printed on every run (npm test) for each
// config: keyword-only (always) and hybrid with each built-in embedding model
// (each printed as SKIPPED with the reason when the model is not available
// locally -- npm test never downloads one; point APRA_KB_EVAL_MODELS_DIR at a
// models folder, or set APRA_KB_EVAL_ALLOW_DOWNLOAD=1, to measure them. The
// nightly real-model lane also sets APRA_KB_EVAL_REQUIRE_MODELS=1 so a model
// that cannot load fails instead of skipping).

const MISS_QUERY_ID = 'real-miss-resource-not-accessible';
const MISS_ENTRY_ID = 'eval-real-memory-vcs-auth-explicit-access';
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
  for (const src of ['real', 'authored']) console.log(formatTable(reports, src));
  console.log(`[kb-recall-eval] report file: ${writeReportFile(reports)}`);
}, 180_000 + MODEL_PROFILES.length * MODEL_EMBED_TIMEOUT_MS);
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
  it('carries the real recorded queries, each with its provenance and a label in the eval KB', () => {
    const real = loadQueries().filter(q => q.source === 'real');
    expect(real.length).toBeGreaterThanOrEqual(40);
    for (const q of real) {
      expect(q.provenance, `no provenance on ${q.id}`).toMatch(/^recorded kb_query, agent session [0-9a-f]{8} at \d{4}-\d\d-\d\dT/);
      expect(q.expected.length).toBeGreaterThan(0);
    }
    for (const q of loadQueries()) expect(q.provenance, `no provenance on ${q.id}`).toBeTruthy();
  });

  it('measures entries with real content, recall_cues and error_signatures (not title-only)', () => {
    const entries = loadEvalEntries() as Array<{ id: string; summary: string; content?: string; recall_cues?: string[]; error_signatures?: string[] }>;
    expect(entries.filter(e => typeof e.content === 'string' && e.content.length > e.summary.length).length).toBeGreaterThanOrEqual(15);
    expect(entries.filter(e => (e.recall_cues ?? []).length > 0).length).toBeGreaterThanOrEqual(100);
    expect(entries.filter(e => (e.error_signatures ?? []).length > 0).length).toBeGreaterThanOrEqual(3);
    // The stored rows carry them too (bible import keeps the D9 fields).
    const target = entries.find(e => e.id === MISS_ENTRY_ID)!;
    expect(ctx.provider.hasEntry(target.id)).toBe(true);
  });

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
    expect(r.queries).toBeGreaterThanOrEqual(180);
    expect(Number.isFinite(r.recallAt5)).toBe(true);
    expect(Number.isFinite(r.mrr)).toBe(true);
    expect(r.bySource.authored.recallAt5).toBeGreaterThanOrEqual(FLOOR_RECALL);
    expect(r.bySource.authored.mrr).toBeGreaterThanOrEqual(FLOOR_MRR);
    expect(r.bySource.real.recallAt5).toBeGreaterThanOrEqual(FLOOR_REAL_RECALL);
    expect(r.bySource.real.mrr).toBeGreaterThanOrEqual(FLOOR_REAL_MRR);
  });

  it('runs every built-in model config, or skips it loudly -- and fails a skip when models are required', () => {
    for (const cfg of modelConfigs) {
      const r = reports.find(x => x.config === cfg.name)!;
      if (r.skipped !== undefined) {
        console.log(`[kb-recall-eval] ${cfg.name} SKIPPED: ${r.skipped}`);
        if (modelsRequired()) expect.fail(`APRA_KB_EVAL_REQUIRE_MODELS=1 but ${cfg.name} skipped: ${r.skipped}`);
      }
    }
  });

  // Scope-error case (owner notes): the query carrying 'Resource not
  // accessible by integration', sent with error_text, MUST return the real
  // push+pr entry (the recorded operator memory on VCS auth access levels)
  // within the top 5. Asserted in the keyword-only configuration, which always
  // runs (error_text is matched against error_signatures through the
  // normalized FTS index), and in every model configuration that ran. Note:
  // this full query also carries the error in its free text and the entry's
  // content quotes it, so on its own this assertion can survive dropping
  // error_text; the falsifiable error_text check is the situation-only test
  // below, where dropping error_text, or no longer indexing error_signatures,
  // makes it fail.
  it('scope-error query with error_text returns the push+pr entry in the top 5 (keyword-only and every model)', async () => {
    expect(ctx.provider.hasEntry(MISS_ENTRY_ID)).toBe(true);
    const query = loadQueries().find(q => q.id === MISS_QUERY_ID)!;
    expect(query.error_text).toBe('Resource not accessible by integration');

    const kw = reports.find(r => r.config === keywordConfig.name)!;
    const kwRank = kw.perQuery.find(p => p.id === MISS_QUERY_ID)!.rank;
    console.log(`[kb-recall-eval] ${MISS_QUERY_ID}: keyword-only push+pr rank=${kwRank ?? 'not in top 5'}`);
    expect(kwRank).not.toBeNull();
    expect(kwRank!).toBeLessThanOrEqual(5);

    for (const cfg of modelConfigs) {
      const hy = reports.find(r => r.config === cfg.name)!;
      if (hy.skipped === undefined) {
        const hyRank = hy.perQuery.find(p => p.id === MISS_QUERY_ID)!.rank;
        console.log(`[kb-recall-eval] ${MISS_QUERY_ID}: ${cfg.name} push+pr rank=${hyRank ?? 'not in top 5'}`);
        expect(hyRank, cfg.name).not.toBeNull();
        expect(hyRank!, cfg.name).toBeLessThanOrEqual(5);
      } else {
        console.log(`[kb-recall-eval] ${MISS_QUERY_ID}: ${cfg.name} not asserted (${hy.skipped})`);
      }
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

  // Semantic similarity floor (profiles.ts SEMANTIC_FLOORS): for every model
  // that loaded, at its configured floor no nonsense query's result differs
  // from keyword-only, and recall@5 / MRR on the real and authored sets stay
  // within FLOOR_TOLERANCE of the same model with no floor. Runs in the
  // nightly real-model lane (models present); a skipped model is reported by
  // the config test above. Falsifiability: set a model's floor to 0 and the
  // nonsense assertion fails (26 of 26 nonsense queries change).
  it('semantic floor: nonsense queries equal keyword-only, recall/MRR within tolerance of no floor (every loaded model)', async () => {
    const queries = loadQueries();
    for (const cfg of modelConfigs) {
      const r = reports.find(x => x.config === cfg.name)!;
      if (r.skipped !== undefined) continue;
      const name = MODEL_PROFILES[modelConfigs.indexOf(cfg)];
      const floor = BUILTIN_EMBEDDING_PROFILES[name].semanticFloor!;
      const rank = await cfg.setup(ctx.provider);
      if ('skip' in rank) continue;
      try {
        const [none, at] = await semanticFloorSweep(ctx.provider, queries, [null, floor], path.join(ctx.dir, 'kb.sqlite'));
        console.log(formatFloorSweep(name, [none, at]));
        expect(at.nonsenseChanged, `${name}: nonsense queries changed at floor ${floor} (of ${NONSENSE_QUERIES.length})`).toBe(0);
        expect(none.nonsenseChanged, `${name}: the floor is doing nothing`).toBeGreaterThan(0);
        for (const set of ['real', 'authored'] as const) {
          expect(at[set].recallAt5, `${name} ${set} recall@5`).toBeGreaterThanOrEqual(none[set].recallAt5 - FLOOR_TOLERANCE);
          expect(at[set].mrr, `${name} ${set} MRR`).toBeGreaterThanOrEqual(none[set].mrr - FLOOR_TOLERANCE);
        }
      } finally {
        await cfg.teardown?.(ctx.provider);
      }
    }
  }, MODEL_PROFILES.length * MODEL_EMBED_TIMEOUT_MS);

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

  // Authored and owner-reported queries are capped; real recorded queries are
  // exempt (copied verbatim from agents that did not know the answer -- see
  // scripts/kb-recall-queries-real.mjs) and their leakage is printed instead.
  it('keeps every authored query under the leakage cap against its target title+summary', () => {
    const byId = new Map((loadEvalEntries() as Array<{ id: string; title: string; summary: string }>).map(e => [e.id, e]));
    const realLeak: number[] = [];
    for (const q of loadQueries()) {
      const targets = q.expected.map(id => byId.get(id));
      for (const t of targets) expect(t, `no entry for ${q.id}`).toBeDefined();
      const l = Math.min(...targets.map(t => leakage(q.query, t!)));
      if (q.source === 'real') realLeak.push(l);
      else expect(l, `query ${q.id} leaks the answer`).toBeLessThanOrEqual(LEAKAGE_CAP);
    }
    const over = realLeak.filter(l => l > LEAKAGE_CAP).length;
    console.log(`[kb-recall-eval] real-query leakage (not capped): ${over}/${realLeak.length} over ${LEAKAGE_CAP}, mean ${(realLeak.reduce((a, b) => a + b, 0) / realLeak.length).toFixed(2)}`);
  });
});

// Keyword-only regression floors, set below the measured baselines.
// Authored set (139 queries): measured recall@5 0.9137, MRR 0.8288.
const FLOOR_RECALL = 0.85;
const FLOOR_MRR = 0.75;
// Real set (42 recorded queries): measured recall@5 1.0000, MRR 0.9083.
const FLOOR_REAL_RECALL = 0.95;
const FLOOR_REAL_MRR = 0.85;

// Max recall@5 / MRR loss allowed for the semantic floor against no floor
// (one query of the 42-query real set is 0.024).
const FLOOR_TOLERANCE = 0.03;
