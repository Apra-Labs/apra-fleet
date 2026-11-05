/**
 * The KB embedder runs the model in a worker thread, off the server's event
 * loop: a CPU-bound runtime inside the worker leaves a main-thread 5 ms
 * interval ticking, a crashed worker marks the embedder failed (never a server
 * crash), close() terminates the worker, and the real onnxruntime-web runtime
 * works through the worker (tiny local ONNX model).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Embedder,
  EmbedWorkerLostError,
  createOrtRuntime,
  shutdownEmbedder,
  _setEmbedderForTest,
  type EmbeddingRuntimeFactory,
} from '../../src/services/knowledge/embedding/embedder.js';
import { createWorkerRuntime, resolveEmbedWorkerScript } from '../../src/services/knowledge/embedding/worker-runtime.js';
import { resolveEmbeddingModel, type EmbeddingModelChoice } from '../../src/services/knowledge/embedding/profiles.js';
import { writeTinyModel, TINY_DIMS } from '../helpers/tiny-embedding-model.js';
import {
  busyInProcessRuntime,
  busyRuntimeSource,
  measureEventLoopGaps,
  testWorkerSpawn,
} from '../helpers/busy-embed-worker.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-embed-worker-')); });
afterEach(() => {
  _setEmbedderForTest(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function tinyChoice(folder: string): EmbeddingModelChoice {
  return resolveEmbeddingModel({ path: folder, pooling: 'cls', normalize: true }, () => {});
}

/** A runtime factory that starts the given test worker through the real createWorkerRuntime. */
function workerFactory(factoryExpr: string): EmbeddingRuntimeFactory {
  return (profile, dir) => createWorkerRuntime(profile, dir, { spawn: () => testWorkerSpawn(factoryExpr) });
}

const BUSY_MS = 250;
const TEXTS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];

describe('embedding runs off the main thread', () => {
  it('a CPU-bound runtime in the worker leaves a main-thread 5 ms interval ticking (max gap under 100 ms)', async () => {
    const folder = writeTinyModel(path.join(tmp, 'tiny'));
    const e = new Embedder({ choice: tinyChoice(folder), runtimeFactory: workerFactory(busyRuntimeSource(BUSY_MS)), log: vi.fn() });
    // Load first (worker start-up is not what is measured), then embed.
    expect(await e.embedQuery('warm')).toBeInstanceOf(Float32Array);
    const { result, maxGapMs, ticks } = await measureEventLoopGaps(() => e.embedDocuments(TEXTS));
    expect(result).toHaveLength(TEXTS.length);
    expect(result!.every((v) => v instanceof Float32Array && v.length === 4)).toBe(true);
    // ~1.5 s of worker CPU: the interval keeps firing throughout.
    expect(maxGapMs).toBeLessThan(100);
    expect(ticks).toBeGreaterThan(50);
    await e.close();
  });

  it('control: the same CPU-bound runtime on the main thread stalls the interval (the measurement is sensitive)', async () => {
    const folder = writeTinyModel(path.join(tmp, 'tiny'));
    const e = new Embedder({ choice: tinyChoice(folder), runtimeFactory: async () => busyInProcessRuntime(BUSY_MS), log: vi.fn() });
    await e.embedQuery('warm');
    const { maxGapMs } = await measureEventLoopGaps(() => e.embedDocuments(TEXTS));
    expect(maxGapMs).toBeGreaterThan(BUSY_MS * TEXTS.length * 0.8);
  });

  it('vectors come back as Float32Arrays with their own buffers (transferred)', async () => {
    const folder = writeTinyModel(path.join(tmp, 'tiny'));
    const e = new Embedder({ choice: tinyChoice(folder), runtimeFactory: workerFactory(busyRuntimeSource(1)), log: vi.fn() });
    const docs = (await e.embedDocuments(['ab', 'cd']))!;
    expect(docs.map((d) => d.buffer.byteLength)).toEqual([16, 16]);
    expect(docs[0].buffer).not.toBe(docs[1].buffer);
    await e.close();
  });
});

