/**
 * The worker-thread half of the KB embedder: the message protocol between
 * worker-runtime.ts (main thread) and a worker that owns one embedding
 * runtime. Kept free of anything but the protocol so the real worker entry
 * (embed-worker.ts) and test workers serve the exact same code path.
 *
 * Protocol (one runtime per worker):
 *   main -> worker  { type: 'load', profile, dir }
 *   worker -> main  { type: 'loaded', dims } | { type: 'load-error', message }
 *   main -> worker  { type: 'embed', id, texts }
 *   worker -> main  { type: 'result', id, vectors } (vector buffers transferred)
 *                 | { type: 'error', id, message }
 */
import type { MessagePort } from 'node:worker_threads';
import type { EmbeddingProfile } from './profiles.js';
import type { EmbeddingRuntime } from './ort-runtime.js';

export type MainToWorker =
  | { type: 'load'; profile: EmbeddingProfile; dir: string }
  | { type: 'embed'; id: number; texts: string[] };

export type WorkerToMain =
  | { type: 'loaded'; dims: number }
  | { type: 'load-error'; message: string }
  | { type: 'result'; id: number; vectors: Float32Array[] }
  | { type: 'error'; id: number; message: string };

/** Loads the runtime inside the worker. */
export type InWorkerRuntimeFactory = (profile: EmbeddingProfile, dir: string) => Promise<EmbeddingRuntime>;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Serve the embed protocol on port with the runtime factory. */
export function serveEmbedWorker(port: MessagePort, factory: InWorkerRuntimeFactory): void {
  let runtime: Promise<EmbeddingRuntime> | null = null;
  // Requests run one at a time, in arrival order (the runtime is single-threaded anyway).
  let chain: Promise<unknown> = Promise.resolve();
  const post = (msg: WorkerToMain, transfer: ArrayBuffer[] = []) => port.postMessage(msg, transfer);

  port.on('message', (msg: MainToWorker) => {
    if (msg.type === 'load') {
      runtime = factory(msg.profile, msg.dir);
      chain = runtime.then(
        (rt) => post({ type: 'loaded', dims: rt.dims }),
        (err: unknown) => post({ type: 'load-error', message: errMessage(err) }),
      );
      return;
    }
    if (msg.type === 'embed') {
      const { id, texts } = msg;
      chain = chain.then(async () => {
        try {
          if (!runtime) throw new Error('embed before load');
          const vectors = await (await runtime).embed(texts);
          // Each pooled vector owns its buffer: transfer, never copy. A vector
          // that is a view on a shared buffer is copied first so the transfer
          // cannot detach another vector's memory.
          const own = vectors.map((v) => (v.byteOffset === 0 && v.byteLength === v.buffer.byteLength ? v : v.slice()));
          post({ type: 'result', id, vectors: own }, own.map((v) => v.buffer as ArrayBuffer));
        } catch (err) {
          post({ type: 'error', id, message: errMessage(err) });
        }
      });
    }
  });
}
