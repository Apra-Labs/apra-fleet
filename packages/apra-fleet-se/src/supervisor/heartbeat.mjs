// =============================================================================
// Supervisor liveness record: <dataDir>/supervisor.json
// =============================================================================
//
// The supervisor cannot report its own hard death (SIGKILL / TerminateProcess
// runs no handler), so liveness has to be readable from OUTSIDE the process.
// While running it rewrites this file every `intervalMs`; a reader (core
// `apra-fleet status`) judges liveness from `updatedAt` + `intervalMs` and a
// pid probe, and never needs to import this package.
//
// Record shape (JSON):
//   { pid, port, beadsDir, version, startedAt, updatedAt, intervalMs }
//   plus `stoppedAt` (ISO) on the FINAL record written by a clean stop.
//
// Final-state decision: a clean shutdown KEEPS the file and adds `stoppedAt`
// (rather than deleting it) so a reader can tell "stopped cleanly" from
// "never started" and from "died without a trace".
//
// Atomicity: every write goes to a temp file in the same directory and is
// renamed over supervisor.json, so a concurrent reader sees either the old or
// the new complete document, never a partial one.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';

export const HEARTBEAT_FILE_NAME = 'supervisor.json';
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;
/** Optional override (milliseconds); mainly for tests and short-lived runs. */
export const HEARTBEAT_INTERVAL_ENV = 'FLEET_SE_HEARTBEAT_INTERVAL_MS';

export function heartbeatPath(dataDir) {
    return path.join(dataDir, HEARTBEAT_FILE_NAME);
}

export function resolveHeartbeatIntervalMs(env = process.env) {
    const n = Number(env[HEARTBEAT_INTERVAL_ENV]);
    return Number.isFinite(n) && n >= 10 ? Math.floor(n) : DEFAULT_HEARTBEAT_INTERVAL_MS;
}

/** Atomic write: temp file in the same dir + rename. Synchronous. */
export function writeHeartbeatFile(file, record) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${HEARTBEAT_FILE_NAME}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    try {
        fs.renameSync(tmp, file);
    } catch (err) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
        throw err;
    }
}

/**
 * @param {{ dataDir: string, port: number, beadsDir?: string|null, version?: string, intervalMs?: number,
 *           pid?: number, now?: () => Date, log?: (msg: string) => void }} opts
 */
export function createHeartbeat(opts) {
    const {
        dataDir, port, beadsDir = null, version = null,
        intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
        pid = process.pid, now = () => new Date(), log = () => {},
    } = opts;
    const file = heartbeatPath(dataDir);
    const startedAt = now().toISOString();
    let timer = null;
    let stopped = false;

    function record(extra = {}) {
        return { pid, port, beadsDir, version, startedAt, updatedAt: now().toISOString(), intervalMs, ...extra };
    }
    function safeWrite(extra) {
        try {
            writeHeartbeatFile(file, record(extra));
        } catch (err) {
            // Never let a liveness write take the supervisor down.
            log(`[supervisor] heartbeat write to ${file} failed: ${err && err.message ? err.message : err}`);
        }
    }

    return {
        file,
        /** Writes the first record now and then every intervalMs. Idempotent. */
        start() {
            if (timer || stopped) return;
            safeWrite();
            timer = setInterval(() => safeWrite(), intervalMs);
            if (typeof timer.unref === 'function') timer.unref();
        },
        /** Stops the interval and writes the final record (with stoppedAt). Idempotent. */
        stop() {
            if (stopped) return;
            stopped = true;
            if (timer) { clearInterval(timer); timer = null; }
            const t = now().toISOString();
            safeWrite({ updatedAt: t, stoppedAt: t });
        },
    };
}
