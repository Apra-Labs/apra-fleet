import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPidAlive } from '../../utils/process-utils.js';

// Cross-process exclusive lock for one bible file. serializeBibleWrite
// (src/tools/kb-export.ts) orders writers inside ONE process; two servers on
// one checkout (stdio transport, or a manual `apra-fleet kb commit` during a
// run) each read-merge-write the same file, and without this the slower one
// overwrites the faster one's entries.
//
// The lock is a file next to the bible (<bible>.lock) created with O_EXCL
// ('wx'), holding {pid, host, at}. Node fs only: no shell, the same on Windows,
// macOS and Linux. A lock is STALE, and removed, when its holder ran on this
// host and that pid is gone (a killed process), when it is older than
// staleMs, or when it holds no readable record and is older than a short
// grace (a holder killed between create and write). Stale removal compares the
// record it judged stale with the one on disk just before unlinking, which
// narrows (not closes) the window in which two waiters both clear one stale
// lock; kb_bible_commit also verifies the committed file afterwards, so a write
// lost in that window is reported, never claimed as committed.

export interface BibleLockOptions {
  /** How long to wait for the lock before failing. Default 60 s. */
  timeoutMs?: number;
  /** Poll interval while waiting. Default 50 ms. */
  pollMs?: number;
  /** A lock older than this is stale whatever its holder. Default 10 min. */
  staleMs?: number;
}

interface LockRecord { pid: number; host: string; at: string }

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 50;
const DEFAULT_STALE_MS = 10 * 60_000;
/** A lock file with no readable record is a writer mid-create until this old. */
const UNREADABLE_GRACE_MS = 5_000;

export class BibleLockTimeoutError extends Error {
  constructor(lockPath: string, holder: string) {
    super('timed out waiting for the bible lock ' + lockPath + ' (held by ' + holder
      + '). Another process is writing this bible; retry, or remove the lock file if its holder is gone.');
    this.name = 'BibleLockTimeoutError';
  }
}

/** The lock file path for a bible file. */
export function bibleLockPath(biblePath: string): string {
  return biblePath + '.lock';
}

function readRecord(lockPath: string): { raw: string; record: LockRecord | null; mtimeMs: number } | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const mtimeMs = fs.statSync(lockPath).mtimeMs;
    try {
      const parsed = JSON.parse(raw) as Partial<LockRecord>;
      const ok = typeof parsed.pid === 'number' && typeof parsed.host === 'string' && typeof parsed.at === 'string';
      return { raw, record: ok ? parsed as LockRecord : null, mtimeMs };
    } catch {
      return { raw, record: null, mtimeMs };
    }
  } catch {
    return null;
  }
}

function isStale(rec: { record: LockRecord | null; mtimeMs: number }, staleMs: number, now: number): boolean {
  const age = now - rec.mtimeMs;
  if (rec.record === null) return age > UNREADABLE_GRACE_MS;
  if (age > staleMs) return true;
  return rec.record.host === os.hostname() && rec.record.pid !== process.pid && !isPidAlive(rec.record.pid);
}

function tryCreate(lockPath: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    const record: LockRecord = { pid: process.pid, host: os.hostname(), at: new Date().toISOString() };
    fs.writeSync(fd, JSON.stringify(record));
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/** Run fn holding the cross-process lock of this bible file. */
export async function withBibleFileLock<T>(biblePath: string, fn: () => Promise<T>, opts: BibleLockOptions = {}): Promise<T> {
  const lockPath = bibleLockPath(biblePath);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryCreate(lockPath)) break;
    const rec = readRecord(lockPath);
    if (rec !== null && isStale(rec, staleMs, Date.now())) {
      const again = readRecord(lockPath);
      if (again !== null && again.raw === rec.raw) {
        try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
      }
      continue;
    }
    if (Date.now() >= deadline) {
      const holder = rec?.record ? 'pid ' + rec.record.pid + ' on ' + rec.record.host + ' since ' + rec.record.at : 'an unknown holder';
      throw new BibleLockTimeoutError(lockPath, holder);
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  try {
    return await fn();
  } finally {
    // Remove only our own lock: one cleared as stale and re-taken by another
    // process must not be deleted under it.
    const rec = readRecord(lockPath);
    if (rec?.record && rec.record.pid === process.pid && rec.record.host === os.hostname()) {
      try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
    }
  }
}
