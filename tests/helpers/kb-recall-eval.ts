import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { importBibleEntries } from '../../src/services/knowledge/bible-import.js';
import { Embedder } from '../../src/services/knowledge/embedding/embedder.js';
import { ModelStore } from '../../src/services/knowledge/embedding/model-store.js';
import { BUILTIN_EMBEDDING_PROFILES, DEFAULT_EMBEDDING_PROFILE } from '../../src/services/knowledge/embedding/profiles.js';
import { FLEET_DIR } from '../../src/paths.js';
// @ts-expect-error plain .mjs (fleet-sprint engine hints)
import { roleHints } from '../../packages/apra-fleet-se/fleet-sprint/kb-hints.mjs';

// KB recall evaluation harness: loads the pinned bible snapshot (with each
// entry's real captured content where one exists, and its recall_cues /
// error_signatures -- tests/fixtures/kb-recall-eval/enrichment.json) plus the
// push+pr entry into a temp SqliteProvider, runs labelled queries and computes
// recall@K and MRR, overall and per query source (real recorded queries,
// authored situation queries, the owner-reported scope-error case).
// Configurations: keyword-only (always runs) and hybrid with each built-in
// embedding model. A model config is reported as skipped (with the reason)
// when the model is not available locally; npm test never downloads one.
// APRA_KB_EVAL_REQUIRE_MODELS=1 (the nightly real-model lane) turns such a
// skip into a test failure. Fixtures: scripts/gen-kb-recall-eval.mjs.

export const EVAL_DIR = path.resolve(__dirname, '../fixtures/kb-recall-eval');
// Pinned snapshot of .fleet/kb-canonical.json (refreshed only by
// scripts/gen-kb-recall-eval.mjs together with the queries), so a routine bible
// promotion cannot turn the coverage check red.
export const BIBLE_PATH = path.resolve(__dirname, '../fixtures/kb-recall-eval/bible-snapshot.json');
/**
 * The BARE bible: a pinned copy of .fleet/kb-canonical.json as committed on
 * 2026-11-10 (178 entries; title, summary, symbols and source_files only --
 * no content, recall_cues or error_signatures), loaded WITHOUT the
 * enrichment overlay. This is what a fresh clone's keyword search actually
 * ranks, and the set the keyword MRR regression against 0.4.4 was found and
 * fixed on (docs/kb-recall-measurements.md). Not refreshed by
 * scripts/gen-kb-recall-eval.mjs: re-pin it only together with the
 * measurements doc and the bare-bible floor in kb-recall-eval.test.ts.
 */
export const BARE_BIBLE_PATH = path.resolve(__dirname, '../fixtures/kb-recall-eval/bible-bare-live.json');
export const RECALL_K = 5;
/** Second cut-off reported next to recall@5: the guard window (KEYWORD_GUARD_WITHIN). */
export const RECALL_K8 = 8;

/**
 * error_text marks an error-text query: the harness passes it as the kb_query
 * error_text input (matched against error_signatures, and part of the
 * semantic text).
 */
export interface EvalQuery { id: string; query: string; expected: string[]; source: string; provenance?: string; error_text?: string }

/** Query sources in queries.json: recorded agent traffic, hand-authored, owner-reported. */
export const QUERY_SOURCES = ['real', 'authored', 'owner-notes'] as const;

export type RankFn = (q: EvalQuery) => Promise<string[]>;

/** A config ranks queries, or is skipped with a reason (e.g. model not available offline). */
export interface EvalConfig {
  name: string;
  /** Prepare the config against a freshly loaded provider. */
  setup(provider: SqliteProvider): Promise<RankFn | { skip: string }>;
  /** Undo setup (e.g. detach the embedder) so the next config starts clean. */
  teardown?(provider: SqliteProvider): Promise<void> | void;
}

