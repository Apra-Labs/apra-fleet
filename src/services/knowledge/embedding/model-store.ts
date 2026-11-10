/**
 * Model store: puts an embedding model's files on disk, lazily, and says
 * whether it is usable.
 *
 * Models folder (the contract; existing downloads at this path are used
 * as-is, never re-downloaded):
 *   <FLEET_DIR>/models/<owner>/<name>@<revision>/
 *   e.g. <FLEET_DIR>/models/Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3/
 * The repo id keeps its owner/name split, so the folder is also a valid
 * transformers.js local model id relative to <FLEET_DIR>/models. The files
 * keep their hub layout inside it (tokenizer.json, onnx/model_quantized.onnx,
 * ...).
 *
 * - Nothing downloads at construction or import time: the first ensure() call
 *   for a model does it, and concurrent first calls share that one download.
 * - A download is staged: every file goes into a temp folder beside the model
 *   folder (<name>@<revision>.part-<pid>-<random>), each built-in profile file
 *   is sha256-checked, and only a complete, verified set is renamed into
 *   place. A model folder therefore exists only when it is complete: an
 *   interrupted or failed download leaves nothing a later run could take for
 *   a ready model (the staging folder is removed, or, after a killed process,
 *   removed by the next attempt). Files already present and verified in an
 *   existing model folder are copied into the staging folder rather than
 *   downloaded again.
 * - Downloaded bytes survive a failed attempt (and a killed process) in a
 *   resume folder beside the model folder (<name>@<revision>.partial), owned
 *   by one process at a time through <name>@<revision>.partial.lock (holder
 *   pid; a dead holder's lock is taken over). Its name never equals a model
 *   folder, so it is never loaded as a model. The next attempt reuses files
 *   there that already pass sha256 and continues the others with an HTTP Range
 *   request; a server that ignores Range (200) or rejects it (416) gets a full
 *   re-download. A file that fails sha256 -- resumed or not -- is deleted. The
 *   resume folder is removed once the model is in place. When another live
 *   process holds the lock, this attempt downloads into its own staging folder
 *   without resume.
 * - A stall timeout (stallTimeoutMs, default MODEL_DOWNLOAD_STALL_MS) fails a
 *   download only when no bytes arrive for that long; a slow but steady
 *   download never times out. The reason names the stall.
 * - The default download (fetchDownload) honours HTTPS_PROXY, HTTP_PROXY and
 *   NO_PROXY (and their lowercase spellings) through undici's
 *   EnvHttpProxyAgent; plain fetch() ignores them.
 * - Files already on disk are re-verified once per process.
 * - A local folder (air-gapped installs) is used as-is: no download, no hash.
 *
 * The result is a typed state (ready | disabled | failed {reason}); this
 * module never throws to its caller.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { FLEET_DIR } from '../../../paths.js';
import { ONNX_FILE_FOR_DTYPE, type EmbeddingModelChoice, type EmbeddingProfile } from './profiles.js';

export type ModelState =
  | { state: 'ready'; profile: EmbeddingProfile; dir: string }
  | { state: 'disabled' }
  | { state: 'failed'; profile?: EmbeddingProfile; reason: string };

/**
 * Download seam: fetch url into destPath. destPath may already hold bytes of
 * an earlier, interrupted attempt; the seam may continue them (HTTP Range) or
 * overwrite them, but must leave the whole file there on success. Rejects on
 * any failure. signal aborts when the download stalls; a seam that ignores it
 * is still cut off (the store stops waiting). onData, when called with each
 * chunk's size, counts as progress for the stall timeout; growth of destPath
 * counts too, so a seam that never calls it is not mistaken for a stall
 * while it writes.
 */
export type ModelDownloadFn = (
  url: string,
  destPath: string,
  signal?: AbortSignal,
  onData?: (bytes: number) => void,
) => Promise<void>;

export interface ModelStoreOptions {
  /** Root of the models folder; default <FLEET_DIR>/models. */
  modelsDir?: string;
  /** Download seam; default fetchDownload (proxy-aware, resumes partial files). Tests inject a fake. */
  download?: ModelDownloadFn;
  /** Hugging Face endpoint; default HF_ENDPOINT or https://huggingface.co. */
  hubEndpoint?: string;
  /** Fail a download when no bytes arrive for this long; default MODEL_DOWNLOAD_STALL_MS. */
  stallTimeoutMs?: number;
}

/** Default stall timeout: a download with no bytes for this long has failed. */
export const MODEL_DOWNLOAD_STALL_MS = 60 * 1000;

