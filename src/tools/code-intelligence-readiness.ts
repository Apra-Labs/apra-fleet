// Typed code_* errors and the single code-index readiness check.
//
// Kept in its own module -- NOT importing from code-intelligence.ts -- so the
// provider files (code-intelligence-gitnexus.ts, -codebase-memory.ts) can
// import it as a value without a circular import (same reason as
// code-intelligence-reindex.ts).
//
// Errors are THROWN, never returned as a result object: the code_* handlers
// JSON.stringify a provider result into an ok envelope, so a returned
// "error-shaped" object would read as success to the caller. A thrown error
// becomes an isError tool result at the MCP boundary. Each message is one
// line, 'CODE: problem Remediation: ...' -- the same pattern as KbSelfError
// (src/services/knowledge/kb-self.ts).

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { isReindexRunning } from './code-intelligence-reindex.js';

export type CodeIntelErrorCode = 'E-CODE-INDEX-NOT-READY' | 'E-CODE-INTEL-DISABLED';

export class CodeIntelError extends Error {
  readonly code: CodeIntelErrorCode;
  readonly remediation: string;
  constructor(code: CodeIntelErrorCode, problem: string, remediation: string) {
    super(`${code}: ${problem} Remediation: ${remediation}`);
    this.name = 'CodeIntelError';
    this.code = code;
    this.remediation = remediation;
  }
}

export type CodeIndexProvider = 'gitnexus' | 'codebase-memory';

export type CodeIndexReadiness =
  | { ready: true }
  | { ready: false; state: 'missing' | 'building' };

// codebase-memory-mcp's default database storage directory (its README
// "Persistence" section: SQLite databases under ~/.cache/codebase-memory-mcp/).
export const CODEBASE_MEMORY_CACHE_DIR = join(homedir(), '.cache', 'codebase-memory-mcp');

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

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
function isPidAlive(pid: number): boolean {
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

/** The commit a gitnexus answer for `repo` is served from ('' when unknown). */
export function indexedCommitOf(repo: string): string {
  return readGitNexusIndexState(repo).lastCommit;
}

/**
 * THE readiness check for a code index -- the one place that decides whether
 * a provider can answer for `repo`. Never throws; any IO failure reads as
 * not ready.
 *
 *   gitnexus        -- ready when <repo>/.gitnexus/meta.json has a non-empty
 *                      lastCommit AND no incrementalInProgress flag AND no
 *                      analyze lock is held. A placeholder meta.json
 *                      (lastCommit '') is NOT an index. Not ready is
 *                      'building' when an analyze is running/locked/mid-write
 *                      or a .gitnexus dir exists, else 'missing'.
 *   codebase-memory -- ready when its cache dir holds at least one project
 *                      database; it exposes no building signal.
 */
export function codeIndexReadiness(provider: CodeIndexProvider, repo?: string): CodeIndexReadiness {
  try {
    if (provider === 'codebase-memory') {
      const ready = existsSync(CODEBASE_MEMORY_CACHE_DIR) && readdirSync(CODEBASE_MEMORY_CACHE_DIR).length > 0;
      return ready ? { ready: true } : { ready: false, state: 'missing' };
    }
    if (!repo) return { ready: true };
    const idx = readGitNexusIndexState(repo);
    if (idx.metaPresent && idx.lastCommit !== '' && !idx.incrementalInProgress && !idx.lockHeld) {
      return { ready: true };
    }
    const building = isReindexRunning(repo) || idx.lockHeld || idx.incrementalInProgress || isDir(join(repo, '.gitnexus'));
    return { ready: false, state: building ? 'building' : 'missing' };
  } catch {
    return { ready: false, state: 'missing' };
  }
}

/** The typed error for a readiness result that is not ready. */
export function indexNotReadyError(
  provider: CodeIndexProvider,
  repo: string | undefined,
  state: 'missing' | 'building',
): CodeIntelError {
  const where = repo ? ` for '${repo}'` : '';
  if (provider === 'codebase-memory') {
    return new CodeIntelError(
      'E-CODE-INDEX-NOT-READY',
      `No codebase-memory code index found${where}.`,
      `Say "Index this project" to your agent (or run 'codebase-memory-mcp cli index_repository' on the repo), then retry.`,
    );
  }
  if (state === 'building') {
    return new CodeIntelError(
      'E-CODE-INDEX-NOT-READY',
      `The gitnexus code index${where} is still being built.`,
      `Wait for the running 'npx gitnexus analyze' to finish, then retry (re-run it in the repo if none is running).`,
    );
  }
  return new CodeIntelError(
    'E-CODE-INDEX-NOT-READY',
    `No gitnexus code index found${where}.`,
    `Run 'npx gitnexus analyze' in the repo (or /pm index), then retry.`,
  );
}

/** Throw E-CODE-INDEX-NOT-READY unless the provider's index for `repo` is ready. */
export function assertCodeIndexReady(provider: CodeIndexProvider, repo?: string): void {
  const readiness = codeIndexReadiness(provider, repo);
  if (!readiness.ready) throw indexNotReadyError(provider, repo, readiness.state);
}

/** The typed error every NullProvider method throws. */
export function codeIntelDisabledError(method: string): CodeIntelError {
  return new CodeIntelError(
    'E-CODE-INTEL-DISABLED',
    `Code intelligence is disabled (provider 'none'), so ${method} cannot be answered.`,
    `Pick a provider: update_member code_intel_provider ('gitnexus' or 'codebase-memory') for this member, or set "provider" in the code-intelligence config.json (apra-fleet install), then retry.`,
  );
}
