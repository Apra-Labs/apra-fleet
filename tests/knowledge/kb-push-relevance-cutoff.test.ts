import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  loadEvalProvider, loadBareBibleEntries, loadEvalEntries, loadQueries, hybridConfig, useCountSnapshot,
  modelsRequired, MODEL_PROFILES, MODEL_EMBED_TIMEOUT_MS,
} from '../helpers/kb-recall-eval.js';
import {
  loadPushBeads, loadPushLabels, measurePushBlocks, formatPushMeasurement, pushBlockFor, providerMemberCall,
  explicitQueryIds, EXPLICIT_SNAPSHOT_PATH, type ExplicitIds, type PushMeasurement,
} from '../helpers/kb-push-path.js';
import { FakeEmbedder } from '../helpers/fake-embedder.js';
import { KbKeywordIndex, keywordMatch } from '../../src/services/knowledge/kb-index.js';
import {
  passesKeywordCutoff, keywordRelevance, RELEVANCE_MIN_KEYWORD_SCORE, RELEVANCE_TOP_RATIO,
} from '../../src/services/knowledge/hybrid-rank.js';
import type { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
// @ts-expect-error plain .mjs (fleet-sprint engine)
import { createKbWorkClient } from '../../packages/apra-fleet-se/fleet-sprint/kb.mjs';
// @ts-expect-error plain .mjs (fleet-sprint engine)
import { createKbInjection } from '../../packages/apra-fleet-se/fleet-sprint/kb-injection.mjs';
// @ts-expect-error plain .mjs (fleet-sprint engine hints)
import { roleHints } from '../../packages/apra-fleet-se/fleet-sprint/kb-hints.mjs';

// The push-path relevance cutoff (kb_query relevant_only), measured in
// docs/kb-recall-measurements.md ("Relevance cutoff on the push path"). Every
// test runs the real fleet-sprint knowledgeFor (kb.mjs) and roleHints over a
// real SqliteProvider loaded with the pinned bible -- no hand-built result
// lists -- and the explicit-caller test goes through the real kb_query tool
// handler (only session-scope resolution is stubbed).
//
// Falsifiability (checked by hand, recorded on the tracker): making
// SqliteProvider.relevantRows return its rows uncut makes "no pushed row is
// below the cutoff" fail (rows with keyword relevance under 2.5 come back),
// and the empty-block and no-model tests fail with it.

const kbState = vi.hoisted(() => ({ p: undefined as unknown }));
vi.mock('../../src/services/tool-scope.js', () => ({
  getSessionMemberId: () => undefined,
  getSessionKbMaintainer: () => false,
  getSessionEngineOrigin: () => false,
}));
vi.mock('../../src/services/knowledge/kb-self.js', () => {
  const providers = () => ({ project: kbState.p, global: kbState.p, projectSlug: 'push-cutoff' });
  return {
    getSelfKbProviders: async () => providers(),
    getSelfReadKb: async () => ({ providers: providers(), anchor: { folder: process.cwd() }, memberView: false }),
    getMemberSplitRead: async () => null,
    mergeSplitById: (a: unknown[]) => a,
    memberOwnerTag: () => undefined,
  };
});
import { kbQuery, kbQuerySchema } from '../../src/tools/kb-query.js';

// Measured on the push-path set, no model (deterministic):
// before 55 relevant / 137 irrelevant, after 41 / 55. With the default
// model: after 41 / 49.
const NO_MODEL_AFTER = { relevant: 41, irrelevant: 55 };
const MODEL_AFTER = { relevant: 41, irrelevant: 49 };

/** Independent keyword score read (not the provider's cutoff code): bm25 of each id, the index size. */
function keywordScoresOf(dbFile: string, situation: string, ids: string[]): { scores: Map<string, number>; docs: number } {
  const db = new DatabaseSync(dbFile);
  try {
    const { sql, bind } = KbKeywordIndex.hitsSql(keywordMatch({ query: situation }), '');
    const hits = db.prepare(sql).all(...bind) as Array<{ rid: number; ks: number | null }>;
    const idOf = new Map((db.prepare('SELECT rowid AS rid, id FROM entries').all() as Array<{ rid: number; id: string }>).map(r => [r.rid, r.id]));
    const all = new Map<string, number>();
    for (const h of hits) if (h.ks !== null) all.set(idOf.get(h.rid)!, h.ks);
    const docs = Number((db.prepare('SELECT COUNT(*) AS n FROM entries_kw').get() as { n: number }).n);
    return { scores: new Map(ids.filter(id => all.has(id)).map(id => [id, all.get(id)!])), docs };
  } finally {
    db.close();
  }
}

/** The text the engine queries with for a doer dispatch on `bead` (its one bead situation). */
function situationOf(bead: { title: string; description: string; acceptance_criteria: string }): string {
  return (roleHints('doer', { beadTitles: [bead] }) as { situations: Array<{ situation: string }> }).situations[0].situation;
}

describe('push-path relevance cutoff on the pinned push-path set (bare bible)', () => {
  let ctx: Awaited<ReturnType<typeof loadEvalProvider>>;
  let reset: () => void;
  let dbFile: string;
  let before: PushMeasurement;
  let after: PushMeasurement;

  beforeAll(async () => {
    ctx = await loadEvalProvider(loadBareBibleEntries());
    // A freshly imported KB rebuilds its keyword index in the background;
    // until it is ready the cutoff has no score and returns rows uncut.
    expect(await ctx.provider.waitForKeywordIndex(60_000)).toBe(true);
    dbFile = path.join(ctx.dir, 'kb.sqlite');
    reset = useCountSnapshot(dbFile);
    reset();
    before = await measurePushBlocks(ctx.provider, loadPushBeads(), loadPushLabels(), { withoutCutoff: true });
    reset();
    after = await measurePushBlocks(ctx.provider, loadPushBeads(), loadPushLabels());
    console.log(formatPushMeasurement('no model, before', before));
    console.log(formatPushMeasurement('no model, after', after));
  }, 120_000);
  afterAll(() => ctx?.cleanup());

  it('the cutoff constants are the measured ones', () => {
    expect(RELEVANCE_MIN_KEYWORD_SCORE).toBe(2.5);
    expect(RELEVANCE_TOP_RATIO).toBe(0.5);
    expect(passesKeywordCutoff(-20, -20, 179)).toBe(true);
    expect(passesKeywordCutoff(-12, -20, 179)).toBe(false); // keyword relevance 2.31
    expect(passesKeywordCutoff(-14, -30, 179)).toBe(false); // under half the best
    expect(passesKeywordCutoff(undefined, -20, 179)).toBe(false); // no keyword match
  });

  it('no pushed row is below the cutoff (labelled set, model off)', () => {
    const beads = loadPushBeads();
    let checked = 0;
    for (const [i, b] of beads.entries()) {
      const ids = after.perBead[i].ids;
      if (ids.length === 0) continue;
      const situation = situationOf(b);
      const sc = keywordScoresOf(dbFile, situation, ids);
      // The best keyword score the provider compared against is among its
      // 30-row window, and it is at least as strong as any kept row's.
      const best = Math.min(...sc.scores.values());
      for (const id of ids) {
        const s = sc.scores.get(id);
        expect(s, `${b.id}: ${id} has a keyword score`).toBeDefined();
        expect(keywordRelevance(s!, sc.docs), `${b.id}: ${id} keyword relevance`).toBeGreaterThanOrEqual(RELEVANCE_MIN_KEYWORD_SCORE);
        expect(s! / best, `${b.id}: ${id} share of the best`).toBeGreaterThanOrEqual(RELEVANCE_TOP_RATIO);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('known-relevant rows that cleared the cutoff before still reach the block', () => {
    const labels = loadPushLabels();
    const beads = loadPushBeads();
    let kept = 0;
    for (const [i, b] of beads.entries()) {
      const relevantBefore = before.perBead[i].ids.filter(id => (labels[b.id] ?? []).includes(id));
      const sc = keywordScoresOf(dbFile, situationOf(b), [...before.perBead[i].ids, ...after.perBead[i].ids]);
      const best = Math.min(...sc.scores.values());
      for (const id of relevantBefore) {
        if (!passesKeywordCutoff(sc.scores.get(id), best, sc.docs)) continue;
        expect(after.perBead[i].ids, `${b.id}: relevant ${id} cleared the cutoff`).toContain(id);
        kept++;
      }
    }
    expect(kept).toBeGreaterThanOrEqual(30);
  });

  it('relevant share rises and irrelevant rows fall to the measured values (model off)', () => {
    expect(before.relevant + before.irrelevant).toBe(24 * 8);
    expect(after.relevantShare).toBeGreaterThan(before.relevantShare);
    expect(after.irrelevant).toBeLessThan(before.irrelevant);
    expect(after.relevant).toBeGreaterThanOrEqual(NO_MODEL_AFTER.relevant);
    expect(after.irrelevant).toBeLessThanOrEqual(NO_MODEL_AFTER.irrelevant);
  });

  it('with the embedder disabled the push path still returns keyword rows that pass the cutoff', () => {
    // No embedder is attached in this block: the semantic list is absent.
    expect(after.rows).toBeGreaterThan(0);
    expect(after.empty).toBeLessThan(after.blocks);
    expect(after.perBead.filter(p => p.ids.length > 0).length).toBeGreaterThanOrEqual(20);
  });

  it('a situation with nothing relevant yields an empty block; the dispatch proceeds with no fallback rows', async () => {
    // Nothing in the bible is about charts, weather or rainfall.
    const bead = {
      title: 'Show a weekly rainfall chart on the weather page',
      description: 'Plot millimetres of rain per day for the last seven days as a bar chart, with the axis labelled in local units.',
      acceptance_criteria: 'The chart shows seven bars with labelled axes',
    };
    reset();
    const uncut = await pushBlockFor(ctx.provider, bead, { withoutCutoff: true });
    expect(uncut.ids.length).toBe(8); // without the cutoff the block always fills

    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const kbWork = createKbWorkClient({ memberCall: providerMemberCall(ctx.provider, { calls }), log: () => {} });
    const logs: string[] = [];
    const injection = createKbInjection({ kbWork, isMemberVerified: () => true, log: (l: string) => logs.push(l) });
    const member = { id: 'member-1', name: 'member-1', type: 'local' };
    const { block, pushed } = await injection.blockWithInfoFor({
      role: 'doer', member, context: { beadTitles: [bead], laneFiles: ['web/weather/rainfall-chart.tsx'] },
    });
    expect(pushed.ids).toEqual([]);
    expect(block.length).toBe(1);
    expect(block[0]).toMatch(/KNOWLEDGE BANK/);
    expect(block[0]).toMatch(/Nothing relevant was found/);
    expect(block[0]).not.toMatch(/"title":/);
    expect(calls.filter(c => c.name === 'kb_query').length).toBeGreaterThan(0);
    expect(calls.every(c => c.name !== 'kb_query' || c.args.relevant_only === true)).toBe(true);
    // laneFiles give the dispatch hint modules, so a fallback would have run here.
    expect(calls.some(c => c.name === 'kb_session_prime')).toBe(false);
  });

  it('the default model: relevant share rises, irrelevant rows fall to the measured values (SKIPPED without the model)', async () => {
    const rank = await hybridConfig.setup(ctx.provider);
    if ('skip' in rank) {
      console.log(`[kb-push-path] default model (${MODEL_PROFILES[0]}) SKIPPED: ${rank.skip}`);
      if (modelsRequired()) expect.fail(`APRA_KB_EVAL_REQUIRE_MODELS=1 but ${hybridConfig.name} skipped: ${rank.skip}`);
      return;
    }
    try {
      reset();
      const mBefore = await measurePushBlocks(ctx.provider, loadPushBeads(), loadPushLabels(), { withoutCutoff: true });
      reset();
      const mAfter = await measurePushBlocks(ctx.provider, loadPushBeads(), loadPushLabels());
      console.log(formatPushMeasurement(`${MODEL_PROFILES[0]}, before`, mBefore));
      console.log(formatPushMeasurement(`${MODEL_PROFILES[0]}, after`, mAfter));
      expect(mAfter.relevantShare).toBeGreaterThan(mBefore.relevantShare);
      expect(mAfter.irrelevant).toBeLessThan(mBefore.irrelevant);
      expect(mAfter.relevant).toBeGreaterThanOrEqual(MODEL_AFTER.relevant);
      expect(mAfter.irrelevant).toBeLessThanOrEqual(MODEL_AFTER.irrelevant);
    } finally {
      await hybridConfig.teardown?.(ctx.provider);
    }
  }, MODEL_EMBED_TIMEOUT_MS);
});

// kb_query called without relevant_only returns the ids, in the order, the
// pre-cutoff code returned for every real recorded query (snapshot recorded
// from the code before the change: keyword-only, and hybrid with a
// deterministic embedder).
describe('explicit kb_query callers are unchanged', () => {
  const snapshot = JSON.parse(fs.readFileSync(EXPLICIT_SNAPSHOT_PATH, 'utf-8')) as Record<string, Record<string, ExplicitIds>>;
  const real = loadQueries().filter(q => q.source === 'real');
  let ctx: Awaited<ReturnType<typeof loadEvalProvider>>;
  let reset: () => void;
  const call = async (args: Record<string, unknown>) => JSON.parse(await kbQuery(kbQuerySchema.parse(args)));

  beforeAll(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ctx = await loadEvalProvider(loadEvalEntries());
    expect(await ctx.provider.waitForKeywordIndex(60_000)).toBe(true);
    kbState.p = ctx.provider;
    reset = useCountSnapshot(path.join(ctx.dir, 'kb.sqlite'));
  }, 120_000);
  afterAll(() => {
    ctx?.cleanup();
    vi.restoreAllMocks();
  });

  it('the snapshot covers every real query', () => {
    expect(real.length).toBeGreaterThanOrEqual(42);
    for (const cfg of ['keyword', 'fake-embedder']) expect(Object.keys(snapshot[cfg]).sort()).toEqual(real.map(q => q.id).sort());
  });

  it('keyword-only: same ids, same order, for every real query', async () => {
    reset();
    expect(await explicitQueryIds(real, call)).toEqual(snapshot.keyword);
  }, 60_000);

  it('hybrid with an embedder: same ids, same order, for every real query', async () => {
    const emb = new FakeEmbedder('eval/push-cutoff-fake', 'r1', 64);
    (ctx.provider as SqliteProvider).attachEmbedder(() => emb);
    try {
      expect(await ctx.provider.waitForEmbeddings(60_000)).toBe(true);
      reset();
      expect(await explicitQueryIds(real, call)).toEqual(snapshot['fake-embedder']);
    } finally {
      ctx.provider.attachEmbedder(null);
    }
  }, 120_000);

  it('relevant_only is an opt-in kb_query input; the same reads with it come back cut', async () => {
    expect(kbQuerySchema.shape).toHaveProperty('relevant_only');
    reset();
    let uncut = 0;
    let cut = 0;
    for (const q of real) {
      const base = { query: q.query, limit: 8, confidence: ['CONFIRMED'], exclude_disputed: true };
      uncut += (await call(base)).l1_results.length;
      cut += (await call({ ...base, relevant_only: true })).l1_results.length;
    }
    expect(cut).toBeLessThan(uncut);
  }, 60_000);
});