function sizeOf(file: string): number {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/** Parse the first byte position of a Content-Range header (bytes <start>-<end>/<total>). */
function contentRangeStart(header: string | null): number | null {
  const m = header ? /^bytes\s+(\d+)-\d+\/(?:\d+|\*)$/i.exec(header.trim()) : null;
  return m ? Number(m[1]) : null;
}

/**
 * Default download: stream the HTTP body to destPath, abortable at any point.
 * Goes through undici's EnvHttpProxyAgent, so HTTPS_PROXY / HTTP_PROXY /
 * NO_PROXY (and lowercase spellings) apply; global fetch() ignores them. When
 * destPath already holds bytes it asks for the rest with a Range request and
 * appends on 206; on 200 (Range ignored) it rewrites the file whole, and on
 * 416 (partial already as large as, or larger than, the file) it deletes the
 * partial and downloads afresh.
 */
export const fetchDownload: ModelDownloadFn = async (url, destPath, signal, onData) => {
  // Built per call: it reads the proxy variables at construction.
  const dispatcher = new EnvHttpProxyAgent();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const have = sizeOf(destPath);
      const headers: Record<string, string> = { 'accept-encoding': 'identity' };
      if (have > 0) headers.range = `bytes=${have}-`;
      const res = await undiciFetch(url, { redirect: 'follow', signal, headers, dispatcher });
      if (res.status === 416 && have > 0) {
        await res.body?.cancel().catch(() => {});
        fs.rmSync(destPath, { force: true });
        continue;
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      }
      const append = res.status === 206 && have > 0 && contentRangeStart(res.headers.get('content-range')) === have;
      if (res.status === 206 && !append) {
        // A range we did not ask for: start over without one.
        await res.body.cancel().catch(() => {});
        fs.rmSync(destPath, { force: true });
        continue;
      }
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          onData?.(chunk.length);
          cb(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
        counter,
        fs.createWriteStream(destPath, { flags: append ? 'a' : 'w' }),
        signal ? { signal } : {},
      );
      return;
    }
    throw new Error(`server rejected the byte range for ${url} twice`);
  } finally {
    dispatcher.destroy().catch(() => {});
  }
};

