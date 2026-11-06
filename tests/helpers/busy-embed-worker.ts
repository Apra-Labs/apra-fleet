/**
 * Test embed workers: the REAL worker protocol (embed-worker-core.ts
 * serveEmbedWorker) serving a fake runtime defined in the test, bundled with
 * esbuild and started through the REAL main-thread side (worker-runtime.ts
 * createWorkerRuntime). Only the model is fake.
 *
 * busyRuntimeSource(ms) is CPU-bound like onnxruntime-web WASM: each text
 * spins the thread for ms milliseconds without yielding, which is what froze
 * the server's event loop when embedding ran on the main thread.
 */
import path from 'node:path';
import { build } from 'esbuild';
import type { EmbedWorkerSpawn } from '../../src/services/knowledge/embedding/worker-runtime.js';

const ROOT = path.resolve(__dirname, '..', '..');
const CORE = path.join(ROOT, 'src', 'services', 'knowledge', 'embedding', 'embed-worker-core.ts');

/** Bundle a worker whose runtime factory is the given JS expression (profile, dir) => Promise<EmbeddingRuntime>. */
export async function testWorkerSpawn(factoryExpr: string, workerData?: unknown): Promise<EmbedWorkerSpawn> {
  const out = await build({
    stdin: {
      contents: [
        `import { parentPort, workerData } from 'node:worker_threads';`,
        `import { serveEmbedWorker } from ${JSON.stringify(CORE)};`,
        `serveEmbedWorker(parentPort, ${factoryExpr});`,
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
  });
  return { script: { script: out.outputFiles[0].text, eval: true, origin: 'esbuild-source' }, workerData };
}

/** JS source of a CPU-bound fake runtime: dims 4, each text spins busyMs then yields a deterministic vector. */
export function busyRuntimeSource(busyMs: number): string {
  return `async (profile, dir) => ({
    dims: 4,
    async embed(texts) {
      return texts.map((t) => {
        const until = Date.now() + ${busyMs};
        let x = 0;
        while (Date.now() < until) x += Math.sqrt(x + 1);
        const v = new Float32Array(4);
        for (let i = 0; i < t.length; i++) v[i % 4] += t.charCodeAt(i);
        v[3] += x > 0 ? 0 : 1;
        return v;
      });
    },
  })`;
}

/** The same CPU-bound fake, run in-process (the pre-worker behaviour, as a control). */
export function busyInProcessRuntime(busyMs: number) {
  return {
    dims: 4,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => {
        const until = Date.now() + busyMs;
        let x = 0;
        while (Date.now() < until) x += Math.sqrt(x + 1);
        const v = new Float32Array(4);
        for (let i = 0; i < t.length; i++) v[i % 4] += t.charCodeAt(i);
        v[3] += x > 0 ? 0 : 1;
        return v;
      });
    },
  };
}

/** Run fn while a 5 ms interval ticks on this thread; report the largest gap between ticks. */
export async function measureEventLoopGaps<T>(fn: () => Promise<T>): Promise<{ result: T; maxGapMs: number; ticks: number }> {
  let last = performance.now();
  let maxGapMs = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
    ticks++;
  }, 5);
  try {
    const result = await fn();
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    return { result, maxGapMs, ticks };
  } finally {
    clearInterval(timer);
  }
}
