// =============================================================================
// fleet-sprint supervisor -- caller authentication and route authorization
// =============================================================================
//
// Implements docs/supervisor-auth.md. Two modes:
//
//   none           (default) every caller is the local operator; identity and
//                  forwarded-prefix headers are ignored entirely. Behaviour is
//                  exactly what it was before this module existed.
//   trusted-front  an authenticating front (a separate process on the same
//                  machine) signs every request it forwards with a short-lived
//                  ES256 compact JWS in X-Fleet-Identity. The supervisor only
//                  verifies it against the front's public JWKS file; it holds
//                  no secret and never talks to an identity provider.
//
// Caller classification in trusted-front mode ("Two kinds of caller"):
//   header present                 -> must verify, else 401 (never local)
//   header absent, loopback peer   -> the local operator (all roles)
//   header absent, any other peer  -> 401
//
// Verification uses Node's built-in crypto only. Every failure is the same
// generic 401 body; the reason is never echoed to the caller and the token is
// never logged.
// =============================================================================

import crypto from 'node:crypto';
import fs from 'node:fs';

/** Request header carrying the front's signed identity assertion. */
export const IDENTITY_HEADER = 'x-fleet-identity';
/** Request header a front sends when it publishes the supervisor under a path. */
export const FORWARDED_PREFIX_HEADER = 'x-forwarded-prefix';

export const AUTH_MODE_NONE = 'none';
export const AUTH_MODE_TRUSTED_FRONT = 'trusted-front';
export const AUTH_MODES = Object.freeze([AUTH_MODE_NONE, AUTH_MODE_TRUSTED_FRONT]);

/** Configuration env vars (flags in bin/serve.mjs take precedence). */
export const AUTH_ENV = Object.freeze({
    mode: 'FLEET_SUPERVISOR_AUTH',
    jwks: 'FLEET_SUPERVISOR_FRONT_JWKS',
    issuer: 'FLEET_SUPERVISOR_FRONT_ISSUER',
    audience: 'FLEET_SUPERVISOR_FRONT_AUDIENCE',
});

export const DEFAULT_AUDIENCE = 'fleet-supervisor';
/** Allowed clock skew, seconds, on iat/exp/nbf. */
export const CLOCK_SKEW_SECONDS = 30;
/** Longest accepted assertion lifetime (exp - iat), seconds. */
export const MAX_ASSERTION_LIFETIME_SECONDS = 300;
/** Upper bound on the header value we are willing to parse at all. */
const MAX_TOKEN_LENGTH = 16 * 1024;

/** Fleet roles, lowest first. Roles are cumulative. */
export const ROLES = Object.freeze(['viewer', 'operator', 'admin']);
const ROLE_RANK = Object.freeze({ viewer: 1, operator: 2, admin: 3 });

/** Policy levels besides the three roles. */
export const POLICY_AUTHENTICATED = 'authenticated';
export const POLICY_LOCAL_ONLY = 'local-only';

/** The local operator: unsigned loopback callers, and everyone in `none` mode. */
export const LOCAL_IDENTITY = Object.freeze({ sub: 'local', name: 'local', email: null, roles: Object.freeze(['admin']) });

/** The constant 401 body. Never says which check failed. */
export const UNAUTHENTICATED_BODY = Object.freeze({ error: 'unauthenticated' });

