/**
 * Local text embedder for the KB: turns queries and documents into vectors
 * with the model the KB config selects (embedding.model), lazily.
 *
 * Runtime: the two packages transformers.js v4 itself runs on --
 * onnxruntime-web (ONNX Runtime compiled to WebAssembly) and
 * @huggingface/tokenizers (pure JS) -- driven directly, with pooling and
 * normalization done here. Not @huggingface/transformers: in Node its entry
 * point imports onnxruntime-node, a native addon that loads its .node binding
 * at import time, plus sharp (another native addon). The fleet server ships
 * as a Node SEA whose require() resolves builtins only, and build-sea.mjs's
 * loader {'.node': 'empty'} hides a native addon at BUILD time, so it would
 * only fail at RUNTIME -- the exact way better-sqlite3 once caused a silent
 * total KB outage (see the header of ../sqlite-provider.ts). Nothing on this
 * module's import graph is a native addon; tests/knowledge/embedder-no-native
 * asserts it.
 *
 * WASM binary: onnxruntime-web's 'onnxruntime-web/wasm' entry is the bundle
 * variant, whose Emscripten glue is inlined (no runtime import() of a sibling
 * .mjs, which a SEA cannot do); only the ~14 MB ort-wasm-simd-threaded.wasm
 * must be supplied, and it is handed over as bytes (env.wasm.wasmBinary), so
 * no file path is ever resolved by the runtime. Decision: in the SEA binary
 * the .wasm is embedded as a SEA asset (WASM_SEA_ASSET, added by
 * scripts/gen-sea-config.mjs), so the binary is version-locked to the glue it
 * was bundled with and works offline; in plain Node it is read from the
 * installed onnxruntime-web package. The model itself is never shipped: the
 * model store downloads it on first use.
 *
 * Threads: numThreads 1 -- the threaded build would spawn workers from a
 * script URL, which a SEA does not have.
 *
 * Failure policy: any download or load failure moves the embedder to failed,
 * logged once with the reason; embedQuery/embedDocuments then resolve to null
 * (never throw or reject) so callers fall back to keyword and anchor search.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { logWarn } from '../../../utils/log-helpers.js';
import { readEmbeddingModelSetting } from '../kb-config.js';
import { ModelStore } from './model-store.js';
import {
  ONNX_FILE_FOR_DTYPE,
  resolveEmbeddingModel,
  type EmbeddingModelChoice,
  type EmbeddingProfile,
} from './profiles.js';

/** SEA asset name of the onnxruntime-web WASM binary (see scripts/gen-sea-config.mjs). */
export const WASM_SEA_ASSET = 'onnxruntime-web/ort-wasm-simd-threaded.wasm';

