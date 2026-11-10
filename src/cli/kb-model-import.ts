// `apra-fleet kb model import <folder | archive> [--model <name>]`
//
// Offline install of a built-in KB embedding model, for hosts that can reach
// neither the apra-fleet GitHub release nor Hugging Face. The input is either
// a folder in hub layout (config.json, tokenizer.json, onnx/model_quantized.onnx,
// ...) or a tar archive of one (.tar, or gzip-compressed .tar.gz / .tgz --
// read with node:zlib and the small tar reader below: no tar or zip package
// is in the dependencies, so zip is not accepted). Archive members are
// matched by their path ending in the file's hub path, so an archive whose
// files sit under a top-level folder works too.
//
// Every file is checked against the built-in profile's pinned sha256 and the
// model is placed atomically at the folder ModelStore.modelDir computes
// (ModelStore.importModel); a missing file or a bad hash places nothing and
// exits non-zero naming the file. The model defaults to the configured
// embedding.model when that is a built-in name, else the default profile.
//
// A running fleet server whose model load failed retries on its own backoff
// (Embedder.scheduleRetry, embedder.ts: 60 s doubling, capped at 15 min);
// the retry calls ModelStore.ensure, which finds the imported folder complete
// and verified and loads it with no download and no restart.

import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  BUILTIN_EMBEDDING_PROFILES,
  DEFAULT_EMBEDDING_PROFILE,
  type EmbeddingProfile,
} from '../services/knowledge/embedding/profiles.js';
import { ModelStore } from '../services/knowledge/embedding/model-store.js';
import { readKbConfigForMerge } from '../services/knowledge/kb-config.js';

const MODEL_NAMES = Object.keys(BUILTIN_EMBEDDING_PROFILES);

export const KB_MODEL_IMPORT_USAGE =
  `Usage: apra-fleet kb model import <folder | archive.tar | archive.tar.gz> [--model ${MODEL_NAMES.join(' | ')}]`;

interface Io {
  log: (msg: string) => void;
  error: (msg: string) => void;
}

const defaultIo: Io = {
  log: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
};

export interface KbModelImportOptions {
  /** Model store to place into (tests); default the process models folder. */
  store?: ModelStore;
  /** Profile to import (tests: a built-in-shaped profile pinned to test files); overrides --model. */
  profile?: EmbeddingProfile;
}

/** One regular file read from a tar archive. */
export interface TarFile {
  name: string;
  data: Buffer;
}

function cString(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf-8');
}

function octal(buf: Buffer, start: number, len: number): number {
  // GNU base-256 for very large sizes: high bit of the first byte set.
  if (buf[start] & 0x80) {
    let n = 0;
    for (let i = start + 1; i < start + len; i++) n = n * 256 + buf[i];
    return n;
  }
  const s = cString(buf, start, len).trim();
  return s === '' ? 0 : parseInt(s, 8);
}

/** Parse pax extended header records ("<len> key=value\n"). */
function paxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    if (sp === -1) break;
    const len = parseInt(data.subarray(pos, sp).toString('utf-8'), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = data.subarray(sp + 1, pos + len - 1).toString('utf-8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    pos += len;
  }
  return out;
}

/**
 * Read the regular files of a tar archive (ustar, GNU long names, pax path
 * records). Directories, links and other entry types are skipped. Throws on
 * a truncated or malformed archive.
 */
