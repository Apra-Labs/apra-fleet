#!/usr/bin/env node
// KB kb_query latency benchmark (design D2b budget: p95 under 200 ms per
// query on CPU on a 5k-entry KB).
//
// Builds a synthetic KB (deterministic PRNG) in a temp folder whose entries
// are sized like the real bible entries (tests/fixtures/kb-recall-eval:
// title ~60-130 chars, summary ~140-530, content up to ~1100, 3-8 recall
// cues, 1-5 source files, 0-6 symbols, error signatures on a few percent),
// embeds it, then measures through SqliteProvider.query:
//   - single queries (query text, file/symbol anchors, error_text on a third);
//   - bursts of 6 concurrent situation queries, the shape of one fleet-sprint
//     knowledgeFor call (one kb_query per bead/file situation, issued together);
// and prints p50/p95/p99 for both. These two make up the SHORT-QUERY lane:
// 3-7 words (6-14 in bursts) from an invented 3000-word pool, so its p95 holds
// for short queries only.
//
// ENGINE-SITUATION lane: real engine situations are 450-800 chars of real
// English ('about to work on: <title>. <description>. Done when:
// <acceptance>'). The lane builds them through the real fleet-sprint
// roleHints() (packages/apra-fleet-se/fleet-sprint/kb-hints.mjs, doer role)
// from real text -- titles and summaries of the recall eval entries
// (tests/fixtures/kb-recall-eval) -- keeps those of 450-800 chars, and issues
// them with the anchors / error_text roleHints derives, as single queries and
// as bursts of 6 (reported whole and per query). So that real words have
// realistic keyword posting lists, the KB holds the eval entries themselves
// and about half of the synthetic entries are written in the eval entries'
// real vocabulary (the rest keep the invented pool). Text output and --json
// (key engine_situation) report the lane next to the short-query lane.
//
// Vectors: query vectors come from the REAL default model when it is available
// locally (APRA_KB_BENCH_MODELS_DIR, a models folder holding it, e.g. the
// nightly lane's cache; or APRA_KB_BENCH_ALLOW_DOWNLOAD=1 to fetch it from the
// Hugging Face hub into that folder, default a temp folder removed at exit),
// else from a hashed-bag-of-words fake. Document vectors are always a fake
// with the model's real dims (embedding 5k entries with the real model on CPU
// takes many minutes and does not change the per-query cost: scoring is the
// same brute-force compare). The output states which.
// APRA_KB_BENCH_REQUIRE_MODEL=1 (the nightly real-model lane) makes a missing
// real model a failure (exit 3) instead of a fallback to the fake.
//
// Similarity floor check (real model only): loads the recall eval's entries
// (tests/fixtures/kb-recall-eval) into a second temp KB, embeds them with the
// real model (real document vectors), and runs nonsense queries: each must
// return exactly the keyword-only result -- 0 rows when no keyword matches --
// and the output shows the row count without the floor next to it. Any
// difference exits 4.
//
// Runs against the BUILT server (dist/): run `npm run build` first.
// Usage: node scripts/kb-query-bench.mjs [--entries 5000] [--queries 300] [--bursts 60]
//          [--situations 120] [--situation-bursts 30] [--breakdown] [--json]
// --breakdown also times each ranked list alone (the others switched off).
// Writes nothing outside its temp folder (removed at exit).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}
const N_ENTRIES = arg('entries', 5000);
const N_QUERIES = arg('queries', 300);
const N_BURSTS = arg('bursts', 60);
const N_SITUATIONS = arg('situations', 120);
const N_SITUATION_BURSTS = arg('situation-bursts', 30);
const SITUATION_MIN_CHARS = 450;
const SITUATION_MAX_CHARS = 800;
const BURST_SIZE = 6; // fleet-sprint KB_MAX_SITUATION_QUERIES
const REQUIRE_MODEL = process.env.APRA_KB_BENCH_REQUIRE_MODEL === '1';
const WARMUP = 10;
const JSON_OUT = process.argv.includes('--json');
const DIMS = 384;
const LIMIT = 20;

// Scratch data dir BEFORE any dist import (paths.ts reads it at load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-query-bench-'));
process.env.APRA_FLEET_DATA_DIR = path.join(tmp, 'fleet-data');
process.env.APRA_FLEET_KB_EMBED = 'off';
fs.mkdirSync(process.env.APRA_FLEET_DATA_DIR, { recursive: true });
const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });

