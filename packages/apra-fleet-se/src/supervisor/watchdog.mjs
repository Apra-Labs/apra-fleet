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
// every ledger-listed sprint and combines three independent signals -- PID
// liveness, child HTTP reachability (the child's own `/state` endpoint on
// its --viewer-port), and (apra-fleet-p2to.3.1) that SAME `/state` payload's
// generic `pause.status` field (see packages/apra-fleet-workflow/src/viewer/
// index.mjs's `state.pause`, apra-fleet-p2to.2.1) -- into EXACTLY SIX statuses:
//
//   running-healthy      PID alive (and plausibly OUR child), HTTP answering,
//                        and not paused.
//   paused               PID alive, HTTP answering, and the child's own
//                        `state.pause.status` reads 'paused' (apra-fleet-
//                        p2to.1's engine pause primitive has actually
//                        engaged, not merely been requested). Treated as a
//                        LIVE, healthy state -- never stalled/dead, and
//                        (like running-healthy/running-unresponsive) its
//                        reservation is never auto-released.
//   running-unresponsive PID alive but HTTP silent. This is an OPERATOR-ATTENTION
//                        signal, NOT a death sentence: a wedged/slow child is
//                        never auto-declared crashed and is never killed here.
//   crashed              PID gone, and NO terminal state persisted in old_runs/
//                        (or the legacy old_sprints/, apra-fleet-eft.37.1),
//                        and NOT within the launch-failed window.
//   finished             PID gone, and a terminal state IS persisted in old_runs/
//                        (or the legacy old_sprints/, apra-fleet-eft.37.1)
//   launch-failed        PID gone within the configurable launch window (default 60s),
//                        NO terminal state, a symptom of immediate child exit
//
// CRITICAL invariants (acceptance criteria):
//   * The classifier returns EXACTLY ONE of the six statuses per sprint.
//   * A hung child (PID alive, HTTP not answering) is running-unresponsive --
//     never crashed, never killed.
//   * A live-pid child the engine has actually paused is `paused`, never
//     stalled/dead/crashed -- and, like every other live status, its
//     reservation is never force-released (apra-fleet-p2to.3.1).
//   * PID-gone WITH an old_runs/ (or legacy old_sprints/) terminal state =>
//     finished; WITHOUT one => crashed.
//   * PID reuse is guarded: the liveness probe validates the PID is plausibly
//     OUR child (its command line still carries the sprint's unique
//     `--viewer-port <port>` marker), not just any process that reused the PID
//     number after our child exited.
//   * This module NEVER auto-kills or auto-restarts anything. It only observes
//     and classifies; remediation is an operator decision.
// =============================================================================

import http from 'node:http';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isPidAlive } from './reconcile.mjs';
import { getTerminalRunStatePath, getRunningRunStatePath } from '@apralabs/apra-fleet-workflow/viewer/run-state-paths';
import { writeJsonFileAtomic } from '@apralabs/apra-fleet-workflow/viewer/debounced-writer';
import { withTimestamps } from './log-timestamp.mjs';
import { HISTORY_EVENTS } from './history.mjs';

/** The six statuses the classifier may return. */
export const WATCHDOG_STATUS = Object.freeze({
    RUNNING_HEALTHY: 'running-healthy',
    // (apra-fleet-p2to.3.1) A live, HTTP-reachable child the engine has
    // actually paused (state.pause.status === 'paused', not merely
    // 'pausing') -- see this module's file-level doc comment.
    PAUSED: 'paused',
    RUNNING_UNRESPONSIVE: 'running-unresponsive',
    CRASHED: 'crashed',
    FINISHED: 'finished',
    LAUNCH_FAILED: 'launch-failed',
});

/** Default watchdog probe interval (ms). Overridable via createWatchdog opts. */
export const WATCHDOG_DEFAULT_INTERVAL_MS = 5000;

