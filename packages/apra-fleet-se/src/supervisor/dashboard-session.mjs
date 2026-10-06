// =============================================================================
// Browser session for the supervisor's HTML pages (apra-fleet-50j6.6, 50j6.12)
// =============================================================================
//
// The open, read-only pages (GET /, the extra index paths, the /ui project
// page) must never hand an unauthenticated caller a credential: the service
// token may be the shared fleet key, and any local process can reach the
// loopback port. So:
//
//   - A page request WITHOUT credentials renders, sets NO cookie, and shows a
//     short notice with a paste-token sign-in form.
//   - The form POSTs the token in the request BODY to `POST /signin`
//     (registerSignInRoute below). A same-origin request carrying a
//     constant-time match sets the se_token cookie to the DERIVED value
//     (auth.mjs deriveDashboardCookie -- not reversible into the token) and
//     303-redirects back to the page. A mismatch sets no cookie and answers
//     401; a cross-origin request answers 403 before the token is compared.
//   - The long-lived token never travels in a URL: a page request carrying
//     `?token=` is answered 400 with the sign-in page and NO cookie, and the
//     presented value is never compared (a URL ends up in browser history,
//     autocomplete and copied links, and a command line that builds one puts
//     the key in the process list).
//
// The token is passed as a value or as a provider function so callers can
// hand in the supervisor's LIVE token (server.mjs re-resolves it when the
// fleet key appears or rotates) rather than a startup snapshot.
// =============================================================================

import { TOKEN_COOKIE_NAME, deriveDashboardCookie, isAuthorized, tokenEquals } from './auth.mjs';
import { resolveMountPrefix, mountHref } from './mount-prefix.mjs';

/** Query parameter that used to carry the service token. Refused now. */
export const TOKEN_EXCHANGE_PARAM = 'token';

/** App path of the paste-token sign-in POST route. */
export const SIGN_IN_PATH = '/signin';

/** Form field carrying the service token in the POST body. */
export const SIGN_IN_TOKEN_FIELD = 'token';

/** Form field carrying the app path to return to after sign-in. */
export const SIGN_IN_NEXT_FIELD = 'next';

/** Upper bound on a sign-in POST body; a token is a few hundred bytes at most. */
const MAX_SIGN_IN_BODY_BYTES = 8 * 1024;

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Resolve a token that may be given as a value or a provider function.
 * @param {string|null|undefined|(() => string|null|undefined)} token
 * @returns {string|null}
 */
function liveToken(token) {
    const value = typeof token === 'function' ? token() : token;
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The `Set-Cookie` header value for an authenticated browser session.
 * @param {string} token the service token (never placed in the cookie itself)
 * @returns {string}
 */
export function dashboardSessionCookie(token) {
    return `${TOKEN_COOKIE_NAME}=${deriveDashboardCookie(token)}; Path=/; SameSite=Strict; HttpOnly`;
}

/**
 * A safe app path to return to after sign-in: a root-relative path only
 * (never protocol-relative or absolute), with any token parameter dropped.
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeNextPath(raw) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return '/';
    if (raw.charAt(0) !== '/' || raw.charAt(1) === '/' || raw.charAt(1) === '\\') return '/';
    if (/[\\\u0000-\u001f]/.test(raw)) return '/';
    let url;
    try {
        url = new URL(raw, 'http://localhost');
    } catch {
        return '/';
    }
    if (url.origin !== 'http://localhost') return '/';
    url.searchParams.delete(TOKEN_EXCHANGE_PARAM);
    return url.pathname + url.search;
}

/**
 * Is this POST a same-origin browser request (or a non-browser client)?
 *
 * - `Sec-Fetch-Site`, when the browser sends it, must be `same-origin` or
 *   `none` (user-initiated).
 * - `Origin`, when present, must be an http loopback origin whose host:port
 *   equals the request's `Host` header. `Origin: null` (sandboxed frame,
 *   opaque redirect) is refused.
 * - A request with neither header is a non-browser client (curl), which is
 *   not a cross-site request forgery vector, and is allowed.
 *
 * @param {{ headers?: Record<string, unknown> }} req
 * @returns {boolean}
 */
export function isSameOriginRequest(req) {
    const headers = (req && req.headers) || {};
    const fetchSite = headers['sec-fetch-site'];
    if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
    const origin = headers.origin;
    if (origin === undefined) return true;
    if (typeof origin !== 'string' || origin === 'null') return false;
    let parsed;
    try {
        parsed = new URL(origin);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'http:') return false;
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) return false;
    const host = typeof headers.host === 'string' ? headers.host.toLowerCase() : '';
    return host.length > 0 && parsed.host === host;
}