if (!fs.existsSync(path.join(DIST, 'services', 'knowledge', 'sqlite-provider.js'))) {
  console.error('kb-query-bench: dist/ not built -- run `npm run build` first');
  cleanup();
  process.exit(2);
}
const { SqliteProvider } = await import(pathToFileURL(path.join(DIST, 'services', 'knowledge', 'sqlite-provider.js')).href);
const { Embedder } = await import(pathToFileURL(path.join(DIST, 'services', 'knowledge', 'embedding', 'embedder.js')).href);
const { ModelStore } = await import(pathToFileURL(path.join(DIST, 'services', 'knowledge', 'embedding', 'model-store.js')).href);
const { BUILTIN_EMBEDDING_PROFILES, DEFAULT_EMBEDDING_PROFILE } =
  await import(pathToFileURL(path.join(DIST, 'services', 'knowledge', 'embedding', 'profiles.js')).href);
const { importBibleEntries } = await import(pathToFileURL(path.join(DIST, 'services', 'knowledge', 'bible-import.js')).href);
// The engine's own situation builder (plain ESM, no build step).
const { roleHints } = await import(pathToFileURL(path.join(ROOT, 'packages', 'apra-fleet-se', 'fleet-sprint', 'kb-hints.mjs')).href);

// Real text: the recall eval entries (titles, summaries, files, symbols).
const EVAL_DIR = path.join(ROOT, 'tests', 'fixtures', 'kb-recall-eval');
const readEval = (f) => JSON.parse(fs.readFileSync(path.join(EVAL_DIR, f), 'utf-8'));
const EVAL_ENTRIES = [...readEval('bible-snapshot.json').entries, ...readEval('extra-entries.json').entries];
const REAL_VOCAB = [...new Set(EVAL_ENTRIES.flatMap((e) => `${e.title} ${e.summary ?? ''}`.match(/[A-Za-z][A-Za-z_]{2,}/g) ?? []))];

// -- deterministic PRNG and vocabulary --------------------------------------
let seed = 0x9e3779b9;
function rnd() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const SYL = ['ka', 'lo', 'mi', 'ner', 'tos', 'vel', 'ra', 'quin', 'dar', 'sel', 'po', 'trem', 'zu', 'bal', 'fen', 'gor', 'hix', 'ul', 'ost', 'pry'];
const VOCAB = Array.from({ length: 3000 }, () => Array.from({ length: between(2, 4) }, () => pick(SYL)).join(''));
const COMMON = ['the', 'a', 'when', 'after', 'before', 'because', 'fails', 'returns', 'writes', 'reads', 'cache', 'index', 'member', 'session', 'token', 'retry', 'timeout', 'error', 'config', 'build'];
const words = (n) => Array.from({ length: n }, () => (rnd() < 0.3 ? pick(COMMON) : pick(VOCAB))).join(' ');
const realWords = (n) => Array.from({ length: n }, () => pick(REAL_VOCAB)).join(' ');
const FILES = Array.from({ length: 600 }, (_, i) => `src/${pick(VOCAB)}/${pick(VOCAB)}-${i}.ts`);
const SYMBOLS = Array.from({ length: 1500 }, () => `${pick(VOCAB)[0].toUpperCase()}${pick(VOCAB)}.${pick(VOCAB)}`);
const ERRORS = Array.from({ length: 300 }, () => `E${between(100, 999)} ${words(between(4, 8))}`);

// Sized like the bible entries (see the header).
// The first entries are the eval entries themselves (real text); of the
// rest, odd ones use the real vocabulary, even ones the invented pool.
function entry(i) {
  if (i < EVAL_ENTRIES.length) {
    const e = EVAL_ENTRIES[i];
    return {
      type: e.type ?? 'knowledge',
      title: e.title,
      summary: e.summary ?? e.title,
      content: e.summary ?? e.title,
      source_files: e.source_files ?? [],
      symbols: e.symbols ?? [],
      confidence: 'INFERRED',
      source: 'bench',
      author: 'kb-query-bench',
    };
  }
  const w = i % 2 === 1 ? realWords : words;
  const paragraphs = Array.from({ length: between(0, 2) }, () => w(between(40, 120)) + '.');
  return {
    type: pick(['learning', 'knowledge', 'runbook']),
    title: `${w(between(7, 13))} ${i}`,
    summary: w(between(20, 60)) + '.',
    content: paragraphs.length ? paragraphs.join('\n\n') : w(between(10, 25)) + '.',
    source_files: Array.from({ length: between(1, 5) }, () => pick(FILES)),
    symbols: Array.from({ length: between(0, 6) }, () => pick(SYMBOLS)),
    recall_cues: Array.from({ length: between(3, 8) }, () => w(between(2, 5))),
    error_signatures: rnd() < 0.05 ? [pick(ERRORS)] : [],
    confidence: rnd() < 0.6 ? 'INFERRED' : 'UNVERIFIED',
    source: 'bench',
    author: 'kb-query-bench',
  };
}

