// HTTP client for the always-on fleet supervisor (apra-fleet-se/src/supervisor).
//
// Shape copied deliberately from fleet-sprint/coordination.mjs:49-191 (the
// dolt-push-mutex / child-id-allocator clients): base-URL normalisation with a
// trailing-slash strip, an INJECTABLE fetch (`opts.fetch ?? globalThis.fetch`,
// throwing at construction if neither exists), one shared internal request
// helper, and a throw-on-primary-call / swallow-and-log-on-cleanup-call split
// (getHealth/getMembers/listSprints/getSprint/postSprint/getLog throw;
// stopSprint/forceRelease swallow and return false).
//
// Bearer forward-compat (apra-fleet PR #493): today's supervisor is
// unauthenticated, and that MUST keep working. On every request this client
// calls the injected `readTokenFile()`; a non-empty string is sent as
// `Authorization: Bearer <token>`, a null/empty result sends no auth header at
// all. The token is cached in memory after the first read (successful or
// not) and re-read exactly once on a 401 before giving up, since the token
// file can be minted or rotated while the bridge is already running.
//
// No `node:fs`, no `process.env`, no direct `globalThis.fetch` capture at
// module scope: every I/O seam (`fetch`, `readTokenFile`, `log`) is injected,
// per this package's injected-I/O rule -- unit tests against fakes are the
// only verification available (no live supervisor in this build's scope).
//
// The token is NEVER logged, NEVER interpolated into a thrown error's message
// or details, and NEVER returned from any method -- only `tokenPath` (a
// filesystem path, not a secret) is ever named, so an operator knows where to
// look for a 401.

import { BridgeError, BRIDGE_ERROR_CODES } from './errors.mjs';
import { resolveStringRefs } from '@apralabs/apra-fleet-workflow/viewer/lean-state';

/** Default location named in a 401 message when the caller does not pass `tokenPath`. */
const DEFAULT_TOKEN_PATH = '<dataDir>/private/token';

