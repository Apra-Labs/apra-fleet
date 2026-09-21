// The always-on local JSONL mirror -- ground truth to diff the future
// append-blob sink against (see the implementation plan's Part B sink
// list and "Append-blob sink specifics"). Follows
// `packages/apra-fleet-se/src/supervisor/self-log.mjs`'s append-stream
// pattern (open once, `write()` per line, `end()` on stop), but every I/O
// seam is INJECTED -- this module never imports `node:fs`, per this
// package's injected-I/O rule:
//
//   - `openAppendStream(path, onError)` -- returns a writable-stream-like
//     object (`{ write(chunk), end(cb?), on?(event, fn) }`); production
//     wiring passes something built on
//     `fs.createWriteStream(path, { flags: 'a' })`, tests pass an in-memory
//     fake. `onError` is this sink's terminal-failure handler (below).
//   - `redact(record)` -- every record passes through this BEFORE it is
//     serialised. This is the one hard requirement in this file: a secret
//     that reaches `JSON.stringify()` here reaches disk, so `redact` is
//     never optional and never skippable.
//   - `clock.now()` -- stamps each line with when THIS sink received the
//     record (`receivedAt`), independent of any timestamp the record
//     itself carries -- useful for correlating the mirror against the
//     sprint's own wall clock without relying on every record shape
//     agreeing on a timestamp field name.
//
// WHY THIS SINK HAS A `health()` AND A FAILURE STATE
// -----------------------------------------------------------------------------
// A writable stream reports ENOSPC/EACCES/EBADF as an 'error' EVENT on a
// later tick; it is never thrown from `write()`. So neither this module's
// own try/catch nor `sinks/index.mjs`'s per-sink isolation can see it, and
// an unhandled 'error' event is re-thrown by Node as an uncaught exception
// -- a full disk would kill a two-day sprint over its LOG file. The
// injected `openAppendStream(path, onError)` hands that event back here
// (see `bin/runtime.mjs`), and this sink treats it as terminal: the stream
// is dead, every later record is dropped, and `health()` says so.
//
// `health()` matches `append-blob.mjs`'s shape field for field, because
// `sinks/health.mjs` reads them through one `readHealth()`. Two additions
// this sink needs and that one does not: `terminal` (a dead fd never
// self-heals, unlike a 500 that the next flush retries, so it must escalate
// on the FIRST check rather than after three) and `droppedRecords` (records
// that are gone for good, as opposed to append-blob's `pendingRecords`,
// which are still buffered and will be retried).

import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';
import { stampAndSerialize } from './record.mjs';
import { createRedactor } from '../log-safe.mjs';

/**
 * How long `stop()` waits for the append stream to flush before giving up
 * and returning anyway.
 *
 * WHY FIVE SECONDS: flushing a few buffered lines to a local file is a
 * sub-millisecond operation, so any value here is pure headroom for a
 * loaded disk -- but the wait must be BOUNDED, because a stream wedged on a
 * dead network mount or a full disk may never emit 'finish' at all, and an
 * unbounded await would hang daemon shutdown forever (the one thing worse
 * than losing the tail of a log file). Five seconds is far more than a real
 * local flush ever needs, and comfortably inside the ~10-30s grace a
 * SIGTERM/service-manager shutdown allows, so the bound can fire and still
 * leave time to report it before the process is killed.
 */
export const DEFAULT_STOP_TIMEOUT_MS = 5000;

function safeMessage(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * @param {object} deps
 * @param {string} deps.path - destination file path (append mode).
 * @param {(path: string, onError?: (err: any) => void) => { write: (chunk: string) => any, end?: (cb?: Function) => any, on?: Function }} deps.openAppendStream
 *   - injected; opens (or returns an already-open) append-mode stream for `path`. The second
 *   argument is this sink's stream-error handler; a stream implementation that ignores it (an
 *   older wrapper, or a test fake) still works -- this sink also subscribes via
 *   `stream.on('error')` when the object exposes one, so the crash-proofing does not depend
 *   on a single wiring point.
 * @param {(record: any) => any} [deps.redact] - injected; strips secrets before a record is serialised.
 *   Optional -- when omitted, defaults to `log-safe.mjs`'s `createRedactor()` (key-name +
 *   credential-URL masking) rather than leaving a caller who forgot this with NO redaction
 *   at all, which was the wrong default. Still validated: a value that IS provided but is
 *   not a function is a caller mistake worth a loud CONFIG_MISSING, not a silent fallback.
 * @param {{ now: () => string|number, setTimeout?: Function, clearTimeout?: Function }} deps.clock
 *   - injected; `now()` stamps each line's `receivedAt`. When it also carries
 *   `setTimeout`/`clearTimeout` those are used for `stop()`'s bounded wait, so a caller can
 *   drive that wait without a real timer; otherwise the global timers are used.
 * @param {number} [deps.stopTimeoutMs] - default DEFAULT_STOP_TIMEOUT_MS.
 * @returns {{ start: () => void, emit: (record: any) => void, flushNow: () => void, stop: () => Promise<void>, health: () => object }}
 * @throws {BridgeError} CONFIG_MISSING if any required dependency is absent, CONFIG_INVALID for a bad stopTimeoutMs
 */