// -- embedders ----------------------------------------------------------------
function hashedBagOfWords(text, dims, salt) {
  const v = new Float32Array(dims);
  for (const w of text.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    const h = createHash('sha256').update(salt + w).digest();
    v[h.readUInt32LE(0) % dims] += (h[4] & 1) === 0 ? 1 : -1;
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < dims; i++) v[i] /= n;
  return v;
}

function fakeEmbedder(modelId, revision, queryEmbed) {
  return {
    state: { state: 'ready' },
    modelId,
    revision,
    dims: DIMS,
    tokenLimit: 512,
    async embedDocuments(texts) { return texts.map((t) => hashedBagOfWords(t, DIMS, modelId)); },
    async embedQuery(text) { return queryEmbed ? queryEmbed(text) : hashedBagOfWords(text, DIMS, modelId); },
  };
}

async function realQueryEmbedder() {
  const modelsDir = process.env.APRA_KB_BENCH_MODELS_DIR || path.join(tmp, 'models');
  const allow = process.env.APRA_KB_BENCH_ALLOW_DOWNLOAD === '1';
  const store = allow
    ? new ModelStore({ modelsDir, hubEndpoint: 'https://huggingface.co' })
    : new ModelStore({ modelsDir, download: async () => { throw new Error(`model not in ${modelsDir} (downloads off)`); } });
  const profile = BUILTIN_EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE];
  const real = new Embedder({ choice: { kind: 'enabled', profile }, store, log: () => {} });
  const probe = await real.embedQuery('probe');
  if (!probe) return { skip: real.state.reason ?? real.state.state };
  return { real, profile };
}

// Queries with no answer in the eval KB (gibberish, off-topic, unknown
// identifiers): with the similarity floor each returns 0 rows.
const NONSENSE = [
  { query: 'qwzx plorbt vandersnoot' }, { query: 'xyzzy frobnicate glorp' }, { query: 'purple elephant banana spaceship' },
  { query: 'recipe for chocolate cake' }, { query: 'football world cup results' }, { query: 'fhqwhgads' },
  { query: 'QuxbarFrobnicator.glorpify' }, { fts_terms: ['QuxbarFrobnicator.glorpify'] },
];

/** Real document AND query vectors on the eval entries: rows returned per nonsense query. */
async function floorCheck(real) {
  const dir = path.join(tmp, 'floor');
  fs.mkdirSync(dir, { recursive: true });
  const evalDir = path.join(ROOT, 'tests', 'fixtures', 'kb-recall-eval');
  const read = (f) => JSON.parse(fs.readFileSync(path.join(evalDir, f), 'utf-8'));
  const enrichment = read('enrichment.json').entries;
  const entries = [...read('bible-snapshot.json').entries, ...read('extra-entries.json').entries]
    .map((e) => ({ ...e, ...(enrichment[e.id] ?? {}) }));
  const p = new SqliteProvider(path.join(dir, 'kb.sqlite'));
  await p.init();
  try {
    await importBibleEntries(p, entries, { verbatim: true });
    p.attachEmbedder(() => real);
    if (!(await p.waitForEmbeddings(30 * 60 * 1000))) throw new Error('embedding the eval entries did not finish');
    const out = [];
    const ids = async (q, extra) =>
      (await p.query({ ...q, ...extra, limit: 20, confidence: ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] })).results.map((e) => e.id);
    for (const q of NONSENSE) {
      const hybrid = await ids(q, {});
      const keyword = await ids(q, { disable_lists: ['semantic'] });
      const noFloor = await ids(q, { semantic_floor: Number.NEGATIVE_INFINITY });
      out.push({
        q: q.query ?? `fts_terms:${q.fts_terms.join(',')}`,
        rows: hybrid.length,
        keyword_rows: keyword.length,
        no_floor_rows: noFloor.length,
        same_as_keyword: JSON.stringify(hybrid) === JSON.stringify(keyword),
      });
    }
    return { entries: entries.length, vectors: p.vectorStore.count(), results: out };
  } finally {
    p.close();
  }
}

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/**
 * Engine-shaped situations: a doer bead built from one eval entry (title,
 * summary as description) and another's summary as acceptance, run through
 * the real roleHints(); kept when 450-800 chars. Each yields the kb_query the
 * engine issues for it (query, anchors, error_text). Distinct texts, so every
 * query pays its own embedding.
 */