describe('worker lifecycle', () => {
  it('starts lazily: constructing the embedder spawns nothing', async () => {
    const folder = writeTinyModel(path.join(tmp, 'tiny'));
    const factory = vi.fn(workerFactory(busyRuntimeSource(1)));
    const e = new Embedder({ choice: tinyChoice(folder), runtimeFactory: factory, log: vi.fn() });
    expect(factory).not.toHaveBeenCalled();
    await e.embedQuery('x');
    expect(factory).toHaveBeenCalledTimes(1);
    await e.close();
  });

  it('a worker crash mid-request marks the embedder failed and resolves null; the process survives', async () => {
    const folder = writeTinyModel(path.join(tmp, 'tiny'));
    const crashing = `async () => ({
      dims: 4,
      async embed(texts) {
        if (texts.some((t) => t.includes('boom'))) setImmediate(() => { throw new Error('native abort in session.run'); });
        return new Promise(() => {});
      },
    })`;
    const log = vi.fn();
    const e = new Embedder({ choice: tinyChoice(folder), runtimeFactory: workerFactory(crashing), log });
    const res = await e.embedDocuments(['boom']);
    expect(res).toBeNull();
    expect(e.state).toMatchObject({ state: 'failed', reason: expect.stringMatching(/embed worker crashed: native abort in session.run/) });
    expect(log.mock.calls.some(([m]) => /semantic search off/.test(String(m)))).toBe(true);
    // Failed: later calls resolve null without reloading.
    await expect(e.embedQuery('again')).resolves.toBeNull();
  });

  it('a worker that exits on its own while idle marks the embedder failed', async () => {
    const folder = writeTinyModel(path.join(tmp, 'tiny'));
    const exiting = `async () => {
      setTimeout(() => process.exit(3), 50);
      return { dims: 4, async embed(texts) { return texts.map(() => new Float32Array(4)); } };
    }`;
    const e = new Embedder({ choice: tinyChoice(folder), runtimeFactory: workerFactory(exiting), log: vi.fn() });
    expect(await e.embedQuery('x')).toBeInstanceOf(Float32Array);
    await vi.waitFor(() => expect(e.state).toMatchObject({ state: 'failed', reason: expect.stringMatching(/exited \(code 3\)/) }), { timeout: 5000 });
    expect(await e.embedQuery('y')).toBeNull();
  });

  it('close() terminates the worker: the old runtime rejects, a later call loads a fresh worker', async () => {
    const folder = writeTinyModel(path.join(tmp, 'tiny'));
    const runtimes: Awaited<ReturnType<EmbeddingRuntimeFactory>>[] = [];
    const base = workerFactory(busyRuntimeSource(1));
    const e = new Embedder({
      choice: tinyChoice(folder),
      runtimeFactory: async (p, d) => { const r = await base(p, d); runtimes.push(r); return r; },
      log: vi.fn(),
    });
    await e.embedQuery('x');
    const started = Date.now();
    await e.close();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(e.state.state).toBe('idle');
    await expect(runtimes[0].embed(['y'])).rejects.toBeInstanceOf(EmbedWorkerLostError);
    expect(await e.embedQuery('z')).toBeInstanceOf(Float32Array);
    expect(runtimes).toHaveLength(2);
    await e.close();
  });

  it('shutdownEmbedder() closes the process embedder (bounded)', async () => {
    const folder = writeTinyModel(path.join(tmp, 'tiny'));
    const e = new Embedder({ choice: tinyChoice(folder), runtimeFactory: workerFactory(busyRuntimeSource(1)), log: vi.fn() });
    _setEmbedderForTest(e);
    await e.embedQuery('x');
    expect(e.state.state).toBe('ready');
    await shutdownEmbedder();
    expect(e.state.state).toBe('idle');
  });

  it('a load error in the worker fails the embedder with the reason and leaves no worker running', async () => {
    const folder = writeTinyModel(path.join(tmp, 'tiny'));
    const log = vi.fn();
    const e = new Embedder({
      choice: tinyChoice(folder),
      runtimeFactory: workerFactory(`async () => { throw new Error('bad model file'); }`),
      log,
    });
    expect(await e.embedQuery('x')).toBeNull();
    expect(e.state).toMatchObject({ state: 'failed', reason: expect.stringMatching(/bad model file/) });
  });
});

describe('the real onnxruntime-web runtime through the worker', () => {
  it('resolves the worker script from TS source here, and embeds with the tiny model', async () => {
    const script = await resolveEmbedWorkerScript();
    expect(script.origin).toBe('esbuild-source');
    expect(script.eval).toBe(true);

    const folder = writeTinyModel(path.join(tmp, 'tiny'));
    const e = new Embedder({ choice: tinyChoice(folder), runtimeFactory: createOrtRuntime, log: vi.fn() });
    const q = await e.embedQuery('hello world');
    expect(q).toBeInstanceOf(Float32Array);
    expect(q!.length).toBe(TINY_DIMS);
    expect(e.state).toMatchObject({ state: 'ready', dims: TINY_DIMS });
    await e.close();
  });
});