/** A loaded model: embeds already-prefixed texts into pooled (and, per profile, normalized) vectors. */
export interface EmbeddingRuntime {
  dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Pipeline factory seam: load the model in dir for profile. Tests inject a fake. */
export type EmbeddingRuntimeFactory = (profile: EmbeddingProfile, dir: string) => Promise<EmbeddingRuntime>;

export type EmbedderState =
  | { state: 'idle'; modelId: string; revision: string }
  | { state: 'loading'; modelId: string; revision: string }
  | { state: 'ready'; modelId: string; revision: string; dims: number }
  | { state: 'disabled' }
  | { state: 'failed'; modelId?: string; revision?: string; reason: string };

export type EmbedderLog = (message: string) => void;

export interface EmbedderOptions {
  choice: EmbeddingModelChoice;
  store?: ModelStore;
  runtimeFactory?: EmbeddingRuntimeFactory;
  log?: EmbedderLog;
}

const defaultLog: EmbedderLog = (m) => logWarn('kb_embedding', m);

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Embedder {
  private readonly choice: EmbeddingModelChoice;
  private readonly store: ModelStore;
  private readonly runtimeFactory: EmbeddingRuntimeFactory;
  private readonly log: EmbedderLog;
  private current: EmbedderState;
  private runtime: EmbeddingRuntime | null = null;
  private loading: Promise<EmbeddingRuntime | null> | null = null;

  constructor(opts: EmbedderOptions) {
    this.choice = opts.choice;
    this.store = opts.store ?? new ModelStore();
    this.runtimeFactory = opts.runtimeFactory ?? createOrtRuntime;
    this.log = opts.log ?? defaultLog;
    this.current = opts.choice.kind === 'disabled'
      ? { state: 'disabled' }
      : { state: 'idle', modelId: opts.choice.profile.modelId, revision: opts.choice.profile.revision };
  }

  get state(): EmbedderState { return this.current; }

  /** The active profile, or null when embedding is disabled. */
  get profile(): EmbeddingProfile | null {
    return this.choice.kind === 'enabled' ? this.choice.profile : null;
  }
  get modelId(): string | null { return this.profile?.modelId ?? null; }
  get revision(): string | null { return this.profile?.revision ?? null; }
  /** Vector size: the loaded model's, else the profile's (undefined for a not-yet-loaded custom model). */
  get dims(): number | undefined { return this.runtime?.dims ?? this.profile?.dims; }
  get tokenLimit(): number | null { return this.profile?.tokenLimit ?? null; }

  /** Embed a search query (profile query prefix applied). Null when disabled or failed. */
  async embedQuery(text: string): Promise<Float32Array | null> {
    const out = await this.embedWith([text], this.profile?.queryPrefix ?? '');
    return out ? out[0] : null;
  }

  /** Embed documents (profile doc prefix applied). Null when disabled or failed. */
  async embedDocuments(texts: string[]): Promise<Float32Array[] | null> {
    if (texts.length === 0) return this.choice.kind === 'enabled' && this.current.state !== 'failed' ? [] : null;
    return this.embedWith(texts, this.profile?.docPrefix ?? '');
  }

  private async embedWith(texts: string[], prefix: string): Promise<Float32Array[] | null> {
    try {
      const runtime = await this.ensureLoaded();
      if (!runtime) return null;
      return await runtime.embed(texts.map((t) => prefix + t));
    } catch (err) {
      // A run error on one input is not a load failure: the model stays ready.
      this.log(`embedding failed for ${this.modelId ?? 'model'}: ${errMessage(err)}`);
      return null;
    }
  }

  private ensureLoaded(): Promise<EmbeddingRuntime | null> {
    if (this.runtime) return Promise.resolve(this.runtime);
    if (this.choice.kind === 'disabled' || this.current.state === 'failed') return Promise.resolve(null);
    if (!this.loading) this.loading = this.load(this.choice.profile);
    return this.loading;
  }

  private async load(profile: EmbeddingProfile): Promise<EmbeddingRuntime | null> {
    const ids = { modelId: profile.modelId, revision: profile.revision };
    this.current = { state: 'loading', ...ids };
    let reason: string;
    try {
      const stored = await this.store.ensure({ kind: 'enabled', profile });
      if (stored.state === 'ready') {
        const runtime = await this.runtimeFactory(profile, stored.dir);
        this.runtime = runtime;
        this.current = { state: 'ready', ...ids, dims: runtime.dims };
        return runtime;
      }
      reason = stored.state === 'failed' ? stored.reason : `model store returned ${stored.state}`;
    } catch (err) {
      reason = `load failed: ${errMessage(err)}`;
    }
    this.current = { state: 'failed', ...ids, reason };
    this.log(`embedding model ${profile.modelId}@${profile.revision} unavailable, semantic search off (keyword and anchor search remain): ${reason}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Process-wide embedder (lazy): built from the KB config on first use.
// ---------------------------------------------------------------------------

let shared: Embedder | null = null;

/** The process embedder for this host's KB config; constructing it loads nothing. */
export function getEmbedder(): Embedder {
  if (!shared) {
    const choice = resolveEmbeddingModel(readEmbeddingModelSetting(), (m) => logWarn('kb_config', m));
    shared = new Embedder({ choice });
  }
  return shared;
}

/** Current state of the process embedder, without loading anything. */
export function getEmbeddingState(): EmbedderState {
  return getEmbedder().state;
}

/** Tests only: replace (or with null, reset) the process embedder. */
export function _setEmbedderForTest(e: Embedder | null): void {
  shared = e;
}

// ---------------------------------------------------------------------------
// onnxruntime-web runtime
// ---------------------------------------------------------------------------

function isSea(): boolean {
  try {
    const sea = createRequire(import.meta.url)('node:sea') as { isSea?: () => boolean };
    return typeof sea.isSea === 'function' && sea.isSea();
  } catch {
    return false;
  }
}

/** The onnxruntime-web WASM binary: the SEA asset in a binary, the installed package file otherwise. */
export function loadOrtWasmBinary(): Uint8Array {
  if (isSea()) {
    const sea = createRequire(import.meta.url)('node:sea') as { getAsset(name: string): ArrayBuffer };
    try {
      return new Uint8Array(sea.getAsset(WASM_SEA_ASSET));
    } catch (err) {
      throw new Error(`this binary has no ${WASM_SEA_ASSET} asset (rebuild with npm run build:binary): ${errMessage(err)}`);
    }
  }
  const file = createRequire(import.meta.url).resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm');
  return fs.readFileSync(file);
}

type Ort = typeof import('onnxruntime-web/wasm');
let ortPromise: Promise<Ort> | null = null;

/** Import and configure onnxruntime-web once. */
function loadOrt(): Promise<Ort> {
  if (!ortPromise) {
    ortPromise = (async () => {
      const ort = await import('onnxruntime-web/wasm');
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmBinary = loadOrtWasmBinary();
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

/** Default runtime factory: tokenizer.json + the profile's ONNX file, run on onnxruntime-web WASM. */
export const createOrtRuntime: EmbeddingRuntimeFactory = async (profile, dir) => {
  const [{ Tokenizer }, ort] = await Promise.all([import('@huggingface/tokenizers'), loadOrt()]);
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
  };
};