/** Truncate a response body for use in a generic error message; never throws. */
function snippet(text, max = 200) {
  if (typeof text !== 'string' || text.length === 0) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * Redact any bearer token from a response body snippet before embedding in
 * an error message or log line. If a token is present (non-empty), replaces
 * its occurrences with [redacted]; if no token, returns the text unchanged.
 * @param {string} text
 * @param {string|null} token
 * @returns {string}
 */
function redactToken(text, token) {
  if (typeof text !== 'string' || typeof token !== 'string' || token.length === 0) return text;
  return text.split(token).join('[redacted]');
}

/** Best-effort, safe description of a network-level fetch failure. */
function describeNetworkError(err) {
  return (err && err.message) || String(err);
}

/**
 * apra-fleet PR #493's documented relaunch-gate shape on a 409: `field`
 * is `'issue'`. The message prose is NOT matched (via regex or otherwise),
 * since api.mjs's field value is a structural contract the server maintains,
 * but the message is not: a future wording change would silently reclassify
 * this 409 as a plain LAUNCH_CONFLICT (different exit code 5 vs 7) without
 * test coverage to catch it. The field discriminates; the message is not
 * structural.
 * @param {any} body
 * @returns {boolean}
 */
function isRelaunchGateConflict(body) {
  return Boolean(body && body.field === 'issue');
}

/**
 * Create a client for the fleet supervisor's HTTP API.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl - e.g. `http://127.0.0.1:8787`; trailing slash tolerated.
 * @param {typeof fetch} [opts.fetch] - injectable; defaults to `globalThis.fetch`,
 *   throws at construction if neither is available.
 * @param {() => (string|null)} [opts.readTokenFile] - injectable, synchronous;
 *   returns the current bearer token or null/empty if none is deposited yet.
 *   NEVER `node:fs` -- the caller supplies this so the token's real source is
 *   swappable and fakeable in tests.
 * @param {string} [opts.tokenPath] - the on-disk path the token would be read
 *   from, used ONLY to name it in a 401 error message; never read directly.
 * @param {(msg: string) => void} [opts.log]
 * @returns {{
 *   getHealth: () => Promise<object>,
 *   getMembers: () => Promise<object>,
 *   listSprints: () => Promise<object>,
 *   getSprint: (sprintId: string) => Promise<object|null>,
 *   postSprint: (body: object) => Promise<object>,
 *   stopSprint: (sprintId: string) => Promise<object|boolean>,
 *   getLog: (sprintId: string, opts?: { tail?: number }) => Promise<string>,
 *   forceRelease: (sprintId: string, opts?: { by?: string, reason?: string }) => Promise<object|boolean>,
 * }}
 */
export function createSupervisorClient(opts = {}) {
  const base = String(opts.baseUrl || '').replace(/\/+$/, '');
  if (!base) {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, 'createSupervisorClient requires a baseUrl');
  }
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'createSupervisorClient requires a fetch implementation (Node >=18 global fetch or an injected one)',
    );
  }
  const readTokenFile = typeof opts.readTokenFile === 'function' ? opts.readTokenFile : () => null;
  const tokenPath = opts.tokenPath || DEFAULT_TOKEN_PATH;
  const log = opts.log ?? (() => {});

  // `undefined` = never read yet OR last read returned empty;
  // non-empty string = the cached token. Cache ONLY successful reads (non-empty strings).
  // While no token exists, re-read on every request -- a local file read is far cheaper
  // than a wasted HTTP 401 round-trip. Read once per process lifetime after a token is
  // minted, or once per forced 401 refresh cycle.
  let cachedToken;
  let lastReadToken; // Track the most recently read token for redaction purposes

  /**
   * @param {{ forceRefresh?: boolean }} [o]
   * @returns {string|null}
   */
  function readToken(o = {}) {
    if (!o.forceRefresh && cachedToken !== undefined) return cachedToken;
    let value = null;
    try {
      value = readTokenFile();
    } catch (err) {
      // Never let a readTokenFile() failure surface the token (there isn't
      // one to surface here) or take down a call that would otherwise
      // succeed unauthenticated -- log the failure kind only.
      log(`[supervisor-client] readTokenFile() threw (treating as no token): ${err && err.name ? err.name : 'Error'}`);
      value = null;
    }
    // Cache ONLY successful (non-empty) reads. When no token exists, keep cachedToken
    // undefined so the next call re-reads instead of wasting a 401 round-trip.
    if (typeof value === 'string' && value.length > 0) {
      cachedToken = value;
      lastReadToken = value;
    } else {
      cachedToken = undefined;
      // Keep lastReadToken from prior successful read, for redaction purposes.
    }
    return (typeof value === 'string' && value.length > 0) ? value : null;
  }

  /** Perform one raw fetch, attaching the bearer header only when `token` is non-empty. */
  async function doFetch(path, { method, body, token }) {
    const headers = {};
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchImpl(`${base}${path}`, { method, headers, body: payload });
  }

  /** Read a fetch Response's body once and shape it for the caller. */
  async function finishResponse(res, expectText) {
    const text = typeof res.text === 'function' ? await res.text() : '';
    if (expectText) return { status: res.status, text };
    let json;
    if (text) {
      try { json = JSON.parse(text); } catch { json = undefined; }
    }
    return { status: res.status, json, text };
  }

  /**
   * The one shared internal request helper every verb below is built on.
   * Handles base-URL join, bearer injection, the single 401-retry-once
   * cycle, and network-error mapping. Never applies status-code-specific
   * business mapping (400/404/409/etc.) -- that is each verb's own job,
   * since the same status means different things on different routes.
   *
   * @param {string} path - already includes any leading slash and query string.
   * @param {{ method?: string, body?: object, expectText?: boolean }} [reqOpts]
   * @returns {Promise<{ status: number, json?: any, text?: string }>}
   * @throws {BridgeError} SUPERVISOR_UNAVAILABLE on a network failure or any
   *   malformed response, SUPERVISOR_UNAUTHORIZED if the request is still 401
   *   after one retry.
   */
  async function request(path, reqOpts = {}) {
    const { method = 'GET', body, expectText = false } = reqOpts;
    const token = readToken();

    let res;
    try {
      res = await doFetch(path, { method, body, token });
      // Internal sentinel caught by the surrounding catch handler; never crosses module boundary.
      if (!res) throw new TypeError('fetch resolved to undefined');
      // Ensure res.status is readable and finishResponse completes.
      const result = await finishResponse(res, expectText);

      if (result.status === 401) {
        // The token may have been minted or rotated after our cache was
        // populated (or while we held no token at all) -- re-read once,
        // bypassing the cache, before giving up.
        const refreshedToken = readToken({ forceRefresh: true });
        if (refreshedToken && refreshedToken !== token) {
          let retryRes;
          try {
            retryRes = await doFetch(path, { method, body, token: refreshedToken });
            // Internal sentinel caught by the surrounding catch handler; never crosses module boundary.
            if (!retryRes) throw new TypeError('fetch resolved to undefined');
            const retryResult = await finishResponse(retryRes, expectText);
            if (retryResult.status !== 401) return retryResult;
          } catch (err) {
            if (err instanceof BridgeError) throw err;
            throw new BridgeError(
              BRIDGE_ERROR_CODES.SUPERVISOR_UNAVAILABLE,
              `could not reach supervisor at ${base}: ${describeNetworkError(err)}`,
            );
          }
        }
        throw new BridgeError(
          BRIDGE_ERROR_CODES.SUPERVISOR_UNAUTHORIZED,
          `supervisor rejected ${method} ${path} as unauthorized (401); deposit or refresh the bearer token at ${tokenPath}`,
        );
      }

      return result;
    } catch (err) {
      // If it's already a BridgeError (e.g., the 401 throw above), re-throw unchanged.
      if (err instanceof BridgeError) throw err;
      // Any other error (network, malformed response, etc.) becomes SUPERVISOR_UNAVAILABLE.
      throw new BridgeError(
        BRIDGE_ERROR_CODES.SUPERVISOR_UNAVAILABLE,
        `could not reach supervisor at ${base}: ${describeNetworkError(err)}`,
      );
    }
  }

  /** Uniform mapping for any status this client's verbs don't special-case. */
  function unmappedError(status, text) {
    const redacted = redactToken(text, lastReadToken);
    const tail = snippet(redacted);
    return new BridgeError(
      BRIDGE_ERROR_CODES.SUPERVISOR_UNAVAILABLE,
      `supervisor returned HTTP ${status}${tail ? `: ${tail}` : ''}`,
      { status },
    );
  }

  // -- primary calls: throw on failure --------------------------------------

  async function getHealth() {
    const { status, json, text } = await request('/api/health');
    if (status >= 200 && status < 300) return json ?? {};
    throw unmappedError(status, text);
  }

  async function getMembers() {
    const { status, json, text } = await request('/api/members');
    if (status >= 200 && status < 300) return json ?? {};
    throw unmappedError(status, text);
  }

  async function listSprints() {
    const { status, json, text } = await request('/api/sprints');
    if (status >= 200 && status < 300) return json ?? {};
    throw unmappedError(status, text);
  }

  /**
   * GET /api/sprints/:id. api.mjs's getSprint() answers with one of three
   * shapes -- `{live:true,state}`, `{live:false,terminal:true,state}`, or
   * `{live:false,history,latest}` -- this normalises all three into one
   * shape so callers never branch on which arrived. Un-leans `state` when
   * present: the child's `/state` (and a persisted terminal record) is
   * dedupeStrings()-leaned, replacing any string of 24+ chars occurring
   * twice with `{$ref:n}` against a `_strings` table; centralising the
   * resolveStringRefs() undo here means no caller can forget it.
   * 404 is a real "no such sprint" answer here, not an error -- returns null.
   */
  async function getSprint(sprintId) {
    const { status, json, text } = await request(`/api/sprints/${encodeURIComponent(sprintId)}`);
    if (status === 404) return null;
    if (status < 200 || status >= 300) throw unmappedError(status, text);

    const body = json ?? {};
    const rawState = body.state;
    const state = (rawState && typeof rawState === 'object')
      ? resolveStringRefs(rawState, rawState._strings || [])
      : (rawState ?? null);

    return {
      sprintId: body.sprintId ?? sprintId,
      live: Boolean(body.live),
      terminal: Boolean(body.terminal),
      state,
      history: body.history ?? null,
      latest: body.latest ?? null,
    };
  }

  /**
   * POST /api/sprints. Forwards the request body as-is -- `overrideRelaunchGate`
   * is included ONLY when the caller put it there; this client never adds it.
   */
  async function postSprint(body = {}) {
    const payload = { ...body };
    const { status, json, text } = await request('/api/sprints', { method: 'POST', body: payload });
    if (status >= 200 && status < 300) return json ?? {};

    if (status === 400) {
      const redactedError = json && json.error ? redactToken(json.error, lastReadToken) : undefined;
      const redactedText = redactToken(text, lastReadToken);
      throw new BridgeError(
        BRIDGE_ERROR_CODES.LAUNCH_INVALID,
        redactedError || `launch request rejected as invalid (400)${snippet(redactedText) ? `: ${snippet(redactedText)}` : ''}`,
        { field: json && json.field },
      );
    }
    if (status === 409) {
      if (isRelaunchGateConflict(json)) {
        // Carry the server's message verbatim (but redacted), per spec.
        const redactedError = json && json.error ? redactToken(json.error, lastReadToken) : '';
        throw new BridgeError(BRIDGE_ERROR_CODES.LAUNCH_RELAUNCH_GATE, redactedError, { field: json.field });
      }
      const redactedError = json && json.error ? redactToken(json.error, lastReadToken) : undefined;
      const redactedText = redactToken(text, lastReadToken);
      throw new BridgeError(
        BRIDGE_ERROR_CODES.LAUNCH_CONFLICT,
        redactedError || `launch conflicted with an existing sprint (409)${snippet(redactedText) ? `: ${snippet(redactedText)}` : ''}`,
        { field: json && json.field },
      );
    }
    throw unmappedError(status, text);
  }

  /** GET /sprints/:id/log?tail=N -- raw text, not JSON. */
  async function getLog(sprintId, o = {}) {
    const qs = Number.isInteger(o.tail) && o.tail > 0 ? `?tail=${o.tail}` : '';
    const { status, text } = await request(`/sprints/${encodeURIComponent(sprintId)}/log${qs}`, { expectText: true });
    if (status >= 200 && status < 300) return text ?? '';
    // A crashed sprint legitimately has no log file -- treat 404 as a normal condition,
    // not an infrastructure failure. This allows watch's fallback path to distinguish
    // between "no structured state available" and "supervisor unreachable".
    if (status === 404) return null;
    throw unmappedError(status, text);
  }

  // -- cleanup calls: swallow and log, return false -------------------------

  /** POST /api/sprints/:id/stop. Cleanup-class: never throws. */
  async function stopSprint(sprintId) {
    try {
      const { status, json, text } = await request(`/api/sprints/${encodeURIComponent(sprintId)}/stop`, { method: 'POST' });
      if (status >= 200 && status < 300) return json ?? true;
      const redactedText = redactToken(text, lastReadToken);
      log(`[supervisor-client] stopSprint('${sprintId}') failed: HTTP ${status}${snippet(redactedText) ? ` ${snippet(redactedText)}` : ''}`);
      return false;
    } catch (err) {
      const redactedMessage = err && err.message ? redactToken(err.message, lastReadToken) : '';
      log(`[supervisor-client] stopSprint('${sprintId}') failed: ${redactedMessage}`);
      return false;
    }
  }

  /** POST /api/reservations/:sprintId/force-release. Cleanup-class: never throws. */
  async function forceRelease(sprintId, o = {}) {
    try {
      const { status, json, text } = await request(`/api/reservations/${encodeURIComponent(sprintId)}/force-release`, {
        method: 'POST',
        body: { by: o.by, reason: o.reason },
      });
      if (status >= 200 && status < 300) return json ?? true;
      const redactedText = redactToken(text, lastReadToken);
      log(`[supervisor-client] forceRelease('${sprintId}') failed: HTTP ${status}${snippet(redactedText) ? ` ${snippet(redactedText)}` : ''}`);
      return false;
    } catch (err) {
      const redactedMessage = err && err.message ? redactToken(err.message, lastReadToken) : '';
      log(`[supervisor-client] forceRelease('${sprintId}') failed: ${redactedMessage}`);
      return false;
    }
  }

  return {
    getHealth,
    getMembers,
    listSprints,
    getSprint,
    postSprint,
    stopSprint,
    getLog,
    forceRelease,
  };
}
