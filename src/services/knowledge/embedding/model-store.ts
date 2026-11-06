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
 * - One overall deadline (downloadDeadlineMs, default
 *   MODEL_DOWNLOAD_DEADLINE_MS) bounds the whole download -- every file,
 *   redirects and body streaming -- not each request: a server trickling
 *   bytes forever fails at the deadline with a reason naming the timeout.
 * - Files already on disk are re-verified once per process.
 * - A local folder (air-gapped installs) is used as-is: no download, no hash.
 *
 * The result is a typed state (ready | disabled | failed {reason}); this
 * module never throws to its caller.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FLEET_DIR } from '../../../paths.js';
import { ONNX_FILE_FOR_DTYPE, type EmbeddingModelChoice, type EmbeddingProfile } from './profiles.js';

export type ModelState =
  | { state: 'ready'; profile: EmbeddingProfile; dir: string }
  | { state: 'disabled' }
  | { state: 'failed'; profile?: EmbeddingProfile; reason: string };

/**
 * Download seam: fetch url into destPath (create or overwrite). Rejects on any
 * failure. signal aborts at the overall model download deadline; a seam that
 * ignores it is still cut off (the store stops waiting at the deadline).
 */
export type ModelDownloadFn = (url: string, destPath: string, signal?: AbortSignal) => Promise<void>;

export interface ModelStoreOptions {
  /** Root of the models folder; default <FLEET_DIR>/models. */
  modelsDir?: string;
  /** Download seam; default streams over fetch(). Tests inject a fake. */
  download?: ModelDownloadFn;
  /** Hugging Face endpoint; default HF_ENDPOINT or https://huggingface.co. */
  hubEndpoint?: string;
  /** Overall deadline for one model's whole download; default MODEL_DOWNLOAD_DEADLINE_MS. */
  downloadDeadlineMs?: number;
}

/** Overall budget for downloading one model (all files; the largest built-in file is ~34 MB). */
export const MODEL_DOWNLOAD_DEADLINE_MS = 20 * 60 * 1000;

/** Default download: stream the HTTP body to destPath, abortable at any point. */
export const fetchDownload: ModelDownloadFn = async (url, destPath, signal) => {
  const res = await fetch(url, { redirect: 'follow', signal });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  await pipeline(
    Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
    fs.createWriteStream(destPath),
    signal ? { signal } : {},
  );
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
  private readonly deadlineMs: number;
  /** One promise per model folder: in flight, or settled ready. Failures are dropped so a later call may retry. */
  private readonly pending = new Map<string, Promise<ModelState>>();

  constructor(opts: ModelStoreOptions = {}) {
    this.modelsDir = opts.modelsDir ?? path.join(FLEET_DIR, 'models');
    this.download = opts.download ?? fetchDownload;
    this.hubEndpoint = (opts.hubEndpoint ?? process.env.HF_ENDPOINT ?? 'https://huggingface.co').replace(/\/+$/, '');
    this.deadlineMs = opts.downloadDeadlineMs ?? MODEL_DOWNLOAD_DEADLINE_MS;
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

    // One deadline for the whole download.
    const deadline = new AbortController();
    const timeoutReason = `timed out after ${this.deadlineMs / 1000} s (overall model download deadline)`;
    let onDeadline!: (err: Error) => void;
    const deadlineHit = new Promise<never>((_, reject) => { onDeadline = reject; });
    deadlineHit.catch(() => { /* observed via the race below */ });
    const timer = setTimeout(() => {
      const err = new Error(timeoutReason);
      deadline.abort(err);
      onDeadline(err);
    }, this.deadlineMs);
    timer.unref?.();

    let current = '';
    try {
      for (const file of src.files) {
        current = file.path;
        const staged = path.join(staging, ...file.path.split('/'));
        fs.mkdirSync(path.dirname(staged), { recursive: true });
        if (good.has(file.path)) {
          fs.copyFileSync(path.join(dir, ...file.path.split('/')), staged);
          continue;
        }
        if (deadline.signal.aborted) throw new Error(timeoutReason);
        const url = `${this.hubEndpoint}/${src.repo}/resolve/${encodeURIComponent(src.revision)}/${file.path}`;
        try {
          await Promise.race([this.download(url, staged, deadline.signal), deadlineHit]);
        } catch (err) {
          throw new Error(deadline.signal.aborted ? timeoutReason : errMessage(err));
        }
        if (file.sha256) {
          const actual = await sha256OfFile(staged);
          if (actual !== file.sha256) {
            return {
              state: 'failed',
              profile,
              reason: `sha256 mismatch for ${src.repo}@${src.revision}/${file.path}: expected ${file.sha256}, got ${actual}; file removed`,
            };
          }
        }
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
      return { state: 'ready', profile, dir };
    } catch (err) {
      return {
        state: 'failed',
        profile,
        reason: `download of ${src.repo}@${src.revision}/${current} failed: ${errMessage(err)}`,
      };
    } finally {
      clearTimeout(timer);
      fs.rmSync(staging, { recursive: true, force: true });
    }
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