// -----------------------------------------------------------------------------
// Route policy -- the ONE table, enforced by server.mjs's dispatcher before any
// handler runs, for requests that carry a verified assertion. Patterns use the
// same `:param` syntax as supervisor.route(), and every route any register*()
// helper adds must appear here (test/supervisor-auth-route-policy.test.mjs
// scans the source for route registrations and fails on a missing entry).
// An asserted request matching no entry is denied (403).
// -----------------------------------------------------------------------------
export const ROUTE_POLICY = Object.freeze([
    // Dashboard pages, sprint lists and state, live views, history, health.
    { method: 'GET', path: '/', min: 'viewer' },
    { method: 'GET', path: '/state', min: 'viewer' },
    { method: 'GET', path: '/events', min: 'viewer' },
    { method: 'GET', path: '/api/health', min: 'viewer' },
    { method: 'GET', path: '/api/whoami', min: POLICY_AUTHENTICATED },
    { method: 'GET', path: '/api/sprints', min: 'viewer' },
    { method: 'GET', path: '/api/sprints/:id', min: 'viewer' },
    { method: 'GET', path: '/sprints/:id/live', min: 'viewer' },
    { method: 'GET', path: '/sprints/:id/live/events', min: 'viewer' },
    { method: 'GET', path: '/sprints/:id/live/state', min: 'viewer' },
    { method: 'GET', path: '/sprints/:id/live/extensions/:extId/detail/:itemId', min: 'viewer' },
    { method: 'GET', path: '/sprints/:id/live/activities/:activityId/output', min: 'viewer' },
    { method: 'GET', path: '/sprints/:id/history', min: 'viewer' },
    // Launch, stop, pause, resume, answer decisions, save logs, read raw logs,
    // backlog, and the member list the launch form needs.
    { method: 'POST', path: '/api/sprints', min: 'operator' },
    { method: 'POST', path: '/api/sprints/:id/stop', min: 'operator' },
    { method: 'POST', path: '/api/sprints/:id/decisions/:decisionId', min: 'operator' },
    { method: 'POST', path: '/sprints/:id/live/stop', min: 'operator' },
    { method: 'POST', path: '/sprints/:id/live/pause', min: 'operator' },
    { method: 'POST', path: '/sprints/:id/live/resume', min: 'operator' },
    { method: 'POST', path: '/sprints/:id/live/save_logs', min: 'operator' },
    { method: 'POST', path: '/sprints/:id/live/extensions/:extId/actions/:actionId', min: 'operator' },
    { method: 'GET', path: '/sprints/:id/log', min: 'operator' },
    { method: 'GET', path: '/supervisor/log', min: 'operator' },
    { method: 'GET', path: '/api/backlog', min: 'operator' },
    { method: 'GET', path: '/api/backlog/tasks', min: 'operator' },
    { method: 'GET', path: '/api/members', min: 'operator' },
    // Shutdown and force-release of member reservations.
    { method: 'POST', path: '/api/shutdown', min: 'admin' },
    { method: 'POST', path: '/api/reservations/:sprintId/force-release', min: 'admin' },
    // Sprint-to-supervisor callbacks: never reachable with an assertion.
    { method: 'POST', path: '/api/dolt-push-mutex/:sprintId/acquire', min: POLICY_LOCAL_ONLY },
    { method: 'POST', path: '/api/dolt-push-mutex/:sprintId/release', min: POLICY_LOCAL_ONLY },
    { method: 'POST', path: '/api/dolt-push-mutex/:sprintId/renew', min: POLICY_LOCAL_ONLY },
    { method: 'GET', path: '/api/dolt-push-mutex', min: POLICY_LOCAL_ONLY },
    { method: 'POST', path: '/api/child-id-allocator/:parentId/allocate', min: POLICY_LOCAL_ONLY },
    { method: 'POST', path: '/api/child-id-allocator/confirm', min: POLICY_LOCAL_ONLY },
    { method: 'POST', path: '/api/child-id-allocator/release', min: POLICY_LOCAL_ONLY },
    { method: 'GET', path: '/api/child-id-allocator', min: POLICY_LOCAL_ONLY },
]);

