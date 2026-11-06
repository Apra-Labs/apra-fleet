/**
 * Main-thread side of the KB embedder runtime: every model load and every
 * session.run (documents AND queries) happens in a worker_thread
 * (embed-worker.ts); this thread only posts texts and receives the
 * Float32Array vectors (their buffers transferred, not copied).
 *
 * Why: onnxruntime-web WASM runs synchronously on the thread that calls
 * session.run -- awaiting it does not yield to timers or I/O. On the server's
 * main thread one batch froze every tool call and /health for seconds (a 5 ms
 * interval got zero ticks for 2-6 s per batch on the real model).
 *
 * Lifecycle: the worker starts lazily (the first load), is unref'd while idle
 * so it never keeps a process alive, and is terminated by close() (server
 * shutdown). If it crashes or exits on its own, every pending request rejects
 * with EmbedWorkerLostError and onLost callbacks fire, so the embedder marks
 * itself failed and keyword search keeps serving; the server never crashes.
 *
 * Where the worker script comes from (resolveEmbedWorkerScript):
 *   1. SEA binary: the self-contained CommonJS bundle embedded as the SEA
 *      asset EMBED_WORKER_SEA_ASSET (built by scripts/build-sea.mjs, added by
 *      scripts/gen-sea-config.mjs), run with eval -- a SEA has no script file
 *      on disk. The WASM bytes come from the WASM_SEA_ASSET asset, read here
 *      and handed over in workerData, so the worker resolves no paths.
 *   2. Plain install (tsc output): the sibling embed-worker.js.
 *   3. The plain-Node CommonJS bundle (dist/sea-bundle.cjs): the sibling
 *      kb-embed-worker.cjs that build-sea.mjs writes next to it.
 *   4. TS source (tests, tsx): embed-worker.ts bundled on the fly with
 *      esbuild (a dev dependency, present in a source checkout only).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { EmbeddingProfile } from './profiles.js';
import type { EmbeddingRuntime } from './ort-runtime.js';
import type { MainToWorker, WorkerToMain } from './embed-worker-core.js';

/** SEA asset name of the onnxruntime-web WASM binary (see scripts/gen-sea-config.mjs). */
export const WASM_SEA_ASSET = 'onnxruntime-web/ort-wasm-simd-threaded.wasm';
/** SEA asset name of the bundled embed worker script (see scripts/build-sea.mjs, gen-sea-config.mjs). */
export const EMBED_WORKER_SEA_ASSET = 'kb/embed-worker.cjs';
/** File name of the bundled embed worker next to dist/sea-bundle.cjs. */
export const EMBED_WORKER_BUNDLE_FILE = 'kb-embed-worker.cjs';

/** A worker died (crash or unexpected exit); the runtime is unusable. */
export class EmbedWorkerLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbedWorkerLostError';
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isSea(): boolean {
  try {
    const sea = createRequire(import.meta.url)('node:sea') as { isSea?: () => boolean };
    return typeof sea.isSea === 'function' && sea.isSea();
  } catch {
    return false;
  }
}

function seaAsset(name: string): ArrayBuffer {
  const sea = createRequire(import.meta.url)('node:sea') as { getAsset(name: string): ArrayBuffer };
  try {
    return sea.getAsset(name);
  } catch (err) {
    throw new Error(`this binary has no ${name} asset (rebuild with npm run build:binary): ${errMessage(err)}`);
  }
}

/** The onnxruntime-web WASM binary: the SEA asset in a binary, the installed package file otherwise. */
export function loadOrtWasmBinary(): Uint8Array {
  if (isSea()) return new Uint8Array(seaAsset(WASM_SEA_ASSET));
  const file = createRequire(import.meta.url).resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm');
  return fs.readFileSync(file);
}

/** A worker script: a file (path or URL) or, with eval, the script source itself. */
export interface EmbedWorkerScript {
  script: string | URL;
  eval: boolean;
  /** Where it came from (diagnostics). */
  origin: 'sea-asset' | 'compiled' | 'bundle-file' | 'esbuild-source';
}

function sibling(name: string): string | null {
  try {
    const file = fileURLToPath(new URL(`./${name}`, import.meta.url));
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

let sourceBundle: Promise<string> | null = null;

/** Bundle embed-worker.ts with esbuild (TS source runs only). */
function bundleFromSource(entry: string): Promise<string> {
  if (!sourceBundle) {
    sourceBundle = (async () => {
      // Non-literal specifier: no bundler pulls esbuild into a build of this module.
      const esbuildName = 'esbuild';
      let esbuild: typeof import('esbuild');
      try {
        esbuild = (await import(esbuildName)) as typeof import('esbuild');
      } catch (err) {
        throw new Error(`cannot bundle the embed worker from source (${entry}): esbuild unavailable: ${errMessage(err)}`);
      }
      const out = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        platform: 'node',
        target: 'node22',
        format: 'cjs',
        write: false,
        logLevel: 'silent',
        define: { 'import.meta.url': 'import_meta_url' },
        banner: { js: EMBED_WORKER_BANNER },
        loader: { '.node': 'empty' },
      });
      return out.outputFiles[0].text;
    })().catch((err) => { sourceBundle = null; throw err; });
  }
  return sourceBundle;
}

