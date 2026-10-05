// =============================================================================
// Auto-sprint supervisor -- the viewer back-link, and its ENFORCEMENT
// (apra-fleet-i9ag.5)
// =============================================================================
//
// Every page the supervisor dashboard hands an operator as a "sprint viewer"
// -- the live-proxied child HTML at `GET /sprints/:id/live`, that same route's
// finished-sprint fallthrough, and the dedicated `GET /sprints/:id/history` --
// must carry ONE anchor back to that sprint's own card on the dashboard. All
// three pages open in a new tab (`target="_blank"` on the dashboard's links),
// so without it the operator is stranded: there is no other navigation on the
// viewer page at all.
//
// WHY THIS IS ITS OWN MODULE, AND WHY IT ASSERTS
// ---------------------------------------------
// The back-link used to be a best-effort string transform: find `<body`, splice
// the anchor in after it, and serve whatever came out. That silently produced a
// LINKLESS page for over a release, because `<body>` is not a reliable needle.
// @apralabs/apra-fleet-workflow's viewer HTML_TEMPLATE has an explanatory CSS
// comment in its `<head>` `<style>` block that contains the literal text
// `<body>` (".. with only overflow: hidden on <body>, .."). That text comes
// ~12.5KB BEFORE the document's real `<body data-view="..">` tag, so a
// first-match splice landed the whole `<p><a ..></a></p>` INSIDE a CSS comment
// inside `<style>`. The bytes were on the wire -- a substring assertion over
// the served HTML passed -- but a browser parses everything inside `<style>`
// as CSS, so the anchor never existed in the DOM:
// `document.querySelectorAll('a')` returned `[]` on both the live viewer and
// the History page in the M1 Windows acceptance run.
//
// So this module owns two halves, and the served routes use BOTH:
//
//   1. `bodyContentStartIndex()` finds the real `<body>` start tag by skipping
//      comment, `<script>` and `<style>` regions -- a `<body` inside any of
//      those is text, not a tag.
//   2. `assertViewerBackLink()` re-reads the FINISHED page the way the browser
//      (and the acceptance harness) does -- anchors in the body only, with
//      `<style>`/`<script>`/comment regions removed -- and throws when the
//      expected anchor is not there. Callers turn that throw into a loud 5xx
//      plus a logged error. A viewer page that cannot carry a back-link is a
//      dead end for the operator; failing loud is the only honest answer,
//      because the silent one is exactly the defect above.
//
// This all lives on the SUPERVISOR side on purpose: the generic child viewer in
// packages/apra-fleet-workflow must never learn that its HTML is being served
// through a dashboard (docs/generic-engine-boundary.md).
// =============================================================================

import { mountHref } from './mount-prefix.mjs';
import { sprintCardAnchorId } from './sprint-anchor.mjs';

/**
 * The link text an operator must be able to recognise as "this goes back to
 * the thing that sent me here". Deliberately the SAME pattern the release
 * acceptance harness runs against every anchor's `innerText` on a viewer page,
 * so a page this module accepts is a page that harness accepts.
 */
export const VIEWER_BACK_LINK_TEXT_PATTERN = /console|supervisor|dashboard|sprints/i;

/**
 * The visible text of every supervisor viewer back-link -- both the one this
 * module injects into proxied/history pages and the one a supervisor-spawned
 * child viewer renders itself (the workflow viewer's opts.backLink, threaded
 * in via the fleet-sprint CLI's --viewer-back-url). Must match
 * VIEWER_BACK_LINK_TEXT_PATTERN.
 */
export const VIEWER_BACK_LINK_TEXT = 'Back to the supervisor dashboard';

/**
 * The stable marker attribute the generic workflow viewer puts on a
 * caller-supplied back-link anchor (apra-fleet-workflow's
 * VIEWER_BACK_LINK_ATTR). Mirrored here as a literal rather than imported so
 * this module stays free of a runtime dependency on the viewer package; the
 * served-routes test pins the two to the same value.
 */
export const CHILD_VIEWER_BACK_LINK_ATTR = 'data-viewer-back-link';

/**
 * The ABSOLUTE back URL a supervisor-spawned child viewer renders when the
 * operator opens it directly on its own host:port (the "Dashboard live at"
 * address in the sprint's raw log) rather than through GET /sprints/:id/live:
 * this supervisor's own origin + the dashboard root + that sprint's card
 * anchor -- the same target viewerBackLinkHref() produces for the proxied
 * routes, made absolute because the page is not served from this origin.
 * Built with WHATWG URL, never by shell expansion.
 * @param {string} serviceUrl - this supervisor's own origin, e.g. http://localhost:8787
 * @param {string} sprintId
 * @returns {string}
 */
