// =============================================================================
// Auto-sprint supervisor -- service token mint/load + per-request auth guard
// =============================================================================
//
// The supervisor binds loopback-only and guards its mutating/API surface with a
// shared bearer token held in a file under the supervisor data root. This module
// owns three things and nothing else:
//
//   loadOrCreateToken(dir) -- idempotent mint-or-reuse of <dir>/private/token.
//   isAuthorized(req, tok) -- does this request carry the token?
//   requiresAuth(method, path) -- is this route behind the guard at all?
//
// Wiring these into the HTTP server (listen on 127.0.0.1, answer 401) is a
// separate task; this file deliberately has no http/server dependency so it can
// be unit tested and reused by both the server and any future CLI probe.
//
// apra-fleet-iywi.1.1: the GENERIC token pieces (fleet.key + private/token
// resolution, the bearer/cookie credential check, the cookie parser, and the
// fail-closed path normaliser) are lifted into the shared
// @apralabs/apra-fleet-client/auth/local-token helper so the apra-fleet server
// console can reuse them without depending on this package. This module keeps
// every export below byte-for-byte (same names, same call signatures) and
// keeps its OWN route policy: `TOKEN_COOKIE_NAME` (this supervisor's cookie is
// `se_token`) and `requiresAuth` (which routes are guarded) are NOT part of
// the shared helper -- see the closed regression apra-fleet-hzb2, where a
// blanket `/api/` prefix rule in the supervisor 401ed an unauthenticated
// `GET /api/health`. Moving route policy into the shared helper would let a
// future caller (e.g. the console) inherit this supervisor's prefix rule by
// accident, so each caller keeps its own.
//
// -----------------------------------------------------------------------------
// FILE PERMISSIONS: POSIX vs Windows
// -----------------------------------------------------------------------------
// On POSIX the token file is created 0600 and that mode is re-asserted on every
// load, so a token file loosened out-of-band is healed (and a mode we cannot
// enforce is a hard error, not a warning).
//
// Windows has no POSIX mode bits -- fs.chmod there only toggles the read-only
// attribute, and fs.stat reports a synthesised mode, so asserting 0600 would be
// theatre. The real protection on Windows is that the supervisor data root lives
// under the user's profile and inherits that directory's ACL. We cannot verify
// that inheritance from here, so we do NOT claim it: the returned descriptor
// carries `aclVerified: false`, which GET /api/health surfaces later as the
// TOKEN_ACL_UNVERIFIED_WARNING string. POSIX returns `aclVerified: true` because
// the mode assertion below actually proved it.
//
// The platform branch is on `process.platform`, never on which shell/tools are
// present: node under Git Bash on Windows still reports 'win32'.
//
// The token itself is NEVER logged or included in a thrown Error message.
// =============================================================================

import {
    PRIVATE_DIRNAME,
    TOKEN_FILENAME,
    TOKEN_FILE_MODE,
    PRIVATE_DIR_MODE,
    TOKEN_BYTES,
    TOKEN_ACL_UNVERIFIED_WARNING,
    tokenFilePath,
    loadOrCreateToken,
    readLocalToken,
    isAuthorized as isAuthorizedGeneric,
    readCookie,
    normalizePath,
} from '@apralabs/apra-fleet-client/auth/local-token';

export {
    PRIVATE_DIRNAME,
    TOKEN_FILENAME,
    TOKEN_FILE_MODE,
    PRIVATE_DIR_MODE,
    TOKEN_BYTES,
    TOKEN_ACL_UNVERIFIED_WARNING,
    tokenFilePath,
    loadOrCreateToken,
    readCookie,
};

/** Cookie name accepted as an alternative to the Authorization header. */
export const TOKEN_COOKIE_NAME = 'se_token';

