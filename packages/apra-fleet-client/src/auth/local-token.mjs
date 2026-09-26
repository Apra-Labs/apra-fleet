// =============================================================================
// Shared local-token helper (apra-fleet-iywi.1.1, C3/DQ-20/s4.4).
//
// Generic pieces lifted out of packages/apra-fleet-se/src/supervisor/auth.mjs
// so any local HTTP surface on this machine (the fleet-sprint supervisor, the
// apra-fleet server console, and any future caller) can share ONE token
// resolution, bearer/cookie credential check, and fail-closed path
// normaliser -- without sharing route policy. Route policy (which paths are
// guarded, which cookie name to use) is deliberately NOT here: each caller
// keeps its own `requiresAuth`/guard so one caller's prefix rule can never
// leak into another's route table (see the closed regression
// apra-fleet-hzb2, where a blanket `/api/` rule in the supervisor 401ed an
// unauthenticated `GET /api/health`).
//
// This module owns:
//   readLocalToken(dataDir, opts) -- resolve the shared credential: prefer
//     <home>/.apra-fleet/fleet.key, fall back to <dataDir>/private/token.
//   loadOrCreateToken(dataDir) -- idempotent mint-or-reuse of the
//     private/token fallback file.
//   isAuthorized(req, token, opts) -- does this request carry `token`, via
//     bearer header or a caller-named cookie?
//   readCookie(header, name) -- extract one cookie by exact name.
//   cookieFor(token, opts) -- build a Set-Cookie value for `token`.
//   normalizePath(urlPath) -- parse a raw request path the same way the HTTP
//     router does, or `null` if it cannot be parsed (callers must treat
//     `null` as "guarded" to fail closed).
//
// FILE PERMISSIONS: POSIX vs Windows (private/token fallback only) --
// unchanged from the original supervisor module. On POSIX the token file is
// created 0600 and that mode is re-asserted on every load. Windows has no
// POSIX mode bits, so the returned descriptor carries `aclVerified: false`
// there; callers may surface TOKEN_ACL_UNVERIFIED_WARNING.
//
// The token itself is NEVER logged or included in a thrown Error message.
// =============================================================================

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Subdirectory of a caller's data root that holds operator-private state. */
export const PRIVATE_DIRNAME = 'private';

/** Filename of the fallback token inside PRIVATE_DIRNAME. */
export const TOKEN_FILENAME = 'token';

/** Required POSIX mode of the token file (owner read/write only). */
export const TOKEN_FILE_MODE = 0o600;

/** Required POSIX mode of the private directory (owner only). */
export const PRIVATE_DIR_MODE = 0o700;

/** Number of random bytes minted per fallback token (hex-encoded => 64 chars). */
export const TOKEN_BYTES = 32;

/**
 * Health warning emitted when the token file's protection could not be proved
 * (Windows: ACL inheritance is assumed but unverifiable from this process).
 */
export const TOKEN_ACL_UNVERIFIED_WARNING = 'token-file-acl-unverified';

/** Cookie name used when a caller does not supply one. */
const DEFAULT_COOKIE_NAME = 'local_token';

/** A minted token is exactly TOKEN_BYTES of lowercase hex. */
const TOKEN_PATTERN = new RegExp(`^[0-9a-f]{${TOKEN_BYTES * 2}}$`);

/**
 * Dummy origin used to normalize a request path before matching. Mirrors an
 * HTTP router's own `new URL(req.url || '/', <origin>)`, so a guard and its
 * dispatcher can never disagree about which route a URL names.
 */
const NORMALIZATION_BASE = 'http://localhost';

/**
 * Subdirectory of `home` holding the shared fleet key (src/services/jwt.ts's
 * KEY_PATH, which is hardcoded to `os.homedir()` and does NOT honor
 * APRA_FLEET_DATA_DIR -- see jwt.ts line 6). `home` is overridable here only
 * so a test can point it at a fixture; jwt.ts itself has no such override,
 * so every OTHER reader/writer of this file always uses the real
 * `os.homedir()`.
 */
const FLEET_KEY_DIRNAME = '.apra-fleet';

