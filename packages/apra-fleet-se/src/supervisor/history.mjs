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

import { renameWithRetry } from './rename-with-retry.mjs';

/** On-disk schema version for the persisted history document. */
export const HISTORY_VERSION = 1;

/** Default file name for the persisted history inside the service data dir. */
export const HISTORY_FILENAME = 'sprint-history.json';

/** Recognized terminal event names recorded by eft.5.4 flows. */
export const HISTORY_EVENTS = Object.freeze({
    ABORTED_BY_RESTART: 'aborted-by-restart',
    FORCE_RELEASED: 'force-released',
    // apra-fleet-k7b.3: the spawner's own SAME-INSTANCE `child.once('exit',
    // ...)` observation -- NOT a terminal reservation event (the ledger
    // reservation stays held; see ledger.mjs's recordExit() doc comment).
    // Recorded here too (in addition to the ledger annotation) so the exit
    // is visible in the durable audit trail even once the reservation is
    // eventually released.
    CHILD_EXITED: 'child-exited',
    // apra-fleet-k7b.2: the watchdog observed a PID-gone sprint WITH a
    // persisted terminal run-state (old_runs/, or the legacy branch-keyed
    // fallback) -- i.e. classifySprint() returned FINISHED, not CRASHED.
    // Recorded the first time this instance's watchdog classifies a given
    // sprint FINISHED (see watchdog.mjs's `recordedFinishes` guard), same
    // once-per-sprint discipline as apra-fleet-eft.20.3's CRASHED recorder.
    FINISHED: 'finished',
    // apra-fleet-0j1 / apra-fleet-cvb.1: the watchdog itself released a
    // still-held reservation the moment it classified the sprint CRASHED or
    // FINISHED -- mirroring reconcile()'s ABORTED_BY_RESTART (restart-time)
    // and forceRelease()'s FORCE_RELEASED (operator-initiated) events, but
    // for the AUTOMATIC, continuous, mid-run case neither of those covers.
    AUTO_RELEASED: 'auto-released',
    // apra-fleet-gey.1: the watchdog observed a sprint whose child exited
    // within the configurable launch-failed window (default 60s) with no
    // terminal state recorded -- a symptom of immediate child failure (e.g.
    // a missing dependency, a hard-crash before first dispatch). Distinct
    // from CRASHED to surface this diagnostic signal separately.
    LAUNCH_FAILED: 'launch-failed',
});

/** An empty, well-formed history document. */
export function emptyHistoryDocument() {
    return { version: HISTORY_VERSION, events: [] };
}

// apra-fleet-gey.2: the relaunch gate (api.mjs's launch()) needs "what was
// the prior incarnation of THIS issueRoot's terminal outcome" -- but only
// the RELEASE events (AUTO_RELEASED / FORCE_RELEASED / ABORTED_BY_RESTART,
// and CHILD_EXITED) carry `issueRoots` today (watchdog.mjs/reconcile.mjs
// always pass it through from the ledger entry being released/observed);
// the DETAIL events (FINISHED with its terminalReason/verdict, LAUNCH_FAILED
// with its reason) do not -- see defaultRecordFinished()/classifySprint()'s
// history.record() calls in watchdog.mjs. Both event shapes are always
// recorded under the SAME `sprintId` (the run-id, apra-fleet-k7b.1/.2) for
// one incarnation, so `latestForIssueRoot()` below correlates them by that
// shared key: find the most recent issueRoots-carrying event to identify
// WHICH sprintId was this root's last incarnation, then pull the actual
// terminal detail (FINISHED > LAUNCH_FAILED > the anchor event itself) from
// that sprintId's own event history.

/** Recognized terminal-event kinds latestForIssueRoot() reads its terminal-record shape's `event` from. */
const TERMINAL_DETAIL_EVENTS = Object.freeze([HISTORY_EVENTS.FINISHED, HISTORY_EVENTS.LAUNCH_FAILED]);

/**
 * Terminal reasons the engine itself flags as "must not be retried blindly"
 * (fleet-sprint/runner.js's resolveTerminalReason()/findDoltDivergedCause()):
 * an unmergeable Dolt/beads sync conflict is the concrete case that motivated
 * this gate (the apra-fleet-bnb-de118180 incident). Extend this set as more
 * such reasons are identified elsewhere in the engine; an unlisted reason
 * simply does not gate a relaunch (a false negative here only skips a
 * warning -- it never blocks a legitimate relaunch).
 */
export const DETERMINISTIC_TERMINAL_REASONS = Object.freeze(new Set(['BEADS_SYNC_CONFLICT']));

/**
 * True when a `latestForIssueRoot()` terminal record represents a reason
 * that will almost certainly recur on an identical relaunch unless something
 * about the request/environment changes first -- either:
 *   - a LAUNCH_FAILED incarnation (apra-fleet-gey.1: the child exited within
 *     the launch window before any dispatch ever ran -- e.g. an Arg Contract
 *     violation, a missing member beads DB -- always reproducible from the
 *     SAME request), or
 *   - a FINISHED incarnation whose terminalReason the engine flagged as
 *     must-not-be-retried-blindly (DETERMINISTIC_TERMINAL_REASONS above).
 * @param {{ event?: string|null, terminalReason?: string|null }|null|undefined} record
 * @returns {boolean}
 */
