// =============================================================================
// Auto-sprint supervisor -- global dolt push mutex (apra-fleet-eft.9.2,
// Plan Part 3.4)
// =============================================================================
//
// ONE supervisor-owned mutex that serializes EVERY cross-sprint `bd dolt push`.
// This is a LOAD-BEARING v1 requirement, not a fallback:
//
//   * PoC-confirmed constraint C.2: ANY concurrent write to the same row hard-
//     conflicts (row-level, NOT cell-level, in bd 1.1.0 embedded mode -- the
//     disjoint-field re-test refuted the upstream cell-level claim).
//   * PoC-confirmed constraint C.3: one unresolved conflict wedges the ENTIRE
//     clone sync.
//
// Therefore all cross-sprint dolt writes MUST serialize: two sprints must never
// execute a dolt push at the same time. The mutex lives HERE (the supervisor),
// not per-child -- a per-child lock cannot coordinate across independent
// detached sprint processes.
//
// -----------------------------------------------------------------------------
// Design points that map directly to the acceptance criteria:
//
//   * Non-overlapping push windows: at most ONE holder is ever granted; every
//     other acquirer waits until the holder releases. `acquire()` resolves only
//     when the caller genuinely owns the mutex.
//
//   * FIFO fairness / no starvation: waiters are granted strictly in the order
//     they enqueued (a plain queue, shifted from the front), so a steady stream
//     of new acquirers can never indefinitely jump an already-waiting sprint.
//
//   * Lease + crash safety: a grant carries a LEASE (expiresAt = now + leaseMs).
//     A crashed holder that never calls release() cannot wedge the mutex
//     forever -- `reclaimExpired()` (driven both on every acquire attempt and by
//     an optional background sweep) force-releases a holder whose lease expired
//     OR whose recorded pid is no longer alive, then hands the mutex to the next
//     waiter. A holder may `renew()` to extend its lease for a legitimately long
//     push.
//
//   * Release on every terminal path: release() is idempotent and token-guarded
//     (a stale/expired holder's late release cannot evict a newer holder), so
//     the runner.js D-push bracket can release in a `finally` on success,
//     failure, and (via lease expiry) child crash.
// =============================================================================

import { isPidAlive } from './reconcile.mjs';

/** Default lease duration: how long a single dolt push may hold the mutex
 *  before it is considered crashed/wedged and force-reclaimed. A real dolt
 *  push-with-reconcile is seconds; 60s is generous headroom. */
export const DEFAULT_LEASE_MS = 60_000;

/** Default background sweep interval for reclaiming expired/dead holders. */
export const DEFAULT_SWEEP_MS = 5_000;

let tokenSeq = 0;
/** Monotonic, collision-free grant token. */
function nextToken(sprintId) {
    tokenSeq += 1;
    return `${sprintId}#${tokenSeq}#${Date.now().toString(36)}`;
}

/**
 * Create the global dolt push mutex.
 *
 * @param {{
 *   leaseMs?: number,
 *   sweepMs?: number,
 *   now?: () => number,
 *   isPidAlive?: (pid: number) => boolean,
 *   setInterval?: typeof setInterval,
 *   clearInterval?: typeof clearInterval,
 *   logger?: { log?: Function, error?: Function },
 * }} [deps]
 */
