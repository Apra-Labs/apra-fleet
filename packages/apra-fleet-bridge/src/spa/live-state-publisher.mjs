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

/** Default cap on per-item detail uploads per publish call, so a phase that
 *  finishes fifty activities at once is spread over a few ticks, not a burst. */
export const DEFAULT_MAX_DETAIL_UPLOADS_PER_TICK = 10;

/**
 * Per-item files the viewer's lazy-load clicks read, beside state.json:
 * activities/<id>.json (an activity's FULL output -- the lean state carries it
 * truncated) and extensions/<ext>/<item>.json (e.g. a bead description). Without
 * them, 'more...' on a running sprint 404ed until finalize wrote the archive.
 */
export function liveDetailBlobName(sprintId, relPath) {
  return `${ARCHIVE_PREFIX}/${encodeURIComponent(sprintId)}/${relPath}`;
}

function* finishedTruncatedActivities(state) {
  const groups = Array.isArray(state.tree) ? state.tree : [];
  for (const g of groups) {
    for (const p of (g && Array.isArray(g.phases) ? g.phases : [])) {
      for (const e of (p && Array.isArray(p.events) ? p.events : [])) {
        if (!e || e.type !== 'activity' || typeof e.id !== 'string') continue;
        const data = e.data || {};
        // A running activity's output is still growing: upload it once, when done.
        if (data.isRunning === true) continue;
        if (data.outputTruncated || data.errorTruncated) yield e.id;
      }
    }
  }
}

/** Every `{ id, updatedAt? }` item anywhere in one extension's namespace data. */
function* extensionItems(value, depth = 0) {
  if (depth > 6 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) yield* extensionItems(v, depth + 1);
    return;
  }
  if (typeof value.id === 'string' && value.id.length > 0) {
    yield { id: value.id, signature: String(value.updatedAt ?? '') };
  }
  for (const v of Object.values(value)) {
    if (v && typeof v === 'object') yield* extensionItems(v, depth + 1);
  }
}

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
  const {
    accountUrl, containerName, sas, http, now,
    minIntervalMs = DEFAULT_LIVE_STATE_MIN_INTERVAL_MS,
    log = () => {},
    // Optional: when absent, only state.json is published (the viewer still
    // works; 'more...' waits for the archive). Both come from the supervisor
    // client (getActivityOutput / getExtensionDetail).
    fetchActivityOutput = null,
    fetchExtensionDetail = null,
    // Which extensions have on-demand detail worth mirroring. Explicit, not
    // guessed: an extension absent here is never walked.
    detailExtensions = ['beads'],
    maxDetailUploadsPerTick = DEFAULT_MAX_DETAIL_UPLOADS_PER_TICK,
  } = deps;
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

  // Per-item uploads already done: activity id -> true (uploaded once, when
  // finished); `${ext}\u0000${item}` -> the updatedAt signature last uploaded.
  const uploadedActivities = new Set();
  const uploadedDetails = new Map();

  /** @returns {Promise<string|null>} null on success, else why it failed */
  async function putJson(sprintId, relPath, payload) {
    const blobName = liveDetailBlobName(sprintId, relPath);
    const res = await http.putBlockBlob({ accountUrl, containerName, sas, blobName, body: JSON.stringify(payload), contentType: 'application/json' });
    if (!res || res.status < 200 || res.status >= 300) {
      return `upload of ${containerName}/${blobName} failed: HTTP ${res ? res.status : 'no response'}`;
    }
    return null;
  }

  /** Upload up to maxDetailUploadsPerTick new per-item files. Never throws. */
  async function publishDetails(sprintId, state) {
    let budget = maxDetailUploadsPerTick;
    if (typeof fetchActivityOutput === 'function') {
      for (const id of finishedTruncatedActivities(state)) {
        if (budget <= 0) return;
        if (uploadedActivities.has(id)) continue;
        budget -= 1;
        try {
          const full = await fetchActivityOutput(sprintId, id);
          if (!full) { uploadedActivities.add(id); continue; } // gone: nothing to mirror
          const body = { id };
          if (typeof full.output === 'string') body.output = full.output;
          if (typeof full.error === 'string') body.error = full.error;
          const failed = await putJson(sprintId, `activities/${encodeURIComponent(id)}.json`, body);
          if (failed) { noteFailure(`activity ${id}: ${failed}`); continue; }
          uploadedActivities.add(id);
          detailFailures = 0;
        } catch (err) {
          noteFailure(`activity ${id}: ${safeMessage(err)}`);
        }
      }
    }
    if (typeof fetchExtensionDetail === 'function') {
      const exts = state.extensions && typeof state.extensions === 'object' ? state.extensions : {};
      for (const extId of detailExtensions) {
        for (const item of extensionItems(exts[extId])) {
          if (budget <= 0) return;
          const key = `${extId}\u0000${item.id}`;
          if (uploadedDetails.get(key) === item.signature) continue;
          budget -= 1;
          try {
            const detail = await fetchExtensionDetail(sprintId, extId, item.id);
            if (!detail) { uploadedDetails.set(key, item.signature); continue; }
            const failed = await putJson(sprintId, `extensions/${encodeURIComponent(extId)}/${encodeURIComponent(item.id)}.json`, {
              id: item.id, text: typeof detail.text === 'string' ? detail.text : '', updatedAt: detail.updatedAt ?? null,
            });
            if (failed) { noteFailure(`${extId} ${item.id}: ${failed}`); continue; }
            uploadedDetails.set(key, item.signature);
            detailFailures = 0;
          } catch (err) {
            noteFailure(`${extId} ${item.id}: ${safeMessage(err)}`);
          }
        }
      }
    }
  }

  // Detail uploads keep their OWN streak: a state.json success must not
  // reset it, or per-item files failing on every tick would never escalate.
  let detailFailures = 0;
  function noteFailure(message) {
    detailFailures += 1;
    lastFailureAt = now();
    lastFailure = message;
    log(`[live-state] ${message} (attempt ${detailFailures}; retried on the next tick)`);
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
      const state = sprint && sprint.state;
      if (typeof sprintId !== 'string' || sprintId.length === 0 || !state || typeof state !== 'object') {
        return { published: false, reason: 'no-state' };
      }
      const result = await publishState(sprintId, sprint, state);
      await publishDetails(sprintId, state);
      return result;
    },

    health() {
      const worst = Math.max(consecutiveFailures, detailFailures);
      return {
        name: 'live-state',
        healthy: worst === 0,
        consecutiveFailures: worst,
        successfulFlushes: successfulUploads,
        pendingRecords: worst > 0 ? 1 : 0,
        lastSuccessAt,
        lastFailureAt,
        lastFailure,
        target,
        detailsUploaded: uploadedActivities.size + uploadedDetails.size,
      };
    },
  };

  async function publishState(sprintId, sprint, state) {
      try {
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
  }
}

export default createLiveStatePublisher;
