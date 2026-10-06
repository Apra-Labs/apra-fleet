// fleet-bridge Part D2 (fleet-bridge-implementation-plan.md): the viewer's
// data-provider seam.
//
// THE HAZARD THIS FILE GUARDS AGAINST: proxy.mjs's rewriteChildHtml()
// text-patches eight exact single-quoted literals in the served HTML so a
// proxied child's client-side calls re-enter the supervisor's live proxy
// under the '/sprints/:id/live' prefix. Moving those call sites behind a
// data-provider seam (this sprint's work) silently breaks the supervisor's
// live proxy -- the page loads and then never updates -- unless the
// literals stay byte-identical in the emitted HTML. This file asserts
// against the REAL HTML_TEMPLATE()/renderHistoryPageHtml() output (not a
// hand-written fixture), so a future change to the client script that
// drops or renames one of these literals fails here before it ever reaches
// a live dashboard.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HTML_TEMPLATE } from '@apralabs/apra-fleet-workflow/viewer';
import { rewriteChildHtml, livePrefixFor } from '../src/supervisor/proxy.mjs';
import { renderHistoryPageHtml } from '../src/supervisor/history-view.mjs';

const PREFIX = livePrefixFor('sprint-x');

// The eight literals named in proxy.mjs's own rewriteChildHtml() doc
// comment and in fleet-bridge-implementation-plan.md Part D2. Note '/state?'
// and '/extensions/'/'/activities/' are deliberately searched WITHOUT a
// closing quote (rewriteChildHtml itself matches them that way, since the
// real call sites interpolate a suffix after the literal prefix).
const LITERALS_WITH_CLOSING_QUOTE = ["'/events'", "'/stop'", "'/pause'", "'/resume'"];
const LITERALS_WITHOUT_CLOSING_QUOTE = ["'/state?", "'/extensions/", "'/activities/"];
// '/save_logs' is part of the documented eight but, as of this sprint, has
// NO client-side call site in HTML_TEMPLATE's script at all (only the
// server-side POST /save_logs route handler exists -- see index.mjs's
// request listener). rewriteChildHtml still handles it correctly (asserted
// below against an isolated fixture, matching supervisor-proxy.test.mjs's
// existing style); it is intentionally excluded from the "present in the
// live template" assertions so this file does not assert a tautology. If a
// future change adds a client call to /save_logs, extend
// LITERALS_WITH_CLOSING_QUOTE to include it and this comment can go.
const SAVE_LOGS_LITERAL = "'/save_logs'";

describe('fleet-bridge Part D2: viewer <-> live-proxy literal lockstep', () => {
    test('every literal proxy.mjs rewrites (except /save_logs, see comment) is present in the REAL live-mode HTML_TEMPLATE output', () => {
        const html = HTML_TEMPLATE([]);
        for (const lit of LITERALS_WITH_CLOSING_QUOTE) {
            assert.ok(html.includes(lit), `expected live template to still contain ${lit}`);
        }
        for (const lit of LITERALS_WITHOUT_CLOSING_QUOTE) {
            assert.ok(html.includes(lit), `expected live template to still contain ${lit}`);
        }
    });

    test('/save_logs has no client call site in the live template today -- documents the gap rather than asserting a tautology', () => {
        const html = HTML_TEMPLATE([]);
        assert.ok(!html.includes(SAVE_LOGS_LITERAL), 'if this now fails, a client call to /save_logs was added -- move it into the guarded literal set above');
    });

    test('rewriteChildHtml() still rewrites every one of the eight literals (including /save_logs, in isolation) to the live prefix, with no bare literal left behind', () => {
        for (const lit of LITERALS_WITH_CLOSING_QUOTE.concat([SAVE_LOGS_LITERAL])) {
            const fixture = 'fetch(' + lit + ');';
            const out = rewriteChildHtml(fixture, PREFIX);
            assert.ok(out.includes("'" + PREFIX + lit.slice(1)), `expected ${lit} to be rewritten under the live prefix`);
            assert.ok(!out.includes(lit), `expected no bare ${lit} left behind after rewrite`);
        }
        for (const lit of LITERALS_WITHOUT_CLOSING_QUOTE) {
            const fixture = 'fetch(' + lit + "id + '/whatever');";
            const out = rewriteChildHtml(fixture, PREFIX);
            assert.ok(out.includes("'" + PREFIX + lit.slice(1)), `expected ${lit} to be rewritten under the live prefix`);
            assert.ok(!out.includes(lit), `expected no bare ${lit} left behind after rewrite`);
        }
    });

    test('rewriteChildHtml() applied to the REAL live-mode HTML_TEMPLATE output rewrites every present literal, and none survive unprefixed', () => {
        const html = HTML_TEMPLATE([]);
        const out = rewriteChildHtml(html, PREFIX);
        for (const lit of LITERALS_WITH_CLOSING_QUOTE.concat(LITERALS_WITHOUT_CLOSING_QUOTE)) {
            assert.ok(out.includes("'" + PREFIX + lit.slice(1)), `expected rewritten output to contain the prefixed form of ${lit}`);
            assert.ok(!out.includes(lit), `expected no bare ${lit} to survive rewriteChildHtml() on the real template output`);
        }
    });
});

