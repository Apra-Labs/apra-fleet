/**
 * Server exit bookkeeping (GitHub #585).
 *
 * Every observable exit path of a fleet server appends exactly ONE
 * {"tag":"shutdown","reason":...} record to fleet-<pid>.log, synchronously,
 * before the process exits -- so a server that vanished can be told apart
 * from one that was asked to stop (and status/start can report the former,
 * see describeUncleanExit in singleton.ts).
 *
 * Paths: SIGINT, SIGTERM, SIGHUP, SIGBREAK (Windows console Ctrl+Break;
 * SIGTERM never arrives on Windows), POST /shutdown, the shutdown_server
 * tool, and crashes (uncaughtException / unhandledRejection). Crashes are
 * observed via 'uncaughtExceptionMonitor', which runs BEFORE Node's default
 * crash handling without replacing it -- the process still prints the error
 * and exits 1 exactly as before.
 */
import { appendLogRecord, maskSecrets } from '../utils/log-helpers.js';

export type ShutdownReason =
  | 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGBREAK'
  | 'http_shutdown' | 'shutdown_server'
  | 'uncaughtException' | 'unhandledRejection';

let recorded = false;

/**
 * Append the shutdown record once per process (the first reason wins: e.g.
 * POST /shutdown re-enters the SIGINT path, which must not add a second line).
 * Synchronous -- the line is on disk when this returns.
 */
export function recordShutdown(reason: ShutdownReason, detail?: Record<string, unknown>): void {
  if (recorded) return;
  recorded = true;
  const crash = reason === 'uncaughtException' || reason === 'unhandledRejection';
  appendLogRecord(crash ? 'error' : 'info', { tag: 'shutdown', reason, pid: process.pid, ...(detail ?? {}) });
}

/** Test hook: forget that a record was written. */
export function _resetShutdownRecordForTests(): void {
  recorded = false;
}

/** Signals that end a server, per platform. SIGBREAK exists only on Windows. */
export function shutdownSignals(platform: NodeJS.Platform = process.platform): NodeJS.Signals[] {
  const sigs: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  if (platform === 'win32') sigs.push('SIGBREAK');
  return sigs;
}

type ProcLike = Pick<NodeJS.Process, 'on' | 'off'>;

/**
 * Wire every exit path to recordShutdown. `onSignal` runs the server's own
 * graceful shutdown (which ends in process.exit). Returns an uninstaller.
 */
export interface ShutdownHandlerOptions {
  /** Hard deadline for the graceful shutdown after the first signal (unref'd). */
  forceExitMs?: number;
  /** Injectable for tests. */
  exit?: (code: number) => void;
}

export const SHUTDOWN_FORCE_EXIT_MS = 10_000;

export function installShutdownHandlers(
  onSignal: (reason: ShutdownReason) => void,
  proc: ProcLike = process,
  platform: NodeJS.Platform = process.platform,
  options: ShutdownHandlerOptions = {},
): () => void {
  const removers: Array<() => void> = [];
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const forceExitMs = options.forceExitMs ?? SHUTDOWN_FORCE_EXIT_MS;
  let shuttingDown = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const forceExit = (why: string) => {
    appendLogRecord('warn', { tag: 'shutdown_forced', reason: why, pid: process.pid });
    exit(1);
  };
  removers.push(() => { if (forceTimer) clearTimeout(forceTimer); });
  for (const sig of shutdownSignals(platform)) {
    const handler = () => {
      // A graceful shutdown can hang (e.g. handle.close() waiting on open
      // connections) where SIGHUP/SIGBREAK used to just end the process: a
      // second signal exits at once, and an unref'd deadline bounds the wait.
      if (shuttingDown) {
        forceExit(`second ${sig}`);
        return;
      }
      shuttingDown = true;
      recordShutdown(sig as ShutdownReason);
      forceTimer = setTimeout(() => forceExit(`graceful shutdown exceeded ${forceExitMs}ms`), forceExitMs);
      forceTimer.unref();
      onSignal(sig as ShutdownReason);
    };
    proc.on(sig, handler);
    removers.push(() => proc.off(sig, handler));
  }
  const monitor = (err: unknown, origin: string) => {
    const e = err as { message?: unknown; stack?: unknown } | undefined;
    const message = typeof e?.message === 'string' ? e.message : String(err);
    recordShutdown(origin === 'unhandledRejection' ? 'unhandledRejection' : 'uncaughtException', {
      error: maskSecrets(message).slice(0, 2000),
    });
  };
  proc.on('uncaughtExceptionMonitor', monitor);
  removers.push(() => proc.off('uncaughtExceptionMonitor', monitor));
  return () => { for (const r of removers) r(); };
}
