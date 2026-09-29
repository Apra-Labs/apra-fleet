// Publishes a RUNNING sprint's state to blob storage, so the public blob
// viewer shows progress while the sprint runs -- not just the raw JSONL log,
// and not only after finalize. Same file layout the archive writes and the
// viewer's blob data source reads: sprints/<sprintId>/state.json, beside the
// archive's activities/ and extensions/ (see archive.mjs / archive-publisher.mjs).
//
// WHY RATE-LIMITED, AND WHY "CHANGED" IS CHECKED FIRST. watch polls every few
// seconds; a full state upload per poll would be pointless churn. The body is
// only re-sent when it differs from what was last published, and never more
// often than `minIntervalMs` -- except the terminal state, which is always
// published at once, because it is the last word and there is no later tick
// to carry it.
//
// NEVER THROWS. Called from watch's poll loop, whose rule is that nothing
// observational can end a sprint. A failed upload is recorded and reported
// through health(), in the same shape append-blob.mjs uses, so
// sinks/health.mjs escalates a publisher that keeps failing instead of the
// remote view silently freezing.
//
// INJECTED I/O ONLY: `http` is append-blob-http.mjs's client (putBlockBlob),
// `now` is the injected clock. The SAS lives in this closure only; it is
// passed to the http layer on each call and never logged or returned.
//
// ASCII only.

import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';
import { buildListStatePayload } from '@apralabs/apra-fleet-workflow/viewer/lean-state';
import { ARCHIVE_PREFIX } from './archive-publisher.mjs';

/** Default floor between two uploads of a changed, non-terminal state. */
export const DEFAULT_LIVE_STATE_MIN_INTERVAL_MS = 30 * 1000;

/** The blob name the viewer reads a sprint's state from. */
export function liveStateBlobName(sprintId) {
  return `${ARCHIVE_PREFIX}/${encodeURIComponent(sprintId)}/state.json`;
}

function safeMessage(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * The body to publish: the supervisor's state as the viewer reads it. A live
 * sprint's state already arrives as the lean `/state` payload (it carries a
 * `_strings` table); a finished one arrives as the engine's full persisted
 * state and is leaned here, so both land in the same shape.
 * @param {object} state
 * @returns {string}
 */
function bodyFor(state) {
  const payload = Array.isArray(state._strings) ? state : buildListStatePayload(state);
  return JSON.stringify(payload);
}

/**
 * @param {object} deps
 * @param {string} deps.accountUrl
 * @param {string} deps.containerName
 * @param {string} deps.sas - closure-only; never returned or logged
 * @param {{ putBlockBlob: Function }} deps.http
 * @param {() => number} deps.now
 * @param {number} [deps.minIntervalMs]
 * @param {(msg: string) => void} [deps.log]
 * @returns {{ publish: (sprintId: string, sprint: object) => Promise<{ published: boolean, reason: string }>, health: () => object }}
 * @throws {BridgeError} CONFIG_MISSING / CONFIG_INVALID at construction only
 */
export function createLiveStatePublisher(deps = {}) {
  const { accountUrl, containerName, sas, http, now, minIntervalMs = DEFAULT_LIVE_STATE_MIN_INTERVAL_MS, log = () => {} } = deps;
  for (const [name, value] of [['accountUrl', accountUrl], ['containerName', containerName], ['sas', sas]]) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, `createLiveStatePublisher requires a non-empty ${name}`, { field: name });
    }
  }
  if (!http || typeof http.putBlockBlob !== 'function') {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, 'createLiveStatePublisher requires an injected http with putBlockBlob', {});
  }
  if (typeof now !== 'function') {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, 'createLiveStatePublisher requires an injected now()', {});
  }
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_INVALID, 'createLiveStatePublisher: minIntervalMs must be a non-negative number', { minIntervalMs });
  }

  let lastBody = null;
  let lastPublishedAt = null;
  let consecutiveFailures = 0;
  let successfulUploads = 0;
  let lastSuccessAt = null;
  let lastFailureAt = null;
  let lastFailure = null;
  let target = null;

  return {
    async publish(sprintId, sprint) {
      try {
        const state = sprint && sprint.state;
        if (typeof sprintId !== 'string' || sprintId.length === 0 || !state || typeof state !== 'object') {
          return { published: false, reason: 'no-state' };
        }
        const body = bodyFor(state);
        if (body === lastBody) return { published: false, reason: 'unchanged' };

        const terminal = sprint.terminal === true;
        const at = now();
        if (!terminal && lastPublishedAt !== null && at - lastPublishedAt < minIntervalMs) {
          return { published: false, reason: 'rate-limited' };
        }

        const blobName = liveStateBlobName(sprintId);
        target = `${containerName}/${blobName}`;
        const res = await http.putBlockBlob({ accountUrl, containerName, sas, blobName, body, contentType: 'application/json' });
        if (!res || res.status < 200 || res.status >= 300) {
          consecutiveFailures += 1;
          lastFailureAt = at;
          lastFailure = `HTTP ${res ? res.status : 'no response'}${res && res.errorCode ? ` (${res.errorCode})` : ''}`;
          log(`[live-state] upload of ${target} failed: ${lastFailure} (attempt ${consecutiveFailures}; retried on the next tick)`);
          return { published: false, reason: 'failed' };
        }
        lastBody = body;
        lastPublishedAt = at;
        consecutiveFailures = 0;
        successfulUploads += 1;
        lastSuccessAt = at;
        return { published: true, reason: terminal ? 'terminal' : 'changed' };
      } catch (err) {
        consecutiveFailures += 1;
        lastFailureAt = now();
        lastFailure = safeMessage(err);
        log(`[live-state] upload failed: ${lastFailure} (attempt ${consecutiveFailures}; retried on the next tick)`);
        return { published: false, reason: 'failed' };
      }
    },

    health() {
      return {
        name: 'live-state',
        healthy: consecutiveFailures === 0,
        consecutiveFailures,
        successfulFlushes: successfulUploads,
        pendingRecords: consecutiveFailures > 0 ? 1 : 0,
        lastSuccessAt,
        lastFailureAt,
        lastFailure,
        target,
      };
    },
  };
}

export default createLiveStatePublisher;
