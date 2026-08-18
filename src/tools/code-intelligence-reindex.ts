// Auto-reindex module (P3, design D3). Kept in its own file -- NOT importing
// from code-intelligence.ts -- so code-intelligence-gitnexus.ts can import
// this module as a value without creating a circular import (mirrors the
// code-intelligence-freshness.ts precedent: code-intelligence.ts re-exports
// GitNexusProvider from gitnexus.ts, so anything gitnexus.ts needs at module
// load time must live outside code-intelligence.ts).
import { spawn, type ChildProcess } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { logWarn, logError } from '../utils/log-helpers.js';

interface ReindexEntry {
  runningChild?: ChildProcess;
  lastFinishedAt?: number;
}

// Module-level per-repo state (design D3): in-memory is acceptable -- the
// server is long-lived, and a restart just means one extra reindex.
const state = new Map<string, ReindexEntry>();

const CONFIG_PATH = join(homedir(), '.apra-fleet', 'data', 'code-intelligence', 'config.json');

export const DEFAULT_COOLDOWN_MS = 120000;

// Bound how much stderr is retained for the non-zero-exit log line.
const STDERR_TAIL_MAX_CHARS = 4000;

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

// Consults config + the decision function, then spawns
// `npx gitnexus analyze` with cwd = repoPath, detached, stdio ignored except
// a captured tail of stderr logged on non-zero exit. Never awaited on the
// tool-call path (it does not await the child), never throws -- every
// failure path is logged and this function returns false instead. Returns
// whether a reindex was actually started.
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

    let child: ChildProcess;
    try {
      child = spawn('npx', ['gitnexus', 'analyze'], {
        cwd: repoPath,
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: process.platform === 'win32',
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logError('code-intelligence-reindex', `failed to spawn background reindex for ${repoPath}: ${detail}`);
      return false;
    }

    state.set(repoPath, { runningChild: child, lastFinishedAt: existing?.lastFinishedAt });

    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_MAX_CHARS);
    });

    child.on('error', (err) => {
      state.set(repoPath, { lastFinishedAt: Date.now() });
      logError('code-intelligence-reindex', `background reindex process error for ${repoPath}: ${err.message}`);
    });

    child.on('exit', (code) => {
      state.set(repoPath, { lastFinishedAt: Date.now() });
      if (code !== 0) {
        logWarn('code-intelligence-reindex', `background reindex for ${repoPath} exited with code ${code}: ${stderrTail}`);
      }
    });

    child.unref();
    return true;
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
