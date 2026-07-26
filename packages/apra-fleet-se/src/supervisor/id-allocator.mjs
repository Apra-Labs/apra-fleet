// =============================================================================
// Auto-sprint supervisor -- globally-coordinated child-id allocator
// (apra-fleet-eft.9.3, Plan Part 3.4)
// =============================================================================
//
// ONE supervisor-owned allocator that mints the next child id under a shared
// parent bead, so two concurrently-running sprints NEVER derive the same child
// id. This is a LOAD-BEARING v1 requirement, not a fallback:
//
//   * PoC-confirmed constraint C.4: two sprints that each run
//     `bd create --parent X` in their OWN dolt clone independently derive the
//     same next child id (each clone only sees the siblings it already has), so
//     both mint `X.<n>` -- and the two D-pushes then hard-conflict on that row
//     (constraint C.2), which wedges the entire clone sync (constraint C.3).
//
// Therefore child-id minting for any shared parent MUST be globally serialized:
// the allocator lives HERE (the supervisor), the same authority that owns the
// dolt push mutex, and hands each creator an EXPLICIT, distinct child id that
// the sprint then passes to `bd create --id <childId>`. Because the id is
// pre-decided by one authority, the two creates target DIFFERENT rows and never
// conflict.
//
// -----------------------------------------------------------------------------
// Design points that map directly to the acceptance criteria:
//
//   * Zero collisions under concurrent same-parent creation (C.4): each parent
//     has its OWN monotonic sequence. allocate() assigns and advances that
//     sequence SYNCHRONOUSLY (no await before the state mutation), so on JS's
//     single thread two concurrent allocate() calls for the same parent can
//     never read-modify-write the same counter -- they get strictly distinct,
//     sequential ids.
//
//   * Sequential per parent, concurrent across parents (NOT one global lock):
//     the per-parent sequences are independent. There is no cross-parent lock
//     held across an await, so an allocation under parent A never blocks an
//     allocation under parent B. Same parent serializes (shared counter);
//     different parents proceed in parallel.
//
//   * State survives supervisor restart: every mutation is persisted atomically
//     (temp file + rename) and allocate() does not resolve its id to the caller
//     until the snapshot INCLUDING that id is durably on disk. A restarted
//     supervisor reload()s the per-parent high-water marks, so it never re-mints
//     an id it already handed out before the crash.
//
//   * A child that dies mid-allocation does not leak or reserve a permanent gap
//     that breaks later allocation: allocate() RESERVES a seq under a lease +
//     recorded pid and returns a token; the sprint calls confirm(token) only
//     AFTER `bd create` succeeds (durably committing the id), or release(token)
//     if the create failed. A child that dies BEFORE confirming leaves an
//     outstanding reservation whose lease expires / whose pid is found dead --
//     reclaimExpired() then returns that seq to a per-parent free pool, and the
//     next allocate() under that parent REUSES it. So an abandoned reservation
//     becomes a benign, reclaimable hole, never a permanent gap and never a
//     leaked/stuck counter.
// =============================================================================

import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';

import { isPidAlive } from './reconcile.mjs';

/** On-disk schema version for the persisted allocator document. */
export const ID_ALLOCATOR_VERSION = 1;

/** Default file name for the persisted allocator state inside the data dir. */
export const ID_ALLOCATOR_FILENAME = 'child-id-allocator.json';

/** Default lease duration: how long a reserved-but-unconfirmed child id may
 *  stay outstanding before it is considered abandoned (crashed creator) and
 *  reclaimed. A `bd create` is sub-second; 60s is generous headroom. */
export const DEFAULT_LEASE_MS = 60_000;

/** Default background sweep interval for reclaiming abandoned reservations. */
export const DEFAULT_SWEEP_MS = 5_000;

let tokenSeq = 0;
/** Monotonic, collision-free reservation token. */
function nextToken(parentId) {
    tokenSeq += 1;
    return `${parentId}#${tokenSeq}#${Date.now().toString(36)}`;
}

