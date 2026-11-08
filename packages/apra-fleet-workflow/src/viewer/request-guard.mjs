// =============================================================================
// Mutating-request guard (cross-site request forgery defence)
// =============================================================================
//
// Shared by the supervisor's route() dispatcher (apra-fleet-se
// src/supervisor/server.mjs) and the per-run dashboard viewer's own POST
// routes (./index.mjs). Both bind loopback HTTP servers whose POST routes
// change state (record an operator answer, launch/stop a run, shut down), so
// any web page the operator happens to visit could otherwise fire a plain HTML
// form POST at them.
//
// Every non-GET/HEAD/OPTIONS request must:
//   (a) carry Content-Type application/json -- a browser can only send that
//       cross-site after a CORS preflight, which these servers never approve,
//       and an HTML form can never send it at all; and
//   (b) be same-origin: no Origin header (a non-browser client: curl, the
//       sprint child's HTTP clients, a server-side proxy) or an Origin whose
//       host equals the request's own Host; a Sec-Fetch-Site of cross-site or
//       same-site is refused too -- UNLESS it carries a valid token
//       (`Authorization: Bearer <token>` or `X-Fleet-Token: <token>`) and a
//       token is configured.
// A presented token that does not match is always refused, even when the
// request would otherwise pass the origin check.
//
// DNS rebinding: (b) compares the Origin with the request's Host header, and a
// rebound page (attacker.example re-resolved to 127.0.0.1) controls BOTH and
// makes them agree. So the Host header is validated first, on EVERY request
// (GET included -- a rebound page could otherwise read /api/sprints, /state):
// checkRequestHost() admits only a Host whose name is a loopback name
// (localhost, 127.0.0.1, [::1]), any IP literal (a page served from an IP
// literal is served by that IP, so it cannot rebind to us), the server's own
// configured bind host (unless a wildcard), or an explicitly allowed extra
// name. The port is not compared: a rebinding attacker cannot choose the NAME
// the browser puts in Host, and a same-machine port-forward/reverse proxy
// legitimately changes the port. A token does not waive the Host check (a
// non-browser token holder sends a real name anyway).
// =============================================================================

import crypto from 'node:crypto';
import net from 'node:net';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Header a client may use instead of `Authorization: Bearer`. */
export const TOKEN_HEADER = 'x-fleet-token';

function headerValue(req, name) {
    const v = req && req.headers ? req.headers[name] : undefined;
    if (Array.isArray(v)) return v[0];
    return typeof v === 'string' ? v : undefined;
}

function presentedToken(req) {
    const auth = headerValue(req, 'authorization');
    if (auth) {
        // No regex: a prefix check cannot backtrack on a hostile header.
        const a = auth.trim();
        if (a.length > 7 && a.slice(0, 6).toLowerCase() === 'bearer' && /^\s$/.test(a[6])) {
            const tok = a.slice(7).trim();
            if (tok) return tok;
        }
    }
    const t = headerValue(req, TOKEN_HEADER);
    return t ? t.trim() : undefined;
}

