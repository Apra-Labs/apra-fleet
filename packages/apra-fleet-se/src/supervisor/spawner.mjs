// =============================================================================
// Auto-sprint supervisor -- detached child-per-sprint spawner (apra-fleet-eft.4.2,
// Plan Part 2.1, process model B)
// =============================================================================
//
// Launches each sprint as the EXISTING `bin/cli.mjs` CLI (see its argv contract
// around buildOptionsSpec()/main(), ~line 100-420), as a fully detached, truly
// independently-surviving orphan:
//
//   spawn(command, args, { detached: true, stdio: 'ignore' })  +  child.unref()
//
// There is deliberately NO parent-child IPC channel and NO kill-on-parent-exit
// behavior wired here. On POSIX, `detached: true` gives the child its own
// process group/session, so:
//
//   * killing the supervisor (even SIGKILL) leaves every already-launched
//     child running -- this module never listens for or reacts to the
//     supervisor's own exit;
//   * a crashing/killed child never takes down a sibling child or the
//     supervisor -- each child is spawned independently and this module only
//     tracks its own local bookkeeping (freed on that child's 'exit'), it
//     never propagates one child's failure to another.
//
// This module owns exactly one extra invariant beyond "spawn detached":
// **--viewer-port allocation is unique across every currently-live sprint**.
// The four-status watchdog (eft.4.3), restart re-adoption (eft.4.5), and the
// combined reservation ledger (eft.5, src/supervisor/ledger.mjs) are separate
// concerns and are NOT this module's job -- the ledger, notably, persists
// `childPid` for restart PID-probe reconciliation but does not persist ports,
// so live-port uniqueness is this module's own in-memory bookkeeping for as
// long as this supervisor process has been up.
// =============================================================================

