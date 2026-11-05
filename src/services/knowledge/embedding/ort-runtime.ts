/**
 * The in-process onnxruntime-web embedding runtime: tokenizer.json + the
 * profile's ONNX file, run on onnxruntime-web WASM, with pooling and
 * normalization done here.
 *
 * This module runs INSIDE the embed worker thread (embed-worker.ts), never on
 * the server's main thread: one session.run on onnxruntime-web WASM is
 * synchronous CPU work that does not yield to timers or I/O, so running it on
 * the main thread froze every tool call and /health for seconds at a time.
 * worker-runtime.ts is the main-thread side.
 *
 * Bundling: this module and embed-worker.ts are bundled on their own into a
 * self-contained CommonJS script (the SEA asset, see scripts/build-sea.mjs),
 * so they must not import anything that needs a file path at runtime:
 * no import.meta.url, no node:sea, no KB config. The WASM binary is handed in
 * as bytes by the main thread (worker-runtime.ts loadOrtWasmBinary).
 *
 * Threads: numThreads 1 -- the threaded build would spawn its own workers
 * from a script URL, which a SEA does not have.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ONNX_FILE_FOR_DTYPE, type EmbeddingProfile } from './profiles.js';

/** A loaded model: embeds already-prefixed texts into pooled (and, per profile, normalized) vectors. */
export interface EmbeddingRuntime {
  dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Release the runtime (terminates its worker). Optional: in-process and fake runtimes have nothing to free. */
  close?(): Promise<void>;
  /**
   * Register a callback for when the runtime dies on its own (worker crash or
   * exit). Optional: only worker-backed runtimes can die independently.
   */
  onLost?(cb: (reason: string) => void): void;
}

/** Pipeline factory seam: load the model in dir for profile. Tests inject a fake. */
export type EmbeddingRuntimeFactory = (profile: EmbeddingProfile, dir: string) => Promise<EmbeddingRuntime>;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Ort = typeof import('onnxruntime-web/wasm');
let ortPromise: Promise<Ort> | null = null;

/** Import and configure onnxruntime-web once per thread. */
function loadOrt(wasmBinary: Uint8Array): Promise<Ort> {
  if (!ortPromise) {
    ortPromise = (async () => {
      const ort = await import('onnxruntime-web/wasm');
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmBinary = wasmBinary;
      ort.env.logLevel = 'error';
      return ort;
    })().catch((err) => { ortPromise = null; throw err; });
  }
  return ortPromise;
}

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`cannot read ${file}: ${errMessage(err)}`);
  }
}

/** Keep at most limit tokens, preserving the final special token (e.g. [SEP]). */
function truncate(ids: number[], limit: number): number[] {
  if (ids.length <= limit) return ids;
  return [...ids.slice(0, limit - 1), ids[ids.length - 1]];
}

/** Pool one sequence's token states [seq, dims] into one vector. */
export function poolAndNormalize(
  hidden: Float32Array,
  seqLen: number,
  dims: number,
  pooling: 'cls' | 'mean',
  normalize: boolean,
): Float32Array {
  const out = new Float32Array(dims);
  if (pooling === 'cls') {
    out.set(hidden.subarray(0, dims));
  } else {
    for (let t = 0; t < seqLen; t++) {
      for (let d = 0; d < dims; d++) out[d] += hidden[t * dims + d];
    }
    for (let d = 0; d < dims; d++) out[d] /= seqLen;
  }
  if (normalize) {
    let norm = 0;
    for (let d = 0; d < dims; d++) norm += out[d] * out[d];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let d = 0; d < dims; d++) out[d] /= norm;
  }
  return out;
}

/** Load the model in dir on onnxruntime-web WASM in THIS thread (call it from the embed worker). */
export async function createInProcessOrtRuntime(
  profile: EmbeddingProfile,
  dir: string,
  wasmBinary: Uint8Array,
): Promise<EmbeddingRuntime> {
  const [{ Tokenizer }, ort] = await Promise.all([import('@huggingface/tokenizers'), loadOrt(wasmBinary)]);
  const tokenizer = new Tokenizer(
    readJson(path.join(dir, 'tokenizer.json')),
    fs.existsSync(path.join(dir, 'tokenizer_config.json')) ? readJson(path.join(dir, 'tokenizer_config.json')) : {},
  );
  const onnxFile = path.join(dir, ...ONNX_FILE_FOR_DTYPE[profile.dtype].split('/'));
  let session: import('onnxruntime-web/wasm').InferenceSession;
  try {
    session = await ort.InferenceSession.create(fs.readFileSync(onnxFile), { executionProviders: ['wasm'] });
  } catch (err) {
    throw new Error(`cannot load ${onnxFile}: ${errMessage(err)}`);
  }
  const outputName = session.outputNames.includes('last_hidden_state') ? 'last_hidden_state' : session.outputNames[0];
  const inputs = new Set(session.inputNames);
  if (!inputs.has('input_ids')) throw new Error(`${onnxFile} has no input_ids input (inputs: ${session.inputNames.join(', ')})`);

  const embedOne = async (text: string): Promise<Float32Array> => {
    const ids = truncate(tokenizer.encode(text).ids, profile.tokenLimit);
    const n = ids.length;
    const shape = [1, n];
    // Feed only what the model declares (encoder exports differ on attention_mask / token_type_ids).
    const feeds: Record<string, import('onnxruntime-web/wasm').Tensor> = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, (v) => BigInt(v)), shape),
    };
    if (inputs.has('attention_mask')) feeds.attention_mask = new ort.Tensor('int64', new BigInt64Array(n).fill(1n), shape);
    if (inputs.has('token_type_ids')) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(n), shape);
    const result = await session.run(feeds);
    const out = result[outputName];
    const data = out.data as Float32Array;
    if (out.dims.length === 2) {
      // Already a sentence embedding [1, dims]: only normalization applies.
      return poolAndNormalize(data, 1, Number(out.dims[1]), 'cls', profile.normalize);
    }
    return poolAndNormalize(data, Number(out.dims[1]), Number(out.dims[2]), profile.pooling, profile.normalize);
  };

  // Probe once so dims are known (custom models) and a broken model fails at load, not at query.
  const probe = await embedOne('probe');
  if (profile.dims !== undefined && probe.length !== profile.dims) {
    throw new Error(`model produced ${probe.length}-dim vectors, profile expects ${profile.dims}`);
  }
  return {
    dims: probe.length,
    async embed(texts) {
      const vectors: Float32Array[] = [];
      for (const t of texts) vectors.push(await embedOne(t));
      return vectors;
    },
    async close() {
      await session.release();
    },
  };
}