export function readTar(buf: Buffer): TarFile[] {
  const files: TarFile[] = [];
  let pos = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (pos + 512 <= buf.length) {
    const header = buf.subarray(pos, pos + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    if (sum !== octal(header, 148, 8)) throw new Error(`not a tar archive (bad header checksum at byte ${pos})`);
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = pos + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new Error('tar archive is truncated');
    const data = buf.subarray(dataStart, dataEnd);
    pos = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = cString(data, 0, data.length); continue; }
    if (type === 'x') { paxPath = paxRecords(data).path ?? null; continue; }
    if (type === 'g') continue;
    let name = cString(header, 0, 100);
    // POSIX ustar ("ustar\0") carries a name prefix; old GNU ("ustar  ") uses that area for other fields.
    if (cString(header, 257, 5) === 'ustar' && header[262] === 0) {
      const prefix = cString(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    if (longName !== null) name = longName;
    if (paxPath !== null) name = paxPath;
    longName = null;
    paxPath = null;
    if (type === '0' || type === '\0' || type === '7') files.push({ name, data: Buffer.from(data) });
  }
  return files;
}

/** Archive member for a hub file path: equal to it, or ending in /<path> (shortest wins). */
function memberFor(files: TarFile[], filePath: string): TarFile | undefined {
  let best: TarFile | undefined;
  for (const f of files) {
    const n = f.name.replace(/^(\.\/)+/, '');
    if (n.split('/').includes('..')) continue;
    if (n !== filePath && !n.endsWith(`/${filePath}`)) continue;
    if (!best || n.length < best.name.length) best = f;
  }
  return best;
}

function configuredBuiltin(): EmbeddingProfile {
  try {
    const embedding = readKbConfigForMerge().embedding;
    const raw = embedding !== null && typeof embedding === 'object' && !Array.isArray(embedding)
      ? (embedding as { model?: unknown }).model
      : undefined;
    if (typeof raw === 'string' && Object.prototype.hasOwnProperty.call(BUILTIN_EMBEDDING_PROFILES, raw)) {
      return BUILTIN_EMBEDDING_PROFILES[raw];
    }
  } catch { /* unreadable config: the default model */ }
  return BUILTIN_EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE];
}

/** Run `kb model <args>`; resolves to the process exit code. */
export async function runKbModel(args: string[], io: Io = defaultIo, opts: KbModelImportOptions = {}): Promise<number> {
  if (args[0] !== 'import') {
    io.error(args.length === 0 ? KB_MODEL_IMPORT_USAGE : `Error: unknown kb model subcommand '${args[0]}'`);
    if (args.length > 0) io.error(KB_MODEL_IMPORT_USAGE);
    return 1;
  }
  return runKbModelImport(args.slice(1), io, opts);
}

/** Run `kb model import <args>`; resolves to the process exit code. */
export async function runKbModelImport(args: string[], io: Io = defaultIo, opts: KbModelImportOptions = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.log(KB_MODEL_IMPORT_USAGE);
    return 0;
  }
  let modelName: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model') {
      modelName = args[++i];
      if (modelName === undefined) { io.error('Error: --model needs a model name'); io.error(KB_MODEL_IMPORT_USAGE); return 1; }
    } else if (args[i].startsWith('--')) {
      io.error(`Error: unknown option ${args[i]}`);
      io.error(KB_MODEL_IMPORT_USAGE);
      return 1;
    } else {
      positional.push(args[i]);
    }
  }
  if (positional.length !== 1) {
    io.error(`Error: expected one folder or archive, got ${positional.length}`);
    io.error(KB_MODEL_IMPORT_USAGE);
    return 1;
  }
  let profile: EmbeddingProfile;
  if (opts.profile) {
    profile = opts.profile;
  } else if (modelName !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(BUILTIN_EMBEDDING_PROFILES, modelName)) {
      io.error(`Error: unknown built-in model "${modelName}". Valid: ${MODEL_NAMES.join(', ')}`);
      return 1;
    }
    profile = BUILTIN_EMBEDDING_PROFILES[modelName];
  } else {
    profile = configuredBuiltin();
  }
  const src = profile.source;
  if (src.kind !== 'hub') { io.error(`Error: ${profile.name} has no pinned files`); return 1; }

  const input = path.resolve(positional[0]);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(input);
  } catch {
    io.error(`Error: ${input} does not exist; nothing was placed`);
    return 1;
  }

  let populate: (staging: string) => Promise<void>;
  if (stat.isDirectory()) {
    populate = async (staging) => {
      for (const file of src.files) {
        const from = path.join(input, ...file.path.split('/'));
        if (!fs.existsSync(from)) continue; // reported as missing by the check
        const to = path.join(staging, ...file.path.split('/'));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
    };
  } else {
    let members: TarFile[];
    try {
      let raw = fs.readFileSync(input);
      if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) raw = gunzipSync(raw);
      members = readTar(raw);
    } catch (err) {
      io.error(`Error: cannot read ${input} as a .tar or .tar.gz archive (${(err as Error).message}); nothing was placed`);
      return 1;
    }
    populate = async (staging) => {
      for (const file of src.files) {
        const member = memberFor(members, file.path);
        if (!member) continue; // reported as missing by the check
        const to = path.join(staging, ...file.path.split('/'));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, member.data);
      }
    };
  }

  const store = opts.store ?? new ModelStore();
  const result = await store.importModel(profile, populate);
  if (!result.ok) {
    io.error(`Error: ${result.reason}`);
    return 1;
  }
  io.log(`Imported ${profile.name} (${src.repo}@${src.revision}, ${src.files.length} files sha256-verified) into ${result.dir}`);
  io.log('A running fleet server loads it on its next model load attempt; no restart needed.');
  return 0;
}
