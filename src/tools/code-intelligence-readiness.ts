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
import { analyzeProgress, isRecordedAnalyzeAlive, isReindexRunning, recordedIndexBuild, type AnalyzeProgress } from './code-intelligence-reindex.js';
import { indexInconsistency, readGitNexusIndexState } from './code-index-state.js';
import { scheduleIndexBuild, type ScheduleReindexOutcome } from './code-index-heal.js';
import { missingOnServerPathMessage } from '../utils/find-on-path.js';

export { readGitNexusIndexState, type GitNexusIndexState } from './code-index-state.js';

export type CodeIntelErrorCode = 'E-CODE-INDEX-NOT-READY' | 'E-CODE-INTEL-DISABLED';

export class CodeIntelError extends Error {
  readonly code: CodeIntelErrorCode;
  readonly remediation: string;
  /**
   * Machine-readable detail returned beside the one-line message as the error
   * tool result's `structuredContent` (the tool wrapper in
   * src/services/tool-registry.ts maps any thrown error carrying it). Set on
   * every E-CODE-INDEX-NOT-READY (IndexNotReadyData); absent otherwise.
   */
  readonly structuredContent?: Record<string, unknown>;
  constructor(code: CodeIntelErrorCode, problem: string, remediation: string, structuredContent?: Record<string, unknown>) {
    super(`${code}: ${problem} Remediation: ${remediation}`);
    this.name = 'CodeIntelError';
    this.code = code;
    this.remediation = remediation;
    if (structuredContent) this.structuredContent = structuredContent;
  }
}

/** Suggested wait before the single retry while a build runs or was just requested (the message says "in a minute or so"). */
export const RETRY_AFTER_BUILDING_MS = 60_000;
/** Suggested wait when a build finished moments ago (the scheduler's cooldown). */
export const RETRY_AFTER_COOLDOWN_MS = 60_000;
/** Suggested wait when the index changed under a call (a rebuild may already be done). */
export const RETRY_AFTER_CHANGED_MS = 5_000;

/**
 * The structured data on every E-CODE-INDEX-NOT-READY tool result
 * (`structuredContent`), next to the unchanged one-line text:
 *
 *   retry_after_ms  -- always a number: how long to wait before ONE retry.
 *                      0 together with retry_will_help: false when no build
 *                      is running and none could be requested, so waiting
 *                      and retrying will not help (follow the remediation or
 *                      fall back).
 *   retry_will_help -- false when no build is running and none was requested.
 *   state           -- the readiness state ('changed' for an answer discarded
 *                      because the index changed while the call ran).
 *   build           -- 'running' (an analyze is live), 'requested' (one was
 *                      just started for this call), or 'none'.
 *   heal            -- the automatic build outcome when one was attempted
 *                      ('started' or the scheduler's not-started reason).
 *   progress        -- the live analyze's phase, elapsed time, last log line
 *                      and line count (as code_status shows) when one is
 *                      recorded for the folder.
 */
export interface IndexNotReadyData {
  code: 'E-CODE-INDEX-NOT-READY';
  provider: CodeIndexProvider;
  state: CodeIndexNotReadyState | 'changed';
  retry_after_ms: number;
  retry_will_help: boolean;
  build: 'running' | 'requested' | 'none';
  heal?: string;
  progress?: AnalyzeProgress;
}

function notReadyData(
  provider: CodeIndexProvider,
  repo: string | undefined,
  state: IndexNotReadyData['state'],
  build: IndexNotReadyData['build'],
  retryAfterMs: number,
  heal?: string,
): Record<string, unknown> {
  const data: IndexNotReadyData = {
    code: 'E-CODE-INDEX-NOT-READY',
    provider,
    state,
    retry_after_ms: retryAfterMs,
    retry_will_help: retryAfterMs > 0,
    build,
  };
  if (heal !== undefined) data.heal = heal;
  if (provider === 'gitnexus' && repo) {
    const progress = analyzeProgress(repo);
    if (progress) data.progress = progress;
  }
  return data as unknown as Record<string, unknown>;
}

export type CodeIndexProvider = 'gitnexus' | 'codebase-memory';

/**
 * Why an index is not ready:
 *   building    -- an analyze is live (this server's run, a held analyze lock,
 *                  or a recorded run whose pid is alive);
 *   interrupted -- meta.json says incrementalInProgress but no analyze is live:
 *                  a run died mid-write and nothing will finish it;
 *   missing     -- no usable index and no analyze is live;
 *   inconsistent -- the index looks complete but its metadata disagrees with
 *                  itself (gitnexus's registry, or fleet's record of its last
 *                  build, names a different commit than meta.json), and no
 *                  analyze is live: a torn write whose answers cannot be
 *                  trusted. `detail` says which copies disagree.
 */
export type CodeIndexNotReadyState = 'missing' | 'building' | 'interrupted' | 'inconsistent';

