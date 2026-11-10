/**
 * The worker-thread half of the KB embedder: the message protocol between
 * worker-runtime.ts (main thread) and a worker that owns one embedding
 * runtime. Kept free of anything but the protocol so the real worker entry
 * (embed-worker.ts) and test workers serve the exact same code path.
 *
 * Protocol (one runtime per worker):
 *   main -> worker  { type: 'load', profile, dir }
 *   worker -> main  { type: 'loaded', dims } | { type: 'load-error', message }
 *   main -> worker  { type: 'embed', id, texts, priority? }
 *   worker -> main  { type: 'result', id, vectors } (vector buffers transferred)
 *                 | { type: 'error', id, message }
 *
 * Scheduling: requests are worked one TEXT at a time, and a 'high' request
 * (a search query) always goes before the next text of a 'normal' one (a
 * background batch of documents). A query therefore waits at most for the one
 * document text already running, never for a whole multi-second batch.
 */
import type { MessagePort } from 'node:worker_threads';
import type { EmbeddingProfile } from './profiles.js';
import type { EmbeddingRuntime } from './ort-runtime.js';

export type MainToWorker =
  | { type: 'load'; profile: EmbeddingProfile; dir: string }
  | { type: 'embed'; id: number; texts: string[]; priority?: EmbedPriority };

/** 'high' for search queries (served first), 'normal' for background document batches. */
export type EmbedPriority = 'high' | 'normal';

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

interface Job {
  id: number;
  texts: string[];
  vectors: Float32Array[];
}

/** Serve the embed protocol on port with the runtime factory. */
export function serveEmbedWorker(port: MessagePort, factory: InWorkerRuntimeFactory): void {
  let runtime: Promise<EmbeddingRuntime> | null = null;
  const high: Job[] = [];
  const normal: Job[] = [];
  let pumping = false;
  const post = (msg: WorkerToMain, transfer: ArrayBuffer[] = []) => port.postMessage(msg, transfer);

  const finish = (job: Job) => {
    // Each pooled vector owns its buffer: transfer, never copy. A vector
    // that is a view on a shared buffer is copied first so the transfer
    // cannot detach another vector's memory.
    const own = job.vectors.map((v) => (v.byteOffset === 0 && v.byteLength === v.buffer.byteLength ? v : v.slice()));
    post({ type: 'result', id: job.id, vectors: own }, own.map((v) => v.buffer as ArrayBuffer));
  };

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const queue = high.length > 0 ? high : normal;
        const job = queue[0];
        if (!job) break;
        try {
          if (!runtime) throw new Error('embed before load');
          const rt = await runtime;
          if (job.vectors.length < job.texts.length) {
            const [v] = await rt.embed([job.texts[job.vectors.length]]);
            job.vectors.push(v);
          }
          if (job.vectors.length === job.texts.length) {
            queue.shift();
            finish(job);
          }
        } catch (err) {
          queue.shift();
          post({ type: 'error', id: job.id, message: errMessage(err) });
        }
        // Yield a macrotask: onnxruntime-web's session.run settles through
        // microtasks only, so without this the worker never reads an incoming
        // (query) message until the whole queue is done.
        await new Promise<void>((r) => setImmediate(r));
      }
    } finally {
      pumping = false;
    }
  };

  port.on('message', (msg: MainToWorker) => {
    if (msg.type === 'load') {
      runtime = factory(msg.profile, msg.dir);
      runtime.then(
        (rt) => post({ type: 'loaded', dims: rt.dims }),
        (err: unknown) => post({ type: 'load-error', message: errMessage(err) }),
      );
      return;
    }
    if (msg.type === 'embed') {
      (msg.priority === 'high' ? high : normal).push({ id: msg.id, texts: msg.texts, vectors: [] });
      void pump();
    }
  });
}
