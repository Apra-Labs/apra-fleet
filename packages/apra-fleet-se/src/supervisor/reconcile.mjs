// =============================================================================
// Auto-sprint supervisor -- restart reconciliation + force-release endpoint
// (apra-fleet-eft.5.4, Plan Part 2.2)
// =============================================================================
//
// Two flows that turn a reservation into a durable terminal event:
//
//   1. Restart reconciliation (pairs with eft.4.5 re-adoption). On supervisor
//      restart the ledger is reloaded from disk, but the children it recorded
//      may or may not still be alive. We PID-probe each entry:
//        * a DEAD child releases BOTH axes in ONE atomic write (ledger.release
//          deletes the whole entry -- members AND issueRoots together, never a
//          torn half-release) and its sprint is marked `aborted-by-restart` in
//          the history log;
//        * a LIVE child keeps both axes reserved -- eft.4.5 re-adopts it.
//      An entry with no recorded childPid cannot be probed and so is treated as
//      not-alive: there is no live process to re-adopt, so holding its
//      reservation forever would wedge the scope.
//
//   2. Force-release (POST /api/reservations/:sprintId/force-release) for a
//      wedged reservation an operator needs to tear down by hand. It releases
//      BOTH axes and records who/why in history. An unknown sprint id 404s.
//
// Both flows go through the SAME ledger.release() (one atomic both-axis write)
// and the SAME history log, so the audit trail is uniform.
//
// apra-fleet-3i3.1: force-release now ALSO kills the reservation's still-live
// child (if any) via the injected `killPid` collaborator, in the SAME action
// -- previously an operator had to separately hunt down and kill a wedged
// child by hand after force-releasing its reservation. `killPid` defaults to
// a SAFE NO-OP (kills nothing, always returns false): sending a real
// destructive signal to an arbitrary pid must never be something a caller
// gets by omission. Only bin/serve.mjs's production wiring injects the real
// `killPid` export below (`process.kill(pid, 'SIGKILL')`, guarded), scoped to
// pids the eft.4.2 spawner actually tracks. Every existing/other test that
// constructs createReconciler({ ledger, history }) without injecting killPid
// therefore never sends a real signal, even when a seeded reservation happens
// to carry a low/system-adjacent childPid.
//
// apra-fleet-3i3.3: forceRelease()'s return now ALSO echoes the released
// entry's branch/base/goal (in addition to the members/issueRoots history.
// record() already echoed) -- release() deletes the whole ledger entry, so
// this is the last point they are readable. The Sprint Stack's new Restart
// control (dashboard.mjs) is a client-side, two-step flow: it calls THIS
// same force-release route first, then POSTs the SAME branch/base/goal/
// members/issueRoots straight back to POST /api/sprints to relaunch, without
// a dedicated server-side "restart" endpoint or any new plumbing here. Purely
// additive to forceRelease()'s existing return shape -- every pre-existing
// caller that ignores the new fields is unaffected.
// =============================================================================

import { readJsonBody, sendJson } from './server.mjs';
import { HISTORY_EVENTS } from './history.mjs';

/**
 * Default liveness probe: signal 0 tests for the process's existence without
 * actually delivering a signal. ESRCH => the pid is gone (dead). EPERM => the
 * process exists but we may not signal it (still ALIVE). Any other error is
 * treated conservatively as not-alive.
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        if (err && err.code === 'EPERM') return true;
        return false;
    }
}

/**
 * Real kill-signal implementation: sends `signal` (default SIGKILL, an
 * immediate hard kill -- distinct from the existing cooperative
 * POST /api/sprints/:id/stop proxy, which asks the child's own /stop
 * endpoint to shut down gracefully) to `pid`. ESRCH (already gone) is
 * treated as success -- the goal ("make sure this pid is not running") is
 * already satisfied. Any other failure (e.g. EPERM) returns false rather
 * than throwing, so a kill failure never blocks the reservation release
 * that follows it in forceRelease() below.
 *
 * NOT wired as createReconciler()'s default -- see the module doc above for
 * why an accidental real kill must never happen by omission. Only
 * bin/serve.mjs's production wiring imports and injects this explicitly.
 * @param {number} pid
 * @param {NodeJS.Signals} [signal]
 * @returns {boolean}
 */
export function killPid(pid, signal = 'SIGKILL') {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, signal);
        return true;
    } catch (err) {
        if (err && err.code === 'ESRCH') return true;
        return false;
    }
}

/** Error thrown when a force-release targets a sprint with no live reservation. */
export class SprintNotFoundError extends Error {
    constructor(sprintId) {
        super(`no live reservation for sprint '${sprintId}'`);
        this.name = 'SprintNotFoundError';
        this.code = 'SPRINT_NOT_FOUND';
        this.sprintId = sprintId;
    }
}

/**
 * Create the restart-reconciler / force-release controller.
 *
 * @param {{
 *   ledger: {
 *     list: () => Array<{ sprintId: string, members: string[], issueRoots: string[], childPid: number|null }>,
 *     get: (sprintId: string) => object|undefined,
 *     release: (sprintId: string) => Promise<boolean>,
 *   },
 *   history: { record: (entry: object) => Promise<object> },
 *   isPidAlive?: (pid: number) => boolean,
 *   killPid?: (pid: number) => boolean,
 *   now?: () => string,
 *   logger?: { log?: Function, error?: Function },
 * }} deps
 */