/**
 * Default timeout (ms) for a single child HTTP reachability probe.
 *
 * apra-fleet CI incident (2026-08-04, run 30880131689): the windows-latest CI
 * job deterministically misclassified a genuinely-healthy child as
 * running-unresponsive. Root cause: the PID-reuse guard's Windows
 * command-line read (readCmdlineViaWmic, falling back to readCmdlineViaCim)
 * used a SYNCHRONOUS `spawnSync()` external process call, executed for every
 * live-PID sprint BEFORE that sprint's HTTP probe was even sent
 * (classifySprint() called isChildAlive() synchronously, then `await`ed
 * probeHttp()). Because Array.prototype.map() invokes each classifySprint()
 * call synchronously up to its first await, ALL of a given classifyAll()
 * pass's synchronous readCmdline calls ran back-to-back and BLOCKED the
 * whole Node.js event loop -- including already-dispatched HTTP
 * request/response processing for an earlier sprint in the same pass -- for
 * their combined duration. Measured on a dev box: `wmic` alone costs ~400ms
 * per call; the `Get-CimInstance` PowerShell fallback costs over 1.2s per
 * call. This starvation is not CI-only: the same production supervisor log
 * this fix's own investigation reviewed showed a live "[watchdog] tick
 * skipped: previous classifyAll() still in flight" line minutes after the
 * CI-only timeout band-aid (a prior revision of this constant) had already
 * landed, confirming the blocking read starves the event loop in real runs
 * too, not just on a loaded CI runner.
 *
 * Fix (this revision): `readCmdlineViaWmic`/`readCmdlineViaCim`/
 * `readCmdlineViaPs` now use `child_process.execFile` via
 * `util.promisify` (same pattern as `scripts/lib/exec-bd.mjs`'s
 * `execBdAsync`) instead of `spawnSync`, and `readProcessCmdline` /
 * `makeChildPidProbe()`'s returned probe / `classifySprint()`'s call site
 * are all async now (see their doc comments) -- so a cmdline read never
 * blocks the event loop, and one sprint's PID-reuse-guard read can no longer
 * starve another sprint's already-in-flight HTTP probe within the same
 * `classifyAll()` pass. With the root cause (event-loop starvation) fixed
 * rather than timed around, the timeout goes back to a single flat value on
 * every platform -- the previous CI-only 6000ms carve-out is removed
 * entirely rather than kept as a "just in case" margin, so CI stays exposed
 * to (i.e. is not blind to) any future regression in this same class of bug.
 */
export const WATCHDOG_DEFAULT_HTTP_TIMEOUT_MS = 1500;

/** Promise-based `child_process.execFile`, used by the Windows/POSIX cmdline
 * readers below instead of `spawnSync` so a PID-reuse-guard read never blocks
 * the Node.js event loop (see WATCHDOG_DEFAULT_HTTP_TIMEOUT_MS's doc comment
 * for the incident this fixes). Mirrors `scripts/lib/exec-bd.mjs`'s
 * `promisify(execFile)` precedent. */
const execFileAsync = promisify(execFile);

/** Default launch-failed window (ms, i.e. 60 seconds). A child exiting within
 * this window from its reservedAt timestamp is classified launch-failed. */
export const WATCHDOG_DEFAULT_LAUNCH_FAILED_WINDOW_MS = 60000;

/**
 * `ps`-based command-line reader for POSIX platforms with no `/proc` (macOS,
 * and a fallback for any other POSIX system where the `/proc` read fails).
 * Uses `execFile` (via `execFileAsync`), not `spawnSync` -- POSIX `ps` is
 * fast and rarely the bottleneck, but this is converted for consistency with
 * the Windows readers below (see WATCHDOG_DEFAULT_HTTP_TIMEOUT_MS's doc
 * comment for why blocking reads matter here at all).
 * @param {number} pid
 * @returns {Promise<string|null>}
 */
