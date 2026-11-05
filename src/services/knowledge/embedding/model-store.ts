/**
 * Model store: puts an embedding model's files on disk, lazily, and says
 * whether it is usable.
 *
 * - Hub models land in <FLEET_DIR>/models/<repo id>@<revision>/ (the repo id
 *   keeps its owner/name split, so the folder is also a valid transformers.js
 *   local model id relative to <FLEET_DIR>/models).
 * - Nothing downloads at construction or import time: the first ensure() call
 *   for a model does it, and concurrent first calls share that one download.
 * - Each file downloads to a temp name beside its final path; a built-in
 *   profile's file is sha256-checked before the rename, and a mismatch deletes
 *   the temp file and fails the model (never a silently wrong model on disk).
 *   Files already on disk are re-verified once per process.
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

/** Download seam: fetch url into destPath (create or overwrite). Rejects on any failure. */
export type ModelDownloadFn = (url: string, destPath: string) => Promise<void>;

export interface ModelStoreOptions {
  /** Root of the models folder; default <FLEET_DIR>/models. */
  modelsDir?: string;
  /** Download seam; default streams over fetch(). Tests inject a fake. */
  download?: ModelDownloadFn;
  /** Hugging Face endpoint; default HF_ENDPOINT or https://huggingface.co. */
  hubEndpoint?: string;
}

/** Overall per-file download budget (the largest built-in file is ~34 MB). */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** Default download: stream the HTTP body to destPath. */
export const fetchDownload: ModelDownloadFn = async (url, destPath) => {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), fs.createWriteStream(destPath));
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

export class ModelStore {
  readonly modelsDir: string;
  private readonly download: ModelDownloadFn;
  private readonly hubEndpoint: string;
  /** One promise per model folder: in flight, or settled ready. Failures are dropped so a later call may retry. */
  private readonly pending = new Map<string, Promise<ModelState>>();

  constructor(opts: ModelStoreOptions = {}) {
    this.modelsDir = opts.modelsDir ?? path.join(FLEET_DIR, 'models');
    this.download = opts.download ?? fetchDownload;
    this.hubEndpoint = (opts.hubEndpoint ?? process.env.HF_ENDPOINT ?? 'https://huggingface.co').replace(/\/+$/, '');
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
        return { state: 'failed', profile, reason: err instanceof Error ? err.message : String(err) };
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

    for (const file of src.files) {
      const dest = path.join(dir, ...file.path.split('/'));
      if (fs.existsSync(dest)) {
        if (!file.sha256) continue;
        const actual = await sha256OfFile(dest);
        if (actual === file.sha256) continue;
        // A corrupt or tampered file on disk: drop it and fetch a fresh copy.
        fs.rmSync(dest, { force: true });
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.part-${process.pid}-${randomUUID().slice(0, 8)}`;
      const url = `${this.hubEndpoint}/${src.repo}/resolve/${encodeURIComponent(src.revision)}/${file.path}`;
      try {
        await this.download(url, tmp);
        if (file.sha256) {
          const actual = await sha256OfFile(tmp);
          if (actual !== file.sha256) {
            return {
              state: 'failed',
              profile,
              reason: `sha256 mismatch for ${src.repo}@${src.revision}/${file.path}: expected ${file.sha256}, got ${actual}; file removed`,
            };
          }
        }
        fs.renameSync(tmp, dest);
      } catch (err) {
        return {
          state: 'failed',
          profile,
          reason: `download of ${src.repo}@${src.revision}/${file.path} failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    return { state: 'ready', profile, dir };
  }
}
