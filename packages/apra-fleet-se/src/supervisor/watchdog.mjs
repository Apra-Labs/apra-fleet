// =============================================================================
// Auto-sprint supervisor -- PID-liveness watchdog + four-status classifier
// (apra-fleet-eft.4.3, Plan Part 2.1, process model B)
// =============================================================================
//
// Same-instance exit events (the spawner's own child 'exit' listener) are
// authoritative WHILE this supervisor process stays up, but a supervisor
// RESTART is the severance point: after a restart the detached children live
// on with no in-memory 'exit' listener wired to them. So we cannot rely on exit
// events alone to know a sprint's true state -- we need an out-of-band probe.
//
// This module is that probe. On a short, CONFIGURABLE interval it PID-probes
// every ledger-listed sprint and combines two independent signals -- PID
// liveness and child HTTP reachability (the child's own `/state` endpoint on
// its --viewer-port) -- into EXACTLY FOUR statuses:
//
//   running-healthy      PID alive (and plausibly OUR child) AND HTTP answering
//   running-unresponsive PID alive but HTTP silent. This is an OPERATOR-ATTENTION
//                        signal, NOT a death sentence: a wedged/slow child is
//                        never auto-declared crashed and is never killed here.
//   crashed              PID gone, and NO terminal state persisted in old_sprints/
//   finished             PID gone, and a terminal state IS persisted in old_sprints/
//
// CRITICAL invariants (acceptance criteria):
//   * The classifier returns EXACTLY ONE of the four statuses per sprint.
//   * A hung child (PID alive, HTTP not answering) is running-unresponsive --
//     never crashed, never killed.
//   * PID-gone WITH an old_sprints/ terminal state => finished; WITHOUT one =>
//     crashed.
//   * PID reuse is guarded: the liveness probe validates the PID is plausibly
//     OUR child (its command line still carries the sprint's unique
//     `--viewer-port <port>` marker), not just any process that reused the PID
//     number after our child exited.
//   * This module NEVER auto-kills or auto-restarts anything. It only observes
//     and classifies; remediation is an operator decision.
// =============================================================================

import http from 'node:http';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isPidAlive } from './reconcile.mjs';
import { getOldSprintStatePath } from '@apralabs/apra-fleet-workflow/viewer/sprint-state-paths';

/** The four -- and only four -- statuses the classifier may return. */
export const WATCHDOG_STATUS = Object.freeze({
    RUNNING_HEALTHY: 'running-healthy',
    RUNNING_UNRESPONSIVE: 'running-unresponsive',
    CRASHED: 'crashed',
    FINISHED: 'finished',
});

/** Default watchdog probe interval (ms). Overridable via createWatchdog opts. */
export const WATCHDOG_DEFAULT_INTERVAL_MS = 5000;

/** Default timeout (ms) for a single child HTTP reachability probe. */
export const WATCHDOG_DEFAULT_HTTP_TIMEOUT_MS = 1500;

/**
 * `ps`-based command-line reader for POSIX platforms with no `/proc` (macOS,
 * and a fallback for any other POSIX system where the `/proc` read fails).
 * @param {number} pid
 * @returns {string|null}
 */
function readCmdlineViaPs(pid) {
    try {
        const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8' });
        if (r.error || r.status !== 0) return null;
        const out = (r.stdout || '').trim();
        return out.length > 0 ? out : null;
    } catch {
        return null;
    }
}

/**
 * Windows command-line reader via WMIC (`wmic process where ProcessId=<pid>
 * get CommandLine`). WMIC's output is a header line ("CommandLine") followed
 * by the value line(s); we drop the header and join the rest.
 * @param {number} pid
 * @returns {string|null}
 */
function readCmdlineViaWmic(pid) {
    try {
        const r = spawnSync(
            'wmic',
            ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine'],
            { encoding: 'utf-8' },
        );
        if (r.error || r.status !== 0) return null;
        const lines = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        // First non-empty line is the "CommandLine" header; the rest is the value.
        if (lines.length < 2) return null;
        const value = lines.slice(1).join(' ').trim();
        return value.length > 0 ? value : null;
    } catch {
        return null;
    }
}

/**
 * Windows command-line reader via PowerShell's `Get-CimInstance`, used as a
 * fallback where WMIC is unavailable (WMIC is deprecated/absent on some
 * modern Windows builds; CIM is the supported replacement).
 * @param {number} pid
 * @returns {string|null}
 */
function readCmdlineViaCim(pid) {
    try {
        const r = spawnSync(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
            { encoding: 'utf-8' },
        );
        if (r.error || r.status !== 0) return null;
        const out = (r.stdout || '').trim();
        return out.length > 0 ? out : null;
    } catch {
        return null;
    }
}

