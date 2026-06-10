import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { KBEntry, StalenessResult } from './types.js';

function execFileAsync(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
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
  filePaths: string[]
): Promise<Record<string, FileHashResult | null>> {
  const result: Record<string, FileHashResult | null> = {};

  if (filePaths.length === 0) return result;

  const existing = filePaths.filter(p => fs.existsSync(p));
  const missing = filePaths.filter(p => !fs.existsSync(p));

  for (const p of missing) {
    result[p] = null;
  }

  if (existing.length === 0) return result;

  let gitSucceeded = false;
  try {
    const { stdout } = await execFileAsync('git', ['hash-object', ...existing]);
    const lines = stdout.trim().split('\n');
    if (lines.length === existing.length) {
      for (let i = 0; i < existing.length; i++) {
        const hash = lines[i].trim();
        if (hash.length > 0) {
          result[existing[i]] = { hash, type: 'git' };
        } else {
          result[existing[i]] = { hash: sha256File(existing[i]), type: 'sha256' };
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
        result[p] = { hash: sha256File(p), type: 'sha256' };
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