export function supervisorViewerBackUrl(serviceUrl, sprintId) {
    if (typeof serviceUrl !== 'string' || serviceUrl.length === 0) {
        throw new TypeError('supervisorViewerBackUrl requires the supervisor serviceUrl');
    }
    if (typeof sprintId !== 'string' || sprintId.length === 0) {
        throw new TypeError('supervisorViewerBackUrl requires a sprintId');
    }
    return new URL(viewerBackLinkHref('', sprintId), serviceUrl).href;
}

/**
 * Tag name at an already-located '<' in a LOWER-CASED document, '' when the
 * '<' does not open (or close) a named tag. Skips one leading '/' so a closing
 * tag reports the same name as its opener.
 * @param {string} lower
 * @param {number} lt - index of the '<'
 * @returns {string}
 */
function tagNameAt(lower, lt) {
    let j = lt + 1;
    if (lower.charAt(j) === '/') j += 1;
    let name = '';
    while (j < lower.length) {
        const ch = lower.charAt(j);
        if (ch < 'a' || ch > 'z') {
            if (ch < '0' || ch > '9') break;
        }
        name += ch;
        j += 1;
    }
    return name;
}

/**
 * Index of the first character of the document's BODY CONTENT -- i.e. just
 * past the real `<body ...>` start tag -- or -1 when there is none.
 *
 * Scans forward skipping the three regions whose contents are text rather than
 * markup (`<!-- -->`, `<script>`, `<style>`), which is the whole point: the
 * generic viewer template's `<style>` block contains the literal text
 * `<body>` inside a CSS comment long before the real tag (see this module's
 * doc comment). A naive `/<body[^>]*>/` matches that text first.
 *
 * @param {unknown} html
 * @returns {number}
 */
export function bodyContentStartIndex(html) {
    if (typeof html !== 'string') return -1;
    const lower = html.toLowerCase();
    let i = 0;
    while (i < lower.length) {
        const lt = lower.indexOf('<', i);
        if (lt < 0) return -1;
        if (lower.startsWith('<!--', lt)) {
            const end = lower.indexOf('-->', lt + 4);
            i = end < 0 ? lower.length : end + 3;
            continue;
        }
        const name = tagNameAt(lower, lt);
        const closing = lower.charAt(lt + 1) === '/';
        if (!closing && (name === 'script' || name === 'style')) {
            const end = lower.indexOf('</' + name, lt);
            i = end < 0 ? lower.length : end + 2 + name.length;
            continue;
        }
        if (!closing && name === 'body') {
            const gt = lower.indexOf('>', lt);
            return gt < 0 ? -1 : gt + 1;
        }
        i = lt + 1;
    }
    return -1;
}

/**
 * The href every supervisor viewer back-link carries for one sprint: the
 * dashboard root plus that sprint's own card anchor (sprint-anchor.mjs is the
 * single source dashboard.mjs renders from too), resolved through mountHref()
 * so it stays inside this package's `/ext/<id>` mount point when the console
 * is the only origin the browser talks to (mount-prefix.mjs).
 * @param {string} mountPrefix - resolveMountPrefix()'s per-request result, or ''
 * @param {string} sprintId
 * @returns {string}
 */
export function viewerBackLinkHref(mountPrefix, sprintId) {
    return mountHref(typeof mountPrefix === 'string' ? mountPrefix : '', '/#' + sprintCardAnchorId(sprintId));
}

/**
 * Renders the back-link injected into (or rendered directly by) every viewer
 * page. `target="_top"` so a click from inside the console's `/ext` iframe
 * navigates the whole browser tab back to the dashboard, not just the iframe.
 * The visible text must satisfy VIEWER_BACK_LINK_TEXT_PATTERN.
 * @param {string} mountPrefix
 * @param {string} sprintId
 * @returns {string}
 */
export function renderViewerBackLinkHtml(mountPrefix, sprintId) {
    const href = viewerBackLinkHref(mountPrefix, sprintId);
    return '<p class="live-view-back-link"><a href="' + href + '" target="_top">&larr; ' + VIEWER_BACK_LINK_TEXT + '</a></p>';
}

/**
 * Splices `backLinkHtml` in as the FIRST body content of `html`.
 *
 * THROWS rather than falling back (apra-fleet-i9ag.5): a non-string body, an
 * empty body, or a document with no real `<body>` start tag is a page this
 * supervisor cannot hand an operator a way out of, and the old silent
 * best-effort prepend is what let a linkless viewer ship. Callers answer a
 * loud 5xx.
 * @param {unknown} html
 * @param {string} backLinkHtml
 * @returns {string}
 */
