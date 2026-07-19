// =============================================================================
// Auto-sprint supervisor -- restart re-adoption of live children by PID
// (apra-fleet-eft.4.5, Plan Part 2.2, pairs with eft.5.4's restart reconciler)
// =============================================================================
//
// eft.5.4's reconciler (./reconcile.mjs) already does the PID-probe pass on
// every restart: a DEAD ledger entry releases both reservation axes and is
// marked aborted-by-restart, while a LIVE entry is left untouched in the
// ledger for re-adoption. This module is that re-adoption: it drives the
// reconciler, then for every retained (still-live) sprint recovers the
// child's --viewer-port -- the ONE piece of state the ledger deliberately
// does NOT persist (see ledger.mjs's Reservation typedef and spawner.mjs's
// own doc comment) -- by reading the live process's own command line and
// registering it with the spawner seam.
//
// That registration is what makes a re-adopted child "tracked" in exactly the
// same sense as a freshly-spawned one: spawner.getLiveEntry(pid) now resolves
// its port, so the watchdog (eft.4.3) can HTTP-probe it and the sprints API
// (eft.4.4, GET /api/sprints) can proxy its live `/state`.
//
// Confirmed scope (per the task): detach-and-PID-readopt only. Sprints do NOT
// need to survive a machine restart (only a supervisor-process restart), and
// there is no IPC and no journal/replay productization -- re-adoption reads
// ONLY the persisted ledger plus PID probing (via the reconciler) plus a
// best-effort read of the live process's own command line.
// =============================================================================

import { readProcessCmdline } from './watchdog.mjs';

/**
 * Extracts the `--viewer-port <N>` value from a process command line string
 * (as produced by readProcessCmdline()). Returns `null` when the flag is
 * absent, malformed, or the parsed value is not a valid TCP port -- callers
 * treat `null` as "port could not be recovered", never as port 0/falsy.
 * @param {string|null} cmdline
 * @returns {number|null}
 */
export function parseViewerPortFromCmdline(cmdline) {
    if (typeof cmdline !== 'string' || cmdline.length === 0) return null;
    const match = cmdline.match(/--viewer-port[\s=]+(\d+)/);
    if (!match) return null;
    const port = Number(match[1]);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/**
 * Creates the restart re-adopter. Every collaborator is injected so a test
 * can drive deterministic PID/cmdline signals without real processes.
 *
 * @param {{
 *   ledger: { get: (sprintId: string) => { childPid: number|null }|undefined },
 *   spawner: { adopt: (pid: number, port: number) => void },
 *   reconciler: { reconcile: () => Promise<{ released: string[], retained: string[] }> },
 *   readCmdline?: (pid: number) => string|null,
 *   logger?: { log?: Function, warn?: Function, error?: Function },
 * }} deps
 * @returns {{
 *   name: string,
 *   readopt(): Promise<{ released: string[], retained: string[], adopted: Array<{ sprintId: string, childPid: number, port: number }>, unresolved: string[] }>,
 * }}
 */
export function createReadopter(deps = {}) {
    const ledger = deps.ledger;
    const spawner = deps.spawner;
    const reconciler = deps.reconciler;
    if (!ledger || typeof ledger.get !== 'function') {
        throw new TypeError('createReadopter requires a ledger with a get() method');
    }
    if (!spawner || typeof spawner.adopt !== 'function') {
        throw new TypeError('createReadopter requires a spawner with an adopt() method');
    }
    if (!reconciler || typeof reconciler.reconcile !== 'function') {
        throw new TypeError('createReadopter requires a reconciler with a reconcile() method');
    }
    const readCmdline = deps.readCmdline ?? readProcessCmdline;
    const logger = deps.logger ?? console;
    const log = (...a) => logger.log?.(...a);
    const logWarn = (...a) => (logger.warn ?? logger.log)?.(...a);

    /**
     * Runs the full restart re-adoption pass, ONCE, at supervisor startup:
     *   1. Drive eft.5.4's reconciler -- dead entries release both axes and
     *      are marked aborted-by-restart; live entries are retained as-is.
     *   2. For every retained (live) sprint, recover its --viewer-port from
     *      the live process's own command line and register it with the
     *      spawner so the sprint is tracked/watchdog-monitored/HTTP-proxyable
     *      exactly like a freshly-spawned child.
     * A live sprint whose port cannot be recovered (unreadable cmdline, e.g.
     * no /proc on this platform, or a permission error) is left retained in
     * the ledger -- it is still counted live for the purpose of NOT auto-
     * aborting it -- but is reported back as `unresolved` rather than thrown,
     * since a best-effort port-recovery failure must never crash startup or
     * silently drop the reservation.
     * @returns {Promise<{ released: string[], retained: string[], adopted: Array<object>, unresolved: string[] }>}
     */
    async function readopt() {
        const { released, retained } = await reconciler.reconcile();

        const adopted = [];
        const unresolved = [];
        for (const sprintId of retained) {
            const entry = ledger.get(sprintId);
            const pid = entry?.childPid ?? null;
            if (pid == null) {
                logWarn(`[readopt] restart: live sprint '${sprintId}' has no recorded childPid -- cannot re-adopt.`);
                unresolved.push(sprintId);
                continue;
            }
            const cmdline = readCmdline(pid);
            const port = parseViewerPortFromCmdline(cmdline);
            if (port == null) {
                logWarn(
                    `[readopt] restart: could not recover --viewer-port for re-adopted sprint '${sprintId}' `
                    + `(pid ${pid}) from its command line -- it stays reserved but is not yet HTTP-proxyable.`,
                );
                unresolved.push(sprintId);
                continue;
            }
            spawner.adopt(pid, port);
            adopted.push({ sprintId, childPid: pid, port });
        }

        log(
            `[readopt] restart: re-adopted ${adopted.length} live sprint(s) by PID `
            + `(${released.length} dead released, ${unresolved.length} live but port-unresolved)`,
        );
        return { released, retained, adopted, unresolved };
    }

    return {
        name: 'readopter',
        readopt,
    };
}
