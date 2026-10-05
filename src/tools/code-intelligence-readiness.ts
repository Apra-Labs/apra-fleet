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

import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { isRecordedAnalyzeAlive, isReindexRunning } from './code-intelligence-reindex.js';
import { readGitNexusIndexState } from './code-index-state.js';
import { scheduleIndexBuild, type ScheduleReindexOutcome } from './code-index-heal.js';

export { readGitNexusIndexState, type GitNexusIndexState } from './code-index-state.js';

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

/**
 * Why an index is not ready:
 *   building    -- an analyze is live (this server's run, a held analyze lock,
 *                  or a recorded run whose pid is alive);
 *   interrupted -- meta.json says incrementalInProgress but no analyze is live:
 *                  a run died mid-write and nothing will finish it;
 *   missing     -- no usable index and no analyze is live.
 */
export type CodeIndexNotReadyState = 'missing' | 'building' | 'interrupted';

export type CodeIndexReadiness =
  | { ready: true }
  | { ready: false; state: CodeIndexNotReadyState };

// codebase-memory-mcp's default database storage directory (its README
// "Persistence" section: SQLite databases under ~/.cache/codebase-memory-mcp/).
export const CODEBASE_MEMORY_CACHE_DIR = join(homedir(), '.cache', 'codebase-memory-mcp');

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
 *                      'building' while an analyze is LIVE -- this server's
 *                      own run, a held analyze lock, or a status.json run
 *                      (codeIndexDir) whose pid is alive, which covers a run
 *                      left by a previous server instance where the gitnexus
 *                      lock is a socket with no file (Windows/Linux). With no
 *                      live analyze, a meta.json still flagged
 *                      incrementalInProgress is 'interrupted' (a run died
 *                      mid-write), anything else 'missing' -- both are dead
 *                      states the code_* pre-flight heals by starting a build.
 *   codebase-memory -- ready when its cache dir holds at least one project
 *                      database; it exposes no building signal.
 *
 * Pure: never starts anything (fleet/member health reports call it too).
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
    if (idx.lockHeld || isReindexRunning(repo) || isRecordedAnalyzeAlive(repo)) return { ready: false, state: 'building' };
    if (idx.metaPresent && idx.incrementalInProgress) return { ready: false, state: 'interrupted' };
    return { ready: false, state: 'missing' };
  } catch {
    return { ready: false, state: 'missing' };
  }
}

/**
 * What the pre-flight did about a not-ready index: the scheduler's outcome, or
 * 'remote-member' when the work folder is not on this host (nothing can be
 * built here). Omitted when no heal was attempted.
 */
export type IndexHealOutcome = ScheduleReindexOutcome | { started: false; reason: 'remote-member'; detail?: string };

const RETRY_SOON = 'Retry the same call in a minute or so (code_status shows the build progress).';

/** The typed error for a readiness result that is not ready. */
export function indexNotReadyError(
  provider: CodeIndexProvider,
  repo: string | undefined,
  state: CodeIndexNotReadyState,
  heal?: IndexHealOutcome,
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
    return new CodeIntelError('E-CODE-INDEX-NOT-READY', `The gitnexus code index${where} is still being built.`, RETRY_SOON);
  }
  const problem = state === 'interrupted'
    ? `The gitnexus code index${where} is marked incomplete and no running analyze was found.`
    : `No gitnexus code index found${where}.`;
  const [what, remediation] = healText(heal);
  return new CodeIntelError('E-CODE-INDEX-NOT-READY', `${problem}${what}`, remediation);
}

/** [sentence appended to the problem, remediation] for a heal outcome. */
function healText(heal: IndexHealOutcome | undefined): [string, string] {
  const detail = heal && !heal.started && heal.detail ? ` (${heal.detail})` : '';
  if (!heal) return ['', 'Call code_reindex to build the index, then retry the same call.'];
  if (heal.started) return [' An index build was requested automatically.', RETRY_SOON];
  switch (heal.reason) {
    case 'already-running':
      return [' An index build is already running.', RETRY_SOON];
    case 'paused': {
      const p = heal.pause;
      const last = p.lastLine ? `, last line '${p.lastLine}'` : '';
      return [
        ` Automatic rebuilds for this folder are paused: the last automatic analyze ended '${p.result}' without a ready index (log: ${p.logPath}${last}).`,
        'Read that log, fix the cause, then call code_reindex -- it retries the build and re-arms automatic rebuilds.',
      ];
    }
    case 'disabled':
      return [
        ' Automatic index builds are off (autoReindex.enabled is false in the code-intelligence config.json).',
        'Call code_reindex to build the index, then retry the same call.',
      ];
    case 'cooldown':
      return [
        ` An index build finished moments ago${detail}.`,
        'Retry the same call in a minute or so; if it still fails, check code_status and call code_reindex.',
      ];
    case 'npx-not-found':
      return [
        ' The fleet server cannot build it: npx is not on its PATH.',
        'Install Node.js (which provides npm and npx) on the fleet server host and restart the server, then retry the same call.',
      ];
    case 'remote-member':
      return [
        ' The work folder is not on this host, so this server cannot build an index for it.',
        'Use the code_* tools from a session on the host that holds the work folder (code_reindex there builds the index), then retry.',
      ];
    default:
      return [
        ` Starting an automatic index build failed: ${heal.reason}${detail}.`,
        'Read the analyze log via code_status, then call code_reindex and retry.',
      ];
  }
}

/** Throw E-CODE-INDEX-NOT-READY unless the provider's index for `repo` is ready. Never starts a build. */
export function assertCodeIndexReady(provider: CodeIndexProvider, repo?: string): void {
  const readiness = codeIndexReadiness(provider, repo);
  if (!readiness.ready) throw indexNotReadyError(provider, repo, readiness.state);
}

/**
 * The gitnexus code_* pre-flight: return when `repo`'s index is ready, else
 * throw E-CODE-INDEX-NOT-READY -- but first HEAL a dead index. A 'missing' or
 * 'interrupted' index gets a background build (scheduleIndexBuild: config-,
 * cooldown- and single-flight-gated, never throws), so a stale or crashed
 * index recovers without anyone running analyze by hand; the error then says
 * whether a build started or why not. Never schedules for a 'building' index,
 * nor for a work folder that is not on this host (`remote`, or absent here):
 * that error says so instead.
 */
export function ensureGitNexusIndexReady(repo: string, opts: { remote?: boolean } = {}): void {
  const readiness = codeIndexReadiness('gitnexus', repo);
  if (readiness.ready) return;
  if (readiness.state === 'building') throw indexNotReadyError('gitnexus', repo, 'building');
  let local = false;
  try { local = !opts.remote && existsSync(repo); } catch { /* treat as not local */ }
  const heal: IndexHealOutcome = local ? scheduleIndexBuild(repo) : { started: false, reason: 'remote-member' };
  throw indexNotReadyError('gitnexus', repo, readiness.state, heal);
}

/** The typed error every NullProvider method throws. */
export function codeIntelDisabledError(method: string): CodeIntelError {
  return new CodeIntelError(
    'E-CODE-INTEL-DISABLED',
    `Code intelligence is disabled (provider 'none'), so ${method} cannot be answered.`,
    `Pick a provider: update_member code_intel_provider ('gitnexus' or 'codebase-memory') for this member, or set "provider" in the code-intelligence config.json (apra-fleet install), then retry.`,
  );
}