/** Filename of the shared fleet key inside FLEET_KEY_DIRNAME (jwt.ts's KEY_PATH). */
const FLEET_KEY_FILENAME = 'fleet.key';

/** True when this process is running on Windows (Git Bash included). */
function isWindows() {
    return process.platform === 'win32';
}

/**
 * Absolute path of the fallback token file for a caller's data root. A pure
 * function of `dir` on every platform, which is what makes "two starts on
 * one dir reuse the same token" hold identically on POSIX and Windows.
 * @param {string} dir caller's data root
 * @returns {string}
 */
export function tokenFilePath(dir) {
    if (typeof dir !== 'string' || dir.length === 0) {
        throw new TypeError('loadOrCreateToken: dir must be a non-empty path');
    }
    return path.join(dir, PRIVATE_DIRNAME, TOKEN_FILENAME);
}

/**
 * Sentinel returned by readExistingToken when the token file exists but holds
 * nothing but whitespace (a torn write from a crashed mint). It MUST stay
 * distinct from `null` (file absent): only the torn-write case may unlink, and
 * conflating the two lets a racing process delete a peer's good token.
 */
const TOKEN_FILE_EMPTY = Symbol('token-file-empty');

/**
 * Read an existing token file.
 * @param {string} file
 * @returns {string|null|typeof TOKEN_FILE_EMPTY} the token, `null` if the file
 *   is absent, or TOKEN_FILE_EMPTY if it exists but is blank
 */
function readExistingToken(file) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err && err.code === 'ENOENT') return null;
        throw err;
    }
    const token = raw.trim();
    // An empty/whitespace-only file is a torn write from a crashed mint: report
    // it distinctly so the caller may clear it. Anything else non-empty but
    // malformed is somebody else's file and must not be silently replaced.
    if (token.length === 0) return TOKEN_FILE_EMPTY;
    if (!TOKEN_PATTERN.test(token)) {
        throw new Error(
            `Service token file is malformed (expected ${TOKEN_BYTES * 2} hex chars): ${file}`,
        );
    }
    return token;
}

/**
 * Enforce 0600 on POSIX and prove it. Heals a loosened file rather than failing,
 * but a mode that cannot be made 0600 is fatal -- the token is a credential.
 * @param {string} file
 */
function enforcePosixTokenMode(file) {
    fs.chmodSync(file, TOKEN_FILE_MODE);
    const mode = fs.statSync(file).mode & 0o777;
    if (mode !== TOKEN_FILE_MODE) {
        throw new Error(
            `Service token file has mode 0${mode.toString(8)}, expected 0600: ${file}`,
        );
    }
}

/**
 * Mint the fallback token, or reuse the one already on disk.
 *
 * Idempotent: repeated calls against the same `dir` always return the same
 * token. Creation is exclusive (flag 'wx') and an absent file is never
 * unlinked, so two processes racing on a COLD data root converge on one
 * token: the loser of the create race adopts the winner's token rather than
 * clobbering it.
 *
 * Known bounded exception: recovery from a torn write. 'wx' is open-then-write,
 * so a peer that reads the file in that microsecond window sees it blank, treats
 * it as a torn mint, unlinks it and mints its own -- the two starts then diverge.
 * Closing that window needs write-temp-then-rename, which loses the atomic
 * create-with-mode-0600 property, so the window is accepted rather than traded
 * away. Do NOT widen this claim to "no race can ever diverge".
 *
 * @param {string} dir caller's data root
 * @returns {{ token: string, path: string, created: boolean, aclVerified: boolean }}
 *   `aclVerified` is true only when the file's protection was actually proved
 *   (POSIX mode 0600). On Windows it is false and callers should surface
 *   TOKEN_ACL_UNVERIFIED_WARNING.
 */
