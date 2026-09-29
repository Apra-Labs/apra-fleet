// =============================================================================
// apra-fleet-i9ag.5 -- viewer-back-link.mjs's two readers, directly.
//
// The served-route coverage lives in i9ag5-viewer-back-link-served-routes.test.mjs
// (that is where the defect is pinned end to end). This file covers only the
// inputs those routes cannot reach: the markup shapes that make finding the real
// `<body>` -- and reading the anchors a browser would -- non-trivial.
// =============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    VIEWER_BACK_LINK_TEXT_PATTERN,
    assertViewerBackLink,
    bodyContentStartIndex,
    renderedBodyAnchors,
    viewerBackLinkHref,
} from '../src/supervisor/viewer-back-link.mjs';
import { sprintCardAnchorId } from '../src/supervisor/sprint-anchor.mjs';

/** Index-returning helper read back as the text it points at, for legibility. */
function bodyContentOf(html) {
    const at = bodyContentStartIndex(html);
    return at < 0 ? null : html.slice(at);
}

describe('apra-fleet-i9ag.5: bodyContentStartIndex skips regions whose contents are text, not markup', () => {
    test('finds the body tag past a <style> block that mentions <body> in a CSS comment', () => {
        const html = '<html><head><style>/* only overflow: hidden on <body>, so .. */</style></head>'
            + '<body class="x">CONTENT</body></html>';
        assert.equal(bodyContentOf(html), 'CONTENT</body></html>');
    });

    test('finds the body tag past a <script> block that writes a <body> string', () => {
        const html = '<html><head><script>var t = "<body>";</script></head><body>CONTENT</body></html>';
        assert.equal(bodyContentOf(html), 'CONTENT</body></html>');
    });

    test('finds the body tag past an HTML comment that mentions <body>', () => {
        const html = '<html><head><!-- pinned via <body> height --></head><body>CONTENT</body></html>';
        assert.equal(bodyContentOf(html), 'CONTENT</body></html>');
    });

    test('is not fooled by a tag whose name merely starts with "body"', () => {
        const html = '<html><bodyguard>no</bodyguard><body>CONTENT</body></html>';
        assert.equal(bodyContentOf(html), 'CONTENT</body></html>');
    });

    test('-1 for a fragment with no body tag, a closing tag only, and non-string input', () => {
        assert.equal(bodyContentStartIndex('<div>fragment</div>'), -1);
        assert.equal(bodyContentStartIndex('</body>'), -1);
        assert.equal(bodyContentStartIndex('{"json":true}'), -1);
        assert.equal(bodyContentStartIndex(undefined), -1);
    });

    test('an unterminated <style> swallows the rest rather than reporting a bogus body', () => {
        assert.equal(bodyContentStartIndex('<head><style>x<body>y'), -1);
    });
});

describe('apra-fleet-i9ag.5: renderedBodyAnchors reads what the DOM would, not what the bytes say', () => {
    test('an anchor that only exists inside <style> is not an anchor', () => {
        const html = '<html><head><style>/* <a href="/x">nope</a> */</style></head><body>none here</body></html>';
        assert.deepEqual(renderedBodyAnchors(html), []);
    });

    test('anchors before the body tag are not body anchors', () => {
        const html = '<html><head><a href="/head">head</a></head><body><a href="/in">in body</a></body></html>';
        assert.deepEqual(renderedBodyAnchors(html), [{ href: '/in', text: 'in body' }]);
    });

    test('text is innerText-ish: nested markup and the arrow entity stripped, whitespace collapsed', () => {
        const html = '<html><body><a href="/d">&larr; Back to\n  the <b>dashboard</b></a></body></html>';
        assert.deepEqual(renderedBodyAnchors(html), [{ href: '/d', text: 'Back to the dashboard' }]);
        assert.match(renderedBodyAnchors(html)[0].text, VIEWER_BACK_LINK_TEXT_PATTERN);
    });
});

describe('apra-fleet-i9ag.5: assertViewerBackLink is the gate, not a hint', () => {
    const sprintId = 'sprint-gate-1';

    test('passes a page whose body anchor matches the expected href and text', () => {
        const href = viewerBackLinkHref('/ext/se', sprintId);
        assert.equal(href, '/ext/se/#' + sprintCardAnchorId(sprintId));
        const html = `<html><body><a href="${href}">&larr; Back to the supervisor dashboard</a></body></html>`;
        assert.equal(assertViewerBackLink(html, { mountPrefix: '/ext/se', sprintId, where: 'unit' }), html);
    });

    test('throws when the anchor exists but points at the wrong sprint, or the wrong mount', () => {
        const right = viewerBackLinkHref('', sprintId);
        assert.throws(
            () => assertViewerBackLink(`<html><body><a href="${viewerBackLinkHref('', 'other-sprint')}">dashboard</a></body></html>`,
                { sprintId, where: 'unit' }),
            /no back-link to the supervisor dashboard/,
        );
        assert.throws(
            () => assertViewerBackLink(`<html><body><a href="${right}">dashboard</a></body></html>`,
                { mountPrefix: '/ext/se', sprintId, where: 'unit' }),
            /no back-link to the supervisor dashboard/,
        );
    });

    test('throws when the href is right but the text says nothing an operator can act on', () => {
        const href = viewerBackLinkHref('', sprintId);
        assert.throws(
            () => assertViewerBackLink(`<html><body><a href="${href}">&larr;</a></body></html>`, { sprintId, where: 'unit' }),
            /no back-link to the supervisor dashboard/,
        );
    });
});
