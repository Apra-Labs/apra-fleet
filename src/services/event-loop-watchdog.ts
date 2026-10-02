/**
 * Event-loop stall watchdog (GitHub #562).
 *
 * A frozen event loop (a blocking sync call, a console stuck in QuickEdit, an
 * undrained stderr pipe) or a suspended process/host used to leave no trace.
 * Two cheap signals:
 *
 *  1. Main thread, every 1s: if the timer fired more than 2s late, log
 *     `event_loop_lag ms=<monotonic drift> wall_ms=<wall-clock gap>` -- AFTER
 *     the fact. A host suspend shows up here too (wall_ms >> interval).
 *  2. Worker thread heartbeat: the main thread stamps a shared timestamp on
 *     every tick; a worker checks it every second and, while the main loop is
 *     stalled, appends `event_loop_blocked ms=<n>` straight to the log file
 *     (appendFileSync -- the main thread cannot write) -- DURING the stall,
 *     first after the stall threshold and then every 30s. If the worker itself
 *     did not get to run on time, the whole process/host was suspended, not
 *     the main loop blocked: that tick is skipped, so a suspend shows only the
 *     lag line after resume.
 *
 * The worker is unref'd (never keeps the process alive) and stop() clears the
 * interval and terminates the worker.
 */
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { logWarn } from '../utils/log-helpers.js';

export interface WatchdogOptions {
  /** Absolute path the worker appends event_loop_blocked lines to. */
  logFile: string | null;
  tickMs?: number;
  /** Main-thread drift beyond which event_loop_lag is logged. */
  lagThresholdMs?: number;
  /** Heartbeat age beyond which the worker reports event_loop_blocked. */
  blockedThresholdMs?: number;
  /** Re-report interval while still blocked. */
  blockedRepeatMs?: number;
}

export interface WorkerTickState {
  prevTick: number;
  lastBeatSeen: number;
  suspendedBeat: number | null;
  lastReportAt: number | null;
}

/**
 * Pure worker decision for one tick. Runs inside the worker (serialized via
 * toString -- keep it self-contained) and in unit tests.
 * Returns the blocked duration to report, or null.
 */
export function evaluateWatchdogTick(
  state: WorkerTickState,
  now: number,
  beat: number,
  cfg: { tickMs: number; blockedThresholdMs: number; blockedRepeatMs: number },
): number | null {
  const selfGap = now - state.prevTick;
  state.prevTick = now;
  if (beat !== state.lastBeatSeen) {
    // The main loop is alive (a new heartbeat): clear any stall state.
    state.lastBeatSeen = beat;
    state.suspendedBeat = null;
    state.lastReportAt = null;
    return null;
  }
  // The worker itself ran late: the whole process/host was suspended. Do not
  // read the stale heartbeat as a blocked main loop until it beats again.
  // (Where the monotonic clock excludes suspend time, the stale-beat age
  // below stays small instead -- either way a suspend is not reported here.)
  if (selfGap > cfg.tickMs * 2 + 1000) {
    state.suspendedBeat = beat;
    return null;
  }
  if (state.suspendedBeat === beat) return null;
  const blocked = now - beat;
  if (blocked < cfg.blockedThresholdMs) return null;
  if (state.lastReportAt !== null && now - state.lastReportAt < cfg.blockedRepeatMs) return null;
  state.lastReportAt = now;
  return Math.round(blocked);
}

function nowAbs(): number {
  return performance.timeOrigin + performance.now();
}

const WORKER_SOURCE = (evaluate: string) => `
const { workerData } = require('node:worker_threads');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const evaluate = (${evaluate});
const beats = new Float64Array(workerData.sab);
const cfg = workerData.cfg;
const nowAbs = () => performance.timeOrigin + performance.now();
const state = { prevTick: nowAbs(), lastBeatSeen: beats[0], suspendedBeat: null, lastReportAt: null };
function localTs() {
  const now = new Date();
  const off = -now.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  const h = String(Math.floor(a / 60)).padStart(2, '0');
  const m = String(a % 60).padStart(2, '0');
  return new Date(now.getTime() + off * 60000).toISOString().slice(0, -1) + sign + h + ':' + m;
}
setInterval(() => {
  const blocked = evaluate(state, nowAbs(), beats[0], cfg);
  if (blocked === null || !workerData.logFile) return;
  try {
    fs.appendFileSync(workerData.logFile, JSON.stringify({ ts: localTs(), level: 'warn', tag: 'event_loop_blocked', msg: 'ms=' + blocked }) + '\\n');
  } catch {}
}, cfg.tickMs);
`;

export interface EventLoopWatchdog {
  stop(): Promise<void>;
}

export function startEventLoopWatchdog(opts: WatchdogOptions): EventLoopWatchdog {
  const tickMs = opts.tickMs ?? 1000;
  const lagThresholdMs = opts.lagThresholdMs ?? 2000;
  const cfg = {
    tickMs,
    blockedThresholdMs: opts.blockedThresholdMs ?? 3000,
    blockedRepeatMs: opts.blockedRepeatMs ?? 30_000,
  };

  const sab = new SharedArrayBuffer(8);
  const beats = new Float64Array(sab);
  beats[0] = nowAbs();

  let worker: Worker | null = null;
  try {
    worker = new Worker(WORKER_SOURCE(evaluateWatchdogTick.toString()), {
      eval: true,
      workerData: { sab, cfg, logFile: opts.logFile },
    });
    worker.unref();
    worker.on('error', () => { /* best-effort diagnostics; never crash the server */ });
  } catch {
    worker = null;
  }

  let lastMono = performance.now();
  let lastWall = Date.now();
  const interval = setInterval(() => {
    const mono = performance.now();
    const wall = Date.now();
    beats[0] = nowAbs();
    const drift = mono - lastMono - tickMs;
    const wallGap = wall - lastWall;
    if (drift > lagThresholdMs || wallGap - tickMs > lagThresholdMs) {
      logWarn('event_loop_lag', `ms=${Math.round(Math.max(drift, 0))} wall_ms=${wallGap}`);
    }
    lastMono = mono;
    lastWall = wall;
  }, tickMs);
  interval.unref();

  return {
    async stop() {
      clearInterval(interval);
      if (worker) {
        const w = worker;
        worker = null;
        try { await w.terminate(); } catch { /* ignore */ }
      }
    },
  };
}