export type CodeIndexReadiness =
  | { ready: true }
  | { ready: false; state: CodeIndexNotReadyState; detail?: string };

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
 *                      analyze is live (see 'building' below) AND the
 *                      metadata is consistent (indexInconsistency). An
 *                      analyze rewrites the index IN PLACE, so a complete-
 *                      looking meta.json under a live analyze is NOT served:
 *                      that is the fence that keeps a half-rewritten graph
 *                      from answering. A placeholder meta.json
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
    // Live analyze first: it may be rewriting an index whose meta.json still
    // reads as complete.
    if (idx.lockHeld || isReindexRunning(repo) || isRecordedAnalyzeAlive(repo)) return { ready: false, state: 'building' };
    if (idx.metaPresent && idx.incrementalInProgress) return { ready: false, state: 'interrupted' };
    if (!idx.metaPresent || idx.lastCommit === '') return { ready: false, state: 'missing' };
    const inconsistency = indexInconsistency(repo, idx, recordedIndexBuild(repo));
    if (inconsistency) return { ready: false, state: 'inconsistent', detail: inconsistency };
    return { ready: true };
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
  detail?: string,
): CodeIntelError {
  const where = repo ? ` for '${repo}'` : '';
  if (provider === 'codebase-memory') {
    // codebase-memory exposes no building signal and fleet never builds its
    // index: waiting will not help until someone indexes the project.
    return new CodeIntelError(
      'E-CODE-INDEX-NOT-READY',
      `No codebase-memory code index found${where}.`,
      `Say "Index this project" to your agent (or run 'codebase-memory-mcp cli index_repository' on the repo), then retry.`,
      notReadyData(provider, repo, state, 'none', 0),
    );
  }
  if (state === 'building') {
    return new CodeIntelError(
      'E-CODE-INDEX-NOT-READY',
      `The gitnexus code index${where} is still being built.`,
      RETRY_SOON,
      notReadyData(provider, repo, state, 'running', RETRY_AFTER_BUILDING_MS),
    );
  }
  const problem = state === 'interrupted'
    ? `The gitnexus code index${where} is marked incomplete and no running analyze was found.`
    : state === 'inconsistent'
      ? `The gitnexus code index${where} has inconsistent metadata${detail ? ` (${detail})` : ''}, so its answers cannot be trusted.`
      : `No gitnexus code index found${where}.`;
  const [what, remediation] = healText(heal);
  const [build, retryAfterMs] = healRetry(heal);
  const healName = heal ? (heal.started ? 'started' : heal.reason) : undefined;
  return new CodeIntelError(
    'E-CODE-INDEX-NOT-READY',
    `${problem}${what}`,
    remediation,
    notReadyData(provider, repo, state, build, retryAfterMs, healName),
  );
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
      // heal.detail is spawnAnalyze's npxUnavailableReason(): which tool is
      // missing (npx or node), the PATH searched, and the install/refresh
      // remedy -- the same text code_reindex reports.
      return [
        ' The fleet server cannot start a build: a tool it needs is not on its PATH.',
        `${heal.detail || missingOnServerPathMessage('npx')} Then retry the same call.`,
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

/** [build, retry_after_ms] for a heal outcome: only a running/requested build or a cooldown is worth waiting for. */
function healRetry(heal: IndexHealOutcome | undefined): [IndexNotReadyData['build'], number] {
  if (!heal) return ['none', 0];
  if (heal.started) return ['requested', RETRY_AFTER_BUILDING_MS];
  if (heal.reason === 'already-running') return ['running', RETRY_AFTER_BUILDING_MS];
  if (heal.reason === 'cooldown') return ['none', RETRY_AFTER_COOLDOWN_MS];
  return ['none', 0];
}

/**
 * The typed error for an answer discarded because the index changed while the
 * call ran: `after` is readiness re-read once the call returned. Not ready ->
 * the error for that state; still ready -> the index was replaced (an analyze
 * finished) mid-call. Either way: retry.
 */
export function indexChangedDuringCallError(repo: string, after: CodeIndexReadiness): CodeIntelError {
  if (!after.ready && after.state !== 'building') {
    return new CodeIntelError(
      'E-CODE-INDEX-NOT-READY',
      `The gitnexus code index for '${repo}' changed while this call was answered and is now ${after.state}${after.detail ? ` (${after.detail})` : ''}; the answer was discarded.`,
      'Retry the same call; it requests a rebuild if one is needed (code_status shows the index state).',
      notReadyData('gitnexus', repo, 'changed', 'none', RETRY_AFTER_CHANGED_MS),
    );
  }
  const why = after.ready ? 'was replaced by an index build' : 'started being rebuilt';
  return new CodeIntelError(
    'E-CODE-INDEX-NOT-READY',
    `The gitnexus code index for '${repo}' ${why} while this call was answered; the answer was discarded.`,
    RETRY_SOON,
    after.ready
      ? notReadyData('gitnexus', repo, 'changed', 'none', RETRY_AFTER_CHANGED_MS)
      : notReadyData('gitnexus', repo, 'changed', 'running', RETRY_AFTER_BUILDING_MS),
  );
}

/** Throw E-CODE-INDEX-NOT-READY unless the provider's index for `repo` is ready. Never starts a build. */
export function assertCodeIndexReady(provider: CodeIndexProvider, repo?: string): void {
  const readiness = codeIndexReadiness(provider, repo);
  if (!readiness.ready) throw indexNotReadyError(provider, repo, readiness.state, undefined, readiness.detail);
}

/**
 * The gitnexus code_* pre-flight: return when `repo`'s index is ready, else
 * throw E-CODE-INDEX-NOT-READY -- but first HEAL a dead index. A 'missing',
 * 'interrupted' or 'inconsistent' index gets a background build (scheduleIndexBuild: config-,
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
  throw indexNotReadyError('gitnexus', repo, readiness.state, heal, readiness.detail);
}

/** The typed error every NullProvider method throws. */
export function codeIntelDisabledError(method: string): CodeIntelError {
  return new CodeIntelError(
    'E-CODE-INTEL-DISABLED',
    `Code intelligence is disabled (provider 'none'), so ${method} cannot be answered.`,
    `Pick a provider: update_member code_intel_provider ('gitnexus' or 'codebase-memory') for this member, or set "provider" in the code-intelligence config.json (apra-fleet install), then retry.`,
  );
}
