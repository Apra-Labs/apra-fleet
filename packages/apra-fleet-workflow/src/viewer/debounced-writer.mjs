// apra-fleet-eft.2.1: debounced sprint-state writer with flush-on-exit.
//
// This is additive to (not a replacement for) the existing
// sprint-logs/sprint_<HHMMSS>.json write-once-on-end persistState() in
// src/viewer/index.mjs, which stays exactly as-is as the child
// crash-safety net. This writer coalesces bursts of rapid state changes
// (e.g. one per activity/phase/state event, see apra-fleet-eft.2.2) into a
// single write per debounce window, and always flushes synchronously
// before the process actually exits (end, SIGINT, SIGTERM, /stop).
//
// The target file path passed in today is a placeholder -- the real
// running/<sprintId>.json -> old_sprints/<sprintId>.json layout under the
// service data directory is wired in a later task (apra-fleet-eft.2.3).

import fs from 'fs';
import path from 'path';

export const MIN_DEBOUNCE_MS = 200;
export const MAX_DEBOUNCE_MS = 500;
export const DEFAULT_DEBOUNCE_MS = 300;

export class DebouncedStateWriter {
    /**
     * @param {object} opts
     * @param {() => any} opts.getState - returns the current state snapshot to serialize.
     * @param {string} opts.filePath - target file path to write to.
     * @param {number} [opts.debounceMs] - coalescing window in ms; must be in
     *   [MIN_DEBOUNCE_MS, MAX_DEBOUNCE_MS], defaults to DEFAULT_DEBOUNCE_MS.
     */
    constructor({ getState, filePath, debounceMs = DEFAULT_DEBOUNCE_MS } = {}) {
        if (typeof getState !== 'function') {
            throw new TypeError('DebouncedStateWriter requires a getState() function');
        }
        if (!filePath) {
            throw new TypeError('DebouncedStateWriter requires a filePath');
        }
        if (typeof debounceMs !== 'number' || Number.isNaN(debounceMs) ||
            debounceMs < MIN_DEBOUNCE_MS || debounceMs > MAX_DEBOUNCE_MS) {
            throw new RangeError(
                `debounceMs must be a number between ${MIN_DEBOUNCE_MS} and ${MAX_DEBOUNCE_MS} (got ${debounceMs})`
            );
        }

        this._getState = getState;
        this._filePath = filePath;
        this._debounceMs = debounceMs;
        this._timer = null;
        this._dirty = false;
        this._writeCount = 0;
    }

    /** Number of debounce window in ms this writer coalesces bursts into. */
    get debounceMs() {
        return this._debounceMs;
    }

    /** Total number of times this writer has actually written to disk. */
    get writeCount() {
        return this._writeCount;
    }

    /**
     * Mark state as dirty and schedule a write in `debounceMs` if one isn't
     * already pending. Rapid repeated calls within the window coalesce into
     * a single write.
     */
    schedule() {
        this._dirty = true;
        if (this._timer) return;
        this._timer = setTimeout(() => {
            this._timer = null;
            this._writeNow();
        }, this._debounceMs);
        // Never let a pending debounce timer keep the process alive on its own.
        if (this._timer && typeof this._timer.unref === 'function') {
            this._timer.unref();
        }
    }

    /**
     * Synchronously flush any pending (or just-scheduled) write immediately.
     * Cancels any outstanding debounce timer first so this never races a
     * later async write. Safe to call even when nothing is dirty (no-op).
     * Must be called from every process-exit path (end, SIGINT, SIGTERM,
     * cooperative /stop) so a debounce window is never lost on shutdown.
     */
    flushSync() {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        if (!this._dirty) return;
        this._writeNow();
    }

    _writeNow() {
        this._dirty = false;
        try {
            const dir = path.dirname(this._filePath);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this._filePath, JSON.stringify(this._getState(), null, 2));
            this._writeCount += 1;
        } catch (e) {
            // A failed write must never crash or block the sprint's own
            // normal exit behavior -- log and move on, same contract as
            // the existing persistState() in index.mjs.
            console.warn(`[Viewer] Warning: failed to write debounced state file: ${e.message}`);
        }
    }
}
