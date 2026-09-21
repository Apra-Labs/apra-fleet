// Two small, PURE, stateful helpers for pacing how often the bridge talks
// back to the outside world (a work-item comment, a status update) over a
// sprint that can run for two days. See the implementation plan's Part B
// and section 7 (observability): "a two-day sprint must produce a
// readable dozen work-item comments, not thousands."
//
// Neither export does any I/O, and neither touches a real timer: `next()`
// and `shouldAnnounce()` only ever return values -- the CALLER is
// responsible for actually waiting `next()` milliseconds (with its own
// injected `sleep`, the same way `await-gate.mjs` does) or for actually
// announcing when `shouldAnnounce()` returns `true`. That split is what
// keeps this module trivially testable with no fake clock at all.

import { BridgeError, BRIDGE_ERROR_CODES } from './errors.mjs';
import { phaseChanged } from './snapshot.mjs';

/**
 * A widening-then-capped backoff counter. `next()` returns `initialMs` the
 * first time it is called, then multiplies by `factor` (capped at `maxMs`)
 * on every subsequent call; `reset()` returns it to the pre-first-call
 * state. Pure arithmetic -- holds no timer, starts no interval.
 *
 * @param {{ initialMs?: number, maxMs?: number, factor?: number }} [opts]
 * @returns {{ next: () => number, reset: () => void }}
 * @throws {BridgeError} CONFIG_INVALID for a non-widening or malformed configuration
 */
export function createBackoff({ initialMs = 5000, maxMs = 60000, factor = 2 } = {}) {
  if (typeof initialMs !== 'number' || !Number.isFinite(initialMs) || initialMs <= 0) {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_INVALID, 'createBackoff requires a positive initialMs', { initialMs });
  }
  if (typeof maxMs !== 'number' || !Number.isFinite(maxMs) || maxMs < initialMs) {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_INVALID, 'createBackoff requires maxMs >= initialMs', { initialMs, maxMs });
  }
  // factor <= 1 would produce a flat or shrinking backoff, which defeats
  // the entire point (and would never reach maxMs) -- almost certainly a
  // caller bug, so it is rejected here rather than silently accepted.
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 1) {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_INVALID, 'createBackoff requires a factor greater than 1', { factor });
  }

  let current = initialMs;
  let calledOnce = false;

  return {
    /** @returns {number} the next interval, in ms. */
    next() {
      if (!calledOnce) {
        calledOnce = true;
        return current;
      }
      current = Math.min(current * factor, maxMs);
      return current;
    },
    /** Return the counter to its pre-first-call state. */
    reset() {
      current = initialMs;
      calledOnce = false;
    },
  };
}

/**
 * A gate that announces a `ProgressSnapshot` only when its phase (title
 * and/or cycle) has changed since the last announcement -- see
 * `snapshot.mjs`'s `phaseChanged()`, which this wraps. The very first
 * snapshot it ever sees always announces (there is no prior phase to have
 * stayed the same as); every subsequent call announces only on an actual
 * transition, so a poll loop calling `shouldAnnounce()` once per tick still
 * only announces once per phase, not once per tick.
 *
 * Pure aside from its own small internal memory of "the last announced
 * snapshot" -- no timer, no I/O.
 *
 * @returns {{ shouldAnnounce: (snapshot: any) => boolean }}
 */
export function createPhaseGate() {
  let hasAnnounced = false;
  let lastAnnounced = null;

  return {
    shouldAnnounce(snapshot) {
      if (!hasAnnounced) {
        hasAnnounced = true;
        lastAnnounced = snapshot;
        return true;
      }
      const changed = phaseChanged(lastAnnounced, snapshot);
      if (changed) {
        lastAnnounced = snapshot;
      }
      return changed;
    },
  };
}
