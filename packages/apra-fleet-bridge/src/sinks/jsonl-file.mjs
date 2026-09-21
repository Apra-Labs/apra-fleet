// The always-on local JSONL mirror -- ground truth to diff the future
// append-blob sink against (see the implementation plan's Part B sink
// list and "Append-blob sink specifics"). Follows
// `packages/apra-fleet-se/src/supervisor/self-log.mjs`'s append-stream
// pattern (open once, `write()` per line, `end()` on stop), but every I/O
// seam is INJECTED -- this module never imports `node:fs`, per this
// package's injected-I/O rule:
//
//   - `openAppendStream(path)` -- returns a writable-stream-like object
//     (`{ write(chunk), end(cb?) }`); production wiring passes something
//     built on `fs.createWriteStream(path, { flags: 'a' })`, tests pass an
//     in-memory fake.
//   - `redact(record)` -- every record passes through this BEFORE it is
//     serialised. This is the one hard requirement in this file: a secret
//     that reaches `JSON.stringify()` here reaches disk, so `redact` is
//     never optional and never skippable.
//   - `clock.now()` -- stamps each line with when THIS sink received the
//     record (`receivedAt`), independent of any timestamp the record
//     itself carries -- useful for correlating the mirror against the
//     sprint's own wall clock without relying on every record shape
//     agreeing on a timestamp field name.

import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';
import { stampAndSerialize } from './record.mjs';
import { createRedactor } from '../log-safe.mjs';

/**
 * @param {object} deps
 * @param {string} deps.path - destination file path (append mode).
 * @param {(path: string) => { write: (chunk: string) => any, end?: (cb?: Function) => any }} deps.openAppendStream
 *   - injected; opens (or returns an already-open) append-mode stream for `path`.
 * @param {(record: any) => any} [deps.redact] - injected; strips secrets before a record is serialised.
 *   Optional -- when omitted, defaults to `log-safe.mjs`'s `createRedactor()` (key-name +
 *   credential-URL masking) rather than leaving a caller who forgot this with NO redaction
 *   at all, which was the wrong default. Still validated: a value that IS provided but is
 *   not a function is a caller mistake worth a loud CONFIG_MISSING, not a silent fallback.
 * @param {{ now: () => string|number }} deps.clock - injected; `now()` stamps each line's `receivedAt`.
 * @returns {{ start: () => void, emit: (record: any) => void, flushNow: () => void, stop: () => void }}
 * @throws {BridgeError} CONFIG_MISSING if any required dependency is absent
 */
export function createJsonlFileSink({ path, openAppendStream, redact, clock } = {}) {
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

  let stream = null;
  let started = false;
  let stopped = false;

  function ensureStarted() {
    if (started) return;
    started = true;
    stream = openAppendStream(path);
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
     * @param {any} record
     */
    emit(record) {
      if (stopped) return;
      ensureStarted();
      stream.write(stampAndSerialize(record, redact, clock));
    },

    /**
     * No-op seam kept for symmetry with the other sinks in this package
     * (the append-blob sink genuinely batches on a timer and needs a real
     * flush; this one writes unbuffered from this module's own
     * perspective, so there is nothing here to flush).
     */
    flushNow() {},

    /** Close the append stream. Idempotent -- a second call is a no-op. */
    stop() {
      if (stopped) return;
      stopped = true;
      if (stream && typeof stream.end === 'function') {
        stream.end();
      }
    },
  };
}