function engineSituations(count) {
  const out = [];
  const seen = new Set();
  const n = EVAL_ENTRIES.length;
  for (let tries = 0; out.length < count && tries < count * 50; tries++) {
    const a = EVAL_ENTRIES[Math.floor(rnd() * n)];
    const b = EVAL_ENTRIES[Math.floor(rnd() * n)];
    if (a === b) continue;
    const bead = { title: a.title, description: a.summary ?? '', acceptance_criteria: b.summary ?? '' };
    const sit = roleHints('doer', { beadTitles: [bead] }).situations.find((x) => x.kind === 'bead');
    if (!sit || seen.has(sit.situation)) continue;
    if (sit.situation.length < SITUATION_MIN_CHARS || sit.situation.length > SITUATION_MAX_CHARS) continue;
    seen.add(sit.situation);
    out.push({
      query: sit.situation,
      anchor_files: sit.files,
      anchor_symbols: sit.symbols,
      ...(sit.errorText ? { error_text: sit.errorText } : {}),
    });
  }
  if (out.length < count) throw new Error(`only ${out.length}/${count} engine situations of ${SITUATION_MIN_CHARS}-${SITUATION_MAX_CHARS} chars could be built`);
  return out;
}

const stats = (sorted) => ({
  p50_ms: Number(pct(sorted, 50).toFixed(1)),
  p95_ms: Number(pct(sorted, 95).toFixed(1)),
  max_ms: Number(sorted[sorted.length - 1].toFixed(1)),
});