export function createDoltMutex(deps = {}) {
    const leaseMs = Number.isFinite(deps.leaseMs) && deps.leaseMs > 0 ? deps.leaseMs : DEFAULT_LEASE_MS;
    const sweepMs = Number.isFinite(deps.sweepMs) && deps.sweepMs > 0 ? deps.sweepMs : DEFAULT_SWEEP_MS;
    const now = deps.now ?? (() => Date.now());
    const probe = deps.isPidAlive ?? isPidAlive;
    const setIntervalFn = deps.setInterval ?? setInterval;
    const clearIntervalFn = deps.clearInterval ?? clearInterval;
    const logger = deps.logger ?? console;
    const log = (...a) => logger.log?.(...a);

    /**
     * The single current holder, or null when the mutex is free.
     * @type {{ sprintId: string, token: string, pid: number|null, acquiredAt: number, expiresAt: number }|null}
     */
    let holder = null;

    /**
     * FIFO waiter queue. Each entry carries the resolve/reject of the promise
     * returned by acquire(); the front entry is granted next when the mutex
     * frees.
     * @type {Array<{ sprintId: string, pid: number|null, resolve: Function, reject: Function, enqueuedAt: number }>}
     */
    const waiters = [];

    let sweepTimer = null;

    /** Grant the mutex to `waiter`, minting a fresh lease + token. */
    function grant(waiter) {
        const at = now();
        holder = {
            sprintId: waiter.sprintId,
            token: nextToken(waiter.sprintId),
            pid: waiter.pid ?? null,
            acquiredAt: at,
            expiresAt: at + leaseMs,
        };
        waiter.resolve({ token: holder.token, sprintId: holder.sprintId, expiresAt: holder.expiresAt });
    }

    /** If the mutex is free and someone is waiting, grant the front waiter. */
    function pump() {
        if (holder !== null) return;
        const next = waiters.shift();
        if (next) grant(next);
    }

    /**
     * Force-release the current holder if its lease has expired OR its recorded
     * pid is no longer alive (a crashed sprint that never released). Returns
     * true if a holder was reclaimed. Driven both on every acquire attempt and
     * by the optional background sweep so a crashed holder never wedges the
     * mutex permanently.
     * @returns {boolean}
     */
    function reclaimExpired() {
        if (holder === null) return false;
        const t = now();
        const leaseExpired = t >= holder.expiresAt;
        // A recorded pid that is no longer alive is a crashed holder -- reclaim
        // immediately without waiting out the full lease. pid == null means the
        // caller opted out of pid-probing (e.g. in-process test) -- rely on the
        // lease alone.
        const pidDead = holder.pid != null && !probe(holder.pid);
        if (!leaseExpired && !pidDead) return false;
        log(`[dolt-mutex] reclaiming ${leaseExpired ? 'expired' : 'dead-pid'} holder '${holder.sprintId}' (pid ${holder.pid ?? 'n/a'}); ${waiters.length} waiter(s) queued`);
        holder = null;
        pump();
        return true;
    }

    /**
     * Acquire the mutex for `sprintId`. Resolves ONLY when the caller genuinely
     * owns it (immediately if free, otherwise FIFO-after every earlier waiter).
     * The resolved value is the lease token required to release/renew.
     *
     * @param {string} sprintId
     * @param {{ pid?: number|null }} [opts]
     * @returns {Promise<{ token: string, sprintId: string, expiresAt: number }>}
     */
    function acquire(sprintId, opts = {}) {
        if (typeof sprintId !== 'string' || sprintId.length === 0) {
            return Promise.reject(new TypeError('acquire() requires a non-empty sprintId'));
        }
        const pid = opts.pid == null ? null : opts.pid;
        if (pid !== null && !Number.isInteger(pid)) {
            return Promise.reject(new TypeError('acquire() pid must be an integer or null'));
        }
        // Opportunistically reclaim a wedged holder before we decide to wait.
        reclaimExpired();
        return new Promise((resolve, reject) => {
            waiters.push({ sprintId, pid, resolve, reject, enqueuedAt: now() });
            pump();
        });
    }

    /**
     * Release the mutex. Idempotent and token-guarded: a release whose token
     * does not match the current holder is a no-op (returns false), so a
     * crashed-then-reclaimed holder's late release can never evict the sprint
     * that legitimately holds the mutex now.
     *
     * @param {string} token the grant token returned by acquire()
     * @returns {boolean} whether this call actually released the current holder
     */
    function release(token) {
        if (holder === null || holder.token !== token) return false;
        log(`[dolt-mutex] '${holder.sprintId}' released; ${waiters.length} waiter(s) queued`);
        holder = null;
        pump();
        return true;
    }

    /**
     * Extend the current holder's lease (for a legitimately long push). No-op
     * (returns false) if the token does not match the current holder.
     * @param {string} token
     * @returns {false|{ expiresAt: number }}
     */
    function renew(token) {
        if (holder === null || holder.token !== token) return false;
        holder.expiresAt = now() + leaseMs;
        return { expiresAt: holder.expiresAt };
    }

    /** Introspection snapshot (clone -- callers cannot mutate internal state). */
    function status() {
        return {
            held: holder !== null,
            holder: holder
                ? { sprintId: holder.sprintId, pid: holder.pid, acquiredAt: holder.acquiredAt, expiresAt: holder.expiresAt }
                : null,
            waiting: waiters.map((w) => ({ sprintId: w.sprintId, pid: w.pid, enqueuedAt: w.enqueuedAt })),
            queueDepth: waiters.length,
        };
    }

    /**
     * Drop a still-queued waiter for `sprintId` (e.g. its HTTP long-poll was
     * aborted). Rejects that waiter's pending acquire() promise. A holder is not
     * a waiter and is untouched -- use lease expiry for a crashed holder.
     * @param {string} sprintId
     * @param {Error} [reason]
     * @returns {number} how many queued waiters were dropped
     */
    function cancelWaiter(sprintId, reason) {
        let dropped = 0;
        for (let i = waiters.length - 1; i >= 0; i -= 1) {
            if (waiters[i].sprintId === sprintId) {
                const [w] = waiters.splice(i, 1);
                dropped += 1;
                w.reject(reason ?? new Error(`acquire cancelled for sprint '${sprintId}'`));
            }
        }
        return dropped;
    }

    return {
        name: 'dolt-mutex',

        // -- seam lifecycle (server.mjs calls start()/stop()) ----------------
        async start() {
            if (sweepTimer) return;
            sweepTimer = setIntervalFn(() => { reclaimExpired(); }, sweepMs);
            // Do not keep the process alive solely for the sweep timer.
            if (sweepTimer && typeof sweepTimer.unref === 'function') sweepTimer.unref();
        },
        async stop() {
            if (sweepTimer) {
                clearIntervalFn(sweepTimer);
                sweepTimer = null;
            }
            // Fail any still-queued waiters so their promises never dangle.
            while (waiters.length > 0) {
                const w = waiters.shift();
                w.reject(new Error('dolt mutex is shutting down'));
            }
        },

        acquire,
        release,
        renew,
        reclaimExpired,
        cancelWaiter,
        status,
        get leaseMs() { return leaseMs; },
    };
}

