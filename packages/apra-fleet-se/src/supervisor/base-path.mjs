// =============================================================================
// fleet-sprint supervisor -- forwarded path prefix for rendered pages
// =============================================================================
//
// docs/supervisor-auth.md "Forwarded path prefix": a front that publishes the
// supervisor under a path (X-Forwarded-Prefix, honoured only on requests with
// a verified assertion -- see auth.mjs) needs every root-absolute URL the
// browser receives to carry that prefix: links, fetch()/EventSource URLs,
// redirects. Rather than threading a base string through every template and
// client script, the pages are rendered exactly as before and this ONE
// rewriter prefixes the root-absolute URLs on the way out. With an empty base
// nothing is touched, so an un-prefixed page is byte-for-byte unchanged.
//
// What is rewritten (single pass, so nothing is ever prefixed twice):
//   * a quoted string literal or attribute value that starts with one of the
//     supervisor's own top-level path segments (/api, /sprints, /state,
//     /events, /supervisor), e.g. fetch('/api/members'), href="/sprints/x/live",
//     new EventSource('/events');
//   * any root-absolute href/src/action attribute, e.g. href="/".
// What is NOT rewritten:
//   * protocol-relative or absolute URLs (//host, http://...);
//   * data scripts -- `<script>window.__name = <json>;</script>` blocks embed
//     user-authored text (bead titles, descriptions) as JSON, which must reach
//     the browser verbatim even if it happens to contain "/api/...".
// Page data elsewhere is HTML-escaped (quotes become entities), so a quote
// followed by a supervisor path can only come from the page's own code.
// =============================================================================

/** The supervisor's top-level path segments that client code addresses. */
export const SUPERVISOR_ROOT_SEGMENTS = Object.freeze(['api', 'sprints', 'state', 'events', 'supervisor']);
const ROOT_SEGMENT_SET = new Set(SUPERVISOR_ROOT_SEGMENTS);

const URL_START = /(\b(?:href|src|action)=)?(["'`])\/(?!\/)(?=([A-Za-z_]*)([/?#"'`]|$)?)/g;
const DATA_SCRIPT = /<script>window\.__[A-Za-z0-9_]+ = [\s\S]*?<\/script>/g;

/**
 * Prefixes root-absolute supervisor URLs in a fragment of page code.
 * @param {string} text
 * @param {string} base - '' (no-op) or a sanitized prefix such as `/fleet`
 * @param {{ segments?: boolean }} [opts] - segments:false rewrites only
 *   root-absolute href/src/action attributes
 * @returns {string}
 */
export function prefixRootUrls(text, base, opts = {}) {
    if (!base || typeof text !== 'string') return text;
    const segments = opts.segments !== false;
    return text.replace(URL_START, (match, attr, quote, seg, boundary) => {
        if (attr) return `${attr}${quote}${base}/`;
        if (segments && ROOT_SEGMENT_SET.has(seg) && boundary !== undefined) return `${quote}${base}/`;
        return match;
    });
}

/**
 * Prefixes a whole supervisor page (dashboard), leaving data scripts verbatim.
 * @param {string} html
 * @param {string} base
 * @returns {string}
 */
export function prefixPageHtml(html, base) {
    if (!base || typeof html !== 'string') return html;
    let out = '';
    let last = 0;
    for (const m of html.matchAll(DATA_SCRIPT)) {
        out += prefixRootUrls(html.slice(last, m.index), base) + m[0];
        last = m.index + m[0].length;
    }
    return out + prefixRootUrls(html.slice(last), base);
}

/**
 * Prefixes a root-absolute redirect target (Location header).
 * @param {string|undefined} location
 * @param {string} base
 * @returns {string|undefined}
 */
export function prefixLocation(location, base) {
    if (!base || typeof location !== 'string') return location;
    // Only a same-origin path ('/x'). Leave '//host' and '/\host' alone: browsers treat both as
    // protocol-relative URLs to another host, so they must never be re-rooted into a local path.
    return /^\/(?![/\\])/.test(location) ? base + location : location;
}
