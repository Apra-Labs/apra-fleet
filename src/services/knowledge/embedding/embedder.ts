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
 * Threads: the model loads and runs in a worker thread (worker-runtime.ts ->
 * embed-worker.ts -> ort-runtime.ts), never on the server's main thread,
 * because one onnxruntime-web session.run is seconds of synchronous CPU that
 * would otherwise freeze every tool call and /health. Inside the worker,
 * numThreads 1 -- the threaded build would spawn its own workers from a
 * script URL, which a SEA does not have.
 *
 * Failure policy: any download or load failure (or a worker that dies) moves
 * the embedder to failed, logged once per attempt with the reason;
 * embedQuery/embedDocuments then resolve to null (never throw or reject) so
 * callers fall back to keyword and anchor search. A failed load is retried in
 * the background after a bounded backoff (embedderRetryDelayMs: 60 s, doubling,
 * capped at 15 min), never left failed for the life of the process; onReady
 * listeners (the embed queue) hear when a retry succeeds.
 *
 * Start-up: warmUp() starts the load in the background without waiting. The
 * embed queue calls it after a KB opens with vectors already stored, so
 * semantic search comes back after a restart without any write.
 */
import { logWarn } from '../../../utils/log-helpers.js';
import { readEmbeddingModelSetting } from '../kb-config.js';
import { ModelStore } from './model-store.js';
import {
  resolveEmbeddingModel,
  type EmbeddingModelChoice,
  type EmbeddingProfile,
} from './profiles.js';
import type { EmbeddingRuntime, EmbeddingRuntimeFactory } from './ort-runtime.js';
import { createWorkerRuntime, EmbedWorkerLostError } from './worker-runtime.js';

export type { EmbeddingRuntime, EmbeddingRuntimeFactory } from './ort-runtime.js';
export { poolAndNormalize, createInProcessOrtRuntime } from './ort-runtime.js';
export { WASM_SEA_ASSET, EMBED_WORKER_SEA_ASSET, loadOrtWasmBinary, EmbedWorkerLostError } from './worker-runtime.js';

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
  /** Retry backoff after a failed load (defaults: EMBEDDER_RETRY_INITIAL_MS, EMBEDDER_RETRY_MAX_MS). */
  retry?: { initialMs?: number; maxMs?: number };
}

/** First retry after a failed model load. */
export const EMBEDDER_RETRY_INITIAL_MS = 60_000;
/** Longest wait between load retries. */
export const EMBEDDER_RETRY_MAX_MS = 15 * 60_000;