/** Same provider read as kb_query's L1 (CONFIRMED-only default). */
async function rankWith(provider: SqliteProvider, q: EvalQuery, opts: { errorText: boolean; semantic: boolean; keywordGuard?: boolean }): Promise<string[]> {
  const r = await provider.query({
    query: q.query,
    ...(opts.errorText && q.error_text ? { error_text: q.error_text } : {}),
    limit: 20,
    confidence: ['CONFIRMED'],
    ...(opts.semantic ? {} : { disable_lists: ['semantic' as const] }),
    ...(opts.keywordGuard === false ? { disable_keyword_guard: true } : {}),
  });
  return r.results.map(e => e.id);
}

/**
 * Keyword-only: the normalized FTS path plus the error_signatures list for
 * error-text queries, never the semantic list (as with embedding.model none).
 * withErrorText false drops error_text from every call (falsifiability).
 */
export function keywordOnlyConfig(withErrorText = true): EvalConfig {
  return {
    name: withErrorText ? 'keyword-only (embedding.model none)' : 'keyword-only, error_text dropped',
    async setup(provider) {
      return (q) => rankWith(provider, q, { errorText: withErrorText, semantic: false });
    },
  };
}

export const keywordConfig: EvalConfig = keywordOnlyConfig();

/**
 * Where the eval looks for downloaded models: APRA_KB_EVAL_MODELS_DIR, else
 * the fleet models folder (<FLEET_DIR>/models; a sandbox folder under npm
 * test, so normally empty there).
 */
export function evalModelsDir(): string {
  return process.env.APRA_KB_EVAL_MODELS_DIR || path.join(FLEET_DIR, 'models');
}

/**
 * Download policy: never under npm test. APRA_KB_EVAL_ALLOW_DOWNLOAD=1 (a
 * manual local measurement) lets the store fetch a missing model from the
 * Hugging Face hub into evalModelsDir().
 */
function evalModelStore(): ModelStore {
  if (process.env.APRA_KB_EVAL_ALLOW_DOWNLOAD === '1') {
    return new ModelStore({ modelsDir: evalModelsDir(), hubEndpoint: 'https://huggingface.co' });
  }
  return new ModelStore({
    modelsDir: evalModelsDir(),
    download: async () => {
      throw new Error(`model not available locally under ${evalModelsDir()} (downloads are off; set APRA_KB_EVAL_MODELS_DIR, or APRA_KB_EVAL_ALLOW_DOWNLOAD=1 for a manual run)`);
    },
  });
}

/** Max wait for embedding the eval KB with a real model (CPU, single thread). */
export const MODEL_EMBED_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Hybrid with a real embedding model (built-in profile name). Skipped, with
 * the reason, when the model cannot be loaded (offline, not downloaded,
 * failed load); never fails npm test for that.
 */
export function modelConfig(profileName: string, label = 'hybrid', opts: { keywordGuard?: boolean } = {}): EvalConfig {
  return {
    name: `${label} (${profileName})`,
    async setup(provider) {
      const profile = BUILTIN_EMBEDDING_PROFILES[profileName];
      if (!profile) return { skip: `unknown embedding profile ${profileName}` };
      const embedder = new Embedder({ choice: { kind: 'enabled', profile }, store: evalModelStore(), log: () => {} });
      const probe = await embedder.embedQuery('probe');
      if (!probe) {
        const st = embedder.state;
        return { skip: st.state === 'failed' ? st.reason : `embedder state ${st.state}` };
      }
      provider.attachEmbedder(() => embedder);
      if (!(await provider.waitForEmbeddings(MODEL_EMBED_TIMEOUT_MS))) {
        provider.attachEmbedder(null);
        return { skip: `embedding the eval KB with ${profileName} did not finish in time` };
      }
      return (q) => rankWith(provider, q, { errorText: true, semantic: true, keywordGuard: opts.keywordGuard });
    },
    teardown(provider) {
      provider.attachEmbedder(null);
    },
  };
}

/** Every built-in model is measured: the default first, then the others in profile order. */
export const MODEL_PROFILES: string[] = [
  DEFAULT_EMBEDDING_PROFILE,
  ...Object.keys(BUILTIN_EMBEDDING_PROFILES).filter(n => n !== DEFAULT_EMBEDDING_PROFILE),
];
export const modelConfigs: EvalConfig[] = MODEL_PROFILES.map(p => modelConfig(p));
/** Hybrid with the default embedding model. */
export const hybridConfig: EvalConfig = modelConfigs[0];

