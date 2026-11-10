/**
 * Worker-thread entry of the KB embedder: loads the model and runs every
 * session.run off the server's main thread (see worker-runtime.ts, which
 * spawns it, and ort-runtime.ts, which it runs).
 *
 * workerData: { wasmBinary: Uint8Array } -- the onnxruntime-web WASM bytes,
 * read by the main thread (from the SEA asset in a binary, the installed
 * package otherwise), so this script never resolves a file path of its own.
 *
 * How it is loaded: as dist/services/knowledge/embedding/embed-worker.js in a
 * plain install; as the self-contained CommonJS bundle kb-embed-worker.cjs
 * (scripts/build-sea.mjs) embedded as a SEA asset in the binary and run with
 * eval; and bundled on the fly with esbuild when running from TS source.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { serveEmbedWorker } from './embed-worker-core.js';
import { createInProcessOrtRuntime } from './ort-runtime.js';

const data = workerData as { wasmBinary?: Uint8Array } | null;

if (parentPort) {
  serveEmbedWorker(parentPort, (profile, dir) => {
    if (!data?.wasmBinary) return Promise.reject(new Error('embed worker started without the onnxruntime-web WASM binary'));
    return createInProcessOrtRuntime(profile, dir, data.wasmBinary);
  });
}