export function injectViewerBackLink(html, backLinkHtml) {
    if (typeof html !== 'string' || html.length === 0) {
        throw new TypeError('cannot inject a viewer back-link into a non-string or empty page body');
    }
    if (typeof backLinkHtml !== 'string' || backLinkHtml.length === 0) {
        throw new TypeError('cannot inject an empty viewer back-link');
    }
    const at = bodyContentStartIndex(html);
    if (at < 0) {
        throw new Error('cannot inject a viewer back-link: the page has no <body> start tag (non-HTML response?)');
    }
    return html.slice(0, at) + backLinkHtml + html.slice(at);
}

/**
 * Removes the back-link a supervisor-spawned child viewer renders itself
 * (marked with CHILD_VIEWER_BACK_LINK_ATTR, see supervisorViewerBackUrl()) so
 * a page re-served through this supervisor's proxy ends up with exactly ONE
 * back-link: the mount-prefixed one injectViewerBackLink() adds. The child
 * renders that anchor as the very first body content, so only an anchor in
 * that position is removed -- a marker string anywhere else (script text,
 * state data) is left alone. A page without one is returned unchanged.
 * @param {string} html
 * @returns {string}
 */
export function stripChildViewerBackLink(html) {
    if (typeof html !== 'string') return html;
    const at = bodyContentStartIndex(html);
    if (at < 0) return html;
    const rest = html.slice(at);
    const m = /^\s*<a\s[^>]*\bdata-viewer-back-link\b[^>]*>[\s\S]*?<\/a>/i.exec(rest);
    if (!m) return html;
    return html.slice(0, at) + rest.slice(m[0].length);
}

/**
 * Every anchor a BROWSER would find in the rendered body of `html`, as
 * `{ href, text }`. Comment, `<script>` and `<style>` regions are removed
 * first, so an anchor that only exists as text inside one of them is (exactly
 * as in the DOM) not an anchor at all -- that is the precise defect this
 * module exists to catch.
 * @param {unknown} html
 * @returns {Array<{ href: string|null, text: string }>}
 */
export function renderedBodyAnchors(html) {
    if (typeof html !== 'string') return [];
    const inert = html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    const at = bodyContentStartIndex(inert);
    if (at < 0) return [];
    const body = inert.slice(at);
    const anchors = [];
    const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = anchorRe.exec(body)) !== null) {
        const href = /href\s*=\s*"([^"]*)"/i.exec(m[1]);
        anchors.push({
            href: href ? href[1] : null,
            // innerText-ish: drop nested markup and the one HTML entity the
            // back-link itself uses for its arrow glyph (ASCII-only source,
            // per CLAUDE.md).
            text: m[2].replace(/<[^>]*>/g, '').replace(/&larr;/g, '').replace(/\s+/g, ' ').trim(),
        });
    }
    return anchors;
}

/**
 * Throws unless `html` really does hand the operator back to this sprint's
 * dashboard card: an anchor in the RENDERED BODY whose href is
 * viewerBackLinkHref()'s and whose visible text matches
 * VIEWER_BACK_LINK_TEXT_PATTERN. The final gate every viewer route runs before
 * it writes a response.
 * @param {unknown} html
 * @param {{ mountPrefix?: string, sprintId: string, where: string }} opts
 * @returns {string} `html`, unchanged, when the check passes
 */
export function assertViewerBackLink(html, { mountPrefix = '', sprintId, where }) {
    const expected = viewerBackLinkHref(mountPrefix, sprintId);
    const anchors = renderedBodyAnchors(html);
    const hit = anchors.find((a) => a.href === expected && VIEWER_BACK_LINK_TEXT_PATTERN.test(a.text));
    // Exactly one: a second anchor back to the same card (e.g. a child's own
    // rendered link surviving next to the injected one) is a broken page too.
    const cardSuffix = '#' + sprintCardAnchorId(sprintId);
    const toCard = anchors.filter((a) => typeof a.href === 'string' && a.href.endsWith(cardSuffix));
    if (hit && toCard.length > 1) {
        throw new Error(
            `${where}: refusing to serve sprint '${sprintId}' with ${toCard.length} back-links to the supervisor dashboard `
            + `(expected exactly one; rendered body anchors: ${JSON.stringify(anchors)})`,
        );
    }
    if (!hit) {
        throw new Error(
            `${where}: refusing to serve sprint '${sprintId}' with no back-link to the supervisor dashboard `
            + `(expected an anchor href="${expected}" with text matching ${VIEWER_BACK_LINK_TEXT_PATTERN}; `
            + `rendered body anchors: ${JSON.stringify(anchors)})`,
        );
    }
    return html;
}