/**
 * Refuse a page request that carries the service token in its URL. Returns
 * `true` when the response has been written (the caller must stop), `false`
 * when the request has no token parameter and the page should render
 * normally. The presented value is NEVER compared and never sets a cookie:
 * the answer is 400 with the sign-in form.
 *
 * @param {{ url?: string, headers?: Record<string, unknown> }} req
 * @param {{ writeHead: Function, end: Function }} res
 * @param {string|null|undefined|(() => string|null|undefined)} token the supervisor's service token
 * @returns {boolean}
 */
export function handleTokenInUrl(req, res, token) {
    let url;
    try {
        url = new URL(req.url || '/', 'http://localhost');
    } catch {
        return false;
    }
    if (!url.searchParams.has(TOKEN_EXCHANGE_PARAM)) return false;
    url.searchParams.delete(TOKEN_EXCHANGE_PARAM);
    const mountPrefix = resolveMountPrefix(req);
    const next = url.pathname + url.search;
    const form = liveToken(token) ? signInFormHtml(mountPrefix, next) : '';
    sendSignInPage(res, 400, 'Sign-in link refused',
        '<p>A service token in a page address is not accepted: the address can end up in browser history ' +
        'and copied links. Paste the token into the sign-in form instead.</p>' + form +
        '<p><a href="' + escapeAttr(mountHref(mountPrefix, next)) + '">Continue without signing in</a></p>');
    return true;
}

/**
 * Register `POST /signin` -- the paste-token sign-in form's target -- on a
 * supervisor (server.mjs). Not behind the auth guard (requiresAuth leaves it
 * open); it is the way in.
 *
 * Body: `application/x-www-form-urlencoded` with `token` (the service token)
 * and optional `next` (the app path to return to). Answers:
 *   - 403, no cookie: cross-origin request (checked before the token)
 *   - 415 / 413 / 400, no cookie: wrong content type, oversized or bad body
 *   - 401, no cookie: token mismatch (constant-time compare)
 *   - 303 to `next` (mount-aware) with the derived se_token cookie: match
 *   - 404: auth is not configured on this supervisor
 *
 * @param {{ route: Function, token?: string|null }} supervisor reads
 *   `supervisor.token` on every request, so a re-resolved token is honoured.
 */
export function registerSignInRoute(supervisor) {
    supervisor.route('POST', SIGN_IN_PATH, (req, res) => handleSignInPost(req, res, () => supervisor.token));
}

/**
 * The `POST /signin` handler (see registerSignInRoute).
 * @param {any} req
 * @param {any} res
 * @param {string|null|undefined|(() => string|null|undefined)} token
 * @returns {Promise<void>}
 */
