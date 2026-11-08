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
// =============================================================================

import crypto from 'node:crypto';

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
        const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
        if (m) return m[1].trim();
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

/**
 * Decides whether a request may reach a mutating route.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ token?: string|null }} [opts] - `token`: the accepted token, or
 *   empty/absent when no token mechanism is configured (then only same-origin
 *   requests pass).
 * @returns {null | { status: number, error: string }} null when allowed, else
 *   the status and message to answer with.
 */
export function checkMutatingRequest(req, opts = {}) {
    const method = String((req && req.method) || 'GET').toUpperCase();
    if (SAFE_METHODS.has(method)) return null;

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