/** Keyword-only first (always runs), then hybrid with each built-in model. */
export const DEFAULT_CONFIGS: EvalConfig[] = [keywordConfig, ...modelConfigs, ...guardOffConfigs()];

/**
 * Hybrid configs with the keyword top-5 guard switched off (internal
 * disable_keyword_guard), for the guard before/after comparison. Opt in with
 * APRA_KB_EVAL_GUARD_OFF=1: each one re-embeds the eval KB, so they stay out
 * of the default run.
 */
export function guardOffConfigs(): EvalConfig[] {
  if (process.env.APRA_KB_EVAL_GUARD_OFF !== '1') return [];
  return MODEL_PROFILES.map(p => modelConfig(p, 'hybrid, guard off', { keywordGuard: false }));
}

/** Nightly real-model lane: a model config that skips is a failure, not a note. */
export function modelsRequired(): boolean {
  return process.env.APRA_KB_EVAL_REQUIRE_MODELS === '1';
}

export function loadQueries(): EvalQuery[] {
  return JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'queries.json'), 'utf-8')).queries;
}

/** Bible snapshot + extra entries, each overlaid with its enrichment.json fields. */
export function loadEvalEntries(): unknown[] {
  const bible = JSON.parse(fs.readFileSync(BIBLE_PATH, 'utf-8')).entries as Array<Record<string, unknown>>;
  const extra = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'extra-entries.json'), 'utf-8')).entries as Array<Record<string, unknown>>;
  const enrichment = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'enrichment.json'), 'utf-8')).entries as Record<string, Record<string, unknown>>;
  return [...bible, ...extra].map(e => ({ ...e, ...(enrichment[e.id as string] ?? {}) }));
}

/** The bare bible (BARE_BIBLE_PATH) plus the extra entries, with no enrichment overlay. */
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

/** ranks: per-query 1-based hit rank within top-K, or null for a miss. */
export function recallAtK(ranks: Array<number | null>): number {
  if (ranks.length === 0) return 0;
  return ranks.filter(r => r !== null).length / ranks.length;
}

export function meanReciprocalRank(ranks: Array<number | null>): number {
  if (ranks.length === 0) return 0;
  return ranks.reduce<number>((s, r) => s + (r === null ? 0 : 1 / r), 0) / ranks.length;
}

export interface SetMetrics { queries: number; recallAt5: number; recallAt8: number; mrr: number }

export interface EvalReport {
  config: string;
  queries: number;
  recallAt5: number;
  recallAt8: number;
  mrr: number;
  /** The same metrics restricted to each query source present (real, authored, owner-notes). */
  bySource: Record<string, SetMetrics>;
  perQuery: Array<{ id: string; rank: number | null; rank8: number | null }>;
  /** Set when the config could not run (e.g. model unavailable); metrics are then 0. */
  skipped?: string;
}

export interface EvalImportCounts { imported: number; skipped: number; linked: number; rejected: number }