import { spawn as nodeSpawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Default first port tried when allocating a fresh `--viewer-port`. */
export const DEFAULT_SPAWNER_BASE_PORT = 8081;

/**
 * The default service data directory. Overridable via the FLEET_SE_DATA_DIR
 * env var, otherwise `~/.apra-fleet-se`. Mirrors ledger.mjs's/history.mjs's
 * own identically-named helper (each module keeps its own small copy rather
 * than cross-importing one another -- the established convention in this
 * package, see id-allocator.mjs's own copy too).
 * @returns {string}
 */
export function defaultDataDir() {
    return process.env.FLEET_SE_DATA_DIR
        ? path.resolve(process.env.FLEET_SE_DATA_DIR)
        : path.join(os.homedir(), '.apra-fleet-se');
}

/** Subdirectory (under the SE data dir) that per-sprint raw stdout/stderr log files live in. */
export const SPRINT_LOG_SUBDIR = 'logs';

/**
 * apra-fleet-ou7.1: builds the per-sprint raw stdout/stderr log file path
 * (`<dataDir>/logs/<stem>.log`) a spawned child's stdio is teed to for its
 * whole lifetime, including after a crash (spawnSprint() below opens this
 * BEFORE spawning and hands the fd directly to the child, so a Node-level
 * buffered stream is never in the way of capturing a crash's last output).
 *
 * `stem` is sanitized to the same shell/filesystem-safe character class
 * fleet-sprint/runner.js's ISSUE_ID_PATTERN already uses for issue ids
 * (letters, digits, '.', '_', '-') so a caller-supplied runId can never
 * escape the logs directory (no '/', '\\', or '..' path-traversal) and never
 * needs any extra shell quoting.
 * @param {string} dataDir
 * @param {string} stem - typically the sprint's runId; sanitized before use
 * @returns {string}
 */
export function resolveSprintLogPath(dataDir, stem) {
    const safeStem = String(stem ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
    const fileName = `${safeStem.length > 0 ? safeStem : 'sprint'}.log`;
    // Defense in depth: even after sanitizing, refuse anything that is not
    // a single plain filename (e.g. a sanitized-to-'..'-only stem).
    if (fileName !== path.basename(fileName) || fileName === '.log') {
        throw new Error(`[spawner] refusing to build an unsafe sprint log file name from stem '${stem}'`);
    }
    return path.join(dataDir, SPRINT_LOG_SUBDIR, fileName);
}

/**
 * Resolves the on-disk path to `bin/cli.mjs`, the existing per-sprint CLI this
 * spawner launches. Relative to this file's own package tree
 * (src/supervisor/spawner.mjs -> ../../bin/cli.mjs), matching the layout
 * convention already used by cli.mjs's own resolveRunnerScriptPath().
 * @param {{ dirname?: string }} [deps]
 * @returns {string}
 */
export function defaultCliPath(deps = {}) {
    const dirname = deps.dirname || __dirname;
    return path.join(dirname, '../../bin/cli.mjs');
}

/**
 * Checks whether a TCP port is currently free by actually attempting to bind
 * it (not just consulting in-memory bookkeeping) -- so allocation reflects
 * real OS-level availability, not just what this supervisor process itself
 * has handed out.
 *
 * The real viewer binds the wildcard address (`server.listen(port, cb)`, no
 * host -- see apra-fleet-workflow/src/viewer/index.mjs). On Windows, a
 * loopback-only bind and a pre-existing wildcard bind on the same port can
 * coexist without either side erroring, so a plain `host` bind-test alone
 * can report a port "free" when a real viewer already owns it via a
 * wildcard bind -- allocateFreePort would then hand that port to a second
 * process, and inbound connections would silently split between the two.
 *
 * This is deliberately NOT fixed by making the probe itself bind the
 * wildcard address: doing so opens this process up to inbound connections
 * from every interface, which triggers an interactive Windows Firewall
 * "allow this app" prompt on first use per port -- and in a headless/CI
 * run nothing ever dismisses that prompt, so the bind call hangs
 * indefinitely (confirmed directly: a wildcard-bind probe stalled a real
 * test run with zero CPU progress). Instead, first try to CONNECT to
 * `host` -- a connect (never a bind) never triggers that firewall prompt,
 * and it reaches a wildcard-bound listener just as reliably as a
 * loopback-only one, since either accepts loopback connections. Only if
 * nothing answers do we fall back to the original bind test, which still
 * catches a same-host bind conflict a connect probe alone cannot (e.g. a
 * listener that accepted the socket but is slow to respond).
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<boolean>}
 */
export function isPortAvailable(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
        const probe = net.connect({ port, host });
        const onOccupied = () => { probe.destroy(); resolve(false); };
        probe.once('connect', onOccupied);
        probe.once('error', () => {
            probe.destroy();
            const tester = net.createServer();
            tester.unref();
            tester.once('error', () => resolve(false));
            tester.listen({ port, host, exclusive: true }, () => {
                tester.close(() => resolve(true));
            });
        });
    });
}

/**
 * Finds the lowest free port at or above `startPort`, skipping any port in
 * `excludedPorts` (the set of ports already handed to other LIVE sprints by
 * this supervisor) and any port the OS reports as unavailable. This is the
 * mechanism behind the acceptance criterion "port allocation never hands the
 * same port to two live sprints": excludedPorts is the live set at call time,
 * re-checked against the OS so a port that some unrelated process is already
 * using is also skipped.
 * @param {{
 *   startPort?: number,
 *   maxAttempts?: number,
 *   excludedPorts?: Set<number>|number[],
 *   isAvailable?: (port: number) => Promise<boolean>,
 * }} [opts]
 * @returns {Promise<number>}
 */
