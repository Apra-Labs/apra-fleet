// apra-fleet-eft.2.1: debounced run-state writer with flush-on-exit.
//
// This is additive to (not a replacement for) the existing
// terminal snapshot's write-once-on-end persistState() in
// src/viewer/index.mjs, which stays exactly as-is as the child
// crash-safety net. This writer coalesces bursts of rapid state changes
// (e.g. one per activity/phase/state event, see apra-fleet-eft.2.2) into a
// single write per debounce window, and always flushes synchronously
// before the process actually exits (end, SIGINT, SIGTERM, /stop).
//
// The target file path passed in today is a placeholder -- the real
// running/<runId>.json -> old_runs/<runId>.json layout under the
// service data directory is wired in a later task (apra-fleet-eft.2.3).

import fs from 'fs';
import path from 'path';

export const MIN_DEBOUNCE_MS = 200;
export const MAX_DEBOUNCE_MS = 500;
export const DEFAULT_DEBOUNCE_MS = 300;

// apra-fleet-eft.20.1: single shared atomic-JSON-write primitive for every
// run-state persistence path in this package (the debounced writer below
// AND the terminal-snapshot persistState() in ../viewer/index.mjs). Centralizing
// this here guarantees two invariants that a hand-rolled/partial-patch writer
// could otherwise violate:
//   1. The full object is always serialized in ONE JSON.stringify pass -- no
//      code path ever splices/patches individual fields into previously
//      serialized text (the kind of string surgery that produced the
//      `"phase"":"Develop"` doubled-quote corruption in apra-fleet-eft.20:
//      a stray extra `"` inserted by an in-place field patch rather than a
//      single whole-object serialization). Because the input to
//      fs.writeFileSync is always the direct output of JSON.stringify(), the
//      written bytes are guaranteed to round-trip through JSON.parse().
//   2. The write is atomic: bytes land in a sibling temp file first, then
//      `fs.renameSync` (a single filesystem operation on POSIX) swaps it into
//      place, so a reader (or a crash mid-write) can never observe a
//      truncated/partial file -- only the old complete file or the new
//      complete one.
// The temp filename includes both the pid and a monotonic counter (not just
// Date.now(), which can collide when called faster than the clock's
// resolution) so concurrent/rapid writers targeting the same filePath never
// collide on the same temp path.
let _tmpSeq = 0;
export function writeJsonFileAtomic(filePath, data) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = path.join(
        dir,
        `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${_tmpSeq++}.tmp`
    );
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, filePath);
}

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
            // Write atomically: a concurrent reader (watchdog/dashboard/
            // history views, or this package's own tests) must never observe
            // a partially-written file, and a SIGKILL landing mid-write must
            // never corrupt the previous, still-valid state on disk. Writing
            // to a sibling temp path and renaming into place is atomic on
            // POSIX (rename is a single filesystem operation), so readers see
            // either the old complete file or the new complete file, never a
            // truncated one. The whole state snapshot is always serialized in
            // one JSON.stringify() pass (see writeJsonFileAtomic above) --
            // never patched field-by-field -- so the written bytes always
            // round-trip through JSON.parse().
            writeJsonFileAtomic(this._filePath, this._getState());
            this._writeCount += 1;
        } catch (e) {
            // A failed write must never crash or block the run's own
            // normal exit behavior -- log and move on, same contract as
            // the existing persistState() in index.mjs.
            console.warn(`[Viewer] Warning: failed to write debounced state file: ${e.message}`);
        }
    }
}