export function loadOrCreateToken(dir) {
    const file = tokenFilePath(dir);
    const windows = isWindows();

    fs.mkdirSync(path.dirname(file), {
        recursive: true,
        ...(windows ? {} : { mode: PRIVATE_DIR_MODE }),
    });

    const existing = readExistingToken(file);
    let token = typeof existing === 'string' ? existing : null;
    let created = false;

    if (token === null) {
        // Unlink ONLY a present-but-blank file (a torn mint), which would
        // otherwise wedge the process permanently by defeating the exclusive
        // create below. The absent case must NOT unlink: under a concurrent cold
        // start our read can lose to a peer's write, and unlinking there would
        // delete the peer's fully written token and hand out a divergent one.
        if (existing === TOKEN_FILE_EMPTY) {
            try {
                fs.unlinkSync(file);
            } catch (err) {
                if (!err || err.code !== 'ENOENT') throw err;
            }
        }
        const minted = crypto.randomBytes(TOKEN_BYTES).toString('hex');
        try {
            fs.writeFileSync(file, minted, { mode: TOKEN_FILE_MODE, flag: 'wx' });
            token = minted;
            created = true;
        } catch (err) {
            if (!err || err.code !== 'EEXIST') throw err;
            // Lost the create race (or an empty file was completed by a peer):
            // the winner's token is authoritative.
            const raced = readExistingToken(file);
            token = typeof raced === 'string' ? raced : null;
            if (token === null) {
                // A peer created the file but has not written it yet. Truncating
                // and re-minting here would hand out a token the peer never sees,
                // so fail loudly instead of guessing.
                throw new Error(`Service token file exists but is empty: ${file}`);
            }
        }
    }

    if (!windows) enforcePosixTokenMode(file);

    return { token, path: file, created, aclVerified: !windows };
}

/**
 * Read-only counterpart of loadOrCreateToken(): returns the private/token
 * contents for `dir` if the file exists and is well-formed, or `null`
 * otherwise. Unlike loadOrCreateToken() this NEVER creates the private/
 * directory, NEVER writes the token file, and NEVER heals its mode --
 * a pure read with no side effect on disk.
 * @param {string} dir caller's data root
 * @returns {string|null}
 */
function readPrivateTokenOnly(dir) {
    const file = tokenFilePath(dir);
    const existing = readExistingToken(file);
    return typeof existing === 'string' ? existing : null;
}

/**
 * Resolve a caller's local credential: prefer the shared
 * `<home>/.apra-fleet/fleet.key` (the SAME file src/services/jwt.ts's
 * getOrCreateKey() reads/mints, so every local caller can share one token)
 * over the `<dataDir>/private/token` file `loadOrCreateToken()` mints.
 *
 * This function never MINTS fleet.key itself -- jwt.ts owns creation -- it
 * only reads one if already present and well-formed (a trimmed 64-char
 * lowercase-hex string, the exact shape jwt.ts's getOrCreateKey() and this
 * module's own TOKEN_PATTERN both use). A present-but-malformed fleet.key is
 * REJECTED (never used as the token) and logged as a warning via
 * `opts.logger` (default `console`); resolution then falls through to the
 * private/token fallback exactly as if fleet.key were absent.
 *
 * `opts.createIfMissing` (default `true`, preserving every existing caller
 * byte-for-byte) gates what happens when fleet.key is absent/malformed. When
 * `true` (the default), the private/token fallback mints-or-reuses via
 * loadOrCreateToken() as before. When `false`, the private/token fallback is
 * READ-ONLY (readPrivateTokenOnly(): no mkdir, no write, no mode healing) --
 * if no well-formed token exists at either source this returns `null`
 * instead of minting one. Read-only callers (deploy pre-flight checks,
 * snapshot/verify probes against an already-running server) MUST pass
 * `createIfMissing: false` so a mere read never mints a credential as a side
 * effect.
 *
 * @param {string} dataDir caller's data root (passed through to
 *   loadOrCreateToken() for the private/token fallback)
 * @param {{ home?: string, logger?: { warn?: Function }, createIfMissing?: boolean }} [opts]
 *   `home` overrides where the fleet-key lookup is rooted -- tests MUST pass
 *   a temp dir here (jwt.ts's own KEY_PATH has no such override, so
 *   `loadOrCreateToken`'s fallback is otherwise the only test-isolated path).
 *   `home` defaults to the real `os.homedir()`, matching production.
 *   `createIfMissing` defaults to `true`; pass `false` for a read-only probe.
 * @returns {{ token: string, path: string, source: 'fleet-key'|'private-token', aclVerified: boolean, created: boolean }|null}
 *   `null` only when `createIfMissing: false` and no token exists at either
 *   source.
 */
