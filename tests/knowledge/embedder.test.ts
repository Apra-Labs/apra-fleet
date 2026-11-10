import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import {
  Embedder,
  createOrtRuntime,
  poolAndNormalize,
  _setEmbedderForTest,
  type EmbeddingRuntimeFactory,
} from '../../src/services/knowledge/embedding/embedder.js';
import { resolveEmbeddingModel, type EmbeddingModelChoice } from '../../src/services/knowledge/embedding/profiles.js';
import { ModelStore } from '../../src/services/knowledge/embedding/model-store.js';
import { kbHealthSummary, kbHealthCompactLines } from '../../src/tools/check-status.js';
import { writeTinyModel, tinyTableValue, TINY_DIMS, TINY_VOCAB } from '../helpers/tiny-embedding-model.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-embedder-')); });
afterEach(() => {
  _setEmbedderForTest(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function tinyChoice(folder: string, extra: Record<string, unknown> = {}): EmbeddingModelChoice {
  return resolveEmbeddingModel({ path: folder, pooling: 'cls', normalize: true, ...extra }, () => {});
}

describe('Embedder on the real onnxruntime-web WASM runtime (tiny local ONNX model)', () => {
  it('embeds a query and documents into vectors of the model dims', async () => {
    const folder = writeTinyModel(path.join(tmp, 'tiny'));
    const e = new Embedder({ choice: tinyChoice(folder), store: new ModelStore({ modelsDir: tmp }), log: vi.fn() });
    expect(e.state.state).toBe('idle');
    const q = await e.embedQuery('hello world');
    expect(q).toBeInstanceOf(Float32Array);
    expect(q!.length).toBe(TINY_DIMS);
    const docs = await e.embedDocuments(['kb search', 'world']);
    expect(docs!.map((d) => d.length)).toEqual([TINY_DIMS, TINY_DIMS]);
    expect(e.state).toMatchObject({ state: 'ready', dims: TINY_DIMS, revision: 'local' });
    // CLS pooling of the Gather model = the first token's table row, normalized.
    const row = TINY_VOCAB.indexOf('hello');
    const raw = Array.from({ length: TINY_DIMS }, (_, d) => tinyTableValue(row, d));
    const norm = Math.hypot(...raw);
    expect(Array.from(q!).map((v) => +v.toFixed(5))).toEqual(raw.map((v) => +(v / norm).toFixed(5)));
  });

  it('applies the profile query prefix to queries only', async () => {
    const folder = writeTinyModel(path.join(tmp, 'tiny'));
    const e = new Embedder({ choice: tinyChoice(folder, { query_prefix: 'query: ' }), log: vi.fn() });
    const q = await e.embedQuery('hello');
    const [d] = (await e.embedDocuments(['hello']))!;
    // CLS = first token: the query starts with "query:", the document with "hello".
    expect(Array.from(q!)).not.toEqual(Array.from(d));
  });
});

describe('Embedder failure handling', () => {
  it('a forced load failure: embedQuery resolves to null, one log line names the reason, fleet_status shows failed', async () => {
    const log = vi.fn();
    const factory = vi.fn<EmbeddingRuntimeFactory>(async () => { throw new Error('wasm backend exploded'); });
    const folder = writeTinyModel(path.join(tmp, 'tiny'));
    const e = new Embedder({ choice: tinyChoice(folder), runtimeFactory: factory, log });
    await expect(e.embedQuery('hello')).resolves.toBeNull();
    await expect(e.embedQuery('again')).resolves.toBeNull();
    await expect(e.embedDocuments(['x'])).resolves.toBeNull();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/wasm backend exploded/);
    expect(e.state).toMatchObject({ state: 'failed', reason: expect.stringMatching(/wasm backend exploded/) });

    _setEmbedderForTest(e);
    const health = await kbHealthSummary({ knowledgeDir: path.join(tmp, 'no-kb') });
    expect(health!.embedding).toMatchObject({ state: 'failed', reason: expect.stringMatching(/wasm backend exploded/) });
    expect(kbHealthCompactLines(health!)).toMatch(/semantic search off: model download failed: load failed: wasm backend exploded -- run apra-fleet kb model import/);
  });

  it("'none' -> disabled: no load attempted, null vectors, fleet_status shows disabled", async () => {
    const factory = vi.fn<EmbeddingRuntimeFactory>();
    const e = new Embedder({ choice: { kind: 'disabled' }, runtimeFactory: factory, log: vi.fn() });
    expect(await e.embedQuery('x')).toBeNull();
    expect(factory).not.toHaveBeenCalled();
    _setEmbedderForTest(e);
    const health = await kbHealthSummary({ knowledgeDir: path.join(tmp, 'no-kb') });
    expect(health!.embedding).toMatchObject({ state: 'disabled', reason: expect.any(String), fix: expect.stringContaining('apra-fleet kb embedding') });
    expect(kbHealthCompactLines(health!)).toContain('semantic search off: embedding.model is none');
  });

  it('a corrupt ONNX file fails the load on the real runtime, never a throw', async () => {
    const folder = writeTinyModel(path.join(tmp, 'tiny'));
    fs.writeFileSync(path.join(folder, 'onnx', 'model_quantized.onnx'), 'not an onnx model');
    const log = vi.fn();
    const e = new Embedder({ choice: tinyChoice(folder), runtimeFactory: createOrtRuntime, log });
    await expect(e.embedQuery('hello')).resolves.toBeNull();
    expect(e.state.state).toBe('failed');
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('Embedder query-vector cache', () => {
  function countingFactory() {
    const embedCalls: Array<{ texts: string[]; priority?: string }> = [];
    let fail = false;
    const factory = vi.fn<EmbeddingRuntimeFactory>(async () => ({
      dims: 4,
      async embed(texts: string[], opts?: { priority?: 'high' | 'normal' }) {
        embedCalls.push({ texts, priority: opts?.priority });
        if (fail) throw new Error('run failed');
        await new Promise((r) => setTimeout(r, 5));
        return texts.map((t) => Float32Array.from([t.length, 1, 2, 3]));
      },
    }));
    return { factory, embedCalls, setFail: (v: boolean) => { fail = v; } };
  }

  it('the same query text is embedded once; concurrent identical queries share one run; callers get copies', async () => {
    const folder = writeTinyModel(path.join(tmp, 'tiny'));
    const { factory, embedCalls } = countingFactory();
    const e = new Embedder({ choice: tinyChoice(folder), runtimeFactory: factory, log: vi.fn() });
    const [a, b] = await Promise.all([e.embedQuery('where is the cache'), e.embedQuery('where is the cache')]);
    const c = await e.embedQuery('where is the cache');
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0].priority).toBe('high');
    expect(Array.from(a!)).toEqual(Array.from(c!));
    expect(Array.from(b!)).toEqual(Array.from(c!));
    a![0] = -1; // a caller mutating its vector does not poison the cache
    expect((await e.embedQuery('where is the cache'))![0]).not.toBe(-1);
    expect(embedCalls).toHaveLength(1);
    await e.embedQuery('another query');
    expect(embedCalls).toHaveLength(2);
    // Documents are never served from the query cache.
    await e.embedDocuments(['where is the cache']);
    expect(embedCalls).toHaveLength(3);
  });

  it('a failed query embedding is not cached, and the cache is bounded (LRU)', async () => {
    const { QUERY_VECTOR_CACHE_SIZE } = await import('../../src/services/knowledge/embedding/embedder.js');
    const folder = writeTinyModel(path.join(tmp, 'tiny'));
    const { factory, embedCalls, setFail } = countingFactory();
    const e = new Embedder({ choice: tinyChoice(folder), runtimeFactory: factory, log: vi.fn() });
    setFail(true);
    expect(await e.embedQuery('q')).toBeNull();
    setFail(false);
    expect(await e.embedQuery('q')).not.toBeNull();
    expect(embedCalls).toHaveLength(2);
    for (let i = 0; i < QUERY_VECTOR_CACHE_SIZE; i++) await e.embedQuery(`fill ${i}`);
    const before = embedCalls.length;
    await e.embedQuery(`fill ${QUERY_VECTOR_CACHE_SIZE - 1}`); // most recent: cached
    expect(embedCalls).toHaveLength(before);
    await e.embedQuery('q'); // oldest: evicted, recomputed
    expect(embedCalls).toHaveLength(before + 1);
  });
});

describe('poolAndNormalize', () => {
  it('mean pooling averages tokens; normalize gives unit length', () => {
    const hidden = Float32Array.from([1, 0, 3, 0]); // two tokens, dims 2
    expect(Array.from(poolAndNormalize(hidden, 2, 2, 'mean', false))).toEqual([2, 0]);
    expect(Array.from(poolAndNormalize(hidden, 2, 2, 'mean', true))).toEqual([1, 0]);
  });
});

describe('embedder import graph', () => {
  it.each(['embedder.ts', 'embed-worker.ts'])('%s reaches no native .node addon (onnxruntime-node, sharp) -- SEA-safe', async (entry) => {
    const root = path.resolve(__dirname, '..', '..');
    const result = await build({
      entryPoints: [path.join(root, 'src', 'services', 'knowledge', 'embedding', entry)],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      write: false,
      metafile: true,
      logLevel: 'silent',
      define: { 'import.meta.url': 'import_meta_url' },
    });
    const inputs = Object.keys(result.metafile!.inputs);
    // The model runtime lives in the worker bundle; the main-thread module only spawns it.
    if (entry === 'embed-worker.ts') expect(inputs.some((p) => p.includes('onnxruntime-web'))).toBe(true);
    expect(inputs.filter((p) => p.endsWith('.node'))).toEqual([]);
    expect(inputs.filter((p) => /onnxruntime-node|[\\/]sharp[\\/]|@huggingface[\\/]transformers/.test(p))).toEqual([]);
  });
});
