// =============================================================================
// Browser session for the supervisor's HTML pages (apra-fleet-50j6.6)
// =============================================================================
//
// The open, read-only pages (GET /, the extra index paths, the /ui project
// page) must never hand an unauthenticated caller a credential: the service
// token may be the shared fleet key, and any local process can reach the
// loopback port. So:
//
//   - A page request WITHOUT credentials renders, sets NO cookie, and shows a
//     short notice saying how to sign in.
//   - A page request carrying `?token=<service token>` is a token exchange:
//     a constant-time match sets the se_token cookie to the DERIVED value
//     (auth.mjs deriveDashboardCookie -- not reversible into the token) and
//     302-redirects to the same mount-aware path with the token removed from
//     the URL. A mismatch sets no cookie and answers 401.
//
// This module is the one implementation both page handlers share.
// =============================================================================

import { TOKEN_COOKIE_NAME, deriveDashboardCookie, isAuthorized, tokenEquals } from './auth.mjs';
import { resolveMountPrefix, mountHref } from './mount-prefix.mjs';

/** Query parameter carrying the service token in a token-exchange request. */
export const TOKEN_EXCHANGE_PARAM = 'token';

/**
 * The `Set-Cookie` header value for an authenticated browser session.
 * @param {string} token the service token (never placed in the cookie itself)
 * @returns {string}
 */
export function dashboardSessionCookie(token) {
    return `${TOKEN_COOKIE_NAME}=${deriveDashboardCookie(token)}; Path=/; SameSite=Strict; HttpOnly`;
}

/**
 * Handle a token-exchange request if `req` is one. Returns `true` when the
 * response has been written (the caller must stop), `false` when the request
 * carries no token parameter (or auth is not configured) and the caller should
 * render the page normally.
 *
 * @param {{ url?: string, headers?: Record<string, unknown> }} req
 * @param {{ writeHead: Function, end: Function }} res
 * @param {string|null|undefined} token the supervisor's service token
 * @returns {boolean}
 */
export function handleTokenExchange(req, res, token) {
    if (typeof token !== 'string' || token.length === 0) return false;
    let url;
    try {
        url = new URL(req.url || '/', 'http://localhost');
    } catch {
        return false;
    }
    if (!url.searchParams.has(TOKEN_EXCHANGE_PARAM)) return false;
    const presented = url.searchParams.get(TOKEN_EXCHANGE_PARAM);
    url.searchParams.delete(TOKEN_EXCHANGE_PARAM);
    const location = mountHref(resolveMountPrefix(req), url.pathname) + url.search;
    if (tokenEquals(presented, token)) {
        res.writeHead(302, {
            location,
            'set-cookie': dashboardSessionCookie(token),
            'cache-control': 'no-store',
            'content-length': 0,
        });
        res.end();
        return true;
    }
    const body = Buffer.from(
        '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"/><title>Sign-in rejected</title></head>' +
        '<body><p>The token in this link was not accepted. ' + signInHintText() + '</p>' +
        '<p><a href="' + escapeAttr(location) + '">Continue without signing in</a></p></body></html>\n',
        'utf-8',
    );
    res.writeHead(401, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
    });
    res.end(body);
    return true;
}

/** @returns {string} plain-text sign-in instructions (no secrets, no paths beyond the documented defaults). */
function signInHintText() {
    return 'To sign in, open this page with ?token=&lt;service token&gt; appended to the URL. ' +
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
 * @param {string|null|undefined} token
 * @returns {string}
 */
export function authNoticeHtml(req, token) {
    if (typeof token !== 'string' || token.length === 0) return '';
    if (isAuthorized(req, token)) return '';
    return '<div class="auth-notice" role="status" style="padding: 8px 16px; font-size: 13px; border: 1px solid #b58900; color: inherit; margin: 8px 16px;">' +
        'Read-only view: actions that change state need sign-in. ' + signInHintText() +
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
