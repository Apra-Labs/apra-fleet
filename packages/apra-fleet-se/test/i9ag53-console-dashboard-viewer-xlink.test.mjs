// =============================================================================
// apra-fleet-i9ag.5.3 -- console -> dashboard -> viewer cross-link round trip
// (SUPERVISOR SIDE).
//
// The shell-header half of this feature's triad (a Sprints link rendering
// while project context is null) is covered in
// packages/apra-fleet-shell-ui/test/nav.test.tsx. THIS file covers the other
// two links purely as a round trip over the already-landed pure renderers
// (dashboard.mjs / proxy.mjs / sprint-anchor.mjs / mount-prefix.mjs) -- no
// server boot needed, since every piece under test here is a pure function.
// Additive only: it does not edit supervisor-dashboard.test.mjs or
// supervisor-proxy.test.mjs, which the i9ag.5.1/i9ag.5.2 impl tasks in this
// sprint own.
//
//   (2) the dashboard header's Console link resolves to
//       '<configured server origin>/ui', carrying no hardcoded host/port.
//   (3) the live viewer's injected back-link targets the SAME anchor id the
//       dashboard renders for that sprint's card -- a genuine round trip
//       (derived from the dashboard's actual rendered output), not two
//       independent assertions against a hand-copied literal.
//   (4) both (2) and (3) are asserted twice: once with no mount prefix (the
//       direct-open case) and once with a mount prefix set (the
//       embedded-via-console-/ext case) -- and the mounted run additionally
//       asserts the href is rooted under that prefix.
// =============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { renderIndexPageHtml } from '../src/supervisor/dashboard.mjs';
import { renderLiveViewBackLinkHtml, injectLiveViewBackLink } from '../src/supervisor/proxy.mjs';
import { sprintCardAnchorId } from '../src/supervisor/sprint-anchor.mjs';
import { mountHref } from '../src/supervisor/mount-prefix.mjs';
import { WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';

/** One minimal, fully-populated SprintView -- the shape dashboard.mjs's
 *  renderSprintSection() expects (see its @typedef SprintView doc comment). */
function sprintView(sprintId) {
    return {
        sprintId,
        branch: 'feat/x',
        goal: 'P1',
        status: WATCHDOG_STATUS.RUNNING_HEALTHY,
        issueRoots: ['root-1'],
        beadCount: 3,
        progress: { closed: 1, required: 3, fraction: 1 / 3 },
        members: [{ name: 'alice', role: null }],
        base: 'main',
        baseDrift: 0,
        beadsPrefix: null,
    };
}

/** A minimal stand-in for the child viewer's OWN served HTML -- just enough
 *  structure (a <body> tag) for injectLiveViewBackLink() to inject into. The
 *  real viewer's markup shape is irrelevant here; this file asserts only on
 *  the injected back-link itself. */
const CHILD_VIEWER_HTML = '<!DOCTYPE html><html><head><title>Sprint</title></head><body><h1>Sprint x</h1></body></html>';

for (const mountPrefix of ['', '/ext/se']) {
    describe(`apra-fleet-i9ag.5.3: console <-> dashboard <-> viewer round trip (mountPrefix=${JSON.stringify(mountPrefix)})`, () => {
        // An arbitrary, non-reserved port -- never the staging ports 7601/8801
        // this sprint's integration rules reserve, and this origin is never
        // actually bound to a listener: it only exercises the renderer's own
        // string-interpolation path, same convention as
        // supervisor-dashboard.test.mjs's own consoleOrigin fixtures.
        const origin = 'http://127.0.0.1:58217';
        const view = sprintView('sprint-round-trip-1');
        const dashboardHtml = renderIndexPageHtml([view], undefined, undefined, { consoleOrigin: origin, mountPrefix });

        test('(2) the dashboard header Console link resolves to <origin>/ui, with no hardcoded host/port', () => {
            const expectedHref = `${origin}/ui`;
            assert.ok(
                dashboardHtml.includes(`<a href="${expectedHref}" target="_top" rel="noopener"`),
                `expected the Console link to target ${expectedHref}; got:\n${dashboardHtml.slice(0, 2000)}`,
            );
            // The origin appears in exactly this one place -- nothing else on
            // the page carries a second, independently-derived host/port.
            const occurrences = dashboardHtml.split(origin).length - 1;
            assert.equal(occurrences, 1, `expected the configured origin to appear exactly once on the page, got ${occurrences}`);
        });

        test("(3) the live-view back-link targets the SAME anchor id the dashboard renders for this sprint's card", () => {
            const anchorId = sprintCardAnchorId(view.sprintId);
            // The dashboard actually rendered a card anchored at this id --
            // not merely that sprintCardAnchorId() returns *some* string.
            assert.ok(
                dashboardHtml.includes(`id="${anchorId}"`),
                `expected the dashboard to render a card anchored at id="${anchorId}"`,
            );

            const backLinkHtml = renderLiveViewBackLinkHtml(mountPrefix, view.sprintId);
            const expectedHref = mountHref(mountPrefix, '/#' + anchorId);
            assert.ok(
                backLinkHtml.includes(`href="${expectedHref}"`),
                `expected the back-link href to be ${expectedHref}; got: ${backLinkHtml}`,
            );
            assert.ok(backLinkHtml.includes('target="_top"'), 'the back-link must escape the console iframe (target="_top")');
            if (mountPrefix) {
                assert.ok(expectedHref.startsWith(mountPrefix), `expected the mounted back-link href to be rooted under ${mountPrefix}, got ${expectedHref}`);
            }

            // The full round trip: inject the back-link into the child
            // viewer's served HTML (exactly as proxy.mjs's proxyHtml() does
            // for a real live view), then confirm the resulting document's
            // own link fragment resolves to the exact anchor id the
            // dashboard rendered above -- derived from the dashboard's
            // actual output on both ends, never a hand-copied literal.
            const viewerHtml = injectLiveViewBackLink(CHILD_VIEWER_HTML, backLinkHtml);
            const linked = /<a href="([^"]+)" target="_top">/.exec(viewerHtml);
            assert.ok(linked, 'expected the injected back-link anchor in the served live-view HTML');
            const [, hrefFromViewer] = linked;
            const fragment = hrefFromViewer.slice(hrefFromViewer.indexOf('#') + 1);
            assert.equal(fragment, anchorId, "the live view's back-link fragment must match the dashboard card's own anchor id");
            assert.ok(
                dashboardHtml.includes(`id="${fragment}"`),
                'the fragment the live view links to must be an id that actually exists on the dashboard page',
            );
        });
    });
}