/** Default per-user data dir shared with the ledger. */
function defaultDataDir() {
    return path.join(os.homedir() || os.tmpdir(), '.apra-fleet', 'supervisor');
}

/**
 * Create the global child-id allocator.
 *
 * @param {{
 *   dataDir?: string,
 *   filePath?: string,
 *   leaseMs?: number,
 *   sweepMs?: number,
 *   now?: () => number,
 *   isPidAlive?: (pid: number) => boolean,
 *   setInterval?: typeof setInterval,
 *   clearInterval?: typeof clearInterval,
 *   fs?: {
 *     mkdir: typeof import('node:fs/promises').mkdir,
 *     readFile: typeof import('node:fs/promises').readFile,
 *     writeFile: typeof import('node:fs/promises').writeFile,
 *     rename: typeof import('node:fs/promises').rename,
 *   },
 *   logger?: { log?: Function, error?: Function },
 * }} [deps]
 */
export function createIdAllocator(deps = {}) {
    const dataDir = deps.dataDir ?? defaultDataDir();
    const filePath = deps.filePath ?? path.join(dataDir, ID_ALLOCATOR_FILENAME);
    const tmpPath = `${filePath}.tmp`;
    const leaseMs = Number.isFinite(deps.leaseMs) && deps.leaseMs > 0 ? deps.leaseMs : DEFAULT_LEASE_MS;
    const sweepMs = Number.isFinite(deps.sweepMs) && deps.sweepMs > 0 ? deps.sweepMs : DEFAULT_SWEEP_MS;
    const now = deps.now ?? (() => Date.now());
    const probe = deps.isPidAlive ?? isPidAlive;
    const setIntervalFn = deps.setInterval ?? setInterval;
    const clearIntervalFn = deps.clearInterval ?? clearInterval;
    const fs = deps.fs ?? fsp;
    const logger = deps.logger ?? console;
    const log = (...a) => logger.log?.(...a);

    /**
     * Per-parent allocation state. Each parent id maps to:
     *   highWater  -- highest seq ever handed out for this parent (monotonic).
     *   free       -- reclaimed seqs (abandoned reservations), reused smallest-
     *                 first before advancing highWater, so a dead creator leaves
     *                 no permanent gap.
     *   reserved   -- outstanding reservations keyed by token:
     *                 { seq, pid, sprintId, reservedAt, expiresAt }.
     * @type {Map<string, { highWater: number, free: number[], reserved: Map<string, { seq: number, pid: number|null, sprintId: string|null, reservedAt: number, expiresAt: number }> }>}
     */
    let parents = new Map();
    let loaded = false;
    let sweepTimer = null;

    // Serialize every disk write so concurrent persists cannot interleave their
    // temp-file writes and renames. The IN-MEMORY seq assignment is synchronous
    // and happens BEFORE we enqueue the write, so different parents never block
    // each other's id assignment -- they only queue behind the shared writer.
    let persistChain = Promise.resolve();

    function parentState(parentId) {
        let st = parents.get(parentId);
        if (!st) {
            st = { highWater: 0, free: [], reserved: new Map() };
            parents.set(parentId, st);
        }
        return st;
    }

    /** Serialize the whole allocator into the persisted document shape. */
    function currentDocument() {
        const doc = { version: ID_ALLOCATOR_VERSION, parents: {} };
        for (const [parentId, st] of parents) {
            const reserved = {};
            for (const [token, r] of st.reserved) {
                reserved[token] = { seq: r.seq, pid: r.pid, sprintId: r.sprintId, reservedAt: r.reservedAt, expiresAt: r.expiresAt };
            }
            doc.parents[parentId] = {
                highWater: st.highWater,
                free: [...st.free].sort((a, b) => a - b),
                reserved,
            };
        }
        return doc;
    }

    /**
     * Atomically replace the on-disk state with a snapshot taken NOW (which
     * already includes the just-made synchronous mutation). Chained so writes
     * never interleave; the returned promise resolves once THIS snapshot is
     * durably on disk. allocate() awaits it before resolving its id so a crash
     * can never lose an already-handed-out id.
     */
    function persist() {
        const snapshot = `${JSON.stringify(currentDocument(), null, 2)}\n`;
        const run = persistChain.then(async () => {
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(tmpPath, snapshot, 'utf-8');
            await fs.rename(tmpPath, filePath);
        });
        // Keep the chain alive regardless of this write's outcome so one failed
        // write cannot poison every later write; the error still propagates to
        // this caller via the returned promise.
        persistChain = run.catch(() => {});
        return run;
    }

    /**
     * Load allocator state from disk. A missing file yields empty state. A
     * corrupt/foreign-version file is a hard error -- the supervisor must not
     * silently drop high-water marks and start re-minting live ids.
     */
    async function load() {
        let raw;
        try {
            raw = await fs.readFile(filePath, 'utf-8');
        } catch (err) {
            if (err && err.code === 'ENOENT') {
                parents = new Map();
                loaded = true;
                return;
            }
            throw err;
        }
        let doc;
        try {
            doc = JSON.parse(raw);
        } catch (err) {
            throw new Error(`id-allocator file ${filePath} is not valid JSON: ${err.message}`);
        }
        if (!doc || typeof doc !== 'object' || doc.version !== ID_ALLOCATOR_VERSION || typeof doc.parents !== 'object') {
            throw new Error(`id-allocator file ${filePath} has an unexpected shape or version (expected ${ID_ALLOCATOR_VERSION})`);
        }
        const next = new Map();
        for (const [parentId, st] of Object.entries(doc.parents)) {
            const reserved = new Map();
            for (const [token, r] of Object.entries(st.reserved ?? {})) {
                reserved.set(token, {
                    seq: r.seq,
                    pid: r.pid ?? null,
                    sprintId: r.sprintId ?? null,
                    reservedAt: r.reservedAt ?? 0,
                    expiresAt: r.expiresAt ?? 0,
                });
            }
            next.set(parentId, {
                highWater: Number.isInteger(st.highWater) ? st.highWater : 0,
                free: Array.isArray(st.free) ? st.free.filter(Number.isInteger).sort((a, b) => a - b) : [],
                reserved,
            });
        }
        parents = next;
        loaded = true;
    }

    /**
     * Reclaim abandoned reservations across ALL parents: any reservation whose
     * lease has expired OR whose recorded pid is no longer alive (a crashed
     * creator that never confirmed/released) has its seq returned to that
     * parent's free pool for reuse. Returns how many were reclaimed. Driven both
     * on every allocate() and by the optional background sweep, so an abandoned
     * reservation never permanently reserves an id.
     * @returns {number}
     */
    function reclaimExpired() {
        const t = now();
        let reclaimed = 0;
        for (const [parentId, st] of parents) {
            for (const [token, r] of st.reserved) {
                const leaseExpired = t >= r.expiresAt;
                // pid == null means the caller opted out of pid-probing (e.g.
                // in-process test) -- rely on the lease alone.
                const pidDead = r.pid != null && !probe(r.pid);
                if (!leaseExpired && !pidDead) continue;
                st.reserved.delete(token);
                if (!st.free.includes(r.seq)) st.free.push(r.seq);
                st.free.sort((a, b) => a - b);
                reclaimed += 1;
                log(`[id-allocator] reclaimed ${leaseExpired ? 'expired' : 'dead-pid'} reservation '${parentId}.${r.seq}' (sprint ${r.sprintId ?? 'n/a'}, pid ${r.pid ?? 'n/a'})`);
            }
        }
        return reclaimed;
    }

    /**
     * Allocate the next child id under `parentId`. Resolves ONLY after the
     * allocation is durably persisted, so a crash can never lose it. The seq is
     * assigned SYNCHRONOUSLY (before any await) so concurrent same-parent calls
     * get strictly distinct, sequential ids; different parents never block.
     *
     * @param {string} parentId  the parent bead id children hang under
     * @param {{ pid?: number|null, sprintId?: string, floor?: number }} [opts]
     *   pid     -- the creating child's pid, for dead-pid reclaim of an
     *              abandoned reservation.
     *   sprintId-- for introspection/logging.
     *   floor   -- the count of children the parent ALREADY has (max existing
     *              child seq). On first touch of a parent, the counter is seeded
     *              above this so the allocator never mints an id colliding with a
     *              pre-existing child created before the allocator existed.
     * @returns {Promise<{ childId: string, parentId: string, seq: number, token: string, expiresAt: number }>}
     */
    async function allocate(parentId, opts = {}) {
        if (typeof parentId !== 'string' || parentId.length === 0) {
            throw new TypeError('allocate() requires a non-empty parentId');
        }
        const pid = opts.pid == null ? null : opts.pid;
        if (pid !== null && !Number.isInteger(pid)) {
            throw new TypeError('allocate() pid must be an integer or null');
        }
        // Opportunistically reclaim abandoned reservations before we mint, so a
        // crashed creator's hole is reused rather than skipped.
        reclaimExpired();

        const st = parentState(parentId);
        // Seed the high-water above any pre-existing children on first contact.
        if (Number.isInteger(opts.floor) && opts.floor > st.highWater) {
            // Only lift the high-water; never drop it. Free holes below the new
            // floor that predate the allocator are discarded (they belong to
            // beads that already exist), so we never hand out an id <= floor.
            st.highWater = opts.floor;
            st.free = st.free.filter((n) => n > opts.floor);
        }

        // Reuse the smallest reclaimed hole before advancing the counter, so an
        // abandoned reservation leaves no permanent gap.
        let seq;
        if (st.free.length > 0) {
            seq = st.free.shift();
        } else {
            st.highWater += 1;
            seq = st.highWater;
        }
        const at = now();
        const token = nextToken(parentId);
        st.reserved.set(token, {
            seq,
            pid,
            sprintId: opts.sprintId ?? null,
            reservedAt: at,
            expiresAt: at + leaseMs,
        });

        // Durability barrier: do not hand the id back until it is on disk, so a
        // restart re-adopts the same high-water and never re-mints this id.
        await persist();
        return { childId: `${parentId}.${seq}`, parentId, seq, token, expiresAt: at + leaseMs };
    }

    /**
     * Durably commit a reservation: the sprint has successfully run
     * `bd create --id <childId>`, so the id is now permanently used. Removes the
     * reservation WITHOUT returning its seq to the free pool (the id is real
     * now). Idempotent: an unknown/already-committed token is a no-op.
     * @param {string} token the reservation token returned by allocate()
     * @returns {Promise<boolean>} whether a reservation was committed
     */
    async function confirm(token) {
        for (const st of parents.values()) {
            const r = st.reserved.get(token);
            if (r) {
                st.reserved.delete(token);
                await persist();
                return true;
            }
        }
        return false;
    }

    /**
     * Release (abandon) a reservation whose `bd create` did NOT succeed: return
     * its seq to the parent's free pool so the next allocate() reuses it, leaving
     * no permanent gap. Idempotent: an unknown token is a no-op.
     * @param {string} token
     * @returns {Promise<boolean>} whether a reservation was released
     */
    async function release(token) {
        for (const st of parents.values()) {
            const r = st.reserved.get(token);
            if (r) {
                st.reserved.delete(token);
                if (!st.free.includes(r.seq)) st.free.push(r.seq);
                st.free.sort((a, b) => a - b);
                await persist();
                return true;
            }
        }
        return false;
    }

    /** Introspection snapshot (clone -- callers cannot mutate internal state). */
    function status() {
        const out = {};
        for (const [parentId, st] of parents) {
            out[parentId] = {
                highWater: st.highWater,
                free: [...st.free].sort((a, b) => a - b),
                reserved: [...st.reserved.values()].map((r) => ({ seq: r.seq, pid: r.pid, sprintId: r.sprintId, expiresAt: r.expiresAt })),
            };
        }
        return { parents: out };
    }

    return {
        name: 'id-allocator',
        filePath,
        dataDir,

        // -- seam lifecycle (server.mjs calls start()/stop()) ----------------
        async start() {
            if (!loaded) await load();
            if (sweepTimer) return;
            sweepTimer = setIntervalFn(() => {
                if (reclaimExpired() > 0) persist().catch(() => {});
            }, sweepMs);
            // Do not keep the process alive solely for the sweep timer.
            if (sweepTimer && typeof sweepTimer.unref === 'function') sweepTimer.unref();
        },
        async stop() {
            if (sweepTimer) {
                clearIntervalFn(sweepTimer);
                sweepTimer = null;
            }
            // Let any in-flight write settle so on-disk state is consistent.
            await persistChain;
        },

        load,
        allocate,
        confirm,
        release,
        reclaimExpired,
        status,
        get leaseMs() { return leaseMs; },
    };
}

