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
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Default first port tried when allocating a fresh `--viewer-port`. */
export const DEFAULT_SPAWNER_BASE_PORT = 8081;

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
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<boolean>}
 */
export function isPortAvailable(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
        const tester = net.createServer();
        tester.unref();
        tester.once('error', () => resolve(false));
        tester.listen({ port, host, exclusive: true }, () => {
            tester.close(() => resolve(true));
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
 *   viewerPort: number, extraArgs?: string[],
 * }} opts
 * @returns {string[]}
 */
export function buildSprintArgv(opts = {}) {
    const { issue, members, branch, base, goal, maxCycles, allowMissingMembers,
        requirementsFile, roleMap, budget, viewerPort, extraArgs } = opts;

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
 * }} [deps]
 * @returns {{
 *   name: string,
 *   start(): Promise<void>,
 *   stop(): Promise<void>,
 *   spawnSprint(opts: object): Promise<{ pid: number, port: number, command: string, args: string[] }>,
 *   liveCount: number,
 *   livePorts: Set<number>,
 *   getLiveEntry(pid: number): { port: number, child: object }|undefined,
 * }}
 */
export function createSpawner(deps = {}) {
    const logger = deps.logger ?? console;
    const logError = (...a) => (logger.error ?? logger.log)?.(...a);
    const spawnImpl = deps.spawn ?? nodeSpawn;
    const isAvailable = deps.isPortAvailable ?? isPortAvailable;
    const basePort = Number.isInteger(deps.basePort) ? deps.basePort : DEFAULT_SPAWNER_BASE_PORT;
    const command = deps.command ?? process.execPath;
    const cliPath = deps.cliPath ?? defaultCliPath();

    /**
     * Live sprints launched BY THIS supervisor process, keyed by child pid.
     * This is only ever used to keep --viewer-port allocation unique within
     * this process's lifetime; it is NOT the durable source of truth (that is
     * eft.5's ledger, re-adopted across restarts by eft.4.5).
     * @type {Map<number, { port: number, child: import('node:child_process').ChildProcess }>}
     */
    const live = new Map();

    function livePortSet() {
        return new Set(Array.from(live.values(), (entry) => entry.port));
    }

    /**
     * Spawns one sprint as a detached `bin/cli.mjs` child with a freshly
     * allocated, currently-unique `--viewer-port`.
     * @param {object} opts - the sprint's cli.mjs flags (issue, members, branch, base, ...)
     * @returns {Promise<{ pid: number, port: number, command: string, args: string[] }>}
     */
    async function spawnSprint(opts = {}) {
        const port = await allocateFreePort({ startPort: basePort, excludedPorts: livePortSet(), isAvailable });
        const args = [cliPath, ...buildSprintArgv({ ...opts, viewerPort: port })];

        const child = spawnImpl(command, args, {
            detached: true,
            stdio: 'ignore',
            ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
            ...(deps.env !== undefined ? { env: deps.env } : {}),
        });

        if (!child || typeof child.pid !== 'number') {
            throw new Error('[spawner] spawn did not return a pid; sprint child process failed to launch');
        }
        const pid = child.pid;
        live.set(pid, { port, child });

        // Free this port for reuse and drop local bookkeeping once the child
        // actually exits. This ONLY reacts to the child's own lifecycle --
        // never to the supervisor's, and never to another child's.
        child.once('exit', () => { live.delete(pid); });
        child.once('error', (err) => {
            logError(`[spawner] child pid=${pid} (issue=${opts.issue}) emitted error:`, err);
            live.delete(pid);
        });

        // CRITICAL (acceptance criterion): unref() so this child never keeps
        // the supervisor's event loop alive on its account. Combined with
        // `detached: true` (its own process group/session on POSIX), a
        // supervisor SIGKILL/exit can never take this child down with it.
        child.unref();

        return { pid, port, command, args };
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
            live.set(pid, { port, child: null });
        },

        /** Number of sprints spawned by this process that haven't exited yet. */
        get liveCount() { return live.size; },
        /** The set of --viewer-port values currently in use by live sprints. */
        get livePorts() { return livePortSet(); },
        /** @param {number} pid */
        getLiveEntry(pid) { return live.get(pid); },
    };
}