/**
 * apra-fleet-ky2l.1.2 (DQ-20): resolve the supervisor's service token,
 * preferring the shared `<home>/.apra-fleet/fleet.key` (the SAME file
 * src/services/jwt.ts's getOrCreateKey() reads/mints, so the supervisor and
 * the fleet MCP server's JWT auth share one token) over the private/token
 * file `loadOrCreateToken()` mints under the supervisor's own data root.
 *
 * apra-fleet-iywi.1.1: this is now a thin wrapper over the shared
 * `readLocalToken()` helper (packages/apra-fleet-client/src/auth/local-token.mjs),
 * which does the actual fleet.key read, validation, and private/token
 * fallback. Kept as its own exported name/signature so every existing caller
 * (bin/serve.mjs, scripts/sandbox-deploy.mjs, scripts/check-foreign-sprints.mjs,
 * tests) is unaffected.
 *
 * @param {string} dir supervisor data root (passed through to
 *   loadOrCreateToken() for the private/token fallback)
 * @param {{ home?: string, logger?: { warn?: Function }, createIfMissing?: boolean }} [opts]
 *   `home` overrides where the fleet-key lookup is rooted -- tests MUST pass
 *   a temp dir here. `createIfMissing` defaults to `true`; pass `false` for a
 *   read-only probe.
 * @returns {{ token: string, path: string, source: 'fleet-key'|'private-token', aclVerified: boolean, created: boolean }|null}
 *   `null` only when `createIfMissing: false` and no token exists at either
 *   source.
 */
export function resolveServiceToken(dir, opts = {}) {
    return readLocalToken(dir, opts);
}

/**
 * Does this request carry the service token?
 *
 * Accepts `Authorization: Bearer <token>` (scheme match is case-insensitive per
 * RFC 7235) or the `se_token=<token>` cookie, which is what lets a browser-based
 * dashboard reach the same guarded routes.
 *
 * apra-fleet-iywi.1.1: delegates to the shared `isAuthorized()` helper with
 * this supervisor's own cookie name (`TOKEN_COOKIE_NAME`), so callers of this
 * module see the exact same 2-argument signature as before.
 *
 * @param {{ headers?: Record<string, unknown> }} req incoming request (or any
 *   object with a `headers` bag)
 * @param {string} token the expected service token
 * @returns {boolean}
 */
export function isAuthorized(req, token) {
    return isAuthorizedGeneric(req, token, { cookieName: TOKEN_COOKIE_NAME });
}

/**
 * Routes behind the guard by shape: POST to a live sprint control endpoint.
 * The trailing slash is load-bearing -- `POST /sprints/x/live` (the live view
 * itself) is NOT guarded; only sub-routes under it (e.g. .../live/stop) are.
 */
const LIVE_CONTROL_PATTERN = /^\/sprints\/[^/]+\/live\//;

/**
 * Is this route behind the auth guard?
 *
 * Guarded: the whole `/api/` surface (read and write alike -- it exposes ledger
 * and member state), plus POST to any sub-route of a sprint's live view, which
 * is where the mutating controls (stop, pause) live. Everything else -- the
 * dashboard shell, /state, /events, the live view itself, history -- stays open
 * because the server is loopback-bound and those are read-only views.
 *
 * apra-fleet-iywi.1.1: the URL normalisation is now the shared
 * `normalizePath()` helper (parse against a dummy origin, take `.pathname`),
 * so a raw `req.url` and a pre-parsed `url.pathname` always answer the same as
 * the HTTP router. The ROUTE POLICY below (which normalised paths are
 * guarded) stays local to this module -- it is NOT part of the shared helper.
 * An unparseable path (`normalizePath` returns `null`) is fail-closed
 * (guarded).
 *
 * @param {string} method HTTP method
 * @param {string} urlPath request path or raw `req.url` (a query string,
 *   fragment, or dot segments are all tolerated; an origin is not expected)
 * @returns {boolean}
 */
export function requiresAuth(method, urlPath) {
    const p = normalizePath(urlPath);
    if (p === null) return true;
    if (p.startsWith('/api/')) return true;
    const verb = typeof method === 'string' ? method.toUpperCase() : '';
    return verb === 'POST' && LIVE_CONTROL_PATTERN.test(p);
}
