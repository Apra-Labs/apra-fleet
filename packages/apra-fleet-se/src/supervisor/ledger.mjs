// =============================================================================
// Auto-sprint supervisor -- combined member + issue-scope reservation ledger
// (apra-fleet-eft.5.1, Plan Part 2.2)
// =============================================================================
//
// ONE combined, supervisor-owned ledger of every live sprint's reservations:
//
//   reservations: {
//     [sprintId]: { members, issueRoots, childPid, reservedAt }
//   }
//
// The two reservation axes -- the member set and the issue-scope root ids -- are
// claimed and released in EXACT LOCKSTEP:
//
//   * the SAME launch event claims members AND issueRoots,
//   * the SAME terminal event releases BOTH,
//   * in ONE atomic disk write, with ONE restart-reconciliation path.
//
// There is deliberately no separate "member ledger" and "issue ledger": a torn
// state where a sprint holds one axis but not the other is unrepresentable here.
//
// This module is pure storage + lockstep transactionality. Overlap DETECTION
// (member union all-or-nothing on POST /api/sprints, and live-expanded issue
// subtree recomputation) is layered on top by eft.5.2 / eft.5.3, which read this
// ledger via list()/get(). Restart PID-probe reconciliation (eft.5.4 / eft.4.5)
// likewise drives release() from the reloaded on-disk state.
//
// Atomicity guarantees (acceptance criteria):
//   * claim() writes BOTH axes or NEITHER -- the in-memory reservation is
//     committed only after the disk write succeeds, so an injected mid-write
//     failure leaves the sprint entirely unreserved (not half-claimed).
//   * The on-disk file is replaced atomically (temp file + rename), so a
//     concurrent reader can never observe a torn/partial JSON document.
//   * The ledger reloads EXACTLY from disk across a process restart.
//
// Intra-sprint memberLocks in auto-sprint/runner.js is a DIFFERENT, orthogonal
// mechanism (role-level, within one sprint) and is intentionally left untouched.
// =============================================================================

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** On-disk schema version for the persisted ledger document. */
export const LEDGER_VERSION = 1;

/** Default file name for the persisted ledger inside the service data dir. */
export const LEDGER_FILENAME = 'reservations.json';

/**
 * The persisted-shape schema other eft.5 tasks build on. This is the contract
 * for what claim()/release() write and what a restarted supervisor re-adopts.
 *
 * @typedef {object} Reservation
 * @property {string[]} members      Full member set reserved (union of members +
 *                                   every roleMap value incl. the orchestrator).
 * @property {string[]} issueRoots   Root issue id(s) the sprint launched with;
 *                                   the identity key for the issue-scope axis.
 * @property {number|null} childPid  Detached child PID (for restart PID-probe
 *                                   reconciliation); null until known.
 * @property {string} reservedAt     ISO-8601 timestamp of the claim.
 *
 * @typedef {object} LedgerDocument
 * @property {number} version                              Equals LEDGER_VERSION.
 * @property {Record<string, Reservation>} reservations    Keyed by sprintId.
 * @property {string|null} [scopeFreshness.lastSyncedAt]   ISO-8601 timestamp of
 *                                                         the last successful bd sync,
 *                                                         or null if never synced.
 */
export const LEDGER_SCHEMA = Object.freeze({
    $id: 'apra-fleet-se/supervisor-reservation-ledger@1',
    type: 'object',
    required: ['version', 'reservations'],
    additionalProperties: false,
    properties: {
        version: { const: LEDGER_VERSION },
        reservations: {
            type: 'object',
            additionalProperties: {
                type: 'object',
                required: ['members', 'issueRoots', 'childPid', 'reservedAt'],
                additionalProperties: false,
                properties: {
                    members: { type: 'array', items: { type: 'string' } },
                    issueRoots: { type: 'array', items: { type: 'string' } },
                    childPid: { type: ['integer', 'null'] },
                    reservedAt: { type: 'string' },
                },
            },
        },
        scopeFreshness: {
            type: 'object',
            additionalProperties: false,
            properties: {
                lastSyncedAt: { type: ['string', 'null'] },
            },
        },
    },
});

/** An empty, well-formed ledger document. */
export function emptyLedgerDocument() {
    return { version: LEDGER_VERSION, reservations: {}, scopeFreshness: { lastSyncedAt: null } };
}

/**
 * The default service data directory. Overridable via the FLEET_SE_DATA_DIR env
 * var, otherwise `~/.apra-fleet-se`.
 * @returns {string}
 */
export function defaultDataDir() {
    return process.env.FLEET_SE_DATA_DIR
        ? path.resolve(process.env.FLEET_SE_DATA_DIR)
        : path.join(os.homedir(), '.apra-fleet-se');
}