export function createJsonlFileSink({ path, openAppendStream, redact, clock, stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS } = {}) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, 'createJsonlFileSink requires a non-empty path', {});
  }
  if (typeof openAppendStream !== 'function') {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, 'createJsonlFileSink requires an injected openAppendStream', {});
  }
  if (redact === undefined) {
    redact = createRedactor();
  } else if (typeof redact !== 'function') {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, 'createJsonlFileSink: redact, when provided, must be a function', {});
  }
  if (!clock || typeof clock.now !== 'function') {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, 'createJsonlFileSink requires an injected clock with now()', {});
  }
  if (typeof stopTimeoutMs !== 'number' || !Number.isFinite(stopTimeoutMs) || stopTimeoutMs <= 0) {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_INVALID, 'createJsonlFileSink requires a positive stopTimeoutMs', { value: stopTimeoutMs });
  }

  const setTimer = typeof clock.setTimeout === 'function' ? (fn, ms) => clock.setTimeout(fn, ms) : (fn, ms) => setTimeout(fn, ms);
  const clearTimer = typeof clock.clearTimeout === 'function' ? (id) => clock.clearTimeout(id) : (id) => clearTimeout(id);

  let stream = null;
  let started = false;
  let stopped = false;

  // -- health bookkeeping (see the file header) --------------------------
  let failed = false;
  let streamErrors = 0;
  let writesOk = 0;
  let droppedRecords = 0;
  let lastSuccessAt = null;
  let lastFailureAt = null;
  let lastFailure = null;
  let lastErrorSeen = null;

  /**
   * Redact any string before it is stored on the health surface. An fs error
   * message legitimately quotes the path it failed on, and the health
   * surface is logged by `sinks/health.mjs` -- so it goes through the same
   * redactor every record goes through, and can never widen into a leak.
   */
  function safeText(value) {
    try {
      const out = redact(String(value));
      return typeof out === 'string' ? out : String(value);
    } catch {
      return '[unredactable message]';
    }
  }

  /**
   * The stream is dead. Record it; never throw, never rethrow. Called from
   * the injected `openAppendStream`'s error callback, from `stream.on('error')`
   * when the object is an EventEmitter, and from a synchronous `write()`
   * throw -- all three describe the same terminal condition, and the same
   * physical error arriving by two of those routes is counted once.
   */
  function noteStreamFailure(err) {
    if (err !== null && err !== undefined && err === lastErrorSeen) return;
    lastErrorSeen = err;
    failed = true;
    streamErrors += 1;
    lastFailureAt = clock.now();
    lastFailure = safeText(safeMessage(err));
  }

  function ensureStarted() {
    if (started) return;
    started = true;
    stream = openAppendStream(path, noteStreamFailure);
    // Belt and braces: if the injected opener ignored the callback argument
    // (an older wrapper, or a fake), subscribing here still keeps the
    // 'error' event handled -- which is what stops Node killing the process.
    if (stream && typeof stream.on === 'function') {
      try {
        stream.on('error', noteStreamFailure);
      } catch {
        // A stream-like object with a hostile on() is not worth dying for.
      }
    }
  }

  return {
    name: 'jsonl-file',
    path,

    /** Open the append stream. Idempotent -- a second call is a no-op. */
    start() {
      ensureStarted();
    },

    /**
     * Redact and append one record as a single JSON line. Auto-starts the
     * stream on first use if `start()` was never called explicitly, so a
     * caller wiring this sink into `createSinkFan` (which does call
     * `start()` itself) and a caller using it standalone both work.
     * A no-op once `stop()` has been called -- records emitted after stop
     * are deliberately dropped rather than reopening a closed stream or
     * throwing (the fan's own `stats()` is where a caller should notice a
     * sink has gone quiet, not a thrown error from a late emit).
     * Once the stream has errored the record is dropped and COUNTED, so
     * `health()` can say how much of the mirror is missing.
     * @param {any} record
     */
    emit(record) {
      if (stopped) return;
      ensureStarted();
      if (failed) {
        droppedRecords += 1;
        return;
      }
      try {
        stream.write(stampAndSerialize(record, redact, clock));
        writesOk += 1;
        lastSuccessAt = clock.now();
      } catch (err) {
        // A synchronous throw from write() (write-after-end, a wedged fd)
        // is the same terminal condition as the async 'error' event.
        noteStreamFailure(err);
        droppedRecords += 1;
      }
    },

    /**
     * No-op seam kept for symmetry with the other sinks in this package
     * (the append-blob sink genuinely batches on a timer and needs a real
     * flush; this one writes unbuffered from this module's own
     * perspective, so there is nothing here to flush).
     */
    flushNow() {},

    /**
     * Close the append stream and WAIT for the flush. Idempotent, never
     * throws, and bounded by `stopTimeoutMs` (see DEFAULT_STOP_TIMEOUT_MS
     * for why it is bounded at all). `end()` is still called synchronously,
     * so a caller that does not await this still closes the stream.
     * @returns {Promise<void>}
     */
    stop() {
      if (stopped) return Promise.resolve();
      stopped = true;
      if (!stream || typeof stream.end !== 'function') return Promise.resolve();

      const isEmitter = typeof stream.on === 'function';
      const takesCallback = stream.end.length >= 1;
      if (!isEmitter && !takesCallback) {
        // Nothing to wait ON: a stream-like object whose end() is
        // synchronous and reports completion no other way. Waiting would
        // mean waiting out the whole bound for no information.
        try {
          stream.end();
        } catch (err) {
          noteStreamFailure(err);
        }
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        let settled = false;
        let timerId = null;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (timerId !== null) {
            clearTimer(timerId);
            timerId = null;
          }
          resolve();
        };
        timerId = setTimer(() => {
          timerId = null;
          if (settled) return;
          // The bound fired: the stream never reported completion. Say so on
          // the health surface rather than pretending the tail was written.
          noteStreamFailure(new Error(`append stream for ${path} did not finish within ${stopTimeoutMs}ms; buffered records may be lost`));
          finish();
        }, stopTimeoutMs);

        if (isEmitter) {
          const subscribe = typeof stream.once === 'function' ? (ev, fn) => stream.once(ev, fn) : (ev, fn) => stream.on(ev, fn);
          try {
            subscribe('finish', finish);
            subscribe('close', finish);
            subscribe('error', finish);
          } catch {
            // Fall through: the bound above still ends this wait.
          }
        }
        try {
          if (takesCallback) {
            stream.end((err) => {
              if (err) noteStreamFailure(err);
              finish();
            });
          } else {
            stream.end();
          }
        } catch (err) {
          noteStreamFailure(err);
          finish();
        }
      });
    },

    /**
     * Whether this mirror is actually being written -- the same shape
     * `append-blob.mjs` publishes, plus `terminal` and `droppedRecords`
     * (see the file header for why those two exist here and not there).
     * A PURE GETTER: no I/O, no control flow, never throws, consistent with
     * what `sinks/health.mjs` contracts for.
     * @returns {{ name: string, healthy: boolean, terminal: boolean, consecutiveFailures: number,
     *   successfulFlushes: number, pendingRecords: number, droppedRecords: number,
     *   lastSuccessAt: any, lastFailureAt: any, lastFailure: string|null, target: string }}
     */
    health() {
      return {
        name: 'jsonl-file',
        healthy: !failed,
        // A dead file descriptor does not retry itself, so a single failure
        // is already permanent -- `terminal` is what tells sinks/health.mjs
        // not to wait for `unhealthyAfter` consecutive failures here.
        terminal: failed,
        consecutiveFailures: streamErrors,
        successfulFlushes: writesOk,
        // Nothing is held in memory by this sink: a record either reached
        // the stream or is gone. `droppedRecords` is the honest counterpart
        // of append-blob's retryable `pendingRecords`.
        pendingRecords: 0,
        droppedRecords,
        lastSuccessAt,
        lastFailureAt,
        lastFailure,
        target: safeText(path),
      };
    },
  };
}