/**
 * Best-effort, per-platform read of a process's command line, for the
 * PID-reuse guard:
 *   - Linux: `/proc/<pid>/cmdline` (NUL-separated argv, joined with spaces).
 *   - Windows: WMIC (`wmic process ... get CommandLine`), falling back to
 *     PowerShell's `Get-CimInstance` when WMIC is unavailable.
 *   - Everything else (macOS and other POSIX platforms without `/proc`): `ps`.
 * Returns `null` when the command line cannot be read on the current
 * platform (missing tool, permission denied, or the pid is gone) -- callers
 * treat `null` as "cannot verify", never as a false negative.
 * @param {number} pid
 * @returns {string|null}
 */
export function readProcessCmdline(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (process.platform === 'linux') {
        try {
            const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
            // argv entries are NUL-separated (and NUL-terminated); normalize to spaces.
            const cmd = raw.toString('utf-8').replace(/\0/g, ' ').trim();
            if (cmd.length > 0) return cmd;
        } catch {
            // fall through to the `ps` fallback below (e.g. /proc unreadable)
        }
        return readCmdlineViaPs(pid);
    }
    if (process.platform === 'win32') {
        return readCmdlineViaWmic(pid) ?? readCmdlineViaCim(pid);
    }
    return readCmdlineViaPs(pid);
}

/**
 * Build the PID-liveness probe WITH the PID-reuse guard. A sprint's PID counts
 * as alive only if:
 *   1. the process exists (signal-0 probe, EPERM => exists), AND
 *   2. if a `marker` is supplied AND the process command line is readable, that
 *      command line still contains the marker (the sprint's unique
 *      `--viewer-port <port>` string). If the command line cannot be read, we
 *      fall back to existence-only -- a documented best-effort, never a false
 *      "crashed".
 *
 * The marker being the unique viewer-port makes this a genuine reuse guard: an
 * unrelated process that merely inherited our exited child's PID number will
 * not be running with that exact `--viewer-port`, so it is correctly treated as
 * NOT our child (=> the sprint is PID-gone -> crashed/finished, never reported
 * as a healthy/unresponsive live sprint that happens to share a PID).
 *
 * @param {{ readCmdline?: (pid: number) => string|null, isAlive?: (pid: number) => boolean }} [deps]
 * @returns {(pid: number, marker?: string|number|null) => boolean}
 */
export function makeChildPidProbe(deps = {}) {
    const readCmdline = deps.readCmdline ?? readProcessCmdline;
    const isAlive = deps.isAlive ?? isPidAlive;
    return (pid, marker) => {
        if (!isAlive(pid)) return false;
        if (marker === undefined || marker === null || marker === '') return true;
        const cmd = readCmdline(pid);
        if (cmd == null) return true; // cannot verify -> best-effort existence
        return cmd.includes(String(marker));
    };
}

/**
 * Default child HTTP reachability probe: a short-timeout GET to the child's own
 * viewer `/state` endpoint. "Reachable" means the child answered with any HTTP
 * status at all (it is serving) -- a connection refused / reset / timeout means
 * unreachable. Never throws: resolves to a boolean.
 * @param {number} port
 * @param {{ host?: string, path?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<boolean>}
 */
export function probeChildHttp(port, opts = {}) {
    const host = opts.host ?? '127.0.0.1';
    const path = opts.path ?? '/state';
    const timeoutMs = Number.isInteger(opts.timeoutMs) ? opts.timeoutMs : WATCHDOG_DEFAULT_HTTP_TIMEOUT_MS;
    if (!Number.isInteger(port) || port <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
        let settled = false;
        const done = (val) => { if (!settled) { settled = true; resolve(val); } };
        const req = http.request({ host, port, path, method: 'GET', timeout: timeoutMs }, (res) => {
            // Any response means the child's HTTP server is answering. Drain and
            // discard the body so the socket can be freed.
            res.resume();
            done(true);
        });
        req.on('timeout', () => { req.destroy(); done(false); });
        req.on('error', () => done(false));
        req.end();
    });
}

/**
 * Create the PID-liveness watchdog seam. Every collaborator is injectable so a
 * test can drive deterministic PID/HTTP/terminal-state signals without real
 * processes, sockets, or files.
 *
 * @param {{
 *   ledger: { list: () => Array<{ sprintId: string, childPid: number|null }> },
 *   resolvePort?: (sprintId: string) => number|undefined,
 *   isChildAlive?: (pid: number, marker?: string|number|null) => boolean,
 *   probeHttp?: (port: number) => Promise<boolean>|boolean,
 *   hasTerminalState?: (sprintId: string) => boolean,
 *   intervalMs?: number,
 *   env?: NodeJS.ProcessEnv,
 *   setIntervalFn?: typeof setInterval,
 *   clearIntervalFn?: typeof clearInterval,
 *   logger?: { log?: Function, error?: Function },
 * }} deps
 * @returns {{
 *   name: string,
 *   start(): Promise<void>,
 *   stop(): Promise<void>,
 *   classifySprint(entry: object): Promise<object>,
 *   classifyAll(): Promise<Array<object>>,
 *   getSnapshot(): Array<object>,
 *   intervalMs: number,
 * }}
 */
