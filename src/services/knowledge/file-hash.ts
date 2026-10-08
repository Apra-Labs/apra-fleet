import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { KBEntry, StalenessResult } from './types.js';
import { logWarn } from '../../utils/log-helpers.js';

// T3.1 (D4 fold-in, Phase 2 review MEDIUM yashr-d8b): computeFileHashBatch
// gains an optional { cwd } anchor so a caller resolving a bible/basis against
// a DIFFERENT repo root (e.g. kb_import's --repo) never needs to mutate the
// process-wide working directory (process.chdir) to get relative paths to
// resolve correctly. When cwd is given, every relative path is resolved
// against it for existence/read/git-hash purposes; the RETURNED map is still
// keyed by the ORIGINAL (unresolved) path strings, matching every existing
// caller's basis-map key expectations. Absolute paths are unaffected (already
// cwd-independent). Omitting cwd preserves the exact previous behavior
// (implicit process.cwd() resolution via fs/execFile defaults).
function execFileAsync(
  cmd: string,
  args: string[],
  opts?: { cwd?: string }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts ?? {}, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

export interface FileHashResult {
  hash: string;
  type: 'git' | 'sha256';
}

function sha256File(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return createHash('sha256').update(data).digest('hex');
}

export async function computeFileHash(filePath: string): Promise<FileHashResult | null> {
  if (!fs.existsSync(filePath)) return null;

  try {
    const { stdout } = await execFileAsync('git', ['hash-object', filePath]);
    const hash = stdout.trim();
    if (hash.length > 0) {
      return { hash, type: 'git' };
    }
  } catch {
    // fall through to sha256
  }

  const hash = sha256File(filePath);
  return { hash, type: 'sha256' };
}

export async function computeFileHashBatch(
  filePaths: string[],
  opts?: { cwd?: string }
): Promise<Record<string, FileHashResult | null>> {
  const result: Record<string, FileHashResult | null> = {};

  if (filePaths.length === 0) return result;

  const root = opts?.cwd;
  // Resolve a possibly-relative basis path against the explicit root WITHOUT
  // touching process.cwd(). Absolute paths pass through unchanged.
  const resolvePath = (p: string): string =>
    root && !path.isAbsolute(p) ? path.join(root, p) : p;

  const existing = filePaths.filter(p => fs.existsSync(resolvePath(p)));
  const missing = filePaths.filter(p => !fs.existsSync(resolvePath(p)));

  for (const p of missing) {
    result[p] = null;
  }

  if (existing.length === 0) return result;

  // One `git hash-object` per chunk, each kept under HASH_ARGV_CHAR_BUDGET:
  // a single argv holding every path overflowed the Windows command-line limit
  // (32767 chars) for large bibles / long checkout paths, git failed, and the
  // sha256 fallback below then never matched the stored git-type basis -- so
  // freshnessSweep silently staled EVERY entry.
  for (const chunk of chunkByArgvLength(existing, resolvePath)) {
    let gitSucceeded = false;
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['hash-object', ...chunk.map(resolvePath)],
        root ? { cwd: root } : undefined
      );
      const lines = stdout.trim().split('\n');
      if (lines.length === chunk.length) {
        for (let i = 0; i < chunk.length; i++) {
          const hash = lines[i].trim();
          if (hash.length > 0) {
            result[chunk[i]] = { hash, type: 'git' };
          } else {
            result[chunk[i]] = { hash: sha256File(resolvePath(chunk[i])), type: 'sha256' };
          }
        }
        gitSucceeded = true;
      }
    } catch (err) {
      // Not silent: a sha256 fallback cannot match a git-type basis, so every
      // entry citing these files will look stale until git hashing works again.
      logWarn('kb_hash', `git hash-object failed for ${chunk.length} file(s); falling back to sha256, so freshness checks against git-type bases will report them stale: ${(err as Error)?.message ?? String(err)}`);
    }

    if (!gitSucceeded) {
      for (const p of chunk) {
        if (!result[p]) {
          result[p] = { hash: sha256File(resolvePath(p)), type: 'sha256' };
        }
      }
    }
  }

  return result;
}

// Well under the Windows 32767-char command-line limit (and POSIX ARG_MAX),
// leaving room for the executable path and quoting overhead.
const HASH_ARGV_CHAR_BUDGET = 8000;

