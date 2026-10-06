// Auto-reindex module (P3, design D3). Kept in its own file -- NOT importing
// from code-intelligence.ts -- so code-intelligence-gitnexus.ts can import
// this module as a value without creating a circular import (mirrors the
// code-intelligence-freshness.ts precedent: code-intelligence.ts re-exports
// GitNexusProvider from gitnexus.ts, so anything gitnexus.ts needs at module
// load time must live outside code-intelligence.ts).
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join } from 'path';
import { logWarn, logError } from '../utils/log-helpers.js';
import { findExecutableOnPath, missingOnServerPathMessage, npxUnavailableReason } from '../utils/find-on-path.js';
import { FLEET_DIR } from '../paths.js';
import { resolveProjectSlug } from '../services/knowledge/project-slug.js';
import { indexInconsistency, isPidAlive, readGitNexusIndexState, type RecordedIndexBuild } from './code-index-state.js';
import { excludeLineFor } from '../services/member-config-io.js';
import type { CodeIndexNotReadyState, CodeIndexReadiness } from './code-intelligence-readiness.js';

/** Why automatic rebuilds of a repo are paused: the automatic run that failed. */
export interface AutoReindexPause {
  /** Result of that run ('failed', 'incomplete', or 'up-to-date' that still left no ready index). */
  result: AnalyzeResult;
  lastLine: string;
  logPath: string;
  finished: string;
}

interface ReindexEntry {
  runningChild?: ChildProcess;
  /** The running child was started automatically (pre-flight heal / freshness), not by code_reindex. */
  runningAuto?: boolean;
  lastFinishedAt?: number;
  /**
   * Set when an AUTOMATIC run ends without a ready index. While set, no
   * automatic run starts for the repo (it would most likely fail the same way,
   * e.g. an analyze that runs out of memory). Cleared by a run that leaves a
   * ready index, by an explicit code_reindex, or by a server restart.
   */
  autoPaused?: AutoReindexPause;
  /**
   * The last analyze failed because gitnexus rejects --index-only. Automatic
   * runs would fail identically every cooldown, so none start until an
   * explicit code_reindex (or a restart) re-arms them.
   */
  gitnexusTooOld?: boolean;
}

// Module-level per-repo state (design D3): in-memory is acceptable -- the
// server is long-lived, and a restart just means one extra reindex.
const state = new Map<string, ReindexEntry>();

const CONFIG_PATH = join(homedir(), '.apra-fleet', 'data', 'code-intelligence', 'config.json');

export const DEFAULT_COOLDOWN_MS = 120000;

// Bound how much of the analyze log tail is read back for status / exit logging.
const LOG_TAIL_MAX_BYTES = 4000;

// Pure decision function (design D3): single-flight per repo + cooldown. No
// timers, no IO -- unit-testable directly. `entry` mirrors the shape the
// module keeps internally, but as plain data (a `running` flag instead of the
// ChildProcess itself) so the pure function never touches process objects.
export function shouldStartReindex(
  entry: { running: boolean; lastFinishedAt?: number } | undefined,
  now: number,
  cooldownMs: number = DEFAULT_COOLDOWN_MS,
): boolean {
  if (entry?.running) return false;
  if (entry?.lastFinishedAt !== undefined && now - entry.lastFinishedAt < cooldownMs) return false;
  return true;
}

interface AutoReindexConfig {
  cooldownMs?: number;
  enabled?: boolean;
}

// Config override lives ONLY in the code-intelligence config.json (design
// D2). Read synchronously -- maybeScheduleReindex is itself synchronous so
// its boolean return value can drive the freshness-note suffix (T3.2)
// without the tool call awaiting anything extra. Absent/unreadable/invalid
// config degrades to defaults (enabled: true).
function readAutoReindexConfig(): AutoReindexConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as { autoReindex?: AutoReindexConfig };
    return parsed.autoReindex ?? {};
  } catch {
    return {};
  }
}

/** True while a background reindex this server started for `repoPath` is still running. */
export function isReindexRunning(repoPath: string): boolean {
  return !!state.get(repoPath)?.runningChild;
}