export async function allocateFreePort(opts = {}) {
    const startPort = Number.isInteger(opts.startPort) ? opts.startPort : DEFAULT_SPAWNER_BASE_PORT;
    const maxAttempts = Number.isInteger(opts.maxAttempts) ? opts.maxAttempts : 1000;
    const excluded = opts.excludedPorts instanceof Set ? opts.excludedPorts : new Set(opts.excludedPorts || []);
    const isAvailable = opts.isAvailable || isPortAvailable;

    for (let i = 0; i < maxAttempts; i++) {
        const candidate = startPort + i;
        if (candidate > 65535) break;
        if (excluded.has(candidate)) continue;
        // eslint-disable-next-line no-await-in-loop -- sequential probing is intentional: we want the LOWEST free port, and each check is cheap.
        if (await isAvailable(candidate)) return candidate;
    }
    throw new Error(
        `[spawner] no free --viewer-port found in [${startPort}, ${startPort + maxAttempts}) ` +
            `(excluding ${excluded.size} port(s) already held by live sprints)`,
    );
}

/**
 * Builds the cli.mjs argv (everything after the script path) for one sprint
 * launch, given the already-allocated `viewerPort`. Pulled into its own pure
 * function so a test can assert the exact flags reach cli.mjs without
 * spawning a real process, matching cli.mjs's own buildRunnerArgs() pattern.
 * @param {{
 *   issue: string, members: string, branch: string, base: string,
 *   goal?: string, maxCycles?: number|string, allowMissingMembers?: boolean,
 *   requirementsFile?: string, roleMap?: object|string, budget?: number|string,
 *   viewerPort: number, serviceUrl?: string, runId?: string, extraArgs?: string[],
 * }} opts
 * @returns {string[]}
 */
export function buildSprintArgv(opts = {}) {
    const { issue, members, branch, base, goal, maxCycles, allowMissingMembers,
        requirementsFile, roleMap, budget, viewerPort, serviceUrl, runId, extraArgs } = opts;

    if (!issue || !members || !branch || !base) {
        throw new Error('buildSprintArgv requires issue, members, branch, and base');
    }
    if (!Number.isInteger(viewerPort) || viewerPort <= 0 || viewerPort > 65535) {
        throw new Error('buildSprintArgv requires an integer viewerPort in [1, 65535]');
    }

    const args = [
        '--issue', issue,
        '--members', members,
        '--branch', branch,
        '--base', base,
        '--viewer-port', String(viewerPort),
    ];
    if (goal !== undefined) args.push('--goal', goal);
    if (maxCycles !== undefined) args.push('--max-cycles', String(maxCycles));
    if (allowMissingMembers) args.push('--allow-missing-members');
    if (requirementsFile !== undefined) args.push('--requirements-file', requirementsFile);
    if (roleMap !== undefined) {
        args.push('--role-map', typeof roleMap === 'string' ? roleMap : JSON.stringify(roleMap));
    }
    if (budget !== undefined) args.push('--budget', String(budget));
    // apra-fleet-f34.1: when this supervisor instance has a known --service-url
    // (its own HTTP listen address, wired in from createSpawner()'s deps.serviceUrl
    // below), forward it so the spawned cli.mjs child threads it into
    // runner.js's HTTP-backed dolt-mutex/id-allocator clients instead of the
    // source-3 no-op fallback. Absent a configured serviceUrl this is omitted
    // entirely -- fallback behavior is unchanged.
    if (serviceUrl !== undefined) args.push('--service-url', serviceUrl);
    // apra-fleet-k7b.1: the supervisor's own sprintId (its ledger reservation
    // key) forwarded as this child's --run-id, so the engine's run-state
    // (running/<runId>.json -> old_runs/<runId>.json, apra-fleet-workflow's
    // viewer) and the dashboard viewer's identity are keyed by the SAME
    // incarnation-unique id the supervisor already uses -- not the sprint
    // branch name, which is reused across relaunches on the same branch and
    // would otherwise silently overwrite prior run history. Omitted here (a
    // direct/standalone CLI launch never goes through this spawner) means
    // cli.mjs falls back to the branch name itself.
    if (runId !== undefined) args.push('--run-id', runId);
    if (Array.isArray(extraArgs)) args.push(...extraArgs);
    return args;
}