export function createWatchdog(deps = {}) {
    const ledger = deps.ledger;
    if (!ledger || typeof ledger.list !== 'function') {
        throw new TypeError('createWatchdog requires a ledger with a list() method');
    }
    const env = deps.env ?? process.env;
    const resolvePort = deps.resolvePort ?? (() => undefined);
    const isChildAlive = deps.isChildAlive ?? makeChildPidProbe();
    const probeHttp = deps.probeHttp ?? probeChildHttp;
    const hasTerminalState = deps.hasTerminalState
        ?? ((sprintId) => {
            try {
                return fs.existsSync(getOldSprintStatePath(sprintId, env));
            } catch {
                return false;
            }
        });
    const intervalMs = Number.isInteger(deps.intervalMs) && deps.intervalMs > 0
        ? deps.intervalMs
        : WATCHDOG_DEFAULT_INTERVAL_MS;
    const setIntervalFn = deps.setIntervalFn ?? setInterval;
    const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
    const logger = deps.logger ?? console;
    const logError = (...a) => (logger.error ?? logger.log)?.(...a);

    /** Latest classification snapshot, refreshed each interval tick. */
    let snapshot = [];
    /** @type {ReturnType<typeof setInterval>|null} */
    let timer = null;

    /**
     * Classify a SINGLE ledger entry into exactly one of the four statuses.
     * @param {{ sprintId: string, childPid: number|null }} entry
     * @returns {Promise<{ sprintId: string, status: string, pidAlive: boolean, httpOk: boolean, childPid: number|null, port: number|undefined }>}
     */
    async function classifySprint(entry) {
        const sprintId = entry.sprintId;
        const childPid = entry.childPid ?? null;
        const port = resolvePort(sprintId);
        // The reuse-guard marker is the sprint's unique --viewer-port string, so
        // a PID-number collision with an unrelated process is not mistaken for
        // our child. When the port is unknown (e.g. a child re-adopted across a
        // restart before its port is rediscovered), we fall back to
        // existence-only liveness rather than fabricating a status.
        const marker = Number.isInteger(port) ? `--viewer-port ${port}` : null;

        const pidAlive = childPid != null && isChildAlive(childPid, marker);

        if (pidAlive) {
            // PID alive: the HTTP signal splits healthy vs unresponsive. A hung
            // child (HTTP silent) is unresponsive -- NEVER auto-declared crashed.
            let httpOk = false;
            if (Number.isInteger(port)) {
                try {
                    httpOk = await probeHttp(port);
                } catch {
                    httpOk = false;
                }
            }
            return {
                sprintId,
                status: httpOk ? WATCHDOG_STATUS.RUNNING_HEALTHY : WATCHDOG_STATUS.RUNNING_UNRESPONSIVE,
                pidAlive: true,
                httpOk,
                childPid,
                port,
            };
        }

        // PID gone: a persisted terminal state in old_sprints/ means it FINISHED;
        // its absence means it CRASHED (died without recording a terminal state).
        const finished = hasTerminalState(sprintId);
        return {
            sprintId,
            status: finished ? WATCHDOG_STATUS.FINISHED : WATCHDOG_STATUS.CRASHED,
            pidAlive: false,
            httpOk: false,
            childPid,
            port,
        };
    }

    /**
     * Classify every ledger-listed sprint. The ledger snapshot is taken once so
     * concurrent ledger mutation cannot disturb this pass.
     * @returns {Promise<Array<object>>}
     */
    async function classifyAll() {
        const entries = ledger.list();
        const results = await Promise.all(entries.map((e) => classifySprint(e)));
        snapshot = results;
        return results;
    }

    return {
        name: 'watchdog',
        intervalMs,

        async start() {
            if (timer) return;
            // Prime an initial snapshot immediately so a status query right after
            // start() does not race the first interval tick.
            try { await classifyAll(); } catch (err) { logError('[watchdog] initial classify failed:', err); }
            timer = setIntervalFn(() => {
                classifyAll().catch((err) => logError('[watchdog] interval classify failed:', err));
            }, intervalMs);
            // Never let the watchdog's own interval keep the process alive on its
            // account -- the supervisor lifecycle owns process liveness.
            if (timer && typeof timer.unref === 'function') timer.unref();
        },

        async stop() {
            if (timer) {
                clearIntervalFn(timer);
                timer = null;
            }
        },

        classifySprint,
        classifyAll,
        /** The most recent classification snapshot (last interval tick). */
        getSnapshot() { return snapshot.map((s) => ({ ...s })); },
    };
}