/**
 * Register the child-id allocator HTTP routes against a supervisor (server.mjs).
 * Detached sprint children mint ids through these:
 *
 *   POST /api/child-id-allocator/:parentId/allocate  body { pid?, sprintId?, floor? }
 *       -> 200 { childId, seq, token, expiresAt }. The child then runs
 *          `bd create --id <childId> --parent <parentId>`.
 *   POST /api/child-id-allocator/confirm             body { token }
 *       -> 200 { confirmed: boolean }. Called after a successful create.
 *   POST /api/child-id-allocator/release             body { token }
 *       -> 200 { released: boolean }. Called if the create failed.
 *   GET  /api/child-id-allocator                     -> 200 status snapshot.
 *
 * @param {{ route: Function }} supervisor
 * @param {ReturnType<typeof createIdAllocator>} allocator
 * @param {{ readJsonBody: Function, sendJson: Function }} http
 */
export function registerIdAllocatorRoutes(supervisor, allocator, http) {
    const { readJsonBody, sendJson } = http;

    supervisor.route('POST', '/api/child-id-allocator/:parentId/allocate', async (req, res, ctx) => {
        const parentId = ctx?.params?.parentId;
        if (!parentId) { sendJson(res, 400, { error: 'missing parentId in path' }); return; }
        const body = (await readJsonBody(req)) ?? {};
        try {
            const grant = await allocator.allocate(parentId, {
                pid: body.pid,
                sprintId: body.sprintId,
                floor: body.floor,
            });
            sendJson(res, 200, { status: 'allocated', ...grant });
        } catch (err) {
            sendJson(res, 503, { error: `allocate failed: ${err.message}` });
        }
    });

    supervisor.route('POST', '/api/child-id-allocator/confirm', async (req, res) => {
        const body = (await readJsonBody(req)) ?? {};
        if (typeof body.token !== 'string' || body.token.length === 0) {
            sendJson(res, 400, { error: 'confirm requires a token' });
            return;
        }
        const confirmed = await allocator.confirm(body.token);
        sendJson(res, 200, { confirmed });
    });

    supervisor.route('POST', '/api/child-id-allocator/release', async (req, res) => {
        const body = (await readJsonBody(req)) ?? {};
        if (typeof body.token !== 'string' || body.token.length === 0) {
            sendJson(res, 400, { error: 'release requires a token' });
            return;
        }
        const released = await allocator.release(body.token);
        sendJson(res, 200, { released });
    });

    supervisor.route('GET', '/api/child-id-allocator', async (req, res) => {
        sendJson(res, 200, allocator.status());
    });
}

/**
 * A no-op allocator client with the allocate()/confirm()/release() surface the
 * runner.js bead-creation path calls. Used when a sprint runs WITHOUT a
 * supervisor (single-process/dev/test): there is, by definition, no second
 * sprint that could mint a colliding child id, so `bd create` derives the id
 * itself. `childId: null` signals the runner to OMIT `--id` and let bd pick.
 * Keeps the create call sites uniform -- they always allocate/confirm; only the
 * client wiring differs.
 * @returns {{ allocate: Function, confirm: Function, release: Function }}
 */
export function nullChildIdAllocatorClient() {
    return {
        async allocate() { return { childId: null, token: null }; },
        async confirm() { return true; },
        async release() { return true; },
    };
}
