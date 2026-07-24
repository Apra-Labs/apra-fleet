import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { KBEntry, StalenessResult } from './types.js';

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

  let gitSucceeded = false;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['hash-object', ...existing.map(resolvePath)],
      root ? { cwd: root } : undefined
    );
    const lines = stdout.trim().split('\n');
    if (lines.length === existing.length) {
      for (let i = 0; i < existing.length; i++) {
        const hash = lines[i].trim();
        if (hash.length > 0) {
          result[existing[i]] = { hash, type: 'git' };
        } else {
          result[existing[i]] = { hash: sha256File(resolvePath(existing[i])), type: 'sha256' };
        }
      }
      gitSucceeded = true;
    }
  } catch {
    // fall through to per-file sha256
  }

  if (!gitSucceeded) {
    for (const p of existing) {
      if (!result[p]) {
        result[p] = { hash: sha256File(resolvePath(p)), type: 'sha256' };
      }
    }
  }

  return result;
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