export function isDeterministicTerminalReason(record) {
    if (!record) return false;
    if (record.event === HISTORY_EVENTS.LAUNCH_FAILED) return true;
    return typeof record.terminalReason === 'string' && DETERMINISTIC_TERMINAL_REASONS.has(record.terminalReason);
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
        // apra-fleet-k7b.3: only meaningful for a CHILD_EXITED event; null for
        // every other (pre-existing) event kind, matching `by`'s optional
        // null-default convention above.
        exitCode: e.exitCode === undefined ? null : e.exitCode,
        signal: e.signal === undefined ? null : e.signal,
        // apra-fleet-ou7.1: same optional/null-default convention -- the
        // sprint's per-sprint raw log file path, recorded on a CHILD_EXITED
        // event so it is still discoverable once the ledger reservation that
        // originally carried it is released.
        logPath: e.logPath === undefined ? null : e.logPath,
        // apra-fleet-k7b.2: only meaningful for a FINISHED event -- the
        // engine's own terminalReason / extensions.terminal.verdict, copied
        // verbatim from the persisted terminal run-state so the durable
        // audit trail carries the SAME words the watchdog log line and the
        // History view do. Null for every other (pre-existing) event kind,
        // same optional/null-default convention as the fields above.
        terminalReason: e.terminalReason === undefined ? null : e.terminalReason,
        verdict: e.verdict === undefined ? null : e.verdict,
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
 *   renameRetry?: {
 *     maxAttempts?: number,
 *     baseDelayMs?: number,
 *     sleep?: (ms: number) => Promise<void>,
 *   },
 *     apra-fleet-ed4.1: bounded EPERM/EBUSY retry options for the persist()
 *     rename step (see rename-with-retry.mjs) -- injectable so a test can
 *     drive a fake clock with no real sleeps. Defaults to
 *     renameWithRetry()'s own defaults (5 attempts, ~10ms escalating).
 * }} [deps]
 */
export function createHistory(deps = {}) {
    const dataDir = deps.dataDir ?? defaultDataDir();
    const filePath = deps.filePath ?? path.join(dataDir, HISTORY_FILENAME);
    const tmpPath = `${filePath}.tmp`;
    const now = deps.now ?? (() => new Date().toISOString());
    const fs = deps.fs ?? fsp;
    const renameRetryOpts = deps.renameRetry ?? {};

    /** @type {Array<object>} authoritative in-memory log, committed after persist. */
    let events = [];
    let loaded = false;
    let txChain = Promise.resolve();

    async function persist(list) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const doc = { version: HISTORY_VERSION, events: list };
        const body = `${JSON.stringify(doc, null, 2)}\n`;
        await fs.writeFile(tmpPath, body, 'utf-8');
        // apra-fleet-ed4.1: bounded EPERM/EBUSY retry -- on Windows this
        // rename can transiently fail while the destination is momentarily
        // locked/open elsewhere, which used to silently drop this event.
        await renameWithRetry(fs, tmpPath, filePath, renameRetryOpts);
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
         * @param {{ sprintId: string, event: string, reason?: string, by?: string|null, members?: string[], issueRoots?: string[], at?: string, exitCode?: number|null, signal?: string|null, logPath?: string|null, terminalReason?: string|null, verdict?: string|null }} entry
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
                exitCode: entry.exitCode,
                signal: entry.signal,
                logPath: entry.logPath,
                terminalReason: entry.terminalReason,
                verdict: entry.verdict,
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

        /**
         * apra-fleet-gey.2: the most recent terminal record for one
         * issueRoot -- used by the relaunch gate (api.mjs's launch()) to
         * decide whether a same-root relaunch should be refused/warned. See
         * this module's file-level "gey.2" doc comment above for why this
         * correlates two different event shapes by their shared sprintId
         * rather than reading a single event directly.
         *
         * Returns `undefined` when this issueRoot has no issueRoots-carrying
         * event at all -- a true first launch (or one whose only prior
         * incarnations are still live/running-unresponsive with nothing
         * terminal yet) -- callers must treat that as "nothing to gate on".
         * @param {string} issue
         * @returns {{ sprintId: string, event: string|null, reason: string|null, terminalReason: string|null, verdict: string|null, at: string }|undefined}
         */
        latestForIssueRoot(issue) {
            if (typeof issue !== 'string' || issue.length === 0) return undefined;
            let anchor;
            for (let i = events.length - 1; i >= 0; i--) {
                if ((events[i].issueRoots ?? []).includes(issue)) { anchor = events[i]; break; }
            }
            if (!anchor) return undefined;
            let detail = anchor;
            for (const kind of TERMINAL_DETAIL_EVENTS) {
                let hit;
                for (let i = events.length - 1; i >= 0; i--) {
                    if (events[i].sprintId === anchor.sprintId && events[i].event === kind) { hit = events[i]; break; }
                }
                if (hit) { detail = hit; break; }
            }
            return {
                sprintId: anchor.sprintId,
                event: detail.event ?? null,
                reason: detail.reason ?? null,
                terminalReason: detail.terminalReason ?? null,
                verdict: detail.verdict ?? null,
                at: anchor.at,
            };
        },

        get size() { return events.length; },
    };
}
