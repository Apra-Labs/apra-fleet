// The sink fan-out -- see the implementation plan's Part B
// (`src/sinks/ -- index.mjs (fan-out) + jsonl-file + append-blob +
// append-blob-http`) and section 7 (observability).
//
// PER-SINK ISOLATION IS THE WHOLE POINT: one sink throwing (or rejecting)
// must never abort a caller's loop (`watch`, in particular) or prevent
// every OTHER sink from receiving the same record. Each sink's `emit()` is
// wrapped individually; a failure is counted and logged ONCE for that
// sink, not once per record -- a sink that starts failing partway through
// a two-day sprint would otherwise flood the log with an entry per tick.
// `stats()` exposes the per-sink success/failure counts so a caller can
// report degradation (e.g. "the append-blob sink has failed N times;
// the local JSONL mirror is still current") without this module deciding
// what to do about it.

import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';

/**
 * @typedef {{ name: string, sink: { start?: Function, emit: Function, flushNow?: Function, stop?: Function } }} SinkEntry
 */

/**
 * @param {object} deps
 * @param {SinkEntry[]} deps.sinks - non-empty; each entry names a sink for `stats()`/log messages.
 * @param {(message: string) => void} [deps.log] - injected; defaults to `console.error`. Never `console.log`
 *   directly imported elsewhere in this module -- this is the one, explicit logging seam.
 * @returns {{
 *   emit: (record: any) => Promise<void>,
 *   flushNow: () => Promise<void>,
 *   stop: () => Promise<void>,
 *   stats: () => Record<string, { success: number, failure: number }>,
 * }}
 * @throws {BridgeError} CONFIG_MISSING/CONFIG_INVALID for a missing or malformed `sinks` list
 */
export function createSinkFan({ sinks, log } = {}) {
  if (!Array.isArray(sinks) || sinks.length === 0) {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, 'createSinkFan requires a non-empty array of { name, sink } entries', {});
  }
  const seenNames = new Set();
  for (const entry of sinks) {
    if (!entry || typeof entry.name !== 'string' || entry.name.length === 0) {
      throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_INVALID, 'createSinkFan: every entry needs a non-empty name', { entry });
    }
    if (!entry.sink || typeof entry.sink.emit !== 'function') {
      throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_INVALID, `createSinkFan: sink "${entry.name}" has no emit() function`, { name: entry.name });
    }
    if (seenNames.has(entry.name)) {
      throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_INVALID, `createSinkFan: duplicate sink name "${entry.name}"`, { name: entry.name });
    }
    seenNames.add(entry.name);
  }

  const logFn = typeof log === 'function' ? log : (msg) => console.error(msg);

  // Per-sink bookkeeping. `loggedEmitFailure` gates the "log once" rule for
  // emit() specifically -- start()/flushNow()/stop() are each best-effort,
  // whole-of-fan operations invoked rarely (not once per record), so their
  // failures are always logged (there is no flood risk to guard against).
  const records = new Map(sinks.map((entry) => [entry.name, {
    entry,
    success: 0,
    failure: 0,
    loggedEmitFailure: false,
  }]));

  // start() is best-effort and isolated exactly like emit(): a sink whose
  // start() throws stays registered (later emits may still succeed, e.g. a
  // transient failure opening a stream) rather than being dropped from the
  // fan entirely.
  for (const rec of records.values()) {
    if (typeof rec.entry.sink.start === 'function') {
      try {
        rec.entry.sink.start();
      } catch (err) {
        logFn(`[sink-fan] sink "${rec.entry.name}" failed to start: ${errMessage(err)}`);
      }
    }
  }

  function errMessage(err) {
    return err && err.message ? err.message : String(err);
  }

  async function emitOne(rec, record) {
    try {
      await rec.entry.sink.emit(record);
      rec.success += 1;
    } catch (err) {
      rec.failure += 1;
      if (!rec.loggedEmitFailure) {
        rec.loggedEmitFailure = true;
        logFn(`[sink-fan] sink "${rec.entry.name}" failed on emit (further failures for this sink are counted in stats() but not logged again): ${errMessage(err)}`);
      }
    }
  }

  return {
    /**
     * Fan `record` out to every sink, isolating each one. Never rejects --
     * a per-sink failure is caught, counted, and logged (once); this
     * function's own promise always resolves once every sink has been
     * tried.
     * @param {any} record
     * @returns {Promise<void>}
     */
    async emit(record) {
      await Promise.all([...records.values()].map((rec) => emitOne(rec, record)));
    },

    /**
     * Best-effort `flushNow()` across every sink that defines one. Isolated
     * the same way as `emit()`, but every failure is logged (flush is a
     * rare, whole-of-fan call, not a per-record one).
     * @returns {Promise<void>}
     */
    async flushNow() {
      await Promise.all([...records.values()].map(async (rec) => {
        if (typeof rec.entry.sink.flushNow !== 'function') return;
        try {
          await rec.entry.sink.flushNow();
        } catch (err) {
          logFn(`[sink-fan] sink "${rec.entry.name}" failed to flush: ${errMessage(err)}`);
        }
      }));
    },

    /**
     * Best-effort `stop()` across every sink that defines one. Isolated the
     * same way as `flushNow()` -- one sink failing to stop cleanly must
     * never prevent the others from being asked to stop too.
     * @returns {Promise<void>}
     */
    async stop() {
      await Promise.all([...records.values()].map(async (rec) => {
        if (typeof rec.entry.sink.stop !== 'function') return;
        try {
          await rec.entry.sink.stop();
        } catch (err) {
          logFn(`[sink-fan] sink "${rec.entry.name}" failed to stop: ${errMessage(err)}`);
        }
      }));
    },

    /**
     * Per-sink emit() success/failure counters, keyed by name.
     * @returns {Record<string, { success: number, failure: number }>}
     */
    stats() {
      const out = {};
      for (const [name, rec] of records.entries()) {
        out[name] = { success: rec.success, failure: rec.failure };
      }
      return out;
    },
  };
}