/**
 * Creates the spawner seam (see src/supervisor/server.mjs's seam docs). Not
 * started until `start()` is called (a no-op here -- there is no persistent
 * state to load; the ledger owns that). `stop()` deliberately never kills any
 * live child: it only clears this process's own local bookkeeping.
 *
 * @param {{
 *   basePort?: number,
 *   command?: string,
 *   cliPath?: string,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   spawn?: typeof import('node:child_process').spawn,
 *   isPortAvailable?: (port: number) => Promise<boolean>,
 *   logger?: { log?: Function, error?: Function },
 *   serviceUrl?: string,
 *   onChildExit?: (info: { pid: number, runId: string|null, exitCode: number|null, signal: string|null, at: string, logPath: string }) => void,
 *   now?: () => string,
 *   dataDir?: string,
 *   fs?: {
 *     mkdirSync: typeof import('node:fs').mkdirSync,
 *     openSync: typeof import('node:fs').openSync,
 *     closeSync: typeof import('node:fs').closeSync,
 *   },
 * }} [deps]
 * @returns {{
 *   name: string,
 *   start(): Promise<void>,
 *   stop(): Promise<void>,
 *   spawnSprint(opts: object): Promise<{ pid: number, port: number, command: string, args: string[], logPath: string }>,
 *   liveCount: number,
 *   livePorts: Set<number>,
 *   getLiveEntry(pid: number): { port: number, child: object, logPath: string }|undefined,
 * }}
 */