export function readLocalToken(dataDir, opts = {}) {
    const home = typeof opts.home === 'string' && opts.home.length > 0 ? opts.home : os.homedir();
    const logger = opts.logger && typeof opts.logger.warn === 'function' ? opts.logger : console;
    const createIfMissing = opts.createIfMissing !== false;
    const fleetKeyPath = path.join(home, FLEET_KEY_DIRNAME, FLEET_KEY_FILENAME);

    let raw = null;
    try {
        raw = fs.readFileSync(fleetKeyPath, 'utf8');
    } catch {
        // Absent (or unreadable) fleet.key -- fall through to private/token
        // without comment; only a PRESENT-but-malformed file is worth a
        // warning (below), since "no fleet.key yet" is the expected steady
        // state before the operator's first `apra-fleet` CLI use.
        raw = null;
    }
    if (raw !== null) {
        const trimmed = raw.trim();
        if (TOKEN_PATTERN.test(trimmed)) {
            return { token: trimmed, path: fleetKeyPath, source: 'fleet-key', aclVerified: !isWindows(), created: false };
        }
        logger.warn(
            `[local-token] WARNING: fleet.key at ${fleetKeyPath} is malformed (expected ${TOKEN_BYTES * 2} lowercase-hex chars) -- `
            + 'never used as the token; falling back to the private/token source.',
        );
    }

    if (!createIfMissing) {
        const token = readPrivateTokenOnly(dataDir);
        if (token === null) return null;
        return { token, path: tokenFilePath(dataDir), source: 'private-token', aclVerified: false, created: false };
    }

    const fallback = loadOrCreateToken(dataDir);
    return { ...fallback, source: 'private-token' };
}

/**
 * Constant-time token comparison. timingSafeEqual throws on length mismatch, so
 * the length is checked first (token length is not secret).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function tokensMatch(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    if (left.length !== right.length || left.length === 0) return false;
    return crypto.timingSafeEqual(left, right);
}

/**
 * Extract one cookie by exact name from a Cookie header value. Matching is on
 * the parsed name, never a substring of the raw header -- `foo_se_token=...`
 * must not satisfy a lookup for `se_token`.
 * @param {unknown} header raw Cookie header value
 * @param {string} name
 * @returns {string|null}
 */
export function readCookie(header, name) {
    if (typeof header !== 'string' || header.length === 0) return null;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() !== name) continue;
        const value = part.slice(eq + 1).trim();
        if (value.length === 0) return null;
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    }
    return null;
}

/**
 * Does this request carry `token`?
 *
 * Accepts `Authorization: Bearer <token>` (scheme match is case-insensitive per
 * RFC 7235) or a named cookie, which is what lets a browser-based UI reach the
 * same guarded routes. The cookie name is a caller-supplied parameter -- each
 * caller picks its own name so one caller's cookie can never be replayed
 * against another's guard.
 *
 * @param {{ headers?: Record<string, unknown> }} req incoming request (or any
 *   object with a `headers` bag)
 * @param {string} token the expected token
 * @param {{ cookieName?: string }} [opts] `cookieName` defaults to
 *   `'local_token'` when omitted; callers with an existing cookie name
 *   (e.g. the supervisor's `se_token`) must pass it explicitly.
 * @returns {boolean}
 */
export function isAuthorized(req, token, opts = {}) {
    if (typeof token !== 'string' || token.length === 0) return false;
    const cookieName = typeof opts.cookieName === 'string' && opts.cookieName.length > 0
        ? opts.cookieName
        : DEFAULT_COOKIE_NAME;
    const headers = (req && req.headers) || {};

    const authorization = headers.authorization ?? headers.Authorization;
    if (typeof authorization === 'string') {
        const match = /^bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization.trim());
        if (match && tokensMatch(match[1], token)) return true;
    }

    const cookie = headers.cookie ?? headers.Cookie;
    const fromCookie = readCookie(cookie, cookieName);
    if (fromCookie !== null && tokensMatch(fromCookie, token)) return true;

    return false;
}