export function sha256OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when a process with this pid is running on this host. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class ModelStore {
  readonly modelsDir: string;
  private readonly download: ModelDownloadFn;
  private readonly hubEndpoint: string;
  private readonly stallMs: number;
  /** One promise per model folder: in flight, or settled ready. Failures are dropped so a later call may retry. */
  private readonly pending = new Map<string, Promise<ModelState>>();

  constructor(opts: ModelStoreOptions = {}) {
    this.modelsDir = opts.modelsDir ?? path.join(FLEET_DIR, 'models');
    this.download = opts.download ?? fetchDownload;
    this.hubEndpoint = (opts.hubEndpoint ?? process.env.HF_ENDPOINT ?? 'https://huggingface.co').replace(/\/+$/, '');
    this.stallMs = opts.stallTimeoutMs ?? MODEL_DOWNLOAD_STALL_MS;
  }

  /** Folder a profile's files live in (the local folder itself for a local profile). */
  modelDir(profile: EmbeddingProfile): string {
    const src = profile.source;
    if (src.kind === 'local') return src.path;
    const parts = src.repo.split('/');
    parts[parts.length - 1] = `${parts[parts.length - 1]}@${src.revision}`;
    return path.join(this.modelsDir, ...parts);
  }

  /** Make the chosen model usable, downloading it on first request. Never throws. */
  ensure(choice: EmbeddingModelChoice): Promise<ModelState> {
    if (choice.kind === 'disabled') return Promise.resolve({ state: 'disabled' });
    const profile = choice.profile;
    const dir = this.modelDir(profile);
    const existing = this.pending.get(dir);
    if (existing) return existing;
    const p = this.materialize(profile, dir).then(
      (state) => {
        if (state.state !== 'ready') this.pending.delete(dir);
        return state;
      },
      (err: unknown): ModelState => {
        this.pending.delete(dir);
        return { state: 'failed', profile, reason: errMessage(err) };
      },
    );
    this.pending.set(dir, p);
    return p;
  }

  private async materialize(profile: EmbeddingProfile, dir: string): Promise<ModelState> {
    const src = profile.source;
    if (src.kind === 'local') {
      let isDir = false;
      try { isDir = fs.statSync(dir).isDirectory(); } catch { /* missing */ }
      if (!isDir) return { state: 'failed', profile, reason: `local model folder ${dir} does not exist` };
      const onnx = ONNX_FILE_FOR_DTYPE[profile.dtype];
      if (!fs.existsSync(path.join(dir, onnx))) {
        return { state: 'failed', profile, reason: `local model folder ${dir} has no ${onnx} (dtype ${profile.dtype})` };
      }
      return { state: 'ready', profile, dir };
    }

    // Which files of an existing model folder are present and intact.
    const good = new Set<string>();
    for (const file of src.files) {
      const at = path.join(dir, ...file.path.split('/'));
      if (!fs.existsSync(at)) continue;
      if (file.sha256 && (await sha256OfFile(at)) !== file.sha256) continue; // corrupt or tampered: fetch afresh
      good.add(file.path);
    }
    if (good.size === src.files.length) return { state: 'ready', profile, dir };

    const parent = path.dirname(dir);
    const base = path.basename(dir);
    fs.mkdirSync(parent, { recursive: true });
    this.removeAbandonedStaging(parent, base);
    const staging = path.join(parent, `${base}.part-${process.pid}-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(staging, { recursive: true });
    // Resume folder: survives a failed attempt; null when another live process owns it.
    const resumeDir = this.claimResumeDir(parent, base);
    const lockFile = path.join(parent, `${base}.partial.lock`);

    // Stall watchdog: fails the download only when no bytes arrive for stallMs.
    const stallSecs = this.stallMs / 1000;
    const stallReason = `stalled: no data received for ${stallSecs} s (model download stall timeout)`;
    const stall = new AbortController();
    let onStall!: (err: Error) => void;
    const stallHit = new Promise<never>((_, reject) => { onStall = reject; });
    stallHit.catch(() => { /* observed via the race below */ });
    let watched: string | null = null;
    let watchedSize = 0;
    let lastActivity = Date.now();
    const markActivity = () => { lastActivity = Date.now(); };
    const timer = setInterval(() => {
      if (watched === null || stall.signal.aborted) return;
      const size = sizeOf(watched);
      if (size !== watchedSize) { watchedSize = size; markActivity(); }
      if (Date.now() - lastActivity >= this.stallMs) {
        const err = new Error(stallReason);
        stall.abort(err);
        onStall(err);
      }
    }, Math.max(10, Math.min(1000, Math.floor(this.stallMs / 4))));
    timer.unref?.();

    let current = '';
    try {
      for (const file of src.files) {
        current = file.path;
        const rel = file.path.split('/');
        const staged = path.join(staging, ...rel);
        fs.mkdirSync(path.dirname(staged), { recursive: true });
        if (good.has(file.path)) {
          fs.copyFileSync(path.join(dir, ...rel), staged);
          continue;
        }
        const target = resumeDir ? path.join(resumeDir, ...rel) : staged;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // A file finished and verified by an earlier attempt needs no request.
        const done = resumeDir !== null && file.sha256 !== undefined && file.sha256 !== ''
          && fs.existsSync(target) && (await sha256OfFile(target)) === file.sha256;
        if (!done) {
          if (stall.signal.aborted) throw new Error(stallReason);
          const url = `${this.hubEndpoint}/${src.repo}/resolve/${encodeURIComponent(src.revision)}/${file.path}`;
          watched = target;
          watchedSize = sizeOf(target);
          markActivity();
          try {
            await Promise.race([this.download(url, target, stall.signal, markActivity), stallHit]);
          } catch (err) {
            throw new Error(stall.signal.aborted ? stallReason : errMessage(err));
          } finally {
            watched = null;
          }
          if (file.sha256) {
            const actual = await sha256OfFile(target);
            if (actual !== file.sha256) {
              fs.rmSync(target, { force: true });
              return {
                state: 'failed',
                profile,
                reason: `sha256 mismatch for ${src.repo}@${src.revision}/${file.path}: expected ${file.sha256}, got ${actual}; file removed`,
              };
            }
          }
        }
        if (target !== staged) fs.copyFileSync(target, staged);
      }
      // Complete and verified: swap the staging folder into place.
      const old = fs.existsSync(dir) ? `${dir}.old-${process.pid}-${randomUUID().slice(0, 8)}` : null;
      if (old) fs.renameSync(dir, old);
      try {
        fs.renameSync(staging, dir);
      } catch (err) {
        if (old) fs.renameSync(old, dir);
        throw err;
      }
      if (old) fs.rmSync(old, { recursive: true, force: true });
      if (resumeDir) fs.rmSync(resumeDir, { recursive: true, force: true });
      return { state: 'ready', profile, dir };
    } catch (err) {
      return {
        state: 'failed',
        profile,
        reason: `download of ${src.repo}@${src.revision}/${current} failed: ${errMessage(err)}`,
      };
    } finally {
      clearInterval(timer);
      fs.rmSync(staging, { recursive: true, force: true });
      if (resumeDir) fs.rmSync(lockFile, { force: true });
    }
  }

  /**
   * Take the resume folder <base>.partial for this process: create the lock
   * <base>.partial.lock holding our pid, taking over a lock whose holder is no
   * longer running. Returns null when a live holder (another process, or this
   * one through another store) has it.
   */
  private claimResumeDir(parent: string, base: string): string | null {
    const lockFile = path.join(parent, `${base}.partial.lock`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
        let holder = 0;
        try { holder = Number(fs.readFileSync(lockFile, 'utf-8').trim()); } catch { /* vanished */ }
        if (pidAlive(holder)) return null;
        fs.rmSync(lockFile, { force: true });
        continue;
      }
      const resumeDir = path.join(parent, `${base}.partial`);
      try {
        fs.mkdirSync(resumeDir, { recursive: true });
      } catch {
        fs.rmSync(lockFile, { force: true });
        return null;
      }
      return resumeDir;
    }
    return null;
  }

  /** Remove staging/old folders of this model left by a process that is no longer running. */
  private removeAbandonedStaging(parent: string, base: string): void {
    let names: string[];
    try { names = fs.readdirSync(parent); } catch { return; }
    const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(part|old)-(\\d+)-[0-9a-f]+$`);
    for (const name of names) {
      const m = re.exec(name);
      if (!m || pidAlive(Number(m[2]))) continue;
      fs.rmSync(path.join(parent, name), { recursive: true, force: true });
    }
  }
}