export function createSpawner(deps = {}) {
    const logger = deps.logger ?? console;
    const logError = (...a) => (logger.error ?? logger.log)?.(...a);
    const spawnImpl = deps.spawn ?? nodeSpawn;
    const isAvailable = deps.isPortAvailable ?? isPortAvailable;
    const basePort = Number.isInteger(deps.basePort) ? deps.basePort : DEFAULT_SPAWNER_BASE_PORT;
    // apra-fleet-ou7.1: where per-sprint raw stdout/stderr log files live
    // (<dataDir>/logs/<stem>.log, resolveSprintLogPath() above). Injectable
    // fs so a test can drive a temp dir/fake fs without touching real disk.
    const dataDir = deps.dataDir ?? defaultDataDir();
    const fsImpl = deps.fs ?? fs;
    const command = deps.command ?? process.execPath;
    const cliPath = deps.cliPath ?? defaultCliPath();
    // apra-fleet-f34.1: the supervisor's OWN HTTP listen address (e.g.
    // `http://localhost:8787`), the same address it already binds for its
    // dolt-mutex/id-allocator/sprint-control API. Threaded into every spawned
    // child's `--service-url` (see buildSprintArgv above) so runner.js takes
    // the HTTP-backed dolt-mutex/id-allocator clients instead of the source-3
    // no-op fallback. Optional: when the caller (bin/serve.mjs) does not pass
    // one, spawned children simply omit --service-url and fall back exactly
    // as before -- no crash, unchanged behavior.
    const serviceUrl = deps.serviceUrl;
    // apra-fleet-k7b.3: optional same-instance child-exit notification (see
    // the 'exit' listener below) and its injectable clock (test determinism,
    // matching ledger.mjs/history.mjs's own `now` seam convention).
    const onChildExit = deps.onChildExit;
    const nowFn = deps.now ?? (() => new Date().toISOString());

    /**
     * Live sprints launched BY THIS supervisor process, keyed by child pid.
     * This is only ever used to keep --viewer-port allocation unique within
     * this process's lifetime; it is NOT the durable source of truth (that is
     * eft.5's ledger, re-adopted across restarts by eft.4.5).
     * @type {Map<number, { port: number, child: import('node:child_process').ChildProcess, logPath: string }>}
     */
    const live = new Map();

    function livePortSet() {
        return new Set(Array.from(live.values(), (entry) => entry.port));
    }

    /**
     * Spawns one sprint as a detached `bin/cli.mjs` child with a freshly
     * allocated, currently-unique `--viewer-port`.
     *
     * apra-fleet-ou7.1: the child's stdout+stderr are teed to a per-sprint
     * raw log file (resolveSprintLogPath()) instead of `stdio: 'ignore'` --
     * opened BEFORE spawning and handed to the child as a real fd (not a
     * Node stream), so raw output is captured for the sprint's WHOLE
     * lifetime, including whatever it wrote right before a crash. The
     * file's own fd is a plain OS-level dup once spawn() hands it to the
     * child, so this process's copy is safe to close the moment the child
     * itself exits (or immediately, if spawn/the pid check fails) without
     * losing anything the child is still writing.
     * @param {object} opts - the sprint's cli.mjs flags (issue, members, branch, base, ...)
     * @returns {Promise<{ pid: number, port: number, command: string, args: string[], logPath: string }>}
     */
    async function spawnSprint(opts = {}) {
        const port = await allocateFreePort({ startPort: basePort, excludedPorts: livePortSet(), isAvailable });
        const args = [cliPath, ...buildSprintArgv({ ...opts, viewerPort: port, serviceUrl: opts.serviceUrl ?? serviceUrl })];

        // apra-fleet-ou7.1: opts.runId is the SAME sprintId createSprintController
        // generates and claims in the ledger BEFORE spawning (apra-fleet-k7b.1) --
        // reused here (not re-derived) so the log file name and the ledger's
        // sprintId key always agree. A direct/standalone spawnSprint() call with
        // no runId (or a test) still gets a unique file via the randomUUID() fallback.
        const logPath = resolveSprintLogPath(dataDir, opts.runId || `direct-${randomUUID()}`);
        fsImpl.mkdirSync(path.dirname(logPath), { recursive: true });
        const logFd = fsImpl.openSync(logPath, 'a');
        let logFdClosed = false;
        const closeLogFd = () => {
            if (logFdClosed) return;
            logFdClosed = true;
            try {
                fsImpl.closeSync(logFd);
            } catch (err) {
                logError(`[spawner] failed to close log fd for '${logPath}':`, err);
            }
        };

        let child;
        try {
            child = spawnImpl(command, args, {
                detached: true,
                stdio: ['ignore', logFd, logFd],
                ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
                ...(deps.env !== undefined ? { env: deps.env } : {}),
            });
        } catch (err) {
            // Spawn itself threw synchronously (e.g. an injected fake spawn in
            // a test) -- our copy of the fd is never handed off, close it now
            // so a failed launch can never leak it.
            closeLogFd();
            throw err;
        }

        if (!child || typeof child.pid !== 'number') {
            closeLogFd();
            throw new Error('[spawner] spawn did not return a pid; sprint child process failed to launch');
        }
        const pid = child.pid;
        live.set(pid, { port, child, logPath });

        // Free this port for reuse and drop local bookkeeping once the child
        // actually exits. This ONLY reacts to the child's own lifecycle --
        // never to the supervisor's, and never to another child's.
        //
        // apra-fleet-k7b.3: also forward the exit code/signal (Node's own
        // 'exit' event args) to the optional onChildExit callback, keyed by
        // this launch's runId (the SAME sprintId createSprintController
        // generates and claims in the ledger BEFORE spawning, apra-fleet-
        // k7b.1) -- NOT re-derived here, so this stays a thin same-instance
        // notification rather than owning ledger/history persistence itself
        // (bin/serve.mjs's wiring does that). A throwing callback must never
        // take down this listener's own bookkeeping cleanup above it.
        //
        // apra-fleet-ou7.1: this is also where the log fd is closed --
        // acceptance criterion "file handles are closed on child exit (no fd
        // leak across many launches)". The child has its own OS-level
        // duplicated descriptor (dup2'd at spawn time), so closing OUR copy
        // here never truncates or loses anything the child wrote, including
        // its very last output before a crash.
        child.once('exit', (code, signal) => {
            live.delete(pid);
            closeLogFd();
            if (typeof onChildExit === 'function') {
                try {
                    // Promise.resolve(...).catch(...) covers BOTH a synchronous
                    // throw and an async callback's rejected promise (bin/
                    // serve.mjs's real wiring is `async`) -- either way this
                    // listener's own bookkeeping cleanup above must never be
                    // affected, and no unhandled rejection should escape.
                    Promise.resolve(onChildExit({
                        pid,
                        runId: opts.runId ?? null,
                        exitCode: code ?? null,
                        signal: signal ?? null,
                        at: nowFn(),
                        logPath,
                    })).catch((err) => {
                        logError(`[spawner] onChildExit callback rejected for pid=${pid}:`, err);
                    });
                } catch (err) {
                    logError(`[spawner] onChildExit callback threw for pid=${pid}:`, err);
                }
            }
        });
        child.once('error', (err) => {
            logError(`[spawner] child pid=${pid} (issue=${opts.issue}) emitted error:`, err);
            live.delete(pid);
            // 'error' can fire instead of, or alongside, 'exit' -- closeLogFd()
            // is idempotent, so whichever fires (or both) closes exactly once.
            closeLogFd();
        });

        // CRITICAL (acceptance criterion): unref() so this child never keeps
        // the supervisor's event loop alive on its account. Combined with
        // `detached: true` (its own process group/session on POSIX), a
        // supervisor SIGKILL/exit can never take this child down with it.
        child.unref();

        return { pid, port, command, args, logPath };
    }

    return {
        name: 'spawner',
        async start() {},
        async stop() {
            // Detached-orphan contract: tearing down the spawner/supervisor
            // must NEVER kill a live sprint child. This only clears local
            // bookkeeping -- the ledger (eft.5) is the durable, restart-
            // surviving record of what is actually still live.
            live.clear();
        },

        spawnSprint,

        /**
         * Registers a RE-ADOPTED child (apra-fleet-eft.4.5): a live process
         * this supervisor instance did not itself spawn -- typically a sprint
         * recovered by PID from the persisted ledger after a supervisor
         * restart, whose --viewer-port has since been recovered from its own
         * command line. This makes the pid known to getLiveEntry()/livePorts
         * for exactly the same reasons a freshly-spawned child is: watchdog
         * HTTP-reachability probing and API port resolution both key off this
         * bookkeeping.
         *
         * There is no ChildProcess handle for a re-adopted pid (this process
         * never spawned it), so unlike spawnSprint() no 'exit'/'error'
         * listener is wired here -- nothing in this process can be notified
         * the moment it exits. The watchdog's own periodic PID-liveness probe
         * is what eventually detects the pid going away; adopt() itself does
         * NOT re-verify liveness (the caller -- eft.4.5's re-adopter -- has
         * already PID-probed via the restart reconciler before calling this).
         * Idempotent: adopting the same pid again simply overwrites its port.
         *
         * apra-fleet-ou7.1: `logPath` is not recovered here (unlike --viewer-
         * port, it is not on the re-adopted child's own command line) --
         * consumers needing it for a re-adopted sprint read it from the
         * ledger's own persisted reservation (recorded at the ORIGINAL
         * claim/spawn, survives the restart), not from this in-memory entry.
         * @param {number} pid
         * @param {number} port
         */
        adopt(pid, port) {
            if (!Number.isInteger(pid) || pid <= 0) {
                throw new TypeError('adopt() requires a positive integer pid');
            }
            if (!Number.isInteger(port) || port <= 0 || port > 65535) {
                throw new TypeError('adopt() requires an integer port in [1, 65535]');
            }
            live.set(pid, { port, child: null, logPath: null });
        },

        /** Number of sprints spawned by this process that haven't exited yet. */
        get liveCount() { return live.size; },
        /** The set of --viewer-port values currently in use by live sprints. */
        get livePorts() { return livePortSet(); },
        /** @param {number} pid */
        getLiveEntry(pid) { return live.get(pid); },
    };
}