function tokensEqual(a, b) {
    const ba = Buffer.from(String(a), 'utf-8');
    const bb = Buffer.from(String(b), 'utf-8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

/** True when the request's Content-Type media type is application/json. */
export function isJsonContentType(req) {
    const ct = headerValue(req, 'content-type');
    if (!ct) return false;
    return ct.split(';')[0].trim().toLowerCase() === 'application/json';
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const WILDCARD_BIND_HOSTS = new Set(['', '0.0.0.0', '::', '[::]']);

/**
 * Normalises a host name or `host[:port]` value to the lowercase hostname a
 * WHATWG URL would report (IPv6 bracketed, trailing dot dropped), or null when
 * it does not parse.
 * @param {string} value
 * @returns {string|null}
 */
export function normalizeHostName(value) {
    let v = String(value ?? '').trim();
    if (!v) return null;
    // A bare IPv6 literal (bind host '::1') needs brackets to parse as a host.
    if (!v.startsWith('[') && net.isIPv6(v)) v = `[${v}]`;
    try {
        const u = new URL(`http://${v}`);
        if (u.username || u.password || (u.pathname && u.pathname !== '/') || u.search || u.hash) return null;
        const name = u.hostname.toLowerCase().replace(/\.$/, '');
        return name || null;
    } catch {
        return null;
    }
}

/**
 * Parses a comma/whitespace separated allowed-hosts list (an env var or CLI
 * value) into normalised host names; unparseable entries are dropped.
 * @param {string|string[]|null|undefined} value
 * @returns {string[]}
 */
export function parseAllowedHosts(value) {
    const parts = Array.isArray(value) ? value.flatMap((v) => String(v).split(/[\s,]+/)) : String(value ?? '').split(/[\s,]+/);
    return parts.map(normalizeHostName).filter(Boolean);
}

function isIpLiteralHost(name) {
    const bare = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
    return net.isIP(bare) !== 0;
}

/**
 * Validates the request's Host header (DNS-rebinding defence). Applies to every
 * method. A request with no Host header (HTTP/1.0, some raw clients) is
 * admitted: a browser always sends one.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ bindHost?: string|null, allowedHosts?: string[]|string|null }} [opts]
 *   `bindHost`: the interface the server bound (admitted as a name unless it
 *   is a wildcard such as 0.0.0.0); `allowedHosts`: extra names to admit (for
 *   an off-box bind reached by DNS name).
 * @returns {null | { status: number, error: string }}
 */
export function checkRequestHost(req, opts = {}) {
    const raw = headerValue(req, 'host');
    if (raw === undefined || raw.trim() === '') return null;
    const name = normalizeHostName(raw);
    if (name) {
        if (LOOPBACK_NAMES.has(name) || isIpLiteralHost(name)) return null;
        const bind = opts.bindHost ? String(opts.bindHost).trim().toLowerCase() : '';
        if (!WILDCARD_BIND_HOSTS.has(bind) && normalizeHostName(bind) === name) return null;
        if (parseAllowedHosts(opts.allowedHosts).includes(name)) return null;
    }
    return {
        status: 403,
        error: `request refused: Host '${raw}' is not a name this server answers to (possible DNS rebinding); add it to the server's allowed hosts if it is legitimate`,
    };
}

/**
 * Decides whether a request may reach a mutating route. Also runs
 * checkRequestHost() first, so a rebound page whose Origin and Host agree on a
 * foreign name is refused.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ token?: string|null, bindHost?: string|null, allowedHosts?: string[]|string|null }} [opts] -
 *   `token`: the accepted token, or empty/absent when no token mechanism is
 *   configured (then only same-origin requests pass); `bindHost` and
 *   `allowedHosts`: see checkRequestHost().
 * @returns {null | { status: number, error: string }} null when allowed, else
 *   the status and message to answer with.
 */
export function checkMutatingRequest(req, opts = {}) {
    const method = String((req && req.method) || 'GET').toUpperCase();
    if (SAFE_METHODS.has(method)) return null;

    const badHost = checkRequestHost(req, opts);
    if (badHost) return badHost;

    if (!isJsonContentType(req)) {
        return {
            status: 415,
            error: `${method} requests must send Content-Type: application/json (form, multipart and text/plain bodies are refused)`,
        };
    }

    const configured = typeof opts.token === 'string' && opts.token.length > 0 ? opts.token : null;
    const presented = presentedToken(req);
    if (presented !== undefined) {
        if (configured && tokensEqual(presented, configured)) return null;
        return { status: 403, error: 'invalid token' };
    }

    const fetchSite = (headerValue(req, 'sec-fetch-site') || '').trim().toLowerCase();
    if (fetchSite === 'cross-site' || fetchSite === 'same-site') {
        return { status: 403, error: `cross-site request refused (Sec-Fetch-Site: ${fetchSite})` };
    }

    const origin = headerValue(req, 'origin');
    if (origin !== undefined) {
        const host = (headerValue(req, 'host') || '').trim().toLowerCase();
        let originHost = null;
        try {
            const u = new URL(origin);
            if (u.protocol === 'http:' || u.protocol === 'https:') originHost = u.host.toLowerCase();
        } catch { /* 'null' or malformed -- refused below */ }
        if (!originHost || !host || originHost !== host) {
            return { status: 403, error: `cross-site request refused (Origin ${origin} is not this server's origin)` };
        }
    }
    return null;
}

/**
 * Header names a same-host proxy must drop when forwarding a request it has
 * already admitted with checkMutatingRequest(): the browser's Origin and fetch
 * metadata describe the PROXY's origin, which the upstream (a different port)
 * would otherwise read as cross-site, and the proxy's own token means nothing
 * upstream (a presented-but-unknown token is refused there).
 */
export const ADMITTED_REQUEST_STRIP_HEADERS = Object.freeze([
    'origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
    'authorization', TOKEN_HEADER,
]);