/** Normalize a claim's axes into a frozen, deduped, sorted-copy reservation. */
function normalizeReservation(input, now) {
    const toStringArray = (v, label) => {
        if (v == null) return [];
        if (!Array.isArray(v)) throw new TypeError(`${label} must be an array of strings`);
        const out = [];
        const seen = new Set();
        for (const item of v) {
            if (typeof item !== 'string' || item.length === 0) {
                throw new TypeError(`${label} must contain only non-empty strings`);
            }
            if (!seen.has(item)) { seen.add(item); out.push(item); }
        }
        return out;
    };

    const members = toStringArray(input.members, 'members');
    const issueRoots = toStringArray(input.issueRoots, 'issueRoots');
    let childPid = input.childPid;
    if (childPid === undefined) childPid = null;
    if (childPid !== null && !Number.isInteger(childPid)) {
        throw new TypeError('childPid must be an integer or null');
    }
    const reservedAt = typeof input.reservedAt === 'string' ? input.reservedAt : now();
    return { members, issueRoots, childPid, reservedAt };
}

/** Deep-clone a reservation so callers can never mutate ledger-internal state. */
function cloneReservation(r) {
    return {
        members: [...r.members],
        issueRoots: [...r.issueRoots],
        childPid: r.childPid,
        reservedAt: r.reservedAt,
    };
}

/**
 * Create the combined reservation ledger. Collaborators are injected so tests
 * can drive an in-memory temp dir and simulate a mid-write failure.
 *
 * @param {{
 *   dataDir?: string,
 *   filePath?: string,
 *   now?: () => string,
 *   fs?: {
 *     mkdir: typeof import('node:fs/promises').mkdir,
 *     readFile: typeof import('node:fs/promises').readFile,
 *     writeFile: typeof import('node:fs/promises').writeFile,
 *     rename: typeof import('node:fs/promises').rename,
 *     rm?: typeof import('node:fs/promises').rm,
 *   },
 *   logger?: { log?: Function, error?: Function },
 * }} [deps]
 */