export function createReconciler(deps = {}) {
    const ledger = deps.ledger;
    const history = deps.history;
    if (!ledger || typeof ledger.list !== 'function' || typeof ledger.release !== 'function') {
        throw new TypeError('createReconciler requires a ledger with list()/get()/release()');
    }
    if (!history || typeof history.record !== 'function') {
        throw new TypeError('createReconciler requires a history with record()');
    }
    const probe = deps.isPidAlive ?? isPidAlive;
    // apra-fleet-3i3.1: safe no-op default -- see killPid()'s and the module
    // doc's explanation of why a real kill must be an explicit opt-in, never
    // an accidental default.
    const kill = deps.killPid ?? (() => false);
    const now = deps.now ?? (() => new Date().toISOString());
    const logger = deps.logger ?? console;
    const log = (...a) => logger.log?.(...a);

    /**
     * PID-probe every reloaded ledger entry once, at supervisor restart. Dead
     * children release both axes and are marked aborted-by-restart; live
     * children are retained for eft.4.5 re-adoption.
     * @returns {Promise<{ released: string[], retained: string[] }>}
     */
    async function reconcile() {
        // Snapshot first: ledger.list() returns clones, so releasing during the
        // loop cannot disturb iteration.
        const entries = ledger.list();
        const released = [];
        const retained = [];
        for (const entry of entries) {
            const alive = entry.childPid != null && probe(entry.childPid);
            if (alive) {
                retained.push(entry.sprintId);
                continue;
            }
            // Dead (or unprobeable) child: release BOTH axes in one atomic write.
            // eslint-disable-next-line no-await-in-loop -- releases must be serialized through the ledger's single-writer transaction chain.
            await ledger.release(entry.sprintId);
            // eslint-disable-next-line no-await-in-loop
            await history.record({
                sprintId: entry.sprintId,
                event: HISTORY_EVENTS.ABORTED_BY_RESTART,
                reason: entry.childPid == null
                    ? 'no recorded child pid at supervisor restart'
                    : `child pid ${entry.childPid} not alive at supervisor restart`,
                members: entry.members,
                issueRoots: entry.issueRoots,
                at: now(),
            });
            released.push(entry.sprintId);
        }
        log(`[reconcile] restart: released ${released.length} dead, retained ${retained.length} live`);
        return { released, retained };
    }

    /**
     * Operator force-release of a wedged reservation. apra-fleet-3i3.1: ALSO
     * kills the reservation's still-live child (if any, via the injected
     * `killPid`) in the SAME action, before releasing both axes and
     * recording an audit reason -- a kill failure (or no recorded childPid at
     * all) never blocks the release that follows it. Throws
     * SprintNotFoundError for an unknown sprint.
     * @param {string} sprintId
     * @param {{ by?: string, reason?: string }} [audit]
     * @returns {Promise<object>} the recorded history event, plus `childPid`,
     *   `killed` (whether the kill signal was believed to land; null when
     *   there was no recorded childPid to kill), and (apra-fleet-3i3.3) the
     *   released entry's `branch`/`base`/`goal` (each `null` when the entry
     *   never persisted it -- a pre-3i3.2 legacy entry, or an omitted `goal`)
     */
    async function forceRelease(sprintId, audit = {}) {
        if (typeof sprintId !== 'string' || sprintId.length === 0) {
            throw new TypeError('forceRelease requires a non-empty sprintId');
        }
        const entry = ledger.get(sprintId);
        if (!entry) {
            throw new SprintNotFoundError(sprintId);
        }
        const childPid = entry.childPid ?? null;
        const killed = childPid != null ? kill(childPid) : null;
        // apra-fleet-3i3.3: capture BEFORE release() below deletes the whole
        // entry -- this is the last point these are readable from the ledger.
        const branch = entry.branch ?? null;
        const base = entry.base ?? null;
        const goal = entry.goal ?? null;
        await ledger.release(sprintId);
        const recorded = await history.record({
            sprintId,
            event: HISTORY_EVENTS.FORCE_RELEASED,
            reason: audit.reason ?? 'force-released by operator',
            by: audit.by ?? null,
            members: entry.members,
            issueRoots: entry.issueRoots,
            at: now(),
        });
        return { ...recorded, childPid, killed, branch, base, goal };
    }

    return {
        name: 'reconciler',
        reconcile,
        forceRelease,
    };
}

/**
 * Register the force-release HTTP route against a supervisor (server.mjs).
 * The path carries the sprint id as a `:sprintId` param, matched by the
 * supervisor's pattern-route support.
 *
 * @param {{ route: (method: string, path: string, handler: Function) => void }} supervisor
 * @param {{ forceRelease: (sprintId: string, audit: object) => Promise<object> }} reconciler
 */
export function registerReservationRoutes(supervisor, reconciler) {
    supervisor.route('POST', '/api/reservations/:sprintId/force-release', async (req, res, ctx) => {
        const sprintId = ctx?.params?.sprintId;
        if (!sprintId) {
            sendJson(res, 400, { error: 'missing sprintId in path' });
            return;
        }
        const body = (await readJsonBody(req)) ?? {};
        try {
            const audit = await reconciler.forceRelease(sprintId, { by: body.by, reason: body.reason });
            sendJson(res, 200, { status: 'force-released', sprintId, audit });
        } catch (err) {
            if (err && err.code === 'SPRINT_NOT_FOUND') {
                sendJson(res, 404, { error: err.message });
                return;
            }
            throw err;
        }
    });
}