/**
 * Register the dolt push mutex HTTP routes against a supervisor (server.mjs).
 * Detached sprint children coordinate through these:
 *
 *   POST /api/dolt-push-mutex/:sprintId/acquire   body { pid? }
 *       Long-polls: the response is deferred until this sprint genuinely owns
 *       the mutex, then returns 200 { token, expiresAt }. If the client aborts
 *       the request, its queued waiter is dropped.
 *   POST /api/dolt-push-mutex/:sprintId/release   body { token }
 *       Releases; 200 { released: boolean }.
 *   POST /api/dolt-push-mutex/:sprintId/renew     body { token }
 *       Extends the lease; 200 { renewed: boolean, expiresAt? }.
 *   GET  /api/dolt-push-mutex                      -> 200 status snapshot.
 *
 * @param {{ route: Function }} supervisor
 * @param {ReturnType<typeof createDoltMutex>} mutex
 * @param {{ readJsonBody: Function, sendJson: Function }} http
 */
export function registerDoltMutexRoutes(supervisor, mutex, http) {
    const { readJsonBody, sendJson } = http;

    supervisor.route('POST', '/api/dolt-push-mutex/:sprintId/acquire', async (req, res, ctx) => {
        const sprintId = ctx?.params?.sprintId;
        if (!sprintId) { sendJson(res, 400, { error: 'missing sprintId in path' }); return; }
        const body = (await readJsonBody(req)) ?? {};
        // If the client hangs up before it is granted, drop its queued waiter so
        // it can never later be handed a mutex nobody is waiting on.
        req.on('close', () => {
            if (!res.writableEnded) {
                mutex.cancelWaiter(sprintId, new Error('acquire request aborted by client'));
            }
        });
        try {
            const grant = await mutex.acquire(sprintId, { pid: body.pid });
            if (res.writableEnded) return; // client already gone
            sendJson(res, 200, { status: 'acquired', ...grant });
        } catch (err) {
            if (res.writableEnded) return;
            sendJson(res, 503, { error: `acquire failed: ${err.message}` });
        }
    });

    supervisor.route('POST', '/api/dolt-push-mutex/:sprintId/release', async (req, res, ctx) => {
        const sprintId = ctx?.params?.sprintId;
        if (!sprintId) { sendJson(res, 400, { error: 'missing sprintId in path' }); return; }
        const body = (await readJsonBody(req)) ?? {};
        if (typeof body.token !== 'string' || body.token.length === 0) {
            sendJson(res, 400, { error: 'release requires a token' });
            return;
        }
        const released = mutex.release(body.token);
        sendJson(res, 200, { released });
    });

    supervisor.route('POST', '/api/dolt-push-mutex/:sprintId/renew', async (req, res, ctx) => {
        const sprintId = ctx?.params?.sprintId;
        if (!sprintId) { sendJson(res, 400, { error: 'missing sprintId in path' }); return; }
        const body = (await readJsonBody(req)) ?? {};
        if (typeof body.token !== 'string' || body.token.length === 0) {
            sendJson(res, 400, { error: 'renew requires a token' });
            return;
        }
        const renewed = mutex.renew(body.token);
        sendJson(res, 200, renewed ? { renewed: true, expiresAt: renewed.expiresAt } : { renewed: false });
    });

    supervisor.route('GET', '/api/dolt-push-mutex', async (req, res) => {
        sendJson(res, 200, mutex.status());
    });
}

/**
 * A no-op mutex client with the acquire()/release() surface the runner.js
 * D-push bracket calls. Used when a sprint runs WITHOUT a supervisor
 * (single-process/dev/test): the push is unguarded because there is, by
 * definition, no second sprint to conflict with. Keeps the D-push call sites
 * uniform -- they always acquire/release, and only the client wiring differs.
 * @returns {{ acquire: Function, release: Function }}
 */
export function nullDoltPushMutexClient() {
    return {
        async acquire() { return { token: null }; },
        async release() { return true; },
    };
}