describe('fleet-bridge Part D2: the data-provider seam is present and wired', () => {
    test('the emitted HTML contains the provider bootstrap (PROVIDER_KIND + both provider implementations)', () => {
        const html = HTML_TEMPLATE([]);
        assert.ok(html.includes('const PROVIDER_KIND'), 'template must define PROVIDER_KIND');
        assert.ok(html.includes('const httpProvider'), 'template must define httpProvider');
        assert.ok(html.includes('const blobProvider'), 'template must define blobProvider');
        assert.ok(html.includes('const dataProvider'), 'template must select a dataProvider');
        assert.ok(html.includes('window.dataProvider'), 'dataProvider must be exposed for the viewer-extensions.mjs lazy-load seam');
    });

    test('default opts select the http provider, byte-identical call literals to before this seam existed', () => {
        const html = HTML_TEMPLATE([]);
        assert.ok(html.includes('const PROVIDER_KIND = "http"'));
        // Control actions: unchanged, direct fetch calls (never rewired
        // through dataProvider.control -- see viewer-provider-seam report:
        // rewiring these broke apra-fleet-se/test/4yr-stop-modal.test.mjs's
        // pinned extraction, which requires confirmStopWorkflow() to be
        // self-contained with only document/fetch/setTimeout in scope).
        assert.ok(html.includes("fetch('/stop', { method: 'POST' })"));
        assert.ok(html.includes("fetch('/pause', { method: 'POST' })"));
        assert.ok(html.includes("fetch('/resume', { method: 'POST' })"));
        // Read paths: now routed through httpProvider, same literal text.
        assert.ok(html.includes("fetch('/activities/' + encodeURIComponent(activityId) + '/output')"));
        assert.ok(html.includes("fetch('/state?_t=' + Date.now(), { cache: 'no-store' })"));
        assert.ok(html.includes("new EventSource('/events')"));
        assert.ok(/\bpoll\(\);/.test(html), 'the live (non-history) driver must still call poll()');
    });

    test('opts.dataProvider "blob" selects the blob provider, hides Pause/Stop (control: null), keeps Save and the pause banner, and wires the blob poll loop instead of the raw EventSource', () => {
        const html = HTML_TEMPLATE([], { dataProvider: 'blob' });
        assert.ok(html.includes('const PROVIDER_KIND = "blob"'));

        assert.ok(!html.includes('id="btn-pause"'), 'blob mode is read-only: no Pause control');
        assert.ok(!html.includes('class="btn btn-stop"'), 'blob mode is read-only: no Stop control');
        assert.ok(!html.includes('id="stop-modal-overlay"'), 'blob mode is read-only: no Stop confirmation modal');
        assert.ok(html.includes('class="btn btn-save"'), 'Save (client-side, no network call) stays available in blob mode');
        assert.ok(html.includes('id="pause-banner"'), 'the pause status banner is informational and stays available in blob mode');

        assert.ok(html.includes('dataProvider.subscribe(() => { schedulePoll(); });'), 'blob mode must wire schedulePoll() through dataProvider.subscribe()');
        assert.ok(/\bpoll\(\);/.test(html), 'blob mode is still live (non-history): poll() must still run');

        // The only remaining 'new EventSource(' occurrence is httpProvider's
        // own (unused-in-blob-mode) definition -- the ACTIVE wiring switched.
        const eventSourceCount = html.split("new EventSource('/events')").length - 1;
        assert.equal(eventSourceCount, 1, 'blob mode must not also construct the live EventSource -- only httpProvider\'s inert definition should remain');
    });

    test('history mode renders the frozen state once and never wires a poll loop (unchanged by this seam)', () => {
        const state = { workflowName: 'x', status: 'success', stats: { activitiesCount: 0, totalTokens: 0, totalCost: 0, unknownCostCount: 0, startTime: 0, durationMs: 0 }, tree: [], extensions: {} };
        const html = renderHistoryPageHtml(state, []);

        assert.ok(!/\bpoll\(\);/.test(html), 'history view must never call poll()');
        assert.ok(html.includes('renderState('), 'history view must render the frozen state directly');
        assert.ok(!html.includes('dataProvider.subscribe(() => { schedulePoll(); });'), 'history view must not wire the blob poll loop');
        assert.ok(!html.includes('id="btn-pause"'), 'history view has no live workflow to pause');
        assert.ok(!html.includes('class="btn btn-stop"'), 'history view has no live workflow to stop');
    });
});