// ---------------------------------------------------------------------------
// Shared analyze runner. BOTH the automatic freshness-triggered reindex
// (maybeScheduleReindex) and the explicit code_reindex tool start analyze
// through spawnAnalyze(), so both record the same analyze.log + status.json
// under <data>/code-index/<slug>/ and neither can run a second analyze in a
// folder where one is already running (this module's per-repo state, plus the
// on-disk gitnexus analyze lock for analyzes started by someone else).
// ---------------------------------------------------------------------------

export type AnalyzePhase = 'starting' | 'running' | 'done';
export type AnalyzeResult = 'indexed' | 'up-to-date' | 'incomplete' | 'failed';

export interface AnalyzeStatus {
  repo: string;
  pid: number | null;
  started: string;
  lockHeld: boolean;
  lastLine: string;
  lineCount: number;
  phase: AnalyzePhase;
  result: AnalyzeResult | null;
  exitCode: number | null;
  finished?: string;
  /** Set on a failed run whose log names a cause the fleet recognizes. */
  failureCause?: AnalyzeFailureCause;
  /** meta.json lastCommit when the run finished (fleet's own record of the build). */
  indexedCommit?: string;
}

export type NotStartedReason =
  | 'already-running'
  | 'npx-not-found'
  | 'gitnexus-not-found'
  | 'spawn-failed'
  | 'remote-member'
  | 'gitnexus-too-old';

/** Directory holding analyze.log + status.json for `repo`. */
export function codeIndexDir(repo: string): string {
  return join(FLEET_DIR, 'code-index', resolveProjectSlug(repo));
}

function statusPath(dir: string): string { return join(dir, 'status.json'); }
function logPath(dir: string): string { return join(dir, 'analyze.log'); }