export function createLedger(deps = {}) {
    const dataDir = deps.dataDir ?? defaultDataDir();
    const filePath = deps.filePath ?? path.join(dataDir, LEDGER_FILENAME);
    const tmpPath = `${filePath}.tmp`;
    const now = deps.now ?? (() => new Date().toISOString());
    const fs = deps.fs ?? fsp;
    const logger = deps.logger ?? console;
    const logError = (...a) => (logger.error ?? logger.log)?.(...a);

    // Authoritative in-memory view. Committed to ONLY after a successful disk
    // write, so a failed persist can never leave a half-claimed reservation.
    /** @type {Map<string, Reservation>} */
    let reservations = new Map();
    let loaded = false;
    // Track the timestamp of the last successful bd sync for scope freshness.
    let lastSyncedAt = null;

    // Serialize every transaction (draft build + atomic write + commit) so
    // concurrent claim()/release() calls can never build a stale draft, nor
    // interleave their temp-file writes and renames.
    let txChain = Promise.resolve();

    function currentDocument(map = reservations) {
        const doc = emptyLedgerDocument();
        for (const [sprintId, r] of map) {
            doc.reservations[sprintId] = cloneReservation(r);
        }
        doc.scopeFreshness.lastSyncedAt = lastSyncedAt;
        return doc;
    }

    /**
     * Atomically replace the on-disk ledger with `doc` (temp file + rename).
     * Never leaves a torn file for a concurrent reader.
     */
    async function persist(doc) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const body = `${JSON.stringify(doc, null, 2)}\n`;
        await fs.writeFile(tmpPath, body, 'utf-8');
        await fs.rename(tmpPath, filePath);
    }

    /**
     * Transactionally apply `mutate` to a clone of the CURRENT committed map,
     * persist the resulting document to disk, and only THEN commit the clone as
     * the live map. The whole transaction is serialized behind txChain, so each
     * one sees the previous commit. If persistence throws, the live map is
     * untouched -- both axes stay in their pre-call state (neither half-claimed
     * nor half-released).
     * @template T
     * @param {(draft: Map<string, Reservation>) => T} mutate
     * @returns {Promise<T>}
     */
    function transact(mutate) {
        const run = txChain.then(async () => {
            const draft = new Map();
            for (const [k, v] of reservations) draft.set(k, cloneReservation(v));
            const result = mutate(draft);
            await persist(currentDocument(draft));
            reservations = draft; // commit only after the disk write succeeded
            return result;
        });
        // Keep the chain alive regardless of this transaction's outcome so one
        // failed write can't poison every later transaction; the error still
        // propagates to this caller via the returned promise.
        txChain = run.catch(() => {});
        return run;
    }

    /**
     * Load the ledger from disk into memory. A missing file yields an empty
     * ledger. A corrupt/foreign-version file is a hard error -- the supervisor
     * must not silently drop live reservations.
     */
    async function load() {
        let raw;
        try {
            raw = await fs.readFile(filePath, 'utf-8');
        } catch (err) {
            if (err && err.code === 'ENOENT') {
                reservations = new Map();
                lastSyncedAt = null;
                loaded = true;
                return;
            }
            throw err;
        }
        let doc;
        try {
            doc = JSON.parse(raw);
        } catch (err) {
            throw new Error(`ledger file ${filePath} is not valid JSON: ${err.message}`);
        }
        if (!doc || typeof doc !== 'object' || doc.version !== LEDGER_VERSION || typeof doc.reservations !== 'object') {
            throw new Error(`ledger file ${filePath} has an unexpected shape or version (expected ${LEDGER_VERSION})`);
        }
        const next = new Map();
        for (const [sprintId, r] of Object.entries(doc.reservations)) {
            next.set(sprintId, normalizeReservation(r, now));
        }
        reservations = next;
        lastSyncedAt = (doc.scopeFreshness && doc.scopeFreshness.lastSyncedAt) || null;
        loaded = true;
    }

    return {
        name: 'ledger',
        filePath,
        dataDir,

        // -- seam lifecycle (server.mjs calls start()/stop()) ----------------
        async start() { if (!loaded) await load(); },
        async stop() { await txChain; },

        load,

        /**
         * Claim BOTH axes for a sprint in one atomic write. Storage-level only:
         * overlap rejection is layered on by eft.5.2/eft.5.3 before calling this.
         * @param {string} sprintId
         * @param {{ members?: string[], issueRoots?: string[], childPid?: number|null, reservedAt?: string }} claimInput
         * @returns {Promise<Reservation>} a clone of the stored reservation
         */
        async claim(sprintId, claimInput = {}) {
            if (typeof sprintId !== 'string' || sprintId.length === 0) {
                throw new TypeError('claim() requires a non-empty sprintId');
            }
            const reservation = normalizeReservation(claimInput, now);
            await transact((draft) => {
                if (draft.has(sprintId)) {
                    throw new Error(`sprint ${sprintId} already holds a reservation; release it before re-claiming`);
                }
                draft.set(sprintId, reservation);
            });
            return cloneReservation(reservation);
        },

        /**
         * Release BOTH axes for a sprint in one atomic write. Idempotent: a
         * no-op (returns false) if the sprint held no reservation.
         * @param {string} sprintId
         * @returns {Promise<boolean>} whether a reservation was removed
         */
        async release(sprintId) {
            if (typeof sprintId !== 'string' || sprintId.length === 0) {
                throw new TypeError('release() requires a non-empty sprintId');
            }
            return transact((draft) => draft.delete(sprintId));
        },

        /**
         * Update the recorded child PID for a live reservation (used once the
         * detached child is spawned). Same lockstep atomic-write discipline.
         * @param {string} sprintId
         * @param {number|null} childPid
         * @returns {Promise<Reservation>}
         */
        async setChildPid(sprintId, childPid) {
            if (childPid !== null && !Number.isInteger(childPid)) {
                throw new TypeError('childPid must be an integer or null');
            }
            let updated;
            await transact((draft) => {
                const r = draft.get(sprintId);
                if (!r) {
                    throw new Error(`cannot set childPid: sprint ${sprintId} holds no reservation`);
                }
                r.childPid = childPid;
                updated = r;
            });
            return cloneReservation(updated);
        },

        /**
         * Return a clone of one sprint's reservation, or undefined.
         * @param {string} sprintId
         * @returns {Reservation|undefined}
         */
        get(sprintId) {
            const r = reservations.get(sprintId);
            return r ? cloneReservation(r) : undefined;
        },

        /**
         * Return clones of all reservations as `{ sprintId, ...reservation }`.
         * @returns {Array<Reservation & { sprintId: string }>}
         */
        list() {
            return [...reservations.entries()].map(([sprintId, r]) => ({ sprintId, ...cloneReservation(r) }));
        },

        /** Current persisted-shape document (a clone). */
        toDocument() { return currentDocument(); },

        /** Number of live reservations. */
        get size() { return reservations.size; },

        /**
         * Get the scope freshness information: timestamp of last successful bd sync
         * and derived age in seconds, or 'never-synced' marker if unknown.
         * @param {() => number} getNow optional function to get current timestamp in ms
         * @returns {{ lastSyncedAt: string|null, ageSeconds: number|string }}
         */
        getScopeFreshness(getNow) {
            if (lastSyncedAt === null) {
                return { lastSyncedAt: null, ageSeconds: 'never-synced' };
            }
            const lastTime = new Date(lastSyncedAt).getTime();
            const currentTime = (getNow && getNow()) || Date.now();
            const ageSeconds = Math.max(0, Math.floor((currentTime - lastTime) / 1000));
            return { lastSyncedAt, ageSeconds };
        },

        /**
         * Update the scope freshness timestamp to record a successful bd sync/pull.
         * @param {string} [timestamp] ISO-8601 timestamp; defaults to current time
         * @returns {Promise<{ lastSyncedAt: string, ageSeconds: number }>}
         */
        async setScopeFreshness(timestamp) {
            const newTimestamp = timestamp || now();
            return transact(() => {
                lastSyncedAt = newTimestamp;
                return { lastSyncedAt: newTimestamp, ageSeconds: 0 };
            });
        },
    };
}