function compilePolicyPattern(path) {
    const source = path.split('/').map((seg) => (seg.startsWith(':')
        ? '[^/]+'
        : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
    return new RegExp(`^${source}$`);
}

const COMPILED_POLICY = ROUTE_POLICY.map((p) => ({ ...p, regex: compilePolicyPattern(p.path), literal: !p.path.includes('/:') }));

/**
 * The policy entry for a request, or null when the route is not in the table.
 * Literal paths win over patterns, mirroring the dispatcher's exact-then-
 * pattern lookup order.
 * @param {string} method
 * @param {string} path - the URL pathname, as the dispatcher sees it
 * @returns {{ method: string, path: string, min: string }|null}
 */
export function policyFor(method, path) {
    const m = String(method || 'GET').toUpperCase();
    const exact = COMPILED_POLICY.find((p) => p.literal && p.method === m && p.path === path);
    const hit = exact ?? COMPILED_POLICY.find((p) => !p.literal && p.method === m && p.regex.test(path));
    return hit ? { method: hit.method, path: hit.path, min: hit.min } : null;
}

/** True when the role set satisfies the minimum role (cumulative roles). */
export function hasRole(roles, min) {
    const need = ROLE_RANK[min];
    if (!need) return false;
    let best = 0;
    for (const r of roles ?? []) best = Math.max(best, ROLE_RANK[r] ?? 0);
    return best >= need;
}

/**
 * Decides whether a verified identity may call a route.
 * @param {{ roles: string[] }} identity
 * @param {string} method
 * @param {string} path
 * @returns {null | { status: 403, body: object }}
 */
export function authorizeRoute(identity, method, path) {
    const policy = policyFor(method, path);
    if (!policy || policy.min === POLICY_LOCAL_ONLY) return { status: 403, body: { error: 'forbidden' } };
    if (policy.min === POLICY_AUTHENTICATED) return null;
    if (hasRole(identity.roles, policy.min)) return null;
    return { status: 403, body: { error: 'forbidden', requiredRole: policy.min } };
}

// -----------------------------------------------------------------------------
// Addresses and forwarded prefix
// -----------------------------------------------------------------------------

/** True for a loopback peer address: 127.0.0.0/8, ::1, ::ffff:127.x.x.x. */
export function isLoopbackAddress(addr) {
    if (typeof addr !== 'string' || addr === '') return false;
    const a = addr.toLowerCase();
    if (a === '::1') return true;
    const v4 = a.startsWith('::ffff:') ? a.slice('::ffff:'.length) : a;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** True when a bind host keeps the listener on loopback only. */
export function isLoopbackBindHost(host) {
    if (typeof host !== 'string') return false;
    const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
    return h === 'localhost' || isLoopbackAddress(h);
}

const PREFIX_PATTERN = /^(\/[A-Za-z0-9._~-]+)+$/;

/**
 * The forwarded path prefix, or '' when absent or not of the accepted shape
 * `^(/[A-Za-z0-9._~-]+)+$`. Callers only consult it for verified requests.
 * @param {string|string[]|undefined} value
 * @returns {string}
 */
export function sanitizeForwardedPrefix(value) {
    const v = Array.isArray(value) ? value[0] : value;
    if (typeof v !== 'string' || v.length > 512) return '';
    // '.' and '..' segments would re-root the path in a browser.
    if (!PREFIX_PATTERN.test(v) || v.split('/').some((s) => s === '.' || s === '..')) return '';
    return v;
}

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

/** A refuse-to-start configuration problem. The message names the setting. */
export class AuthConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AuthConfigError';
    }
}

/**
 * Merges flag values over env values into one auth config.
 * @param {{ auth?: string, frontJwks?: string, frontIssuer?: string, frontAudience?: string }} [flags]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveAuthConfig(flags = {}, env = process.env) {
    const pick = (flag, envName) => {
        if (typeof flag === 'string' && flag.trim() !== '') return flag.trim();
        const e = env[envName];
        return typeof e === 'string' && e.trim() !== '' ? e.trim() : null;
    };
    return {
        mode: pick(flags.auth, AUTH_ENV.mode) ?? AUTH_MODE_NONE,
        jwksPath: pick(flags.frontJwks, AUTH_ENV.jwks),
        issuer: pick(flags.frontIssuer, AUTH_ENV.issuer),
        audience: pick(flags.frontAudience, AUTH_ENV.audience) ?? DEFAULT_AUDIENCE,
    };
}

/**
 * Throws AuthConfigError when the supervisor must refuse to start.
 * @param {{ mode?: string, jwksPath?: string|null, issuer?: string|null }} config
 * @param {string} bindHost
 */
export function validateAuthConfig(config, bindHost) {
    const mode = config?.mode ?? AUTH_MODE_NONE;
    if (!AUTH_MODES.includes(mode)) {
        throw new AuthConfigError(`unknown auth mode '${mode}' (${AUTH_ENV.mode} / --auth): expected one of ${AUTH_MODES.join(', ')}`);
    }
    if (mode !== AUTH_MODE_TRUSTED_FRONT) return;
    if (!isLoopbackBindHost(bindHost)) {
        throw new AuthConfigError(`auth mode '${AUTH_MODE_TRUSTED_FRONT}' requires a loopback bind host (127.0.0.1, ::1 or localhost); got --host '${bindHost}'. The front must be the only network path in.`);
    }
    if (!config.jwksPath) {
        throw new AuthConfigError(`auth mode '${AUTH_MODE_TRUSTED_FRONT}' requires the front's public JWKS file: set ${AUTH_ENV.jwks} or pass --front-jwks <path>`);
    }
    if (!config.issuer) {
        throw new AuthConfigError(`auth mode '${AUTH_MODE_TRUSTED_FRONT}' requires the front's issuer: set ${AUTH_ENV.issuer} or pass --front-issuer <issuer>`);
    }
}

// -----------------------------------------------------------------------------
// JWKS and ES256 verification
// -----------------------------------------------------------------------------

/**
 * Parses a JWKS document into a kid -> KeyObject map of EC P-256 public keys.
 * Throws on any structural problem (the caller fails closed).
 * @param {string} text
 * @returns {Map<string|null, crypto.KeyObject>}
 */
export function parseJwks(text) {
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.keys)) throw new Error('JWKS must be an object with a keys array');
    const keys = new Map();
    for (const jwk of doc.keys) {
        if (!jwk || typeof jwk !== 'object') throw new Error('JWKS key must be an object');
        if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') continue;
        if (jwk.alg !== undefined && jwk.alg !== 'ES256') continue;
        if (jwk.use !== undefined && jwk.use !== 'sig') continue;
        if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('EC JWK needs x and y');
        // Only the public members: a stray private `d` is never imported.
        const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
        const kid = typeof jwk.kid === 'string' && jwk.kid !== '' ? jwk.kid : null;
        if (keys.has(kid)) throw new Error('duplicate kid in JWKS');
        keys.set(kid, key);
    }
    return keys;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

