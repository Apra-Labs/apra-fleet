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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Subdirectory of the supervisor data root that holds operator-private state. */
export const PRIVATE_DIRNAME = 'private';

/** Filename of the service token inside PRIVATE_DIRNAME. */
export const TOKEN_FILENAME = 'token';

/** Required POSIX mode of the token file (owner read/write only). */
export const TOKEN_FILE_MODE = 0o600;

/** Required POSIX mode of the private directory (owner only). */
export const PRIVATE_DIR_MODE = 0o700;

/** Number of random bytes minted per token (hex-encoded => 64 chars). */
export const TOKEN_BYTES = 32;

/** Cookie name accepted as an alternative to the Authorization header. */
export const TOKEN_COOKIE_NAME = 'se_token';

/**
 * Health warning emitted when the token file's protection could not be proved
 * (Windows: ACL inheritance is assumed but unverifiable from this process).
 */
export const TOKEN_ACL_UNVERIFIED_WARNING = 'token-file-acl-unverified';

/** A minted token is exactly TOKEN_BYTES of lowercase hex. */
const TOKEN_PATTERN = new RegExp(`^[0-9a-f]{${TOKEN_BYTES * 2}}$`);

/**
 * Routes behind the guard by shape: POST to a live sprint control endpoint.
 * The trailing slash is load-bearing -- `POST /sprints/x/live` (the live view
 * itself) is NOT guarded; only sub-routes under it (e.g. .../live/stop) are.
 */
const LIVE_CONTROL_PATTERN = /^\/sprints\/[^/]+\/live\//;

/**
 * Dummy origin used to normalize a request path before matching. Mirrors the
 * HTTP router's own `new URL(req.url || '/', <origin>)`, so the guard and the
 * dispatcher can never disagree about which route a URL names.
 */
const NORMALIZATION_BASE = 'http://localhost';

/** True when this process is running on Windows (Git Bash included). */
function isWindows() {
    return process.platform === 'win32';
}

/**
 * Absolute path of the token file for a supervisor data root. A pure function of
 * `dir` on every platform, which is what makes "two starts on one dir reuse the
 * same token" hold identically on POSIX and Windows.
 * @param {string} dir supervisor data root
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
 * conflating the two lets a racing supervisor delete a peer's good token.
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
 * Mint the supervisor service token, or reuse the one already on disk.
 *
 * Idempotent: repeated calls against the same `dir` always return the same
 * token. Creation is exclusive (flag 'wx') and an absent file is never
 * unlinked, so two supervisors racing on a COLD data root converge on one
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
 * @param {string} dir supervisor data root
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
        // otherwise wedge the supervisor permanently by defeating the exclusive
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
 * Does this request carry the service token?
 *
 * Accepts `Authorization: Bearer <token>` (scheme match is case-insensitive per
 * RFC 7235) or the `se_token=<token>` cookie, which is what lets a browser-based
 * dashboard reach the same guarded routes.
 *
 * @param {{ headers?: Record<string, unknown> }} req incoming request (or any
 *   object with a `headers` bag)
 * @param {string} token the expected service token
 * @returns {boolean}
 */
export function isAuthorized(req, token) {
    if (typeof token !== 'string' || token.length === 0) return false;
    const headers = (req && req.headers) || {};

    const authorization = headers.authorization ?? headers.Authorization;
    if (typeof authorization === 'string') {
        const match = /^bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization.trim());
        if (match && tokensMatch(match[1], token)) return true;
    }

    const cookie = headers.cookie ?? headers.Cookie;
    const fromCookie = readCookie(cookie, TOKEN_COOKIE_NAME);
    if (fromCookie !== null && tokensMatch(fromCookie, token)) return true;

    return false;
}

/**
 * Is this route behind the auth guard?
 *
 * Guarded: the whole `/api/` surface (read and write alike -- it exposes ledger
 * and member state), plus POST to any sub-route of a sprint's live view, which
 * is where the mutating controls (stop, pause) live. Everything else -- the
 * dashboard shell, /state, /events, the live view itself, history -- stays open
 * because the server is loopback-bound and those are read-only views.
 *
 * The path is normalized exactly the way the HTTP router normalizes it (parse
 * against a dummy origin, take `.pathname`) before any matching, so a raw
 * `req.url` and a pre-parsed `url.pathname` always answer the same. Without
 * that, `/foo/../api/health` would answer OPEN here while the router dispatched
 * the guarded `/api/health` handler -- an auth bypass. An unparseable path is
 * fail-closed (guarded).
 *
 * @param {string} method HTTP method
 * @param {string} urlPath request path or raw `req.url` (a query string,
 *   fragment, or dot segments are all tolerated; an origin is not expected)
 * @returns {boolean}
 */
export function requiresAuth(method, urlPath) {
    const raw = typeof urlPath === 'string' && urlPath.length > 0 ? urlPath : '/';
    let p;
    try {
        p = new URL(raw, NORMALIZATION_BASE).pathname;
    } catch {
        return true;
    }
    if (p.startsWith('/api/')) return true;
    const verb = typeof method === 'string' ? method.toUpperCase() : '';
    return verb === 'POST' && LIVE_CONTROL_PATTERN.test(p);
}