function writeStatus(dir: string, status: AnalyzeStatus): void {
  try {
    const tmp = statusPath(dir) + '.tmp';
    writeFileSync(tmp, JSON.stringify(status, null, 2));
    renameSync(tmp, statusPath(dir));
  } catch (err) {
    logWarn('code-intelligence-reindex', `could not write status.json in ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readStatusFile(dir: string): AnalyzeStatus | null {
  try { return JSON.parse(readFileSync(statusPath(dir), 'utf8')) as AnalyzeStatus; } catch { return null; }
}

/** Last up-to-LOG_TAIL_MAX_BYTES of analyze.log, split into non-empty lines. */
function readLogLines(dir: string): string[] {
  try {
    const path = logPath(dir);
    const size = statSync(path).size;
    const raw = readFileSync(path, 'utf8');
    const text = size > LOG_TAIL_MAX_BYTES ? raw.slice(-LOG_TAIL_MAX_BYTES) : raw;
    return text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

function logLineCount(dir: string): number {
  try { return readFileSync(logPath(dir), 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0).length; } catch { return 0; }
}

/** Resolve an executable on PATH (PATHEXT-aware on Windows) without a shell. */
export function findOnPath(name: string): string | null {
  return findExecutableOnPath(name);
}

const GITNEXUS_MISSING = /not found|E404|404 Not Found|could not determine executable|ENOENT|ENOTFOUND|EAI_AGAIN/i;

function resultFromExit(dir: string, repo: string, code: number | null): AnalyzeResult {
  if (code !== 0) return 'failed';
  if (readLogLines(dir).some((l) => /already up to date/i.test(l))) return 'up-to-date';
  const idx = readGitNexusIndexState(repo);
  return idx.metaPresent && idx.lastCommit !== '' && !idx.incrementalInProgress && !indexInconsistency(repo, idx) ? 'indexed' : 'incomplete';
}

/**
 * Fleet's record of the last analyze it finished for `repo` (status.json):
 * the commit meta.json named when that run ended. null when no finished,
 * successful run is recorded (or it belongs to another folder sharing the
 * slug dir). Never throws.
 */
export function recordedIndexBuild(repo: string): RecordedIndexBuild | null {
  try {
    const status = readStatusFile(codeIndexDir(repo));
    if (!status || status.phase !== 'done' || !status.finished) return null;
    if (typeof status.repo === 'string' && status.repo !== repo) return null;
    if (status.result !== 'indexed' && status.result !== 'up-to-date') return null;
    if (typeof status.indexedCommit !== 'string' || status.indexedCommit === '') return null;
    return { indexedCommit: status.indexedCommit, finished: status.finished };
  } catch {
    return null;
  }
}

// The exact argv every fleet-initiated analyze runs. `--index-only` is
// gitnexus's pure index mode: it builds the index under .gitnexus/ but skips
// every AI-context write into the work tree (the AGENTS.md / CLAUDE.md block
// and the .claude/skills + .agents/skills folders). Without it, indexing a
// member's TARGET repo dirties tracked files a doer would then commit. An
// older gitnexus that does not know the flag fails loudly (analyze-failed with
// its "unknown option" line), never silently falls back to a writing run.
//
// The package is resolved at a pinned MINIMUM version: 1.6.5 is the first
// gitnexus release whose CLI defines --index-only (verified against the
// published tarballs: 1.6.4's dist/cli/index.js has no such option, 1.6.5's
// does). One constant feeds both the analyze argv and the MCP child argv.
export const GITNEXUS_MIN_VERSION = '1.6.5';
export const GITNEXUS_PACKAGE_SPEC = `gitnexus@>=${GITNEXUS_MIN_VERSION}`;
export const GITNEXUS_ANALYZE_ARGS: readonly string[] = [GITNEXUS_PACKAGE_SPEC, 'analyze', '--index-only'];

/**
 * An npx argv that is safe under a shell. On Windows spawn() runs through
 * cmd.exe (shell: true), where an unquoted `>=` is a redirection, so the
 * version-range package spec is double-quoted there.
 */
export function npxArgsForShell(args: readonly string[], shell: boolean): string[] {
  return args.map((a) => (shell && /[<>^&|]/.test(a) ? `"${a}"` : a));
}

/** Failure cause: the installed gitnexus rejects --index-only (too old). */
export type AnalyzeFailureCause = 'gitnexus-too-old';

/** The CLI parser's rejection of the flag, as it lands in analyze.log. */
const UNKNOWN_INDEX_ONLY = /unknown option\b.*--index-only|--index-only.*unknown option|unrecognized (?:option|argument)\b.*--index-only/i;

/** One-line cause + fix reported wherever the too-old failure surfaces. */
export const GITNEXUS_TOO_OLD_DETAIL =
  `the installed gitnexus does not support --index-only (needs >= ${GITNEXUS_MIN_VERSION}): upgrade gitnexus ` +
  `(npx -y ${GITNEXUS_PACKAGE_SPEC} analyze --index-only) or clear the npx cache (npm cache clean --force), then rerun code_reindex`;

function failureCauseOf(lines: readonly string[]): AnalyzeFailureCause | undefined {
  return lines.some((l) => UNKNOWN_INDEX_ONLY.test(l)) ? 'gitnexus-too-old' : undefined;
}

// Work-tree paths an index-only analyze still creates inside the repo. They
// go into the repo's git exclude file (local, untracked) -- never .gitignore.
export const GITNEXUS_REPO_ARTIFACTS: readonly string[] = ['.gitnexus/'];

/**
 * Adds each repo-relative path to `repoPath`'s git exclude file, resolved by
 * git itself (`git rev-parse --git-path info/exclude`) so a linked worktree
 * (where .git is a file) uses its common dir's exclude. Synchronous, never
 * throws: a failure is logged and the caller carries on. Returns true when the
 * exclude file holds every entry afterwards.
 */
export function ensureLocalGitExcluded(repoPath: string, relPaths: readonly string[]): boolean {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: repoPath, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split(/\r?\n/)[0]?.trim() ?? '';
    if (!out) return false;
    const excludePath = isAbsolute(out) ? out : join(repoPath, out);
    let current = '';
    try { current = readFileSync(excludePath, 'utf8').replace(/\r\n/g, '\n'); } catch { /* absent: create it */ }
    const have = new Set(current.split('\n').map((l) => l.trim()));
    const missing = [...new Set(relPaths.map(excludeLineFor))].filter((l) => !have.has(l));
    if (missing.length === 0) return true;
    const base = current.replace(/\n+$/, '');
    mkdirSync(dirname(excludePath), { recursive: true });
    writeFileSync(excludePath, (base ? `${base}\n` : '') + missing.join('\n') + '\n');
    return true;
  } catch (err) {
    logWarn('code-intelligence-reindex', `could not add ${relPaths.join(', ')} to the git exclude file of ${repoPath}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// Agent docs a plain (non --index-only) `gitnexus analyze` injects its block
// into. gitnexus's cli/ai-context.js (verified in the 1.6.5 tarball) wraps the
// block in `<!-- gitnexus:start -->` ... `<!-- gitnexus:end -->` and writes it
// to AGENTS.md and CLAUDE.md at the repo root. Only a marker on a line of its
// own counts: ai-context.js itself quotes the marker inline in prose.
export const GITNEXUS_INJECTED_BLOCK_FILES: readonly string[] = ['AGENTS.md', 'CLAUDE.md'];
const INJECTED_BLOCK_MARKER = /^<!-- gitnexus:start -->[ \t]*$/m;

/**
 * Repo-relative agent docs of `repoPath` that still carry a gitnexus block
 * injected by an earlier plain analyze run. READ-ONLY: it never edits the work
 * tree (--index-only never removes such a block, so a clone dirtied before the
 * fleet switched to it stays dirty until a human removes it). Never throws.
 */
export function detectInjectedGitnexusBlocks(repoPath: string): string[] {
  const found: string[] = [];
  for (const rel of GITNEXUS_INJECTED_BLOCK_FILES) {
    try {
      if (INJECTED_BLOCK_MARKER.test(readFileSync(join(repoPath, rel), 'utf8'))) found.push(rel);
    } catch { /* absent or unreadable: nothing to report */ }
  }
  return found;
}

/** The one-line WARN for a non-empty detectInjectedGitnexusBlocks() result. */
export function injectedBlockWarning(files: readonly string[]): string | null {
  if (files.length === 0) return null;
  return `WARN: ${files.join(', ')} carries a gitnexus block injected by an earlier plain 'gitnexus analyze' run ` +
    '(--index-only never removes it): remove the block between <!-- gitnexus:start --> and <!-- gitnexus:end --> and commit.';
}

export type SpawnAnalyzeOutcome =
  | { started: true; child: ChildProcess; dir: string }
  | { started: false; reason: NotStartedReason; detail?: string };

/**
 * Synchronously start `npx gitnexus analyze --index-only` detached in `repoPath`, with
 * stdout+stderr going straight to analyze.log (a file descriptor, so the run
 * outlives this server) and status.json kept current until exit. Never
 * throws. Does NOT apply config/cooldown -- callers decide whether to start.
 * `auto` marks an automatic run: one that ends without a ready index pauses
 * automatic runs for the repo (see ReindexEntry.autoPaused). An explicit run
 * (auto false, i.e. code_reindex) clears any pause when it starts.
 */
export function spawnAnalyze(repoPath: string, opts: { auto?: boolean } = {}): SpawnAnalyzeOutcome {
  const auto = opts.auto === true;
  const existing = state.get(repoPath);
  if (existing?.runningChild) return { started: false, reason: 'already-running' };
  if (readGitNexusIndexState(repoPath).lockHeld) {
    return { started: false, reason: 'already-running', detail: 'a gitnexus analyze lock is held for this folder' };
  }
  const npxReason = npxUnavailableReason();
  if (npxReason) {
    return { started: false, reason: 'npx-not-found', detail: npxReason };
  }

  let dir: string;
  let fd: number;
  try {
    dir = codeIndexDir(repoPath);
    mkdirSync(dir, { recursive: true });
    fd = openSync(logPath(dir), 'w');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logError('code-intelligence-reindex', `cannot open analyze log for ${repoPath}: ${detail}`);
    return { started: false, reason: 'spawn-failed', detail };
  }

  // Keep the index dir out of `git status` before analyze creates it.
  ensureLocalGitExcluded(repoPath, GITNEXUS_REPO_ARTIFACTS);

  let child: ChildProcess;
  try {
    child = spawn('npx', npxArgsForShell(GITNEXUS_ANALYZE_ARGS, process.platform === 'win32'), {
      cwd: repoPath,
      detached: true,
      stdio: ['ignore', fd, fd],
      shell: process.platform === 'win32',
    });
  } catch (err) {
    try { closeSync(fd); } catch { /* ignore */ }
    const detail = err instanceof Error ? err.message : String(err);
    logError('code-intelligence-reindex', `failed to spawn background reindex for ${repoPath}: ${detail}`);
    return { started: false, reason: 'spawn-failed', detail };
  }
  try { closeSync(fd); } catch { /* the child holds its own copy */ }

  const startedIso = new Date().toISOString();
  const status: AnalyzeStatus = {
    repo: repoPath, pid: child.pid ?? null, started: startedIso, lockHeld: false,
    lastLine: '', lineCount: 0, phase: 'starting', result: null, exitCode: null,
  };
  writeStatus(dir, status);
  state.set(repoPath, {
    runningChild: child,
    runningAuto: auto,
    lastFinishedAt: existing?.lastFinishedAt,
    autoPaused: auto ? existing?.autoPaused : undefined,
    gitnexusTooOld: auto ? existing?.gitnexusTooOld : undefined,
  });

  const refresh = (): void => {
    const lines = readLogLines(dir);
    status.lastLine = lines.length > 0 ? lines[lines.length - 1] : '';
    status.lineCount = logLineCount(dir);
    status.lockHeld = readGitNexusIndexState(repoPath).lockHeld;
    if (status.phase === 'starting' && status.lineCount > 0) status.phase = 'running';
    writeStatus(dir, status);
  };
  const poller = setInterval(refresh, 300);
  poller.unref?.();

  const finish = (code: number | null, errMsg?: string): void => {
    clearInterval(poller);
    const lines = readLogLines(dir);
    status.lastLine = lines.length > 0 ? lines[lines.length - 1] : (errMsg ?? '');
    status.lineCount = logLineCount(dir);
    status.lockHeld = false;
    status.phase = 'done';
    status.exitCode = code;
    status.result = errMsg ? 'failed' : resultFromExit(dir, repoPath, code);
    const failureCause = status.result === 'failed' ? failureCauseOf(lines) : undefined;
    if (failureCause) status.failureCause = failureCause;
    status.finished = new Date().toISOString();
    const idx = readGitNexusIndexState(repoPath);
    if (idx.lastCommit) status.indexedCommit = idx.lastCommit;
    writeStatus(dir, status);
    // An index whose metadata disagrees with itself is not ready either: an
    // automatic run that leaves one pauses automatic rebuilds like any other.
    const indexReady = idx.metaPresent && idx.lastCommit !== '' && !idx.incrementalInProgress && !indexInconsistency(repoPath, idx);
    const prev = state.get(repoPath);
    let autoPaused: AutoReindexPause | undefined;
    if (!indexReady && auto) {
      autoPaused = { result: status.result, lastLine: status.lastLine, logPath: logPath(dir), finished: status.finished };
    } else if (!indexReady) {
      autoPaused = prev?.autoPaused;
    }
    state.set(repoPath, { lastFinishedAt: Date.now(), autoPaused, gitnexusTooOld: failureCause === 'gitnexus-too-old' ? true : undefined });
    // One warning per finished run: the failure detail and, for an automatic
    // run, that automatic rebuilds are now paused.
    const pausedNote = autoPaused && auto
      ? '; automatic rebuilds paused until code_reindex or a server restart'
      : '';
    if (status.result === 'failed') {
      logWarn('code-intelligence-reindex', `background reindex for ${repoPath} ended failed (${errMsg ?? `exit ${code}`}): ${lines.slice(-5).join(' | ')}${pausedNote}`);
    } else if (pausedNote) {
      logWarn('code-intelligence-reindex', `automatic reindex for ${repoPath} ended ${status.result} without a ready index${pausedNote}`);
    }
  };

  child.on('error', (err) => {
    logError('code-intelligence-reindex', `background reindex process error for ${repoPath}: ${err.message}`);
    finish(null, err.message);
  });
  child.on('exit', (code) => finish(code));
  child.unref();
  return { started: true, child, dir };
}

/** Why an automatic reindex request did not start an analyze. */
export type ScheduleNotStartedReason = 'disabled' | 'cooldown' | 'paused' | NotStartedReason;

export type ScheduleReindexOutcome =
  | { started: true }
  | { started: false; reason: 'paused'; pause: AutoReindexPause; detail?: string }
  | { started: false; reason: Exclude<ScheduleNotStartedReason, 'paused'>; detail?: string };

/** The pause on automatic rebuilds of `repoPath`, or null when they are armed. */
export function autoReindexPause(repoPath: string): AutoReindexPause | null {
  return state.get(repoPath)?.autoPaused ?? null;
}

/** Re-arm automatic rebuilds of `repoPath` (an explicit code_reindex does this). */
export function clearAutoReindexPause(repoPath: string): void {
  const entry = state.get(repoPath);
  if (entry?.autoPaused || entry?.gitnexusTooOld) state.set(repoPath, { ...entry, autoPaused: undefined, gitnexusTooOld: undefined });
}

// Consults config + the decision function, then starts the shared analyze
// runner. Never awaited on the tool-call path (it does not await the child),
// never throws -- every failure path is logged and a typed not-started
// outcome is returned instead, so a caller can say WHY no build started
// (auto-reindex disabled in config, cooldown, npx missing, ...).
export function scheduleReindex(repoPath: string): ScheduleReindexOutcome {
  try {
    const config = readAutoReindexConfig();
    if (config.enabled === false) return { started: false, reason: 'disabled' };
    const cooldownMs = typeof config.cooldownMs === 'number' ? config.cooldownMs : DEFAULT_COOLDOWN_MS;

    const existing = state.get(repoPath);
    if (existing?.runningChild) return { started: false, reason: 'already-running' };
    if (existing?.gitnexusTooOld) return { started: false, reason: 'gitnexus-too-old', detail: GITNEXUS_TOO_OLD_DETAIL };
    if (existing?.autoPaused) return { started: false, reason: 'paused', pause: existing.autoPaused };
    const decisionEntry = existing ? { running: false, lastFinishedAt: existing.lastFinishedAt } : undefined;
    if (!shouldStartReindex(decisionEntry, Date.now(), cooldownMs)) {
      return { started: false, reason: 'cooldown', detail: `an index build finished less than ${Math.round(cooldownMs / 1000)}s ago` };
    }

    const out = spawnAnalyze(repoPath, { auto: true });
    return out.started ? { started: true } : { started: false, reason: out.reason, detail: out.detail };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    try {
      logError('code-intelligence-reindex', `scheduleReindex failed for ${repoPath}: ${detail}`);
    } catch {
      // ignore -- logging itself must never throw out of this function
    }
    return { started: false, reason: 'spawn-failed', detail };
  }
}

/** Boolean form of scheduleReindex (the freshness-note trigger). Never throws. */
export function maybeScheduleReindex(repoPath: string): boolean {
  return scheduleReindex(repoPath).started;
}

// A recorded run older than this is never trusted as live by its pid alone:
// the pid may have been reused by an unrelated process long after the run died.
export const RECORDED_ANALYZE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * True when status.json under codeIndexDir(repo) records an analyze that has
 * not finished and whose pid is still alive -- e.g. one started by a PREVIOUS
 * server instance that is still running. On Windows/Linux the gitnexus lock
 * leaves no file, so this is the cross-process signal for such a run. A
 * finished, pid-less, dead-pid or implausibly old record is not live. Never
 * throws.
 */
export function isRecordedAnalyzeAlive(repoPath: string, now: number = Date.now()): boolean {
  try {
    const status = readStatusFile(codeIndexDir(repoPath));
    if (!status || status.phase === 'done') return false;
    // codeIndexDir is keyed by project slug, which two folders can share.
    if (typeof status.repo === 'string' && status.repo !== repoPath) return false;
    if (typeof status.pid !== 'number' || !Number.isInteger(status.pid) || status.pid <= 0) return false;
    const started = Date.parse(status.started);
    if (Number.isFinite(started) && now - started > RECORDED_ANALYZE_MAX_AGE_MS) return false;
    // A complete index stamped AFTER the run started is that run's own final
    // write: the index is no longer being rewritten, whatever the pid (which
    // may have been reused) says. Readiness fences a complete index on a live
    // recorded run, so this keeps a stale record from fencing it for hours.
    const idx = readGitNexusIndexState(repoPath);
    const indexedAt = Date.parse(idx.indexedAt);
    if (idx.metaPresent && !idx.incrementalInProgress && Number.isFinite(started) && Number.isFinite(indexedAt) && indexedAt > started) return false;
    return isPidAlive(status.pid);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// code_reindex / code_status
// ---------------------------------------------------------------------------

export const FIRST_TICK_BOUND_MS = 8000;
const FIRST_TICK_POLL_MS = 100;
// Where the gitnexus lock is a kernel socket (Linux/Windows) there is no lock
// file to observe; after this grace a live process with output is a tick.
const LOCK_OBSERVE_GRACE_MS = 1500;

/** Every code_reindex response carries the commit the index is built at (null when none/remote). */
export type CodeReindexResult = { indexedCommit: string | null; injectedBlockFiles?: string[] } & CodeReindexOutcome;

export type CodeReindexOutcome =
  | { outcome: 'started'; pid: number | null; lastLine: string; lockHeld: boolean; logPath: string }
  | { outcome: 'up-to-date'; lastLine: string; logPath: string }
  | { outcome: 'starting'; firstTick: false; pid: number | null; note: string; logPath: string }
  | { outcome: 'already-running'; reason: 'already-running'; detail?: string; status: AnalyzeStatus | null }
  | { outcome: 'not-started'; reason: NotStartedReason | 'analyze-failed'; detail?: string; logPath?: string };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Start (or report) an analyze for `repo` and return after the FIRST TICK:
 * analyze lock held, process alive and at least one log line; or the run
 * ended with 'Already up to date'. Never claims 'started' without a tick: a
 * missing npx / gitnexus, or a run that dies before ticking, is a typed
 * 'not-started'. If the bound elapses with the process alive but silent the
 * outcome is 'starting' (firstTick false), still not 'started'.
 */
export async function codeReindex(repo: string, boundMs: number = FIRST_TICK_BOUND_MS): Promise<CodeReindexResult> {
  const r = await codeReindexOutcome(repo, boundMs);
  let indexedCommit: string | null = null;
  try { indexedCommit = readGitNexusIndexState(repo).lastCommit || null; } catch { /* never throw on IO */ }
  return { ...r, indexedCommit, injectedBlockFiles: detectInjectedGitnexusBlocks(repo) };
}

async function codeReindexOutcome(repo: string, boundMs: number): Promise<CodeReindexOutcome> {
  // An explicit reindex re-arms automatic rebuilds paused by a failed automatic run.
  clearAutoReindexPause(repo);
  const out = spawnAnalyze(repo);
  if (!out.started) {
    if (out.reason === 'already-running') {
      let status: AnalyzeStatus | null = null;
      try { status = readStatusFile(codeIndexDir(repo)); } catch { /* ignore */ }
      return { outcome: 'already-running', reason: 'already-running', detail: out.detail, status };
    }
    return { outcome: 'not-started', reason: out.reason, detail: out.detail };
  }

  const { child, dir } = out;
  let exited = false;
  let exitCode: number | null = null;
  let spawnError: string | undefined;
  child.on('exit', (c) => { exited = true; exitCode = c; });
  child.on('error', (e) => { exited = true; spawnError = e.message; });

  const t0 = Date.now();
  const log = logPath(dir);
  while (Date.now() - t0 < boundMs) {
    const lines = readLogLines(dir);
    const last = lines.length > 0 ? lines[lines.length - 1] : '';
    if (exited) {
      if (spawnError) {
        const missing = /ENOENT/.test(spawnError);
        const detail = missing ? `${spawnError}: ${missingOnServerPathMessage('npx')}` : spawnError;
        return { outcome: 'not-started', reason: missing ? 'npx-not-found' : 'spawn-failed', detail, logPath: log };
      }
      if (exitCode === 0) {
        if (lines.some((l) => /already up to date/i.test(l))) return { outcome: 'up-to-date', lastLine: last, logPath: log };
        return { outcome: 'started', pid: child.pid ?? null, lastLine: last, lockHeld: false, logPath: log };
      }
      if (failureCauseOf(lines) === 'gitnexus-too-old') {
        return { outcome: 'not-started', reason: 'gitnexus-too-old', detail: GITNEXUS_TOO_OLD_DETAIL, logPath: log };
      }
      const missing = GITNEXUS_MISSING.test(lines.join('\n'));
      return {
        outcome: 'not-started',
        reason: missing ? 'gitnexus-not-found' : 'analyze-failed',
        detail: last || `analyze exited with code ${exitCode}`,
        logPath: log,
      };
    }
    if (lines.length > 0 && child.pid && isPidAlive(child.pid)) {
      const lockHeld = readGitNexusIndexState(repo).lockHeld;
      if (lockHeld || Date.now() - t0 >= LOCK_OBSERVE_GRACE_MS) {
        return { outcome: 'started', pid: child.pid, lastLine: last, lockHeld, logPath: log };
      }
    }
    await sleep(FIRST_TICK_POLL_MS);
  }
  return {
    outcome: 'starting', firstTick: false, pid: child.pid ?? null, logPath: log,
    note: 'analyze is running but has not yet produced output or taken its lock; poll code_status.',
  };
}

export interface CodeStatusResult {
  repo: string;
  /** status.json of the last analyze run for this folder, or null if none has run. */
  analyze: AnalyzeStatus | null;
  ready: boolean;
  readiness: 'ready' | CodeIndexNotReadyState;
  /** Why the index metadata disagrees with itself (readiness 'inconsistent'); null otherwise. */
  inconsistency: string | null;
  indexedCommit: string | null;
  incrementalInProgress: boolean;
  lockHeld: boolean;
  /** analyze.log of the last run; null when no analyze has written one under this install. */
  logPath: string | null;
  /** Set when an automatic run failed and automatic rebuilds are paused until code_reindex. */
  autoReindexPaused: AutoReindexPause | null;
  /** Agent docs still carrying a gitnexus block from an earlier plain analyze; [] when clean. */
  injectedBlockFiles: string[];
  /** One-line WARN naming those files and the fix; null when clean. */
  injectedBlockWarning: string | null;
}

/**
 * status.json + live readiness + the indexed commit for `repo`. `readiness` is
 * the result of THE readiness check (codeIndexReadiness), passed in by the
 * caller so code_status and the code_* pre-flight can never disagree (it lives
 * in a module that imports this one). Never throws on IO.
 */
export function codeStatus(repo: string, readiness: CodeIndexReadiness): CodeStatusResult {
  const dir = codeIndexDir(repo);
  let analyze = readStatusFile(dir);
  // A run recorded as in-flight whose process is gone (server restarted mid-run)
  // is reconciled from the log + index instead of reporting 'running' forever.
  if (analyze && analyze.phase !== 'done' && !state.get(repo)?.runningChild && !(analyze.pid && isPidAlive(analyze.pid))) {
    const lines = readLogLines(dir);
    analyze = {
      ...analyze,
      phase: 'done',
      lastLine: lines.length > 0 ? lines[lines.length - 1] : analyze.lastLine,
      lockHeld: false,
      // Exit code is unknown after a restart: only the index/log can confirm success.
      result: resultFromExit(dir, repo, 0),
    };
  }
  const idx = readGitNexusIndexState(repo);
  const log = logPath(dir);
  const injected = detectInjectedGitnexusBlocks(repo);
  return {
    repo, analyze,
    ready: readiness.ready,
    readiness: readiness.ready ? 'ready' : readiness.state,
    inconsistency: !readiness.ready && readiness.state === 'inconsistent' ? (readiness.detail ?? null) : null,
    indexedCommit: idx.lastCommit || null,
    incrementalInProgress: idx.incrementalInProgress,
    lockHeld: idx.lockHeld,
    logPath: existsSync(log) ? log : null,
    autoReindexPaused: autoReindexPause(repo),
    injectedBlockFiles: injected,
    injectedBlockWarning: injectedBlockWarning(injected),
  };
}
