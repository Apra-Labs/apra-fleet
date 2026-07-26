// =============================================================================
// Auto-sprint supervisor -- sprint terminal-event history (apra-fleet-eft.5.4)
// =============================================================================
//
// A small, append-only, persisted log of TERMINAL sprint events that the live
// reservation ledger (src/supervisor/ledger.mjs) deliberately does NOT keep.
// The ledger is pure "who holds a reservation RIGHT NOW" storage: releasing a
// sprint erases it entirely. But two eft.5.4 flows need a durable record of WHY
// a reservation went away:
//
//   * restart reconciliation marks a dead child's sprint `aborted-by-restart`,
//   * a force-release records who/why a wedged reservation was torn down.
//
// This module owns that audit trail so the ledger stays torn-state-free. It is
// intentionally minimal: append + atomic replace (temp file + rename), the same
// durability discipline the ledger uses, so a reader never sees a torn file.
// =============================================================================

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** On-disk schema version for the persisted history document. */
export const HISTORY_VERSION = 1;

/** Default file name for the persisted history inside the service data dir. */
export const HISTORY_FILENAME = 'sprint-history.json';

/** Recognized terminal event names recorded by eft.5.4 flows. */
export const HISTORY_EVENTS = Object.freeze({
    ABORTED_BY_RESTART: 'aborted-by-restart',
    FORCE_RELEASED: 'force-released',
});

/** An empty, well-formed history document. */
export function emptyHistoryDocument() {
    return { version: HISTORY_VERSION, events: [] };
}

/** The default service data directory (mirrors ledger.defaultDataDir()). */
export function defaultDataDir() {
    return process.env.FLEET_SE_DATA_DIR
        ? path.resolve(process.env.FLEET_SE_DATA_DIR)
        : path.join(os.homedir(), '.apra-fleet-se');
}

function cloneEvent(e) {
    return {
        sprintId: e.sprintId,
        event: e.event,
        reason: e.reason,
        by: e.by ?? null,
        members: [...(e.members ?? [])],
        issueRoots: [...(e.issueRoots ?? [])],
        at: e.at,
    };
}

/**
 * Create the append-only sprint history log. Collaborators injected so tests
 * can drive a temp dir and a fixed clock.
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
 *   },
 *   logger?: { log?: Function, error?: Function },
 * }} [deps]
 */
export function createHistory(deps = {}) {
    const dataDir = deps.dataDir ?? defaultDataDir();
    const filePath = deps.filePath ?? path.join(dataDir, HISTORY_FILENAME);
    const tmpPath = `${filePath}.tmp`;
    const now = deps.now ?? (() => new Date().toISOString());
    const fs = deps.fs ?? fsp;

    /** @type {Array<object>} authoritative in-memory log, committed after persist. */
    let events = [];
    let loaded = false;
    let txChain = Promise.resolve();

    async function persist(list) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const doc = { version: HISTORY_VERSION, events: list };
        const body = `${JSON.stringify(doc, null, 2)}\n`;
        await fs.writeFile(tmpPath, body, 'utf-8');
        await fs.rename(tmpPath, filePath);
    }

    async function load() {
        let raw;
        try {
            raw = await fs.readFile(filePath, 'utf-8');
        } catch (err) {
            if (err && err.code === 'ENOENT') { events = []; loaded = true; return; }
            throw err;
        }
        let doc;
        try {
            doc = JSON.parse(raw);
        } catch (err) {
            throw new Error(`history file ${filePath} is not valid JSON: ${err.message}`);
        }
        if (!doc || typeof doc !== 'object' || doc.version !== HISTORY_VERSION || !Array.isArray(doc.events)) {
            throw new Error(`history file ${filePath} has an unexpected shape or version (expected ${HISTORY_VERSION})`);
        }
        events = doc.events.map(cloneEvent);
        loaded = true;
    }

    return {
        name: 'history',
        filePath,
        dataDir,

        async start() { if (!loaded) await load(); },
        async stop() { await txChain; },
        load,

        /**
         * Append one terminal event and persist atomically. The in-memory log is
         * committed only after the disk write succeeds.
         * @param {{ sprintId: string, event: string, reason?: string, by?: string|null, members?: string[], issueRoots?: string[], at?: string }} entry
         * @returns {Promise<object>} a clone of the stored event
         */
        async record(entry) {
            if (!entry || typeof entry.sprintId !== 'string' || entry.sprintId.length === 0) {
                throw new TypeError('history.record() requires a non-empty sprintId');
            }
            if (typeof entry.event !== 'string' || entry.event.length === 0) {
                throw new TypeError('history.record() requires a non-empty event name');
            }
            const stored = cloneEvent({
                sprintId: entry.sprintId,
                event: entry.event,
                reason: entry.reason ?? null,
                by: entry.by ?? null,
                members: entry.members,
                issueRoots: entry.issueRoots,
                at: typeof entry.at === 'string' ? entry.at : now(),
            });
            const run = txChain.then(async () => {
                const next = [...events, stored];
                await persist(next);
                events = next; // commit only after the disk write succeeded
                return cloneEvent(stored);
            });
            txChain = run.catch(() => {});
            return run;
        },

        /** All recorded events (clones), in insertion order. */
        list() { return events.map(cloneEvent); },

        /** Every event for one sprint (clones), in insertion order. */
        forSprint(sprintId) {
            return events.filter((e) => e.sprintId === sprintId).map(cloneEvent);
        },

        /** The most recent event for one sprint, or undefined. */
        latestFor(sprintId) {
            for (let i = events.length - 1; i >= 0; i--) {
                if (events[i].sprintId === sprintId) return cloneEvent(events[i]);
            }
            return undefined;
        },

        get size() { return events.length; },
    };
}