function chunkByArgvLength(paths: string[], resolvePath: (p: string) => string): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const p of paths) {
    const cost = resolvePath(p).length + 3; // separator + possible quotes
    if (current.length > 0 && length + cost > HASH_ARGV_CHAR_BUDGET) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(p);
    length += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function checkStaleness(entry: KBEntry): Promise<StalenessResult> {
  if (entry.type !== 'context-cache') return { stale: false };

  if (entry.content_hash === 'invalidated') {
    return { stale: true, reason: 'invalidated' };
  }

  const sourceFile = entry.source_files[0];
  if (!sourceFile) return { stale: false };

  if (!fs.existsSync(sourceFile)) {
    return { stale: true, reason: 'file_missing' };
  }

  try {
    let currentHash: string;
    if (entry.content_hash_type === 'git') {
      const result = await computeFileHash(sourceFile);
      if (!result) return { stale: true, reason: 'file_missing' };
      currentHash = result.hash;
    } else {
      currentHash = sha256File(sourceFile);
    }

    const stale = currentHash !== entry.content_hash;
    return { stale, currentHash };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      return { stale: true, reason: 'unreadable' };
    }
    throw err;
  }
}

/**
 * The repo folder a HEAD-anchored hash was asked for is not inside a git work
 * tree. Thrown instead of silently falling back to hashing files on disk:
 * a disk hash is a working-tree hash, not a branch-HEAD hash.
 */
export class KbHeadHashError extends Error {
  readonly code = 'E-BIBLE-BASIS-NOT-GIT' as const;
  readonly folder: string;
  readonly remediation: string;
  constructor(folder: string, detail: string) {
    const remediation = `Run this from a git checkout ('git init' or clone the repository into '${folder}').`;
    super(`E-BIBLE-BASIS-NOT-GIT: '${folder}' is not inside a git work tree, so file content at HEAD cannot be read (${detail}). Remediation: ${remediation}`);
    this.name = 'KbHeadHashError';
    this.folder = folder;
    this.remediation = remediation;
  }
}

function gitWithStdin(args: string[], cwd: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf-8'));
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${Buffer.concat(err).toString('utf-8').trim()}`));
    });
    child.stdin.end(input);
  });
}

/**
 * Hash each file's content AT THE WORK TREE'S HEAD COMMIT (not the file on
 * disk), keyed by the original path strings. Relative paths resolve against
 * `cwd`, exactly as computeFileHashBatch({ cwd }) resolves them.
 *
 * Digest: the git blob id of HEAD:<path>. That is the same digest the stored
 * basis carries -- computeFileHashBatch runs `git hash-object <file>`, which
 * applies the same clean filters as `git add`, so a file whose on-disk content
 * equals its HEAD content hashes to the HEAD blob id. Uncommitted edits
 * therefore never change the result.
 *
 * A file absent at HEAD (untracked, deleted, a directory, a submodule) maps to
 * null. An unborn HEAD (no commit yet) maps every file to null. A `cwd` that is
 * not inside a git work tree throws KbHeadHashError -- never a disk fallback.
 * Absolute paths are not supported (they map to null): HEAD content is only
 * addressable repo-relatively.
 */
export async function computeHeadFileHashBatch(
  filePaths: string[],
  opts: { cwd: string },
): Promise<Record<string, FileHashResult | null>> {
  const result: Record<string, FileHashResult | null> = {};
  const cwd = opts.cwd;
  // The git check runs even for an empty list, so a caller in a non-git
  // folder always fails loud rather than quietly admitting nothing.

  let prefix: string;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree', '--show-prefix'], { cwd });
    const lines = stdout.split('\n');
    if (lines[0].trim() !== 'true') throw new Error('not inside a work tree');
    prefix = (lines[1] ?? '').trim();
  } catch (err) {
    throw new KbHeadHashError(cwd, (err as Error)?.message ?? String(err));
  }

  if (filePaths.length === 0) return result;
  for (const p of filePaths) result[p] = null;

  try {
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd });
  } catch {
    return result; // unborn HEAD: nothing is committed, so nothing matches
  }

  const queried: string[] = [];
  const lines: string[] = [];
  for (const p of filePaths) {
    if (typeof p !== 'string' || p.length === 0 || /[\r\n]/.test(p) || path.isAbsolute(p) || path.win32.isAbsolute(p)) continue;
    const rel = path.posix.normalize(prefix + p.replace(/\\/g, '/'));
    if (rel.startsWith('../') || rel === '..' || rel === '.') continue;
    queried.push(p);
    lines.push('HEAD:' + rel);
  }
  if (queried.length === 0) return result;

  const stdout = await gitWithStdin(['cat-file', '--batch-check=%(objectname) %(objecttype)'], cwd, lines.join('\n') + '\n');
  const outLines = stdout.split('\n');
  for (let i = 0; i < queried.length; i++) {
    const [oid, type] = (outLines[i] ?? '').trim().split(' ');
    if (type === 'blob' && /^[0-9a-f]{40,64}$/.test(oid)) result[queried[i]] = { hash: oid, type: 'git' };
  }
  return result;
}
