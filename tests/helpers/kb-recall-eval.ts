import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { importBibleEntries } from '../../src/services/knowledge/bible-import.js';
import { Embedder } from '../../src/services/knowledge/embedding/embedder.js';
import { ModelStore } from '../../src/services/knowledge/embedding/model-store.js';
import { BUILTIN_EMBEDDING_PROFILES, DEFAULT_EMBEDDING_PROFILE } from '../../src/services/knowledge/embedding/profiles.js';
import { FLEET_DIR } from '../../src/paths.js';

// KB recall evaluation harness: loads the checked-in bible (plus eval-only
// fixture entries) into a temp SqliteProvider, runs labelled queries and
// computes recall@K and MRR. Configurations: keyword-only (always runs),
// hybrid with the default embedding model and hybrid with an alternative
// model -- the model configs are reported as skipped (with the reason) when
// the model is not available locally; npm test never downloads one.

export const EVAL_DIR = path.resolve(__dirname, '../fixtures/kb-recall-eval');
export const BIBLE_PATH = path.resolve(__dirname, '../../.fleet/kb-canonical.json');
export const RECALL_K = 5;

/**
 * error_text marks an error-text query: the harness passes it as the kb_query
 * error_text input (matched against error_signatures, and part of the
 * semantic text).
 */
export interface EvalQuery { id: string; query: string; expected: string[]; source: string; error_text?: string }

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
async function rankWith(provider: SqliteProvider, q: EvalQuery, opts: { errorText: boolean; semantic: boolean }): Promise<string[]> {
  const r = await provider.query({
    query: q.query,
    ...(opts.errorText && q.error_text ? { error_text: q.error_text } : {}),
    limit: 20,
    confidence: ['CONFIRMED'],
    ...(opts.semantic ? {} : { disable_lists: ['semantic' as const] }),
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
export function modelConfig(profileName: string, label = 'hybrid'): EvalConfig {
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
      return (q) => rankWith(provider, q, { errorText: true, semantic: true });
    },
    teardown(provider) {
      provider.attachEmbedder(null);
    },
  };
}

export const hybridConfig: EvalConfig = modelConfig(DEFAULT_EMBEDDING_PROFILE);
export const ALT_MODEL_PROFILE = 'snowflake-arctic-embed-xs';
export const altModelConfig: EvalConfig = modelConfig(ALT_MODEL_PROFILE, 'hybrid alt-model');

/** Keyword-only first (always runs), then hybrid default model, then the alternative model. */
export const DEFAULT_CONFIGS: EvalConfig[] = [keywordConfig, hybridConfig, altModelConfig];

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
  /** Set when the config could not run (e.g. model unavailable); metrics are then 0. */
  skipped?: string;
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
  if ('skip' in rank) {
    return { config: config.name, queries: queries.length, recallAt5: 0, mrr: 0, perQuery: [], skipped: rank.skip };
  }
  try {
    const perQuery: EvalReport['perQuery'] = [];
    for (const q of queries) perQuery.push({ id: q.id, rank: firstHitRank(await rank(q), q.expected) });
    const ranks = perQuery.map(p => p.rank);
    return { config: config.name, queries: queries.length, recallAt5: recallAtK(ranks), mrr: meanReciprocalRank(ranks), perQuery };
  } finally {
    await config.teardown?.(provider);
  }
}

export function formatReport(r: EvalReport): string {
  if (r.skipped !== undefined) return `[kb-recall-eval] config="${r.config}" SKIPPED: ${r.skipped}`;
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
