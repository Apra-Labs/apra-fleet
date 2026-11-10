import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import {
  DEFAULT_CONFIGS, loadQueries, loadEvalEntries, loadEvalProvider, runEval, formatReport,
  recallAtK, meanReciprocalRank, firstHitRank, missingExpectedIds, writeReportFile, type EvalReport,
  keywordConfig, modelConfigs, MODEL_PROFILES, MODEL_EMBED_TIMEOUT_MS, modelsRequired, formatTable,
  semanticFloorSweep, formatFloorSweep, NONSENSE_QUERIES, guardOffConfigs, loadBareBibleEntries,
  hybridConfig, descriptionSignalSituations, rankSituations, useCountSnapshot, type DescriptionSituation,
} from '../helpers/kb-recall-eval.js';
import { capEmbedText, QUERY_EMBED_MAX_CHARS, type SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { keywordGuardFor } from '../../src/services/knowledge/hybrid-rank.js';
import { FakeEmbedder } from '../helpers/fake-embedder.js';
import { runKeywordAblation, ABLATION_VARIANTS } from '../helpers/kb-keyword-ablation.js';
import { buildV044Kb } from '../helpers/v044-kb-build.js';
import { kbQuerySchema } from '../../src/tools/kb-query.js';
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
const MISS_ENTRY_ID = '4f54d973-5627-49c3-903a-466695892a45';
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

describe('R@8 and the keyword top-5 guard comparison', () => {
  it('reports R@8 next to R@5 and MRR for every source and overall, and R@8 >= R@5', () => {
    const r = reports[0];
    expect(Number.isFinite(r.recallAt8)).toBe(true);
    expect(r.recallAt8).toBeGreaterThanOrEqual(r.recallAt5);
    for (const src of ['real', 'authored']) {
      expect(r.bySource[src].recallAt8).toBeGreaterThanOrEqual(r.bySource[src].recallAt5);
    }
    expect(formatReport(r)).toContain('R@8=');
    expect(formatTable(reports, 'real')).toContain('| R@8 |');
  });

  it('the guard-off switch is internal: not on the kb_query tool schema', () => {
    expect(Object.keys(kbQuerySchema.shape)).not.toContain('disable_keyword_guard');
    expect(kbQuerySchema.safeParse({ query: 'x', disable_keyword_guard: true }).success).toBe(true);
    const parsed = kbQuerySchema.parse({ query: 'x', disable_keyword_guard: true }) as Record<string, unknown>;
    expect(parsed.disable_keyword_guard).toBeUndefined();
  });

  it('real-set hybrid R@8 with the guard is not lower than with it off (APRA_KB_EVAL_GUARD_OFF=1, models present)', () => {
    for (const off of guardOffConfigs()) {
      const on = reports.find(x => x.config === off.name.replace('hybrid, guard off', 'hybrid'));
      const offR = reports.find(x => x.config === off.name);
      if (!on || !offR || on.skipped !== undefined || offR.skipped !== undefined) continue;
      console.log(`[kb-recall-eval] guard comparison ${off.name}: real R@5 ${on.bySource.real.recallAt5.toFixed(4)} vs ${offR.bySource.real.recallAt5.toFixed(4)}, R@8 ${on.bySource.real.recallAt8.toFixed(4)} vs ${offR.bySource.real.recallAt8.toFixed(4)}`);
      expect(on.bySource.real.recallAt8).toBeGreaterThanOrEqual(offR.bySource.real.recallAt8);
    }
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

// The BARE bible (bible-bare-live.json, no enrichment): what a fresh clone's
// keyword search ranks, and the set where keyword MRR had fallen below 0.4.4
// (docs/kb-recall-measurements.md). The ablation re-implements the keyword
// read with each factor switchable; its production variant must equal the
// provider's own result, so the table measures the real code path.
describe('bare bible keyword ranking against 0.4.4', () => {
  let bare: Awaited<ReturnType<typeof loadEvalProvider>>;
  let bareReport: EvalReport;
  let ablation: Map<string, Record<string, string[]>>;
  const dbFile = () => path.join(bare.dir, 'kb.sqlite');

  beforeAll(async () => {
    bare = await loadEvalProvider(loadBareBibleEntries());
    bareReport = await runEval(keywordConfig, bare.provider, loadQueries());
    ablation = runKeywordAblation(dbFile(), loadQueries(), ABLATION_VARIANTS.filter(v => v.v044 || !v.weights));
    console.log(`[kb-recall-eval] bare bible ${formatReport(bareReport).replace('[kb-recall-eval] ', '')}`);
  }, 120_000);
  afterAll(() => bare?.cleanup());

  it('imports the bare bible with no rejects and every labelled id present', () => {
    expect(bare.counts.rejected).toBe(0);
    expect(missingExpectedIds(bare.provider, loadQueries())).toEqual([]);
  });

  it('the ablation production variant reproduces the provider keyword-only order exactly', async () => {
    const mine = ablation.get('current (production weights)')!;
    for (const q of loadQueries()) {
      const got = (await bare.provider.query({ query: q.query, limit: 20, confidence: ['CONFIRMED'], disable_lists: ['semantic'] })).results.map(e => e.id);
      expect(mine[q.id], q.id).toEqual(got);
    }
  });

  it('prints keyword-only next to the 0.4.4 keyword read (real and authored)', () => {
    const v044 = ablation.get('0.4.4 keyword read')!;
    for (const src of ['real', 'authored']) {
      const qs = loadQueries().filter(q => q.source === src);
      const old = meanReciprocalRank(qs.map(q => firstHitRank(v044[q.id], q.expected)));
      console.log(`[kb-recall-eval] bare bible ${src}: keyword-only MRR ${bareReport.bySource[src].mrr.toFixed(4)}, 0.4.4 keyword read MRR ${old.toFixed(4)}`);
    }
  });

  // Manual measurement (APRA_KB_EVAL_ABLATION=1): the full single-factor
  // table on the bare and the enriched eval KB, and a cross-check of the
  // 0.4.4 port against the REAL 0.4.4 SqliteProvider built from the v0.4.4
  // tag (skipped loudly when the tag is not available).
  it('ablation table (APRA_KB_EVAL_ABLATION=1)', async () => {
    if (process.env.APRA_KB_EVAL_ABLATION !== '1') {
      console.log('[kb-recall-eval] ablation table SKIPPED: set APRA_KB_EVAL_ABLATION=1 to print it');
      return;
    }
    const queries = loadQueries();
    const sets: Array<[string, string]> = [['bare bible', dbFile()], ['enriched eval KB', path.join(ctx.dir, 'kb.sqlite')]];
    const lines = ['| variant | ' + sets.map(([n]) => `${n} real MRR | ${n} authored MRR`).join(' | ') + ' |', '|---|' + sets.map(() => '---|---|').join('')];
    const all = sets.map(([, f]) => runKeywordAblation(f, queries, ABLATION_VARIANTS));
    for (const v of ABLATION_VARIANTS) {
      const cells = all.flatMap(res => ['real', 'authored'].map(src => {
        const qs = queries.filter(q => q.source === src);
        return meanReciprocalRank(qs.map(q => firstHitRank(res.get(v.name)![q.id], q.expected))).toFixed(4);
      }));
      lines.push(`| ${v.name} | ${cells.join(' | ')} |`);
    }
    console.log(['KB keyword ablation (MRR@5)', '', ...lines].join('\n'));

    const real044 = await buildV044Kb(bare.dir);
    if (!real044.ok) {
      console.log(`[kb-recall-eval] 0.4.4 cross-check SKIPPED: ${real044.reason}`);
      return;
    }
    const out = real044.run(dbFile(), bare.dir, queries.map(q => ({ op: 'query' as const, query: q.query })));
    const port = all[0].get('0.4.4 keyword read')!;
    queries.forEach((q, i) => {
      const ids = (out[i] as { ids: string[] }).ids;
      expect(port[q.id].slice(0, 5), `0.4.4 port differs on ${q.id}`).toEqual(ids.slice(0, 5));
    });
  }, 300_000);

  // The fix (kb-index.ts KW_WEIGHTS) took bare-bible keyword-only real MRR
  // from 0.7294 to 0.8345, above 0.4.4's 0.7984. Falsifiability (checked by
  // hand): restoring the pre-fix weights (PRE_FIX_KW_WEIGHTS) makes this fail.
  it('keyword-only MRR on the bare bible stays at the fixed value and above the 0.4.4 keyword read', () => {
    const v044 = ablation.get('0.4.4 keyword read')!;
    const real = loadQueries().filter(q => q.source === 'real');
    const oldMrr = meanReciprocalRank(real.map(q => firstHitRank(v044[q.id], q.expected)));
    expect(bareReport.bySource.real.mrr).toBeGreaterThanOrEqual(BARE_REAL_MRR - BARE_TOLERANCE);
    expect(bareReport.bySource.real.mrr).toBeGreaterThan(oldMrr);
    expect(bareReport.bySource.authored.mrr).toBeGreaterThanOrEqual(BARE_AUTHORED_MRR - BARE_TOLERANCE);
  });

  // Guard window (hybrid-rank.ts keywordGuardFor): every keyword top-5 id is
  // inside what a limit-6 read returns. A deterministic fake embedder makes
  // every query hybrid (it has no similarity floor), so this runs without a
  // model. Falsifiability (checked by hand): a fixed window of 8 makes
  // losses > 0; the guard-off count proves the semantic list does displace
  // keyword rows here, so the assertion is not vacuous.
  it('at the member default limit 6 no query loses a keyword top-5 hit (deterministic embedder)', async () => {
    expect(keywordGuardFor(6)).toEqual({ keep: 5, within: 6 });
    expect(keywordGuardFor(8)).toEqual({ keep: 5, within: 8 });
    expect(keywordGuardFor(20)).toEqual({ keep: 5, within: 8 });
    const emb = new FakeEmbedder('eval/guard-window-fake', 'r1', 64);
    bare.provider.attachEmbedder(() => emb);
    try {
      expect(await bare.provider.waitForEmbeddings(60_000)).toBe(true);
      const losses = await guardLosses(bare.provider, 6);
      const lossesOff = await guardLosses(bare.provider, 6, true);
      console.log(`[kb-recall-eval] limit 6, deterministic embedder: queries losing a keyword top-5 hit ${losses}/${loadQueries().length} (guard off: ${lossesOff})`);
      expect(lossesOff).toBeGreaterThan(0);
      expect(losses).toBeLessThanOrEqual(GUARD_LOSSES_AT_6);
    } finally {
      bare.provider.attachEmbedder(null);
    }
  }, 120_000);
});

/** Queries whose keyword-only top 5 is not wholly inside a hybrid read of `limit` rows. */
async function guardLosses(provider: SqliteProvider, limit: number, guardOff = false): Promise<number> {
  let lost = 0;
  for (const q of loadQueries()) {
    const base = { query: q.query, ...(q.error_text ? { error_text: q.error_text } : {}), confidence: ['CONFIRMED' as const] };
    const kw = (await provider.query({ ...base, limit: 20, disable_lists: ['semantic', 'anchor', 'error'] })).results.map(e => e.id).slice(0, 5);
    const got = (await provider.query({ ...base, limit, ...(guardOff ? { disable_keyword_guard: true } : {}) })).results.map(e => e.id);
    if (kw.some(id => !got.includes(id))) lost++;
  }
  return lost;
}

// Bare bible, keyword-only, measured after the fix: real MRR 0.8345,
// authored 0.8283 (pre-fix 0.7294 / 0.8212; 0.4.4 0.7984 / 0.7097).
// Tolerance 0.01: less than one real query falling one place from rank 1
// (0.0119 on 42 queries), so any real-query regression fails.
const BARE_REAL_MRR = 0.8345;
const BARE_AUTHORED_MRR = 0.8283;
const BARE_TOLERANCE = 0.01;
// Measured with the chosen window min(8, limit): 0 (default model and the
// deterministic embedder); with the old fixed window of 8: 107-112 of 182.
const GUARD_LOSSES_AT_6 = 0;

// Engine situations whose signal is in the description (fleet-sprint
// roleHints): the title and description must lead the situation text, so the
// part of it the KB embeds (QUERY_EMBED_MAX_CHARS) carries the description.
// Measured on a fresh enriched eval KB with use_count reset before each pass
// (docs/kb-recall-measurements.md): keyword + anchor MRR 0.6667 (0.4512 with
// the old 'about to change <symbols> in <paths>, which <title>' lead), hybrid
// with the default model 0.7477 (0.1138 before; the judge's set: 0.612).
// Falsifiability (checked by hand): restoring the old situation format in
// kb-hints.mjs makes the embedded-signal and keyword + anchor assertions fail.
describe('engine situations whose signal is in the description', () => {
  let fresh: Awaited<ReturnType<typeof loadEvalProvider>>;
  let sits: DescriptionSituation[];
  let resetUseCounts: () => void;

  beforeAll(async () => {
    fresh = await loadEvalProvider();
    resetUseCounts = useCountSnapshot(path.join(fresh.dir, 'kb.sqlite'));
    sits = descriptionSignalSituations();
  }, 120_000);
  afterAll(() => fresh?.cleanup());

  it('the embedded part of every situation carries its whole description signal', () => {
    expect(sits.length).toBeGreaterThanOrEqual(139);
    const missing = sits.filter(s => !capEmbedText(s.situation, QUERY_EMBED_MAX_CHARS).includes(s.signal)).map(s => s.id);
    expect(missing).toEqual([]);
  });

  it('keyword + anchor (no model) MRR stays at the measured value', async () => {
    resetUseCounts();
    const mrr = meanReciprocalRank(await rankSituations(fresh.provider, sits, false));
    console.log(`[kb-recall-eval] description-signal situations: keyword + anchor MRR ${mrr.toFixed(4)}`);
    expect(mrr).toBeGreaterThanOrEqual(DESC_KEYWORD_MRR - DESC_TOLERANCE);
  });

  it('hybrid MRR and the limit-6 guard with the default model stay at the measured values (SKIPPED without the model)', async () => {
    const rank = await hybridConfig.setup(fresh.provider);
    if ('skip' in rank) {
      console.log(`[kb-recall-eval] description-signal hybrid (${MODEL_PROFILES[0]}) SKIPPED: ${rank.skip}`);
      if (modelsRequired()) expect.fail(`APRA_KB_EVAL_REQUIRE_MODELS=1 but ${hybridConfig.name} skipped: ${rank.skip}`);
      return;
    }
    try {
      resetUseCounts();
      const mrr = meanReciprocalRank(await rankSituations(fresh.provider, sits, true));
      console.log(`[kb-recall-eval] description-signal situations: hybrid (${MODEL_PROFILES[0]}) MRR ${mrr.toFixed(4)}`);
      expect(mrr).toBeGreaterThanOrEqual(DESC_HYBRID_MRR - DESC_TOLERANCE);
      expect(mrr).toBeGreaterThan(0.612);
      // The guard window with the real model at the member default limit.
      const losses = await guardLosses(fresh.provider, 6);
      console.log(`[kb-recall-eval] limit 6, ${MODEL_PROFILES[0]}: queries losing a keyword top-5 hit ${losses}/${loadQueries().length}`);
      expect(losses).toBeLessThanOrEqual(GUARD_LOSSES_AT_6);
    } finally {
      await hybridConfig.teardown?.(fresh.provider);
    }
  }, MODEL_EMBED_TIMEOUT_MS);
});

// Description-signal situations, measured: keyword + anchor 0.6667, hybrid
// (default model) 0.7477. Tolerance 0.01: about three of the 139 situations
// falling one place from rank 1 (0.0036 each).
const DESC_KEYWORD_MRR = 0.6667;
const DESC_HYBRID_MRR = 0.7477;
const DESC_TOLERANCE = 0.01;

// Keyword-only regression floors, set below the measured baselines.
// Authored set (139 queries): measured recall@5 0.9137, MRR 0.8348.
const FLOOR_RECALL = 0.85;
const FLOOR_MRR = 0.75;
// Real set (42 recorded queries): measured recall@5 0.9762, MRR 0.9167.
const FLOOR_REAL_RECALL = 0.95;
const FLOOR_REAL_MRR = 0.85;

// Max recall@5 / MRR loss allowed for the semantic floor against no floor
// (one query of the 42-query real set is 0.024).
const FLOOR_TOLERANCE = 0.03;
