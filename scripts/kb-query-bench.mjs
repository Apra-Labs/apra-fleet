#!/usr/bin/env node
// KB hybrid query latency benchmark (design D2b budget: p95 under 200 ms per
// query on CPU on a 5k-entry KB).
//
// Builds a synthetic KB (deterministic PRNG: realistic title/summary/content
// lengths, recall cues and error signatures, so each entry carries about 5-10
// vectors) in a temp folder, embeds it, then runs a few hundred hybrid queries
// (query text, file/symbol anchors, error_text on a third of them) through
// SqliteProvider.query and prints p50/p95/p99.
//
// Embedder: a hashed-bag-of-words fake with the default model's 384 dims, so
// the brute-force vector compare does the real amount of work. When the real
// default model (bge-small-en-v1.5) is available locally -- set
// APRA_KB_BENCH_MODELS_DIR to a models folder holding it, or
// APRA_KB_BENCH_ALLOW_DOWNLOAD=1 to fetch it from the Hugging Face hub into
// that folder (default: a temp folder removed at exit) -- query vectors come
// from the real model, so its query-embedding time is in the measurement too
// (document vectors stay fake: embedding 5k entries with the real model on
// CPU takes many minutes and does not change the per-query cost).
//
// Runs against the BUILT server (dist/): run `npm run build` first.
// Usage: node scripts/kb-query-bench.mjs [--entries 5000] [--queries 300] [--breakdown] [--json]
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
const FILES = Array.from({ length: 600 }, (_, i) => `src/${pick(VOCAB)}/${pick(VOCAB)}-${i}.ts`);
const SYMBOLS = Array.from({ length: 1500 }, () => `${pick(VOCAB)[0].toUpperCase()}${pick(VOCAB)}.${pick(VOCAB)}`);
const ERRORS = Array.from({ length: 300 }, () => `E${between(100, 999)} ${words(between(4, 8))}`);

function entry(i) {
  const paragraphs = Array.from({ length: between(3, 5) }, () => words(between(90, 150)) + '.');
  return {
    type: pick(['learning', 'knowledge', 'runbook']),
    title: `${words(between(5, 9))} ${i}`,
    summary: words(between(25, 45)) + '.',
    content: paragraphs.join('\n\n'),
    source_files: Array.from({ length: between(1, 3) }, () => pick(FILES)),
    symbols: Array.from({ length: between(1, 3) }, () => pick(SYMBOLS)),
    recall_cues: Array.from({ length: between(1, 3) }, () => words(between(4, 8))),
    error_signatures: rnd() < 0.5 ? [pick(ERRORS)] : [],
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

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

try {
  const provider = new SqliteProvider(path.join(tmp, 'kb.sqlite'));
  await provider.init();

  const t0 = performance.now();
  for (let i = 0; i < N_ENTRIES; i++) await provider.capture(entry(i));
  const tCapture = performance.now() - t0;

  const realQ = await realQueryEmbedder();
  let mode;
  let emb;
  if ('skip' in realQ) {
    mode = `fake query embedder (${DIMS} dims; real model unavailable: ${realQ.skip})`;
    emb = fakeEmbedder('bench/fake-384', 'r1');
  } else {
    mode = `real ${DEFAULT_EMBEDDING_PROFILE} query embedding, fake ${DIMS}-dim document vectors`;
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
  const result = {
    entries: N_ENTRIES,
    vectors,
    vectors_per_entry: Number((vectors / N_ENTRIES).toFixed(2)),
    queries: times.length,
    mode,
    p50_ms: Number(pct(times, 50).toFixed(1)),
    p95_ms: Number(pct(times, 95).toFixed(1)),
    p99_ms: Number(pct(times, 99).toFixed(1)),
    max_ms: Number(times[times.length - 1].toFixed(1)),
    avg_results: Number((returned / times.length).toFixed(1)),
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
    console.log(`[kb-query-bench] p50=${result.p50_ms} ms p95=${result.p95_ms} ms p99=${result.p99_ms} ms max=${result.max_ms} ms (avg ${result.avg_results} results)`);
    for (const [k, v] of Object.entries(breakdown)) console.log(`[kb-query-bench] only ${k}: p50=${v.p50_ms} ms p95=${v.p95_ms} ms`);
    console.log(`[kb-query-bench] build: capture ${result.build_capture_s}s, embed ${result.build_embed_s}s; cpu: ${result.cpu}`);
  }
} finally {
  cleanup();
}