/** Wait before retry number `failures` (1-based): initial, doubling, capped at max. */
export function embedderRetryDelayMs(
  failures: number,
  initialMs = EMBEDDER_RETRY_INITIAL_MS,
  maxMs = EMBEDDER_RETRY_MAX_MS,
): number {
  return Math.min(maxMs, initialMs * 2 ** Math.max(0, failures - 1));
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
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
  private readonly retryInitialMs: number;
  private readonly retryMaxMs: number;
  /** Consecutive failed loads (drives the backoff); 0 once a load succeeds. */
  private failures = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly readyListeners = new Set<() => void>();

  constructor(opts: EmbedderOptions) {
    this.choice = opts.choice;
    this.retryInitialMs = opts.retry?.initialMs ?? EMBEDDER_RETRY_INITIAL_MS;
    this.retryMaxMs = opts.retry?.maxMs ?? EMBEDDER_RETRY_MAX_MS;
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

  /**
   * Start loading the model in the background if nothing has started it yet
   * (state idle). Never waits, never throws; a no-op when disabled, loading,
   * ready, or failed (a failed load retries on its own timer).
   */
  warmUp(): void {
    if (this.choice.kind !== 'enabled' || this.current.state !== 'idle') return;
    void this.ensureLoaded();
  }

  /** Call cb each time a load succeeds (first load or a retry). Returns an unsubscribe. */
  onReady(cb: () => void): () => void {
    this.readyListeners.add(cb);
    return () => { this.readyListeners.delete(cb); };
  }

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
      if (err instanceof EmbedWorkerLostError) {
        // The worker died under this request: the runtime is gone (onLost has
        // normally marked the embedder failed already).
        this.markLost(err.message);
        return null;
      }
      // A run error on one input is not a load failure: the model stays ready.
      this.log(`embedding failed for ${this.modelId ?? 'model'}: ${errMessage(err)}`);
      return null;
    }
  }

  /** The runtime died on its own (worker crash/exit): failed, keyword search keeps serving. */
  private markLost(reason: string): void {
    if (!this.runtime || this.choice.kind !== 'enabled') return;
    const profile = this.choice.profile;
    this.runtime = null;
    this.loading = null;
    this.current = { state: 'failed', modelId: profile.modelId, revision: profile.revision, reason };
    const delay = this.scheduleRetry(profile);
    this.log(`embedding model ${profile.modelId}@${profile.revision} stopped, semantic search off (keyword and anchor search remain): ${reason}; retrying in ${seconds(delay)}`);
  }

  /** Arm the next load attempt after the backoff for the current failure count. Returns the wait. */
  private scheduleRetry(profile: EmbeddingProfile): number {
    this.failures++;
    const delay = embedderRetryDelayMs(this.failures, this.retryInitialMs, this.retryMaxMs);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.current.state !== 'failed' || this.runtime || this.loading) return;
      this.loading = this.load(profile);
    }, delay);
    this.retryTimer.unref?.();
    return delay;
  }

  /**
   * Release the loaded runtime (terminates the embed worker). The embedder can
   * load again on the next embed call. Never throws.
   */
  async close(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const runtime = this.runtime ?? (this.loading ? await this.loading.catch(() => null) : null);
    if (this.retryTimer) clearTimeout(this.retryTimer); // a load that failed while closing
    this.retryTimer = null;
    this.runtime = null;
    this.loading = null;
    this.failures = 0;
    if (this.choice.kind === 'enabled') {
      this.current = { state: 'idle', modelId: this.choice.profile.modelId, revision: this.choice.profile.revision };
    }
    try { await runtime?.close?.(); } catch { /* shutting down */ }
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
        this.loading = null;
        runtime.onLost?.((reason) => { if (this.runtime === runtime) this.markLost(reason); });
        if (this.failures > 0) {
          this.log(`embedding model ${profile.modelId}@${profile.revision} loaded on retry ${this.failures}; semantic search on`);
        }
        this.failures = 0;
        for (const cb of [...this.readyListeners]) {
          try { cb(); } catch { /* a listener must not break the load */ }
        }
        return runtime;
      }
      reason = stored.state === 'failed' ? stored.reason : `model store returned ${stored.state}`;
    } catch (err) {
      reason = `load failed: ${errMessage(err)}`;
    }
    this.current = { state: 'failed', ...ids, reason };
    this.loading = null;
    const delay = this.scheduleRetry(profile);
    this.log(`embedding model ${profile.modelId}@${profile.revision} unavailable, semantic search off (keyword and anchor search remain): ${reason}; retrying in ${seconds(delay)}`);
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

/**
 * Server shutdown: terminate the process embedder's worker, bounded so a stuck
 * worker can never hang the stop. Never throws.
 */
export async function shutdownEmbedder(timeoutMs = 2000): Promise<void> {
  const e = shared;
  if (!e) return;
  let t: NodeJS.Timeout | undefined;
  await Promise.race([
    e.close(),
    new Promise<void>((r) => { t = setTimeout(r, timeoutMs); t.unref?.(); }),
  ]);
  if (t) clearTimeout(t);
}

/** Tests only: replace (or with null, reset) the process embedder. */
export function _setEmbedderForTest(e: Embedder | null): void {
  shared = e;
}

// ---------------------------------------------------------------------------
// onnxruntime-web runtime (in a worker thread)
// ---------------------------------------------------------------------------

/**
 * Default runtime factory: the model loads and runs in a worker thread
 * (worker-runtime.ts, embed-worker.ts), never on the calling thread.
 */
export const createOrtRuntime: EmbeddingRuntimeFactory = (profile, dir) => createWorkerRuntime(profile, dir);