/**
 * Build a `Set-Cookie` header value carrying `token` under a caller-named
 * cookie. Always `HttpOnly`, `SameSite=Strict`, `Path=/` -- never readable
 * from script in the browser and never sent cross-site.
 *
 * Callers that hand a signing secret (like the fleet key) to a browser
 * origin must NOT pass that secret to this function directly -- derive a
 * value that is verifiable but not reversible into the secret first (see
 * packages/apra-fleet-se's console guard for the worked example). This
 * function has no opinion on what `token` is; it only shapes the cookie.
 *
 * @param {string} token value to store in the cookie
 * @param {{ cookieName?: string }} [opts] `cookieName` defaults to
 *   `'local_token'` when omitted.
 * @returns {string} a `Set-Cookie` header value
 */
export function cookieFor(token, opts = {}) {
    if (typeof token !== 'string' || token.length === 0) {
        throw new TypeError('cookieFor: token must be a non-empty string');
    }
    const cookieName = typeof opts.cookieName === 'string' && opts.cookieName.length > 0
        ? opts.cookieName
        : DEFAULT_COOKIE_NAME;
    return `${cookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`;
}

/**
 * Parse a raw request path the same way an HTTP router normally does (parse
 * against a dummy origin, take `.pathname`), so a raw `req.url` and a
 * pre-parsed `url.pathname` always answer the same. Without that,
 * `/foo/../api/health` could answer differently here than the router's own
 * dispatch -- an auth bypass.
 *
 * This is the PATH NORMALISER ONLY -- it carries no route policy. Callers
 * decide for themselves which normalised paths are guarded; an unparseable
 * path returns `null`, and every caller in this codebase treats `null` as
 * "guarded" (fail closed) rather than choosing per-caller.
 *
 * @param {string} urlPath request path or raw `req.url` (a query string,
 *   fragment, or dot segments are all tolerated; an origin is not expected)
 * @returns {string|null} the normalised pathname, or `null` if `urlPath`
 *   could not be parsed at all
 */
export function normalizePath(urlPath) {
    const raw = typeof urlPath === 'string' && urlPath.length > 0 ? urlPath : '/';
    try {
        return new URL(raw, NORMALIZATION_BASE).pathname;
    } catch {
        return null;
    }
}

// =============================================================================
// Per-package upstream credential.
//
// Lifted here from src/console/proxy.ts so BOTH sides of a workflow-package
// hop can derive the same value from the shared fleet key without importing
// the console proxy: the console attaches it on the /ext proxy hop and on the
// registry health probe, and a package's own supervisor accepts it. The
// derivation is byte-for-byte the one the proxy already shipped -- same label,
// same length-prefixed input, same hex sha256 HMAC -- because rotating it
// would invalidate every already-registered package's credential.
//
// The label MUST stay different from any cookie/session label a caller signs
// with the same fleet key (the console's own cookie label in
// src/console/server.ts): equal labels would let a package replay its
// upstream credential as a console credential. That domain separation is the
// entire reason the label is part of the HMAC input.
// =============================================================================

/**
 * Fixed label HMAC'd (together with the package id) under the fleet key to
 * derive a package's upstream credential. Changing this string rotates every
 * package's credential.
 */
export const UPSTREAM_CREDENTIAL_LABEL = 'apra-fleet-ext-upstream-v1';

/**
 * Per-package upstream credential. Keyed digest over a length-prefixed label
 * and package id, so it is (a) not reversible into `fleetKey`, and (b)
 * unambiguously bound to exactly one package id.
 *
 * The length prefix is what removes the id/label ambiguity: without it the
 * ids `"a:b"` and `"a"` + a label ending in `":b"` could produce the same
 * HMAC input, so one package could derive another's credential.
 *
 * @param {string} fleetKey shared fleet key (never included in the output)
 * @param {string} packageId workflow-package id the credential is bound to
 * @returns {string} hex-encoded sha256 HMAC
 */
export function deriveUpstreamCredential(fleetKey, packageId) {
    const input = `${UPSTREAM_CREDENTIAL_LABEL}:${packageId.length}:${packageId}`;
    return crypto.createHmac('sha256', fleetKey).update(input).digest('hex');
}