try {
  const provider = new SqliteProvider(path.join(tmp, 'kb.sqlite'));
  await provider.init();

  const t0 = performance.now();
  for (let i = 0; i < N_ENTRIES; i++) await provider.capture(entry(i));
  const tCapture = performance.now() - t0;

  const realQ = await realQueryEmbedder();
  if ('skip' in realQ && REQUIRE_MODEL) {
    console.error(`kb-query-bench: APRA_KB_BENCH_REQUIRE_MODEL=1 but the real ${DEFAULT_EMBEDDING_PROFILE} model is unavailable: ${realQ.skip}`);
    cleanup();
    process.exit(3);
  }
  let mode;
  let emb;
  if ('skip' in realQ) {
    mode = `fake query embedder (${DIMS} dims; real model unavailable: ${realQ.skip}), fake ${DIMS}-dim document vectors`;
    emb = fakeEmbedder('bench/fake-384', 'r1');
  } else {
    mode = `REAL ${DEFAULT_EMBEDDING_PROFILE} (${realQ.profile.modelId}@${realQ.profile.revision.slice(0, 8)}) query vectors, FAKE ${DIMS}-dim document vectors`;
    emb = fakeEmbedder(realQ.profile.modelId, realQ.profile.revision, (t) => realQ.real.embedQuery(t));
  }
  provider.attachEmbedder(() => emb);
  const t1 = performance.now();
  if (!(await provider.waitForEmbeddings(30 * 60 * 1000))) throw new Error('embedding the synthetic KB did not finish');
  const tEmbed = performance.now() - t1;
  const vectors = provider.vectorStore.count();

  const queries = Array.from({ length: N_QUERIES + WARMUP }, (_, i) => ({
    query: words(between(3, 7)),
    anchor_files: rnd() < 0.7 ? [pick(FILES)] : [],
    anchor_symbols: rnd() < 0.5 ? [pick(SYMBOLS)] : [],
    ...(i % 3 === 0 ? { error_text: pick(ERRORS) } : {}),
  }));
  const times = [];
  let returned = 0;
  for (const [i, q] of queries.entries()) {
    const s = performance.now();
    const r = await provider.query({ ...q, limit: LIMIT, l1_only: true, confidence: ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] });
    const ms = performance.now() - s;
    if (i >= WARMUP) { times.push(ms); returned += r.results.length; }
  }
  times.sort((a, b) => a - b);

  // Bursts of BURST_SIZE concurrent situation queries (one knowledgeFor call):
  // fresh query texts, so each burst pays its query embeddings.
  const burstTimes = [];
  for (let b = 0; b < N_BURSTS + 2; b++) {
    const burst = Array.from({ length: BURST_SIZE }, (_, k) => ({
      query: words(between(6, 14)),
      anchor_files: [pick(FILES)],
      anchor_symbols: rnd() < 0.5 ? [pick(SYMBOLS)] : [],
      ...(k === 0 && rnd() < 0.3 ? { error_text: pick(ERRORS) } : {}),
    }));
    const s = performance.now();
    await Promise.all(burst.map((q) => provider.query({ ...q, limit: LIMIT, l1_only: true, confidence: ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] })));
    if (b >= 2) burstTimes.push(performance.now() - s);
  }
  burstTimes.sort((a, b) => a - b);

  // Engine-situation lane: singles, then bursts of BURST_SIZE (fresh texts).
  const QOPTS = { limit: LIMIT, l1_only: true, confidence: ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] };
  const sitSingles = engineSituations(N_SITUATIONS + WARMUP);
  const sitBurstQs = engineSituations((N_SITUATION_BURSTS + 2) * BURST_SIZE);
  const sitLens = [...sitSingles, ...sitBurstQs].map((q) => q.query.length).sort((a, b) => a - b);
  const sitTimes = [];
  for (const [i, q] of sitSingles.entries()) {
    const s = performance.now();
    await provider.query({ ...q, ...QOPTS });
    if (i >= WARMUP) sitTimes.push(performance.now() - s);
  }
  sitTimes.sort((a, b) => a - b);
  const sitBurstTimes = [];
  for (let b = 0; b < N_SITUATION_BURSTS + 2; b++) {
    const burst = sitBurstQs.slice(b * BURST_SIZE, (b + 1) * BURST_SIZE);
    const s = performance.now();
    await Promise.all(burst.map((q) => provider.query({ ...q, ...QOPTS })));
    if (b >= 2) sitBurstTimes.push(performance.now() - s);
  }
  sitBurstTimes.sort((a, b) => a - b);
  const sitBurstWhole = stats(sitBurstTimes);
  const engineSituation = {
    source: 'roleHints(doer) situations from tests/fixtures/kb-recall-eval titles/summaries',
    chars: { min: sitLens[0], p50: pct(sitLens, 50), max: sitLens[sitLens.length - 1] },
    single: { queries: sitTimes.length, ...stats(sitTimes) },
    burst: {
      size: BURST_SIZE,
      bursts: sitBurstTimes.length,
      whole: sitBurstWhole,
      per_query: {
        p50_ms: Number((sitBurstWhole.p50_ms / BURST_SIZE).toFixed(1)),
        p95_ms: Number((sitBurstWhole.p95_ms / BURST_SIZE).toFixed(1)),
        max_ms: Number((sitBurstWhole.max_ms / BURST_SIZE).toFixed(1)),
      },
    },
  };

  // --breakdown: the same queries with all but one list switched off.
  const breakdown = {};
  if (process.argv.includes('--breakdown')) {
    const ALL = ['keyword', 'error', 'semantic', 'anchor'];
    for (const only of ALL) {
      const t = [];
      for (const q of queries.slice(WARMUP)) {
        const s = performance.now();
        await provider.query({ ...q, limit: LIMIT, l1_only: true, confidence: ['CONFIRMED', 'INFERRED', 'UNVERIFIED'], disable_lists: ALL.filter((x) => x !== only) });
        t.push(performance.now() - s);
      }
      t.sort((a, b) => a - b);
      breakdown[only] = { p50_ms: Number(pct(t, 50).toFixed(1)), p95_ms: Number(pct(t, 95).toFixed(1)) };
    }
  }
  const floor = 'skip' in realQ ? null : await floorCheck(realQ.real);
  const result = {
    entries: N_ENTRIES,
    model: 'skip' in realQ ? null : `${realQ.profile.modelId}@${realQ.profile.revision}`,
    real_query_vectors: !('skip' in realQ),
    real_document_vectors: false,
    vectors,
    vectors_per_entry: Number((vectors / N_ENTRIES).toFixed(2)),
    queries: times.length,
    mode,
    p50_ms: Number(pct(times, 50).toFixed(1)),
    p95_ms: Number(pct(times, 95).toFixed(1)),
    p99_ms: Number(pct(times, 99).toFixed(1)),
    max_ms: Number(times[times.length - 1].toFixed(1)),
    avg_results: Number((returned / times.length).toFixed(1)),
    burst: {
      size: BURST_SIZE,
      bursts: burstTimes.length,
      p50_ms: Number(pct(burstTimes, 50).toFixed(1)),
      p95_ms: Number(pct(burstTimes, 95).toFixed(1)),
      p99_ms: Number(pct(burstTimes, 99).toFixed(1)),
      max_ms: Number(burstTimes[burstTimes.length - 1].toFixed(1)),
    },
    engine_situation: engineSituation,
    ...(floor ? { floor_check: floor } : {}),
    build_capture_s: Number((tCapture / 1000).toFixed(1)),
    build_embed_s: Number((tEmbed / 1000).toFixed(1)),
    cpu: os.cpus()[0]?.model ?? 'unknown',
    ...(Object.keys(breakdown).length ? { breakdown } : {}),
  };
  provider.close();
  if (JSON_OUT) console.log(JSON.stringify(result));
  else {
    console.log(`[kb-query-bench] ${result.entries} entries, ${result.vectors} vectors (${result.vectors_per_entry}/entry), ${result.queries} hybrid queries`);
    console.log(`[kb-query-bench] mode: ${result.mode}`);
    console.log(`[kb-query-bench] short-query lane (3-7 invented words; 6-14 in bursts):`);
    console.log(`[kb-query-bench] single query: p50=${result.p50_ms} ms p95=${result.p95_ms} ms p99=${result.p99_ms} ms max=${result.max_ms} ms (avg ${result.avg_results} results)`);
    const bu = result.burst;
    console.log(`[kb-query-bench] burst of ${bu.size} concurrent queries (${bu.bursts} bursts): p50=${bu.p50_ms} ms p95=${bu.p95_ms} ms p99=${bu.p99_ms} ms max=${bu.max_ms} ms`);
    const es = result.engine_situation;
    console.log(`[kb-query-bench] engine-situation lane (real roleHints situations, ${es.chars.min}-${es.chars.max} chars, p50 ${es.chars.p50}):`);
    console.log(`[kb-query-bench]   single situation (${es.single.queries} queries): p50=${es.single.p50_ms} ms p95=${es.single.p95_ms} ms max=${es.single.max_ms} ms`);
    console.log(`[kb-query-bench]   burst of ${es.burst.size} situations (${es.burst.bursts} bursts): whole p50=${es.burst.whole.p50_ms} ms p95=${es.burst.whole.p95_ms} ms max=${es.burst.whole.max_ms} ms; ` +
      `per query p50=${es.burst.per_query.p50_ms} ms p95=${es.burst.per_query.p95_ms} ms max=${es.burst.per_query.max_ms} ms`);
    if (floor) {
      const zero = floor.results.filter((r) => r.rows === 0).length;
      const same = floor.results.filter((r) => r.same_as_keyword).length;
      console.log(`[kb-query-bench] floor check (eval KB: ${floor.entries} entries, ${floor.vectors} REAL document vectors, real query vectors): ` +
        `${same}/${floor.results.length} nonsense queries return exactly the keyword-only result, ${zero}/${floor.results.length} return 0 rows`);
      for (const r of floor.results) {
        console.log(`[kb-query-bench]   '${r.q}': ${r.rows} rows (keyword-only ${r.keyword_rows}, without the floor ${r.no_floor_rows})${r.same_as_keyword ? '' : ' DIFFERS FROM KEYWORD-ONLY'}`);
      }
    } else {
      console.log('[kb-query-bench] floor check: skipped (needs the real model)');
    }
    for (const [k, v] of Object.entries(breakdown)) console.log(`[kb-query-bench] only ${k}: p50=${v.p50_ms} ms p95=${v.p95_ms} ms`);
    console.log(`[kb-query-bench] build: capture ${result.build_capture_s}s, embed ${result.build_embed_s}s; cpu: ${result.cpu}`);
  }
  // Floor failure: the semantic list added rows to a query with no answer
  // (a row that keyword search finds is the keyword path's, not the floor's).
  if (floor && floor.results.some((r) => !r.same_as_keyword || (r.keyword_rows === 0 && r.rows > 0))) process.exitCode = 4;
} finally {
  cleanup();
}
