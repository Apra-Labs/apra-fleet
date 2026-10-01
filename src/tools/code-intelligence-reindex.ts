// Auto-reindex module (P3, design D3). Kept in its own file -- NOT importing
// from code-intelligence.ts -- so code-intelligence-gitnexus.ts can import
// this module as a value without creating a circular import (mirrors the
// code-intelligence-freshness.ts precedent: code-intelligence.ts re-exports
// GitNexusProvider from gitnexus.ts, so anything gitnexus.ts needs at module
// load time must live outside code-intelligence.ts).
import { spawn, type ChildProcess } from 'child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { delimiter, join } from 'path';
import { logWarn, logError } from '../utils/log-helpers.js';
import { FLEET_DIR } from '../paths.js';
import { resolveProjectSlug } from '../services/knowledge/project-slug.js';
import { isPidAlive, readGitNexusIndexState } from './code-index-state.js';

interface ReindexEntry {
  runningChild?: ChildProcess;
  lastFinishedAt?: number;
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
}

export type NotStartedReason =
  | 'already-running'
  | 'npx-not-found'
  | 'gitnexus-not-found'
  | 'spawn-failed'
  | 'remote-member';

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
  const exts = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* next */ }
    }
  }
  return null;
}

const GITNEXUS_MISSING = /not found|E404|404 Not Found|could not determine executable|ENOENT|ENOTFOUND|EAI_AGAIN/i;

function resultFromExit(dir: string, repo: string, code: number | null): AnalyzeResult {
  if (code !== 0) return 'failed';
  if (readLogLines(dir).some((l) => /already up to date/i.test(l))) return 'up-to-date';
  const idx = readGitNexusIndexState(repo);
  return idx.metaPresent && idx.lastCommit !== '' && !idx.incrementalInProgress ? 'indexed' : 'incomplete';
}

export type SpawnAnalyzeOutcome =
  | { started: true; child: ChildProcess; dir: string }
  | { started: false; reason: NotStartedReason; detail?: string };

/**
 * Synchronously start `npx gitnexus analyze` detached in `repoPath`, with
 * stdout+stderr going straight to analyze.log (a file descriptor, so the run
 * outlives this server) and status.json kept current until exit. Never
 * throws. Does NOT apply config/cooldown -- callers decide whether to start.
 */
export function spawnAnalyze(repoPath: string): SpawnAnalyzeOutcome {
  const existing = state.get(repoPath);
  if (existing?.runningChild) return { started: false, reason: 'already-running' };
  if (readGitNexusIndexState(repoPath).lockHeld) {
    return { started: false, reason: 'already-running', detail: 'a gitnexus analyze lock is held for this folder' };
  }
  if (!findOnPath('npx')) {
    return { started: false, reason: 'npx-not-found', detail: 'npx is not on PATH' };
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

  let child: ChildProcess;
  try {
    child = spawn('npx', ['gitnexus', 'analyze'], {
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
  state.set(repoPath, { runningChild: child, lastFinishedAt: existing?.lastFinishedAt });

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
    state.set(repoPath, { lastFinishedAt: Date.now() });
    const lines = readLogLines(dir);
    status.lastLine = lines.length > 0 ? lines[lines.length - 1] : (errMsg ?? '');
    status.lineCount = logLineCount(dir);
    status.lockHeld = false;
    status.phase = 'done';
    status.exitCode = code;
    status.result = errMsg ? 'failed' : resultFromExit(dir, repoPath, code);
    status.finished = new Date().toISOString();
    writeStatus(dir, status);
    if (status.result === 'failed') {
      logWarn('code-intelligence-reindex', `background reindex for ${repoPath} ended failed (${errMsg ?? `exit ${code}`}): ${lines.slice(-5).join(' | ')}`);
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

// Consults config + the decision function, then starts the shared analyze
// runner. Never awaited on the tool-call path (it does not await the child),
// never throws -- every failure path is logged and this function returns
// false instead. Returns whether a reindex was actually started.
export function maybeScheduleReindex(repoPath: string): boolean {
  try {
    const config = readAutoReindexConfig();
    if (config.enabled === false) return false;
    const cooldownMs = typeof config.cooldownMs === 'number' ? config.cooldownMs : DEFAULT_COOLDOWN_MS;

    const existing = state.get(repoPath);
    const decisionEntry = existing
      ? { running: !!existing.runningChild, lastFinishedAt: existing.lastFinishedAt }
      : undefined;
    if (!shouldStartReindex(decisionEntry, Date.now(), cooldownMs)) return false;

    return spawnAnalyze(repoPath).started;
  } catch (err) {
    try {
      const detail = err instanceof Error ? err.message : String(err);
      logError('code-intelligence-reindex', `maybeScheduleReindex failed for ${repoPath}: ${detail}`);
    } catch {
      // ignore -- logging itself must never throw out of this function
    }
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
export type CodeReindexResult = { indexedCommit: string | null } & CodeReindexOutcome;

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
  return { ...r, indexedCommit };
}

async function codeReindexOutcome(repo: string, boundMs: number): Promise<CodeReindexOutcome> {
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
        return { outcome: 'not-started', reason: missing ? 'npx-not-found' : 'spawn-failed', detail: spawnError, logPath: log };
      }
      if (exitCode === 0) {
        if (lines.some((l) => /already up to date/i.test(l))) return { outcome: 'up-to-date', lastLine: last, logPath: log };
        return { outcome: 'started', pid: child.pid ?? null, lastLine: last, lockHeld: false, logPath: log };
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
  readiness: 'ready' | 'building' | 'missing';
  indexedCommit: string | null;
  incrementalInProgress: boolean;
  lockHeld: boolean;
  logPath: string;
}

/** status.json + live readiness + the indexed commit for `repo`. Never throws on IO. */
export function codeStatus(repo: string): CodeStatusResult {
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
  const ready = idx.metaPresent && idx.lastCommit !== '' && !idx.incrementalInProgress && !idx.lockHeld;
  const running = !!state.get(repo)?.runningChild;
  const readiness = ready ? 'ready' : (running || idx.lockHeld || idx.incrementalInProgress || existsSync(join(repo, '.gitnexus')) ? 'building' : 'missing');
  return {
    repo, analyze, ready, readiness,
    indexedCommit: idx.lastCommit || null,
    incrementalInProgress: idx.incrementalInProgress,
    lockHeld: idx.lockHeld,
    logPath: logPath(dir),
  };
}