export async function handleSignInPost(req, res, token) {
    const mountPrefix = resolveMountPrefix(req);
    const expected = liveToken(token);
    if (!expected) {
        sendSignInPage(res, 404, 'Sign-in unavailable', '<p>This supervisor has no service token configured.</p>');
        return;
    }
    if (!isSameOriginRequest(req)) {
        sendSignInPage(res, 403, 'Sign-in refused', '<p>Cross-origin sign-in requests are not accepted.</p>');
        return;
    }
    const contentType = String((req.headers && req.headers['content-type']) || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/x-www-form-urlencoded') {
        sendSignInPage(res, 415, 'Sign-in refused', '<p>Sign-in expects a form submission.</p>');
        return;
    }
    let raw;
    try {
        raw = await readBody(req, MAX_SIGN_IN_BODY_BYTES);
    } catch {
        sendSignInPage(res, 413, 'Sign-in refused', '<p>The sign-in request was too large.</p>');
        return;
    }
    const form = new URLSearchParams(raw);
    const next = sanitizeNextPath(form.get(SIGN_IN_NEXT_FIELD));
    const presented = (form.get(SIGN_IN_TOKEN_FIELD) || '').trim();
    if (tokenEquals(presented, expected)) {
        res.writeHead(303, {
            location: mountHref(mountPrefix, next),
            'set-cookie': dashboardSessionCookie(expected),
            'cache-control': 'no-store',
            'content-length': 0,
        });
        res.end();
        return;
    }
    sendSignInPage(res, 401, 'Sign-in rejected',
        '<p>The token was not accepted.</p>' + signInFormHtml(mountPrefix, next) +
        '<p><a href="' + escapeAttr(mountHref(mountPrefix, next)) + '">Continue without signing in</a></p>');
}

function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                reject(new Error('body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}

function sendSignInPage(res, status, title, bodyHtml) {
    const body = Buffer.from(
        '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"/><title>' + escapeAttr(title) + '</title></head>' +
        '<body>' + bodyHtml + '</body></html>\n',
        'utf-8',
    );
    res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
    });
    res.end(body);
}

/**
 * The paste-token sign-in form. Posts to the mount-aware SIGN_IN_PATH.
 * @param {string} mountPrefix
 * @param {string} next app path to return to
 * @returns {string}
 */
export function signInFormHtml(mountPrefix, next) {
    return '<form class="sign-in-form" method="post" action="' + escapeAttr(mountHref(mountPrefix, SIGN_IN_PATH)) + '" style="display: inline-flex; gap: 6px; margin-top: 6px;">' +
        '<input type="hidden" name="' + SIGN_IN_NEXT_FIELD + '" value="' + escapeAttr(sanitizeNextPath(next)) + '"/>' +
        '<input type="password" name="' + SIGN_IN_TOKEN_FIELD + '" autocomplete="off" placeholder="service token" aria-label="service token" required/>' +
        '<button type="submit">Sign in</button></form>';
}

/** @returns {string} plain-text sign-in instructions (no secrets, no paths beyond the documented defaults). */
function signInHintText() {
    return 'To sign in, paste the service token into the form below (never put it in a page address). ' +
        'The service token is the contents of ~/.apra-fleet/fleet.key, or, when that file does not exist, ' +
        'of private/token under the supervisor data directory; the supervisor log names which one it uses at startup.';
}

function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The notice an unauthenticated page view shows, or '' when the request is
 * already authenticated (or auth is not configured).
 * @param {{ headers?: Record<string, unknown> }} req
 * @param {string|null|undefined|(() => string|null|undefined)} token
 * @returns {string}
 */
export function authNoticeHtml(req, token) {
    const expected = liveToken(token);
    if (!expected) return '';
    if (isAuthorized(req, expected)) return '';
    let next = '/';
    try {
        const url = new URL((req && req.url) || '/', 'http://localhost');
        next = url.pathname + url.search;
    } catch { /* fall back to '/' */ }
    return '<div class="auth-notice" role="status" style="padding: 8px 16px; font-size: 13px; border: 1px solid #b58900; color: inherit; margin: 8px 16px;">' +
        'Read-only view: actions that change state need sign-in. ' + signInHintText() +
        signInFormHtml(resolveMountPrefix(req), next) +
        '</div>\n';
}

/**
 * Insert `notice` right after the page's opening `<body>` tag.
 * @param {string} html
 * @param {string} notice
 * @returns {string}
 */
export function injectAuthNotice(html, notice) {
    if (!notice) return html;
    const idx = html.indexOf('<body>');
    if (idx === -1) return notice + html;
    const at = idx + '<body>'.length;
    return html.slice(0, at) + '\n' + notice + html.slice(at);
}