export async function loadEvalProvider(entries: unknown[] = loadEvalEntries()): Promise<{ provider: SqliteProvider; dir: string; counts: EvalImportCounts; cleanup: () => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-recall-eval-'));
  const provider = new SqliteProvider(path.join(dir, 'kb.sqlite'));
  await provider.init();
  const res = await importBibleEntries(provider, entries, { verbatim: true });
  const counts: EvalImportCounts = { imported: res.imported, skipped: res.skipped, linked: res.linked, rejected: res.rejected };
  return {
    provider, dir, counts,
    cleanup: () => { provider.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

export async function runEval(config: EvalConfig, provider: SqliteProvider, queries: EvalQuery[]): Promise<EvalReport> {
  const rank = await config.setup(provider);
  if ('skip' in rank) {
    return { config: config.name, queries: queries.length, recallAt5: 0, recallAt8: 0, mrr: 0, bySource: {}, perQuery: [], skipped: rank.skip };
  }
  try {
    const perQuery: EvalReport['perQuery'] = [];
    for (const q of queries) {
      const ranked = await rank(q);
      perQuery.push({ id: q.id, rank: firstHitRank(ranked, q.expected), rank8: firstHitRank(ranked, q.expected, RECALL_K8) });
    }
    const ranks = perQuery.map(p => p.rank);
    const bySource: Record<string, SetMetrics> = {};
    for (const src of new Set(queries.map(q => q.source))) {
      const r = perQuery.filter((_, i) => queries[i].source === src).map(p => p.rank);
      const r8 = perQuery.filter((_, i) => queries[i].source === src).map(p => p.rank8);
      bySource[src] = { queries: r.length, recallAt5: recallAtK(r), recallAt8: recallAtK(r8), mrr: meanReciprocalRank(r) };
    }
    return { config: config.name, queries: queries.length, recallAt5: recallAtK(ranks), recallAt8: recallAtK(perQuery.map(p => p.rank8)), mrr: meanReciprocalRank(ranks), bySource, perQuery };
  } finally {
    await config.teardown?.(provider);
  }
}

export function formatReport(r: EvalReport): string {
  if (r.skipped !== undefined) return `[kb-recall-eval] config="${r.config}" SKIPPED: ${r.skipped}`;
  const lines = [`[kb-recall-eval] config="${r.config}" queries=${r.queries} recall@5=${r.recallAt5.toFixed(4)} R@8=${r.recallAt8.toFixed(4)} MRR=${r.mrr.toFixed(4)}`];
  for (const [src, m] of Object.entries(r.bySource)) {
    lines.push(`[kb-recall-eval]   ${src}: queries=${m.queries} recall@5=${m.recallAt5.toFixed(4)} R@8=${m.recallAt8.toFixed(4)} MRR=${m.mrr.toFixed(4)}`);
  }
  return lines.join('\n');
}

/**
 * Markdown table of recall@5 / MRR per config for one query source (the
 * real set is the headline); a skipped config shows its reason.
 */
export function formatTable(reports: EvalReport[], source: string): string {
  const rows = reports.map(r => {
    if (r.skipped !== undefined) return `| ${r.config} | - | - | - | - | skipped: ${r.skipped.replace(/\|/g, '/')} |`;
    const m = r.bySource[source];
    return m ? `| ${r.config} | ${m.queries} | ${m.recallAt5.toFixed(4)} | ${m.recallAt8.toFixed(4)} | ${m.mrr.toFixed(4)} | |` : `| ${r.config} | 0 | - | - | |`;
  });
  return [`KB recall eval -- ${source} queries`, '', '| config | queries | recall@5 | R@8 | MRR | note |', '|---|---|---|---|---|---|', ...rows].join('\n');
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
  // Markdown tables next to it (<report>.md), e.g. for a CI job summary.
  const tables = QUERY_SOURCES.filter(s => s !== 'owner-notes').map(s => formatTable(reports, s)).join('\n\n');
  fs.writeFileSync(file.replace(/\.json$/, '') + '.md', tables + '\n');
  return file;
}

/**
 * Queries with no answer in the eval KB: gibberish, off-topic text and
 * unknown identifiers. Sent as free text, and the identifier-like ones also
 * as fts_terms (the kb_session_prime path). With a correct semantic floor the
 * hybrid result for each equals the keyword-only result (nothing, or the same
 * keyword hits): a model must not add rows a caller never asked for.
 */
export const NONSENSE_QUERIES: Array<{ query?: string; fts_terms?: string[] }> = [
  'qwzx plorbt vandersnoot', 'xyzzy frobnicate glorp', 'asdf qwer zxcv', 'lorem ipsum dolor sit amet',
  'purple elephant banana spaceship', 'recipe for chocolate cake', 'weather forecast tomorrow in paris',
  'how to bake sourdough bread', 'quantum chromodynamics gluon', 'football world cup results',
  'tax return deadline', 'guitar chord progression', 'hello world', 'random words here', 'fhqwhgads', 'mxyzptlk',
].map(query => ({ query })).concat(
  ['FooBarBazQux.unknownThing', 'ZzTopWidgetFactory', 'NonexistentSymbolName', 'unknownFunctionXyz', 'blargh_whatsit_9000']
    .flatMap(sym => [{ query: sym }, { fts_terms: [sym] }]),
);

export interface FloorSweepRow {
  /** The floor tried; null = no floor. */
  floor: number | null;
  real: SetMetrics;
  authored: SetMetrics;
  /** NONSENSE_QUERIES whose hybrid result differs from the keyword-only result. */
  nonsenseChanged: number;
}

/**
 * Recall@5 / MRR (real and authored sets) and nonsense-query behaviour at each
 * semantic floor, with the model already attached to `provider`. Uses the
 * internal QueryOptions.semantic_floor override; query vectors are cached by
 * the embedder, so each floor costs only the ranking.
 */
export async function semanticFloorSweep(
  provider: SqliteProvider, queries: EvalQuery[], floors: Array<number | null>, dbFile?: string,
): Promise<FloorSweepRow[]> {
  const out: FloorSweepRow[] = [];
  // Every query bumps use_count, which feeds the trust prior: without a reset
  // each floor would be measured on a KB the previous floors already changed.
  // With dbFile, use_count is put back to its starting values before each pass.
  const db = dbFile ? new DatabaseSync(dbFile) : null;
  db?.exec('PRAGMA busy_timeout = 5000');
  const counts = db ? (db.prepare('SELECT id, use_count FROM entries').all() as Array<{ id: string; use_count: number }>) : [];
  const restore = () => {
    if (!db) return;
    const st = db.prepare('UPDATE entries SET use_count = ? WHERE id = ?');
    db.exec('BEGIN');
    for (const c of counts) st.run(c.use_count, c.id);
    db.exec('COMMIT');
  };
  const ids = async (o: { query?: string; fts_terms?: string[]; error_text?: string }, floor: number | null | 'keyword') =>
    (await provider.query({
      ...o, limit: 20, confidence: ['CONFIRMED'],
      ...(floor === 'keyword' ? { disable_lists: ['semantic' as const] } : { semantic_floor: floor ?? Number.NEGATIVE_INFINITY }),
    })).results.map(e => e.id);
  restore();
  const keywordOnly: string[][] = [];
  for (const n of NONSENSE_QUERIES) keywordOnly.push(await ids(n, 'keyword'));
  for (const floor of floors) {
    restore();
    const ranks: Record<string, Array<number | null>> = { real: [], authored: [] };
    const ranks8: Record<string, Array<number | null>> = { real: [], authored: [] };
    for (const q of queries) {
      if (!(q.source in ranks)) continue;
      const got = await ids({ query: q.query, ...(q.error_text ? { error_text: q.error_text } : {}) }, floor);
      ranks[q.source].push(firstHitRank(got, q.expected));
      ranks8[q.source].push(firstHitRank(got, q.expected, RECALL_K8));
    }
    let nonsenseChanged = 0;
    for (const [i, n] of NONSENSE_QUERIES.entries()) {
      if (JSON.stringify(await ids(n, floor)) !== JSON.stringify(keywordOnly[i])) nonsenseChanged++;
    }
    const m = (r: Array<number | null>, r8: Array<number | null>): SetMetrics => ({ queries: r.length, recallAt5: recallAtK(r), recallAt8: recallAtK(r8), mrr: meanReciprocalRank(r) });
    out.push({ floor, real: m(ranks.real, ranks8.real), authored: m(ranks.authored, ranks8.authored), nonsenseChanged });
  }
  restore();
  db?.close();
  return out;
}

export function formatFloorSweep(model: string, rows: FloorSweepRow[]): string {
  const lines = [
    `KB semantic floor sweep -- ${model} (nonsense: ${NONSENSE_QUERIES.length} queries)`,
    '', '| floor | real recall@5 | real MRR | authored recall@5 | authored MRR | nonsense changed |', '|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(`| ${r.floor === null ? 'none' : r.floor.toFixed(2)} | ${r.real.recallAt5.toFixed(4)} | ${r.real.mrr.toFixed(4)} | ${r.authored.recallAt5.toFixed(4)} | ${r.authored.mrr.toFixed(4)} | ${r.nonsenseChanged} |`);
  }
  return lines.join('\n');
}

// -- Engine situations whose signal is in the description -------------------
//
// One situation per authored query, built through the real fleet-sprint
// roleHints('doer') from a bead with a generic title, the authored query as
// the description (followed by a sentence naming invented, unrelated symbols
// and paths, the way a real bead names identifiers) and a generic acceptance
// line -- so the signal is in the description, not the title
// (docs/kb-recall-measurements.md, "Embedded text of engine situations").

const DESC_SIGNAL_TITLES = [
  'Fix the reported failure', 'Follow-up from code review', 'Harden the edge case',
  'Address the judge finding', 'Close the gap found in testing', 'Handle the reported regression',
];
const DESC_SIGNAL_FILLERS = [
  'Keep renderSummaryTable, formatDuration and parseCliFlags in src/cli/summary-table.ts and src/utils/duration.ts behaving as before.',
  'Leave buildReportRows, toPercentString and sortByColumn in src/report/rows.ts and src/report/columns.ts untouched.',
  'Do not change loadThemeConfig, applyPalette and resolveFontStack in src/theme/config.ts and src/theme/palette.ts.',
];
const DESC_SIGNAL_ACCEPTANCE = [
  'npm test passes and a unit test covers the change',
  'the change is covered by a test and the docs mention it',
  'tests pass and no unrelated behaviour changes',
];

export interface DescriptionSituation {
  id: string;
  expected: string[];
  /** The description's signal (the authored query text). */
  signal: string;
  situation: string;
  files: string[];
  symbols: string[];
}

export function descriptionSignalSituations(queries: EvalQuery[] = loadQueries()): DescriptionSituation[] {
  return queries.filter(q => q.source === 'authored').map((q, i) => {
    const bead = {
      title: DESC_SIGNAL_TITLES[i % DESC_SIGNAL_TITLES.length],
      description: `${q.query}. ${DESC_SIGNAL_FILLERS[i % DESC_SIGNAL_FILLERS.length]}`,
      acceptance_criteria: DESC_SIGNAL_ACCEPTANCE[i % DESC_SIGNAL_ACCEPTANCE.length],
    };
    const s = (roleHints('doer', { beadTitles: [bead] }) as { situations: Array<{ situation: string; files: string[]; symbols: string[] }> }).situations[0];
    return { id: q.id, expected: q.expected, signal: q.query, situation: s.situation, files: s.files, symbols: s.symbols };
  });
}

/**
 * First-hit ranks (top 5) of each situation queried the way the engine push
 * path does: situation text plus its anchor files / symbols. semantic false
 * leaves the semantic list out (keyword + anchor only).
 */
export async function rankSituations(provider: SqliteProvider, sits: DescriptionSituation[], semantic: boolean): Promise<Array<number | null>> {
  const out: Array<number | null> = [];
  for (const s of sits) {
    const r = await provider.query({
      query: s.situation, anchor_files: s.files, anchor_symbols: s.symbols, limit: 20, confidence: ['CONFIRMED'],
      ...(semantic ? {} : { disable_lists: ['semantic' as const] }),
    });
    out.push(firstHitRank(r.results.map(e => e.id), s.expected));
  }
  return out;
}

/**
 * Snapshot every entry's use_count (it feeds the hybrid trust prior and every
 * query bumps it) and return a function that puts the snapshot back, so a
 * measurement starts from the imported values whatever ran before it.
 */
export function useCountSnapshot(dbFile: string): () => void {
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA busy_timeout = 5000');
  const counts = db.prepare('SELECT id, use_count FROM entries').all() as Array<{ id: string; use_count: number }>;
  db.close();
  return () => {
    const w = new DatabaseSync(dbFile);
    try {
      w.exec('PRAGMA busy_timeout = 5000');
      const st = w.prepare('UPDATE entries SET use_count = ? WHERE id = ?');
      w.exec('BEGIN');
      for (const c of counts) st.run(c.use_count, c.id);
      w.exec('COMMIT');
    } finally {
      w.close();
    }
  };
}
