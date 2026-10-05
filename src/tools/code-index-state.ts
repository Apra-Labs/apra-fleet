// Pure reader of a repo's gitnexus index directory (<repo>/.gitnexus). Its own
// leaf module (no project imports) so both the readiness check and the analyze
// runner (code-intelligence-reindex.ts) can use it without a circular import.
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/** What the gitnexus index directory of a repo says about itself. */
export interface GitNexusIndexState {
  /** <repo>/.gitnexus/meta.json exists and parses. */
  metaPresent: boolean;
  /** meta.lastCommit; '' for a placeholder or an absent meta. */
  lastCommit: string;
  /** meta.incrementalInProgress is set (an analyze is mid-write or died mid-write). */
  incrementalInProgress: boolean;
  /** The analyze lock is held by a live process. */
  lockHeld: boolean;
}

// Verified against the installed gitnexus 1.6.12 package:
//  - dist/storage/index-lock.js: LOCK_FILENAME = 'analyze.lock', a JSON pidfile
//    ({ pid, hostname, token, ... }) in the index meta dir (<repo>/.gitnexus).
//    This is the macOS/BSD (and fallback) backend; the Windows/Linux socket
//    backend leaves no file, so for those hosts the file check is a no-op and
//    the status.json/in-process running signal covers an analyze we started.
//    A file that exists but cannot be parsed is treated as held (conservative:
//    gitnexus itself treats it as a half-written live lock).
//  - dist/core/index-freshness.js getIndexIncompleteReasons: meta
//    `incrementalInProgress` set => 'incremental-in-progress' (index incomplete).
export function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function analyzeLockHeld(gitnexusDir: string): boolean {
  const lockPath = join(gitnexusDir, 'analyze.lock');
  if (!existsSync(lockPath)) return false;
  try {
    const rec = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown };
    if (typeof rec.pid === 'number' && Number.isInteger(rec.pid) && rec.pid > 0) return isPidAlive(rec.pid);
  } catch { /* malformed / half-written: fall through to held */ }
  return true;
}

/** Read the gitnexus index state of `repo`. Never throws. */
export function readGitNexusIndexState(repo: string): GitNexusIndexState {
  const dir = join(repo, '.gitnexus');
  const state: GitNexusIndexState = { metaPresent: false, lastCommit: '', incrementalInProgress: false, lockHeld: false };
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as {
      lastCommit?: unknown; incrementalInProgress?: unknown;
    };
    state.metaPresent = true;
    state.lastCommit = typeof meta.lastCommit === 'string' ? meta.lastCommit : '';
    state.incrementalInProgress = !!meta.incrementalInProgress;
  } catch { /* absent or unparseable meta reads as no index */ }
  try { state.lockHeld = analyzeLockHeld(dir); } catch { /* ignore */ }
  return state;
}