function decodeJsonSegment(seg) {
    const value = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('segment is not a JSON object');
    return value;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Verifies one compact JWS. Returns the identity, or null on ANY failure.
 * @param {string} token
 * @param {{ keys: Map<string|null, crypto.KeyObject>, issuer: string, audience: string, nowSeconds: number }} opts
 * @returns {{ sub: string, name: string|null, email: string|null, roles: string[], jti: string|null }|null}
 */
export function verifyAssertion(token, { keys, issuer, audience, nowSeconds }) {
    try {
        if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
        const parts = token.split('.');
        if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) return null;
        const [h, p, s] = parts;
        const header = decodeJsonSegment(h);
        if (header.alg !== 'ES256') return null;
        if (header.crit !== undefined) return null;
        let key;
        if (header.kid !== undefined) {
            if (typeof header.kid !== 'string') return null;
            key = keys.get(header.kid);
        } else if (keys.size === 1) {
            key = keys.values().next().value;
        }
        if (!key) return null;
        const sig = Buffer.from(s, 'base64url');
        if (sig.length !== 64) return null;
        const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`, 'ascii'), { key, dsaEncoding: 'ieee-p1363' }, sig);
        if (!ok) return null;

        const claims = decodeJsonSegment(p);
        if (claims.iss !== issuer) return null;
        const aud = claims.aud;
        if (!(aud === audience || (Array.isArray(aud) && aud.includes(audience)))) return null;
        if (!isNum(claims.iat) || !isNum(claims.exp)) return null;
        if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_ASSERTION_LIFETIME_SECONDS) return null;
        if (nowSeconds >= claims.exp + CLOCK_SKEW_SECONDS) return null;
        if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) return null;
        if (claims.nbf !== undefined && (!isNum(claims.nbf) || claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS)) return null;
        if (typeof claims.sub !== 'string' || claims.sub.trim() === '') return null;
        if (!Array.isArray(claims.roles)) return null;
        // Unknown role strings are ignored; none known -> no roles at all.
        const roles = ROLES.filter((r) => claims.roles.includes(r));
        return {
            sub: claims.sub,
            name: typeof claims.name === 'string' && claims.name !== '' ? claims.name : null,
            email: typeof claims.email === 'string' && claims.email !== '' ? claims.email : null,
            roles,
            jti: typeof claims.jti === 'string' && claims.jti !== '' ? claims.jti : null,
        };
    } catch {
        return null;
    }
}

function headerValue(req, name) {
    const v = req && req.headers ? req.headers[name] : undefined;
    if (Array.isArray(v)) return v.length === 1 ? v[0] : v.join(',');
    return v;
}

/**
 * Creates the request authenticator for one supervisor.
 *
 * @param {{
 *   mode?: string,
 *   jwksPath?: string|null,
 *   issuer?: string|null,
 *   audience?: string|null,
 *   now?: () => number,
 *   fs?: { statSync: Function, readFileSync: Function },
 *   logger?: { log?: Function, error?: Function },
 * }} [config]
 * @returns {{
 *   mode: string,
 *   authenticate(req: any): { ok: true, asserted: boolean, identity: object, base: string } | { ok: false, asserted: boolean, status: 401, body: object },
 * }}
 */
export function createAuthenticator(config = {}) {
    const mode = config.mode ?? AUTH_MODE_NONE;
    if (!AUTH_MODES.includes(mode)) throw new AuthConfigError(`unknown auth mode '${mode}'`);
    const fsx = config.fs ?? fs;
    const now = config.now ?? (() => Date.now());
    const logger = config.logger ?? console;
    const logError = (...a) => (logger.error ?? logger.log)?.(...a);
    const issuer = config.issuer ?? null;
    const audience = config.audience || DEFAULT_AUDIENCE;
    const jwksPath = config.jwksPath ?? null;

    const localResult = Object.freeze({ ok: true, asserted: false, identity: LOCAL_IDENTITY, base: '' });
    if (mode === AUTH_MODE_NONE) {
        return { mode, authenticate: () => localResult };
    }

    // JWKS cache, re-read whenever the file's mtime or size changes. Any read
    // or parse failure leaves NO keys (fail closed) until the file is fixed.
    let cachedStamp = null;
    let cachedKeys = new Map();
    let lastError = null;
    function currentKeys() {
        let stamp;
        try {
            const st = fsx.statSync(jwksPath);
            stamp = `${st.mtimeMs}:${st.size}`;
        } catch (err) {
            if (lastError !== 'stat') logError(`[auth] cannot read front JWKS file '${jwksPath}': ${err && err.code ? err.code : 'error'}; rejecting every assertion until it is readable`);
            lastError = 'stat';
            cachedStamp = null;
            cachedKeys = new Map();
            return cachedKeys;
        }
        if (stamp === cachedStamp) return cachedKeys;
        cachedStamp = stamp;
        try {
            cachedKeys = parseJwks(fsx.readFileSync(jwksPath, 'utf8'));
            lastError = null;
        } catch (err) {
            logError(`[auth] front JWKS file '${jwksPath}' is invalid (${err && err.message ? err.message : 'parse error'}); rejecting every assertion until it is fixed`);
            lastError = 'parse';
            cachedKeys = new Map();
        }
        return cachedKeys;
    }

    const reject = (asserted) => ({ ok: false, asserted, status: 401, body: { ...UNAUTHENTICATED_BODY } });

    function authenticate(req) {
        const raw = headerValue(req, IDENTITY_HEADER);
        if (raw !== undefined) {
            const identity = verifyAssertion(String(raw).trim(), {
                keys: currentKeys(), issuer, audience, nowSeconds: Math.floor(now() / 1000),
            });
            if (!identity) return reject(true);
            const base = sanitizeForwardedPrefix(headerValue(req, FORWARDED_PREFIX_HEADER));
            return { ok: true, asserted: true, identity, base };
        }
        const remote = req && req.socket ? req.socket.remoteAddress : undefined;
        if (isLoopbackAddress(remote)) return localResult;
        return reject(false);
    }

    return { mode, authenticate };
}

/** The actor recorded for audit: `{ sub, name }`. */
export function actorOf(identity) {
    const id = identity ?? LOCAL_IDENTITY;
    return { sub: id.sub, name: id.name ?? null };
}