/**
 * Banner of every CommonJS bundle of the worker: shims import.meta.url (unused
 * by the worker's own code; a dependency may read it) for an eval'd script,
 * whose __filename may be a pseudo name.
 */
export const EMBED_WORKER_BANNER =
  'var import_meta_url = (typeof __filename === "string" && require("path").isAbsolute(__filename)) ' +
  '? require("url").pathToFileURL(__filename).href : "file:///kb-embed-worker.cjs";';

/** Where this process loads the embed worker from (see the module header for the order). */
export async function resolveEmbedWorkerScript(): Promise<EmbedWorkerScript> {
  if (isSea()) {
    return { script: new TextDecoder().decode(seaAsset(EMBED_WORKER_SEA_ASSET)), eval: true, origin: 'sea-asset' };
  }
  const compiled = sibling('embed-worker.js');
  if (compiled) return { script: compiled, eval: false, origin: 'compiled' };
  const bundled = sibling(EMBED_WORKER_BUNDLE_FILE);
  if (bundled) return { script: bundled, eval: false, origin: 'bundle-file' };
  const source = sibling('embed-worker.ts');
  if (source) return { script: await bundleFromSource(source), eval: true, origin: 'esbuild-source' };
  throw new Error(`no embed worker script found next to ${import.meta.url}`);
}

/** How to start the worker. Default: the real ORT worker with the WASM bytes. Tests inject their own. */
export interface EmbedWorkerSpawn {
  script: EmbedWorkerScript;
  workerData?: unknown;
}

export interface WorkerRuntimeOptions {
  spawn?: () => Promise<EmbedWorkerSpawn>;
}

async function defaultSpawn(): Promise<EmbedWorkerSpawn> {
  return { script: await resolveEmbedWorkerScript(), workerData: { wasmBinary: loadOrtWasmBinary() } };
}

/**
 * Load profile's model from dir in a new worker thread. Resolves once the
 * worker has loaded it (dims known); rejects with the worker's load error.
 */
export async function createWorkerRuntime(
  profile: EmbeddingProfile,
  dir: string,
  opts: WorkerRuntimeOptions = {},
): Promise<EmbeddingRuntime> {
  const spawn = await (opts.spawn ?? defaultSpawn)();
  const worker = new Worker(spawn.script.script, { eval: spawn.script.eval, workerData: spawn.workerData });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();
  const lostCallbacks: ((reason: string) => void)[] = [];
  let lost: string | null = null;
  let closing = false;
  let loadSettle: { resolve: (dims: number) => void; reject: (e: Error) => void } | null = null;

  // Keep the process alive only while work is in flight (a script awaiting an
  // embedding must not exit early); an idle worker never holds a process open.
  const updateRef = () => {
    if (loadSettle || pending.size > 0) worker.ref();
    else worker.unref();
  };

  const lose = (reason: string) => {
    if (lost !== null || closing) return;
    lost = reason;
    const err = new EmbedWorkerLostError(reason);
    if (loadSettle) { loadSettle.reject(err); loadSettle = null; }
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    for (const cb of lostCallbacks) {
      try { cb(reason); } catch { /* a listener must not break the others */ }
    }
  };

  worker.on('message', (msg: WorkerToMain) => {
    switch (msg.type) {
      case 'loaded':
        loadSettle?.resolve(msg.dims);
        loadSettle = null;
        break;
      case 'load-error':
        loadSettle?.reject(new Error(msg.message));
        loadSettle = null;
        break;
      case 'result':
      case 'error': {
        const p = pending.get(msg.id);
        if (!p) break;
        pending.delete(msg.id);
        if (msg.type === 'result') p.resolve(msg.vectors);
        else p.reject(new Error(msg.message));
        break;
      }
    }
    updateRef();
  });
  worker.on('error', (err) => lose(`embed worker crashed: ${errMessage(err)}`));
  worker.on('exit', (code) => lose(`embed worker exited (code ${code})`));

  const close = async () => {
    if (closing) return;
    closing = true;
    const err = new EmbedWorkerLostError('embed worker closed');
    if (loadSettle) { loadSettle.reject(err); loadSettle = null; }
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    await worker.terminate();
  };

  let dims: number;
  try {
    dims = await new Promise<number>((resolve, reject) => {
      loadSettle = { resolve, reject };
      updateRef();
      const load: MainToWorker = { type: 'load', profile, dir };
      worker.postMessage(load);
    });
  } catch (err) {
    // A failed load leaves nothing running.
    await close().catch(() => {});
    throw err;
  }
  updateRef();

  return {
    dims,
    embed(texts: string[], opts?: { priority?: 'high' | 'normal' }): Promise<Float32Array[]> {
      if (closing) return Promise.reject(new EmbedWorkerLostError('embed worker closed'));
      if (lost !== null) return Promise.reject(new EmbedWorkerLostError(lost));
      const id = nextId++;
      return new Promise<Float32Array[]>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        updateRef();
        const msg: MainToWorker = { type: 'embed', id, texts, priority: opts?.priority ?? 'normal' };
        worker.postMessage(msg);
      });
    },
    close,
    onLost(cb) {
      if (lost !== null) cb(lost);
      else lostCallbacks.push(cb);
    },
  };
}