async function readCmdlineViaPs(pid) {
    try {
        const { stdout } = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8' });
        const out = (stdout || '').trim();
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
 * @returns {Promise<string|null>}
 */
async function readCmdlineViaWmic(pid) {
    try {
        const { stdout } = await execFileAsync(
            'wmic',
            ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine'],
            { encoding: 'utf-8' },
        );
        const lines = (stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
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
 * @returns {Promise<string|null>}
 */
async function readCmdlineViaCim(pid) {
    try {
        const { stdout } = await execFileAsync(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
            { encoding: 'utf-8' },
        );
        const out = (stdout || '').trim();
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
 *
 * Async (previously synchronous via `spawnSync`): the Windows readers in
 * particular cost 400ms-1.2s+ per call, and running them synchronously
 * blocked the whole Node.js event loop -- including an already-dispatched
 * HTTP probe for another sprint in the same `classifyAll()` pass. See
 * WATCHDOG_DEFAULT_HTTP_TIMEOUT_MS's doc comment for the full incident.
 * @param {number} pid
 * @returns {Promise<string|null>}
 */
export async function readProcessCmdline(pid) {
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
        return (await readCmdlineViaWmic(pid)) ?? (await readCmdlineViaCim(pid));
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
 * Async (the returned probe and `readCmdline` may both return a Promise):
 * `readProcessCmdline`'s Windows implementation now shells out via
 * `child_process.execFile` rather than `spawnSync` (see
 * WATCHDOG_DEFAULT_HTTP_TIMEOUT_MS's doc comment), so this never blocks the
 * event loop. `await`ing a plain (non-Promise) return value from an injected
 * synchronous `readCmdline`/`isAlive` test double is a no-op, so existing
 * synchronous test doubles keep working unchanged.
 * @param {{ readCmdline?: (pid: number) => string|null|Promise<string|null>, isAlive?: (pid: number) => boolean|Promise<boolean> }} [deps]
 * @returns {(pid: number, marker?: string|number|null) => Promise<boolean>}
 */
export function makeChildPidProbe(deps = {}) {
    const readCmdline = deps.readCmdline ?? readProcessCmdline;
    const isAlive = deps.isAlive ?? isPidAlive;
    return async (pid, marker) => {
        if (!(await isAlive(pid))) return false;
        if (marker === undefined || marker === null || marker === '') return true;
        const cmd = await readCmdline(pid);
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
 * (apra-fleet-p2to.3.1) Default pause-status probe: GETs the SAME child
 * `/state` endpoint probeChildHttp() above already knows is reachable, and
 * reads its generic `pause.status` field (packages/apra-fleet-workflow/src/
 * viewer/index.mjs's `state.pause`, set by the p2to.2.1 viewer from the
 * p2to.1 engine's own 'pause:requested'/'paused'/'resumed' events). Returns
 * the raw string ('none' | 'pausing' | 'paused'), or `null` when the request
 * fails, times out, or the body is not parseable JSON -- "cannot verify" is
 * never conflated with "not paused": classifySprint() below only acts on an
 * explicit `'paused'` value, so a probe failure here just leaves the child
 * classified by PID+HTTP alone (running-healthy), exactly as it was before
 * this probe existed. Never throws.
 * @param {number} port
 * @param {{ host?: string, path?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<string|null>}
 */
export function probeChildPauseStatus(port, opts = {}) {
    const host = opts.host ?? '127.0.0.1';
    const path = opts.path ?? '/state';
    const timeoutMs = Number.isInteger(opts.timeoutMs) ? opts.timeoutMs : WATCHDOG_DEFAULT_HTTP_TIMEOUT_MS;
    if (!Number.isInteger(port) || port <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
        let settled = false;
        const done = (val) => { if (!settled) { settled = true; resolve(val); } };
        const req = http.request({ host, port, path, method: 'GET', timeout: timeoutMs }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                try {
                    const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                    const status = body && typeof body === 'object' ? body?.pause?.status : null;
                    done(typeof status === 'string' ? status : null);
                } catch {
                    done(null);
                }
            });
            res.on('error', () => done(null));
        });
        req.on('timeout', () => { req.destroy(); done(null); });
        req.on('error', () => done(null));
        req.end();
    });
}

/**
 * apra-fleet-k7b.3: formats a human-readable exit-detail string for a
 * PID-gone sprint from whatever the ledger's recordExit() (spawner's own
 * SAME-INSTANCE 'exit' listener, see spawner.mjs/bin/serve.mjs's wiring)
 * annotated onto its reservation -- e.g. "exited 1 at
 * 2026-07-30T21:25:50.000Z" or "killed by signal SIGKILL at ...". Falls back
 * to the previous bare "pid gone" when nothing was ever recorded (a restart
 * severed the in-memory 'exit' listener before this instance ever observed
 * the child exit -- see this module's own file-level doc comment).
 * @param {{ exitCode?: number|null, signal?: string|null, exitedAt?: string|null }} [info]
 * @returns {string}
 */
export function formatExitDetail(info = {}) {
    const { exitCode, signal, exitedAt } = info;
    if (exitCode == null && !signal) return 'pid gone';
    const at = exitedAt ? ` at ${exitedAt}` : '';
    if (exitCode != null) {
        return signal ? `exited ${exitCode} (signal ${signal})${at}` : `exited ${exitCode}${at}`;
    }
    return `killed by signal ${signal}${at}`;
}

/**
 * apra-fleet-k7b.2: reads and parses a persisted terminal run-state file
 * (old_runs/, or the legacy old_sprints/ directory) at `path`. Returns the
 * parsed object, or `null` when the file does not exist or is not valid
 * JSON -- a reader-side concern only, never thrown: a missing/corrupt
 * terminal-state file must never take the watchdog's classification down
 * with it.
 * @param {string} path
 * @returns {object|null}
 */
function readTerminalRunState(path) {
    try {
        return JSON.parse(fs.readFileSync(path, 'utf-8'));
    } catch {
        return null;
    }
}

/**
 * apra-fleet-k7b.2: resolves whether a PID-gone sprint actually FINISHED, by
 * run-id first and -- ONLY as a fallback for a reservation claimed before
 * apra-fleet-k7b.1's run-id plumbing shipped -- by the sprint's launch
 * branch. Returns the PARSED terminal-state object (not a boolean) so the
 * watchdog log line / sprint-history.json event / History view can copy the
 * engine's own `terminalReason` / `extensions.terminal.verdict` verbatim,
 * instead of a generic message. Returns `null` when no terminal state is
 * found under either key.
 *
 * The legacy branch-key fallback exists because a reservation claimed
 * BEFORE k7b.1 has a sprintId (branch-derived, pre-run-id) that may not
 * match the run-id the engine itself used to write its terminal state; a
 * reservation's OWN recorded `branch` (ledger.mjs's Reservation.branch) is
 * the only other identity available to look that pre-fix terminal state up
 * by. A reservation claimed AFTER k7b.1 always resolves by run-id alone
 * (branch is never consulted once the run-id lookup succeeds).
 * @param {string} sprintId
 * @param {string|null|undefined} branch
 * @param {NodeJS.ProcessEnv} env
 * @returns {object|null}
 */
export function defaultHasTerminalState(sprintId, branch, env = process.env) {
    try {
        const byRunId = getTerminalRunStatePath(sprintId, env);
        if (fs.existsSync(byRunId)) {
            return readTerminalRunState(byRunId);
        }
    } catch {
        // fall through to the branch fallback below
    }
    if (typeof branch === 'string' && branch.length > 0 && branch !== sprintId) {
        try {
            const byBranch = getTerminalRunStatePath(branch, env);
            if (fs.existsSync(byBranch)) {
                return readTerminalRunState(byBranch);
            }
        } catch {
            // no legacy terminal state under the branch key either
        }
    }
    return null;
}

/**
 * apra-fleet-k7b.2: formats a human-readable FINISHED detail string from a
 * persisted terminal run-state, copying the engine's own `terminalReason`
 * and `extensions.terminal.verdict` VERBATIM (never paraphrased/relabeled)
 * -- e.g. "terminalReason=SPRINT_STALLED verdict=needs-changes". Falls back
 * to a bare "finished" when the state carries neither field (or is not an
 * object -- e.g. a truthy-but-non-object test double), so this never throws
 * on an unexpected shape.
 * @param {unknown} state
 * @returns {string}
 */
export function formatFinishedDetail(state) {
    if (!state || typeof state !== 'object') return 'finished';
    const terminalReason = state.terminalReason ?? null;
    const verdict = state?.extensions?.terminal?.verdict ?? null;
    const parts = [];
    if (terminalReason) parts.push(`terminalReason=${terminalReason}`);
    if (verdict) parts.push(`verdict=${verdict}`);
    return parts.length > 0 ? parts.join(' ') : 'finished';
}

/**
 * apra-fleet-k7b.2: default FINISHED recorder, invoked the FIRST time a
 * sprint is observed transitioning into FINISHED (PID gone, terminal state
 * found). Mirrors apra-fleet-eft.20.3's defaultRecordTerminalError below,
 * but for the "actually finished" case instead of "crashed": logs an
 * explicit, greppable watchdog line copying the engine's own
 * terminalReason/verdict verbatim (replacing the generic CRASHED-sounding
 * language a mis-resolved terminal-state lookup used to fall through to),
 * and -- when a `history` collaborator is injected -- appends a durable
 * FINISHED event to sprint-history.json carrying the same fields.
 * @param {{ sprintId: string, state: object|null, env: NodeJS.ProcessEnv, logger: { log?: Function, error?: Function }, history?: { record: (entry: object) => Promise<object> } }} info
 */
export function defaultRecordFinished({ sprintId, state, logger, history }) {
    const log = (logger && (logger.log ?? logger.error)) ?? (() => {});
    const detail = formatFinishedDetail(state);
    log(`[watchdog] FINISHED: Sprint '${sprintId}' finished (${detail}).`);
    if (!history || typeof history.record !== 'function') return;
    const terminalReason = (state && typeof state === 'object' && state.terminalReason) || null;
    const verdict = (state && typeof state === 'object' && state?.extensions?.terminal?.verdict) || null;
    try {
        const result = history.record({ sprintId, event: HISTORY_EVENTS.FINISHED, terminalReason, verdict });
        // history.record() is async; a rejection must never take the
        // classifier down with it (same discipline as recordTerminalError
        // below), so it is observed but not awaited by the caller.
        if (result && typeof result.catch === 'function') {
            result.catch((err) => {
                const logErr = (logger && (logger.error ?? logger.log)) ?? (() => {});
                logErr(`[watchdog] history.record(FINISHED) failed for '${sprintId}':`, err);
            });
        }
    } catch (err) {
        const logErr = (logger && (logger.error ?? logger.log)) ?? (() => {});
        logErr(`[watchdog] history.record(FINISHED) failed for '${sprintId}':`, err);
    }
}

/**
 * apra-fleet-eft.20.3: default terminal-error recorder, invoked the FIRST
 * time a sprint is observed transitioning into CRASHED. The apra-fleet-eft.20
 * smoke-test symptom this fixes: a doer sub-session died mid-Develop and the
 * run just went silent -- no error, no exception, no exit line anywhere, and
 * nothing about the failure was ever persisted. This makes that death
 * observable in two places an operator (or another automated system) would
 * actually look:
 *   (a) an explicit, greppable line via the watchdog's own logger -- the SAME
 *       fleet server log every other watchdog/supervisor line already goes
 *       to, so no new log surface to monitor;
 *   (b) the sprint's own state file, read+merged+written back atomically (the
 *       apra-fleet-eft.20.1 single-pass-JSON.stringify-plus-atomic-rename
 *       primitive) with a `status: 'failed'` and a `lastError` describing
 *       what the watchdog observed. Written back to running/ IN PLACE
 *       (never moved to old_runs/) so classifySprint()'s FINISHED/CRASHED
 *       distinction -- which keys off old_runs/ (or legacy old_sprints/)
 *       membership -- is not disturbed by this write: a sprint the watchdog
 *       declared crashed stays classified crashed on every later tick, it
 *       never silently becomes "finished" just because this recorder
 *       touched its file.
 * apra-fleet-k7b.3: `detail` (formatExitDetail() above) reports the child's
 * OWN recorded exit code/signal/time when this instance's spawner witnessed
 * it (e.g. "exited 1 at 2026-07-30T21:25:50.000Z"), replacing the previously
 * unconditional bare "pid gone" -- unchanged fallback when nothing was
 * recorded (a restart severed the in-memory exit listener, see this
 * module's file-level doc comment).
 * @param {{ sprintId: string, childPid: number|null, env: NodeJS.ProcessEnv, logger: { log?: Function, error?: Function }, detail?: string }} info
 */
export function defaultRecordTerminalError({ sprintId, childPid, env, logger, detail }) {
    const log = (logger && (logger.error ?? logger.log)) ?? (() => {});
    const exitDetail = detail ?? 'pid gone';
    const message = `Sprint '${sprintId}' (pid ${childPid ?? 'unknown'}) is no longer alive (${exitDetail}) and never recorded a terminal state -- classified CRASHED by the PID-liveness watchdog.`;
    log(`[watchdog] TERMINAL ERROR: ${message}`);
    try {
        const statePath = getRunningRunStatePath(sprintId, env);
        let existing = {};
        try {
            existing = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        } catch {
            // No readable prior state (the child died before ever writing one,
            // or its last write was left malformed) -- still record the crash
            // with whatever we know; never let a missing/bad prior file block
            // reporting the failure itself.
        }
        writeJsonFileAtomic(statePath, {
            ...existing,
            status: 'failed',
            terminalReason: existing.terminalReason || `watchdog: crashed (${exitDetail}, no terminal state ever persisted)`,
            lastError: {
                message,
                sprintId,
                childPid: childPid ?? null,
                detectedAt: new Date().toISOString(),
            },
        });
    } catch (err) {
        log(`[watchdog] failed to persist terminal error state for '${sprintId}': ${(err && err.message) || err}`);
    }
}

/**
 * Create the PID-liveness watchdog seam. Every collaborator is injectable so a
 * test can drive deterministic PID/HTTP/terminal-state signals without real
 * processes, sockets, or files.
 *
 * @param {{
 *   ledger: { list: () => Array<{ sprintId: string, childPid: number|null }> },
 *   resolvePort?: (sprintId: string) => number|undefined,
 *   isChildAlive?: (pid: number, marker?: string|number|null) => boolean|Promise<boolean>,
 *   probeHttp?: (port: number) => Promise<boolean>|boolean,
 *   probePauseState?: (port: number) => Promise<string|null>|string|null,
 *   hasTerminalState?: (sprintId: string, branch?: string|null) => object|boolean|null,
 *   recordTerminalError?: (info: { sprintId: string, childPid: number|null, env: NodeJS.ProcessEnv, logger: object }) => void,
 *   recordFinished?: (info: { sprintId: string, state: object|null, env: NodeJS.ProcessEnv, logger: object, history: object|null }) => void,
 *   history?: { record: (entry: object) => Promise<object> },
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
    // (apra-fleet-p2to.3.1) Only ever consulted when probeHttp above already
    // confirmed the child is reachable -- see classifySprint()'s pidAlive
    // branch below. Injectable so a test can drive a deterministic 'paused'/
    // 'pausing'/'none'/null value without a real child HTTP server.
    const probePauseState = deps.probePauseState ?? probeChildPauseStatus;
    // apra-fleet-k7b.2: resolves by run-id first, falling back to the
    // reservation's own recorded `branch` (ledger.mjs's Reservation.branch,
    // legacy pre-run-id lookup key) ONLY when the run-id lookup misses; see
    // defaultHasTerminalState()'s doc comment. Returns the PARSED terminal
    // state (or `null`), not a boolean, so classifySprint() below can copy
    // terminalReason/verdict verbatim -- injected test doubles that return a
    // plain boolean keep working since only truthiness is checked before
    // this value is passed on for (best-effort) field reads.
    const hasTerminalState = deps.hasTerminalState
        ?? ((sprintId, branch) => defaultHasTerminalState(sprintId, branch, env));
    // apra-fleet-eft.20.3: the CRASHED-transition recorder (log line + a
    // persisted failed/lastError in the sprint's running/ state file, see
    // defaultRecordTerminalError above). Injectable so a test can assert on a
    // spy instead of the real fs/logger.
    const recordTerminalError = deps.recordTerminalError ?? defaultRecordTerminalError;
    // apra-fleet-k7b.2: the FINISHED-transition recorder (log line + optional
    // sprint-history.json FINISHED event, see defaultRecordFinished above).
    // Same injectable-for-tests discipline as recordTerminalError.
    const recordFinished = deps.recordFinished ?? defaultRecordFinished;
    // apra-fleet-k7b.2: optional durable history log (bin/serve.mjs wires the
    // real createHistory() instance in); when absent, defaultRecordFinished
    // still logs the watchdog line, it just skips the sprint-history.json
    // event -- classification itself must never depend on history being
    // wired.
    const history = deps.history ?? null;
    const intervalMs = Number.isInteger(deps.intervalMs) && deps.intervalMs > 0
        ? deps.intervalMs
        : WATCHDOG_DEFAULT_INTERVAL_MS;
    const launchFailedWindowMs = Number.isInteger(deps.launchFailedWindowMs) && deps.launchFailedWindowMs > 0
        ? deps.launchFailedWindowMs
        : WATCHDOG_DEFAULT_LAUNCH_FAILED_WINDOW_MS;
    const setIntervalFn = deps.setIntervalFn ?? setInterval;
    const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
    // apra-fleet-k7b.2: ISO-timestamp-prefix every log line from this module.
    const logger = withTimestamps(deps.logger ?? console);
    const logError = (...a) => (logger.error ?? logger.log)?.(...a);
    const log = (...a) => (logger.log ?? logger.error)?.(...a);

    /** Latest classification snapshot, refreshed each interval tick. */
    let snapshot = [];
    /** @type {ReturnType<typeof setInterval>|null} */
    let timer = null;
    // apra-fleet-eft.4.9: reentrancy guard for the setInterval-triggered
    // classifyAll() below. classifyAll() does blocking per-sprint spawnSync
    // cmdline reads plus ~1.5s HTTP liveness probes per sprint, so with
    // several tracked sprints a single tick can exceed intervalMs and the
    // NEXT tick can fire while the previous classifyAll() promise is still
    // unresolved. Two overlapping classifyAll() runs both mutate the shared
    // recordedCrashes/recordedFinishes/recordedLaunchFailures sets and can
    // both race to write the same sprint's persisted state file
    // (recordTerminalError/recordFinished), so a tick that fires while the
    // prior one is still in flight is skipped here rather than allowed to
    // start a second, overlapping classifyAll() run. This flag guards ONLY
    // the interval-triggered path below -- a direct classifyAll() call (e.g.
    // start()'s initial prime, or a test/consumer calling it explicitly)
    // is never blocked by it.
    let intervalClassifyInFlight = false;
    // Sprint ids the CRASHED recorder has already fired for, so a wedged
    // ledger entry that stays CRASHED across many interval ticks gets
    // exactly ONE terminal-error log line + state write, not one per tick.
    // Scoped to this watchdog instance/process lifetime -- a supervisor
    // restart is itself a fresh watchdog instance, and by then the sprint's
    // running/ state file already carries the persisted failed/lastError
    // from before the restart, so there is nothing to re-report.
    const recordedCrashes = new Set();
    // apra-fleet-k7b.2: same one-shot-per-sprint-per-instance discipline as
    // recordedCrashes above, but for the FINISHED transition -- without this
    // guard classifySprint() running on every interval tick would append a
    // fresh FINISHED event to sprint-history.json every tick for as long as
    // the ledger keeps listing that (still-reserved-until-released) sprint.
    const recordedFinishes = new Set();
    // apra-fleet-gey.1: sprint ids for which we've recorded a launch-failed
    // event, using the same one-shot discipline as recordedCrashes/recordedFinishes
    // to avoid duplicate history entries on repeat ticks.
    const recordedLaunchFailures = new Set();

    /**
     * apra-fleet-gey.1: detects if a sprint exited within the launch-failed window
     * (i.e., very quickly after being reserved, with no terminal state recorded).
     * Returns true only if we have reliable evidence that the child exited
     * within the window AND that the child actually ran for a non-zero time.
     * @param {object} entry - the ledger entry
     * @returns {boolean}
     */
    function isLaunchFailed(entry) {
        // Must have exit info recorded (in-memory listener was not severed by restart)
        if (!entry.exitedAt) return false;
        // Must have reservation claim time
        if (!entry.reservedAt) return false;
        // Calculate how long the sprint ran
        const exitedMs = new Date(entry.exitedAt).getTime();
        const reservedMs = new Date(entry.reservedAt).getTime();
        if (!Number.isFinite(exitedMs) || !Number.isFinite(reservedMs)) return false;
        const runTimeMs = Math.max(0, exitedMs - reservedMs);
        // True if the child exited within the launch window AND ran for at least
        // 1ms (to distinguish real fast exits from test artifacts where
        // reservedAt == exitedAt)
        return runTimeMs > 0 && runTimeMs < launchFailedWindowMs;
    }

    /**
     * apra-fleet-0j1 / apra-fleet-cvb.1: release a still-held reservation the
     * moment its sprint is classified CRASHED or FINISHED, mirroring what
     * reconcile()'s restart-time sweep and forceRelease()'s operator-initiated
     * teardown already do (src/supervisor/reconcile.mjs) -- same
     * `ledger.release(sprintId)` call, just invoked continuously from this
     * loop instead of once at startup / on-demand. This does NOT touch
     * classification itself: it only runs AFTER classifySprint() has already
     * decided CRASHED/FINISHED below.
     *
     * Idempotent by construction: `ledger.release()` deletes the whole entry
     * and returns `false` (a no-op) when nothing is held, so calling this on
     * every interval tick for a sprint that reconcile(), an operator's
     * force-release, or this SAME function on a prior tick already released
     * is always safe -- the audit log line / history event below fire only
     * on the tick that ACTUALLY performs the release.
     *
     * A `ledger` collaborator without a `release()` method (e.g. a minimal
     * test double exposing only `list()`, as most of this module's existing
     * tests inject) is treated as "release not supported here" and silently
     * skipped -- never an error, since createWatchdog()'s own required
     * interface has always been `list()` alone; requiring more of every
     * existing injected fake would be an (out-of-scope) breaking change to
     * this module's test seam.
     * @param {string} sprintId
     * @param {'crashed'|'finished'} status
     * @param {string} detail
     */
    async function releaseTerminalReservation(sprintId, status, detail) {
        if (typeof ledger.release !== 'function') return;
        const entry = typeof ledger.get === 'function' ? ledger.get(sprintId) : undefined;
        const members = entry?.members ?? [];
        const issueRoots = entry?.issueRoots ?? [];
        let released = false;
        try {
            released = await ledger.release(sprintId);
        } catch (err) {
            logError(`[watchdog] ledger.release failed for '${sprintId}':`, err);
            return;
        }
        if (!released) return; // already released (reconcile, force-release, or a prior tick) -- nothing to report
        // Same "[<module>] <what happened>" shape reconcile()'s own restart
        // audit line uses ("[reconcile] restart: released N dead, retained M
        // live"), so an operator watching the log sees WHY a reservation
        // cleared regardless of which of the three release paths did it.
        log(`[watchdog] auto-released reservation for '${sprintId}' (status=${status}, ${detail})`);
        if (!history || typeof history.record !== 'function') return;
        try {
            const result = history.record({
                sprintId,
                event: HISTORY_EVENTS.AUTO_RELEASED,
                reason: `watchdog: classified ${status} (${detail})`,
                members,
                issueRoots,
            });
            // history.record() is async; a rejection must never take the
            // classifier down with it, same discipline as recordFinished's
            // history call above.
            if (result && typeof result.catch === 'function') {
                result.catch((err) => logError(`[watchdog] history.record(AUTO_RELEASED) failed for '${sprintId}':`, err));
            }
        } catch (err) {
            logError(`[watchdog] history.record(AUTO_RELEASED) failed for '${sprintId}':`, err);
        }
    }

    /**
     * Classify a SINGLE ledger entry into exactly one of the six statuses.
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

        const pidAlive = childPid != null && (await isChildAlive(childPid, marker));

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
            // (apra-fleet-p2to.3.1) Only consult the pause-state probe once
            // HTTP is already known reachable -- an unresponsive child cannot
            // be asked anything, so it stays running-unresponsive exactly as
            // before this probe existed. A live, HTTP-reachable child the
            // engine has actually engaged a pause on (state.pause.status ===
            // 'paused', NOT the deferred 'pausing') is classified PAUSED
            // instead of running-healthy -- still a live, non-terminal
            // status, so it falls through the same "pidAlive" branch as
            // running-healthy/running-unresponsive and is NEVER routed
            // through releaseTerminalReservation() below (that only runs in
            // the PID-gone branch).
            let pauseStatus = null;
            if (httpOk && Number.isInteger(port)) {
                try {
                    pauseStatus = await probePauseState(port);
                } catch {
                    pauseStatus = null;
                }
            }
            const status = pauseStatus === 'paused'
                ? WATCHDOG_STATUS.PAUSED
                : (httpOk ? WATCHDOG_STATUS.RUNNING_HEALTHY : WATCHDOG_STATUS.RUNNING_UNRESPONSIVE);
            return {
                sprintId,
                status,
                pidAlive: true,
                httpOk,
                childPid,
                port,
                ...(pauseStatus ? { pauseStatus } : {}),
            };
        }

        // PID gone: a persisted terminal state in old_runs/ (or legacy
        // old_sprints/) means it FINISHED; its absence means either CRASHED
        // or LAUNCH_FAILED (both died without recording a terminal state).
        //
        // apra-fleet-k7b.3: `detail` reports whatever this SAME instance's
        // spawner actually witnessed (ledger.recordExit(), see spawner.mjs/
        // bin/serve.mjs's wiring) -- e.g. "exited 1 at ..." -- falling back to
        // the previous bare "pid gone" when nothing was recorded (a restart
        // severed the in-memory exit listener before this instance ever saw
        // the child exit; see this module's file-level doc comment).
        const detail = formatExitDetail(entry);
        // apra-fleet-k7b.2: resolves by run-id first, falling back to this
        // reservation's own recorded `branch` for a pre-k7b.1 reservation
        // (see defaultHasTerminalState()'s doc comment). Returns the parsed
        // terminal state object (or `null`/falsy for an injected boolean
        // test double), never just a boolean.
        const terminalState = hasTerminalState(sprintId, entry.branch ?? null);
        const finished = Boolean(terminalState);

        // apra-fleet-gey.1: determine if this is a launch-failed sprint
        // (exited within the launch window with no terminal state).
        const launchFailed = !finished && isLaunchFailed(entry);
        const classifiedStatus = finished ? WATCHDOG_STATUS.FINISHED : (launchFailed ? WATCHDOG_STATUS.LAUNCH_FAILED : WATCHDOG_STATUS.CRASHED);

        if (!finished) {
            if (launchFailed) {
                // apra-fleet-gey.1: record the launch-failed event once per sprint
                if (!recordedLaunchFailures.has(sprintId)) {
                    recordedLaunchFailures.add(sprintId);
                    if (history && typeof history.record === 'function') {
                        try {
                            const result = history.record({
                                sprintId,
                                event: HISTORY_EVENTS.LAUNCH_FAILED,
                                reason: `watchdog: child exited within launch window (${detail})`,
                            });
                            // history.record() is async; rejection must never take
                            // classification down with it, same discipline as other
                            // history recorders.
                            if (result && typeof result.catch === 'function') {
                                result.catch((err) => logError(`[watchdog] history.record(LAUNCH_FAILED) failed for '${sprintId}':`, err));
                            }
                        } catch (err) {
                            logError(`[watchdog] history.record(LAUNCH_FAILED) threw for '${sprintId}':`, err);
                        }
                    }
                    log(`[watchdog] LAUNCH_FAILED: Sprint '${sprintId}' exited within launch window (${detail}).`);
                }
            } else {
                // apra-fleet-eft.20.3: this is the silent-death case the
                // apra-fleet-eft.20 smoke test exposed -- a doer/orchestrator
                // child died mid-Develop with zero diagnostic signal anywhere.
                // Make it observable the FIRST time this sprint is classified
                // CRASHED: an explicit log line, plus a persisted failed/lastError
                // written into its own running/ state file.
                if (!recordedCrashes.has(sprintId)) {
                    recordedCrashes.add(sprintId);
                    try {
                        recordTerminalError({ sprintId, childPid, env, logger, detail });
                    } catch (err) {
                        // The recorder itself must never take the classifier down
                        // with it -- classification (the watchdog's core contract)
                        // must keep proceeding even if diagnostics reporting fails.
                        logError(`[watchdog] recordTerminalError threw for '${sprintId}':`, err);
                    }
                }
            }
        } else if (!recordedFinishes.has(sprintId)) {
            // apra-fleet-k7b.2: the FIRST time this sprint is classified
            // FINISHED, log + (best-effort) record the engine's own
            // terminalReason/verdict verbatim -- gated exactly like
            // recordedCrashes above so a still-reserved (until released)
            // finished sprint does not append a fresh history event on every
            // subsequent interval tick.
            recordedFinishes.add(sprintId);
            try {
                recordFinished({ sprintId, state: terminalState, env, logger, history });
            } catch (err) {
                logError(`[watchdog] recordFinished threw for '${sprintId}':`, err);
            }
        }
        // apra-fleet-0j1 / apra-fleet-cvb.1: act on the classification just
        // made (CRASHED or FINISHED or LAUNCH_FAILED, any terminal state
        // classification means a still-reserved sprint's reservation is stale)
        // -- run on EVERY tick, not gated by recordedCrashes/recordedFinishes
        // above, since ledger.release() is itself idempotent (a no-op once
        // released) and this is what makes a sprint's reservation clear within
        // one watchdog poll interval of it going CRASHED/FINISHED/LAUNCH_FAILED,
        // with no operator action or restart needed.
        try {
            await releaseTerminalReservation(sprintId, classifiedStatus, detail);
        } catch (err) {
            logError(`[watchdog] releaseTerminalReservation threw for '${sprintId}':`, err);
        }
        return {
            sprintId,
            status: classifiedStatus,
            pidAlive: false,
            httpOk: false,
            childPid,
            port,
            detail,
            // apra-fleet-k7b.2: only populated when finished === true;
            // undefined (not null) for CRASHED/LAUNCH_FAILED so existing assertions
            // on the classifier's return shape for the crashed/running paths are
            // unaffected.
            ...(finished ? { terminalState } : {}),
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
                // apra-fleet-eft.4.9: skip this tick if the previous
                // interval-triggered classifyAll() has not resolved yet, so
                // overlapping runs never race on recordedCrashes/
                // recordedFinishes/recordedLaunchFailures or interleave
                // their state-file writes. The `finally` always clears the
                // flag -- even a classifyAll() rejection (already caught
                // below) or a thrown error unlocks the NEXT tick.
                if (intervalClassifyInFlight) {
                    log('[watchdog] tick skipped: previous classifyAll() still in flight');
                    return;
                }
                intervalClassifyInFlight = true;
                classifyAll()
                    .catch((err) => logError('[watchdog] interval classify failed:', err))
                    .finally(() => { intervalClassifyInFlight = false; });
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
