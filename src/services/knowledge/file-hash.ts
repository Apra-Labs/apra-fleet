import { execFile } from 'node:child_process';
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
