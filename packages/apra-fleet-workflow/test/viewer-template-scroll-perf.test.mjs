// Structural guards for the dashboard template's scroll + performance
// contract. Symptom being pinned (operator-reported): on large sprints the
// Activity widget was clipped and unscrollable, and the page grew sluggish.
// Root causes: (1) missing min-height: 0 on the nested flex chain, so the
// panel grew past its parent instead of .stream-list scrolling; (2) every
// SSE event refetched and fully re-rendered the whole state, rewriting the
// innerHTML of every (already finished) activity each tick.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HTML_TEMPLATE } from '../src/viewer/index.mjs';

test('flex scroll chain carries min-height: 0 down to the stream list', () => {
    const html = HTML_TEMPLATE([]);
    for (const marker of [
        '.main-content { display: flex; flex: 1; overflow: hidden; min-height: 0; }',
        '.stream-list { flex: 1; min-height: 0;',
        '.tab-content.active { display: flex; min-height: 0; }',
    ]) {
        assert.ok(html.includes(marker), `template must contain: ${marker}`);
    }
    assert.ok(
        /\.panel \{[^}]*min-height: 0;/.test(html),
        'the .panel rule must include min-height: 0'
    );
});

test('apra-fleet-eft.43: html/body are pinned to the viewport, and #stream-list has both overflow-y: auto and a bounded height to scroll inside of', () => {
    const html = HTML_TEMPLATE([]);

    // Structural-only (no layout engine here, per this file's header comment)
    // -- these are the exact rules apra-fleet-eft.43 pinned as the minimum
    // that must survive: html,body height: 100%, body itself constrained to
    // the viewport (100vh/100dvh) as a flex column, and #stream-list bound by
    // flex: 1 + min-height: 0 with its own overflow-y: auto. Deleting any one
    // of them (e.g. reverting html,body to auto height, or #stream-list back
    // to a plain flex: 1 with no min-height: 0) must fail this test.
    assert.ok(/html,\s*body\s*\{[^}]*height:\s*100%;[^}]*\}/.test(html), 'html and body must both be pinned to 100% height');
    assert.ok(/body\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*\}/.test(html), 'body must be a bounded (100vh/100dvh) flex column, not a page that grows with content');
    assert.ok(
        /\.stream-list\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/.test(html),
        '#stream-list must be flex: 1 + min-height: 0 + overflow-y: auto so its own scrollbar (not the window) engages once content exceeds the bounded pane'
    );
});

test('apra-fleet-7lk / apra-fleet-eft.43: tree groups/phases are flex-shrink: 0 so they scroll instead of squishing to fit', () => {
    const html = HTML_TEMPLATE([]);
    assert.ok(/\.tree-group\s*\{[^}]*flex-shrink:\s*0;/.test(html), '.tree-group must be flex-shrink: 0');
    assert.ok(/\.tree-phase\s*\{[^}]*flex-shrink:\s*0;/.test(html), '.tree-phase must be flex-shrink: 0');
});

test('extension tab containers are bounded flex children, not clipped blocks', () => {
    const html = HTML_TEMPLATE([{ id: 'beads', title: 'Beads', js: '' }]);
    assert.ok(
        html.includes('id="extension-beads" style="flex: 1; min-height: 0; padding: 12px; overflow-y: auto;"'),
        'extension container must be flex: 1 + min-height: 0 + overflow-y: auto so it scrolls inside the panel'
    );
});

test('finished activities render once (dataset.rendered guard)', () => {
    const html = HTML_TEMPLATE([]);
    assert.ok(
        html.includes("if (evEl.dataset.rendered === 'done') return;"),
        'renderTreeIncremental must skip activities already rendered as done'
    );
    assert.ok(
        html.includes("if (!act.isRunning) evEl.dataset.rendered = 'done';"),
        'a non-running activity must be marked done after its final render'
    );
});

test('live view coalesces SSE-triggered polls; history view stays poll-free', () => {
    const live = HTML_TEMPLATE([]);
    assert.ok(live.includes('function schedulePoll()'), 'live view must define schedulePoll');
    const handler = live.match(/source\.onmessage = \(e\) => \{([^]*?)\n    \};/);
    assert.ok(handler, 'live view must define the source.onmessage handler');
    assert.ok(handler[1].includes('schedulePoll();'), 'SSE onmessage must go through schedulePoll');
    assert.ok(!/(?<!schedule)[pP]oll\(\);/.test(handler[1]), 'onmessage must not call poll() directly');

    const history = HTML_TEMPLATE([], { history: true, state: { workflowName: 'x', status: 'success', stats: {}, tree: [] } });
    assert.ok(!history.includes('new EventSource'), 'history view must not open an EventSource');
    assert.ok(!history.includes('schedulePoll'), 'history view must not carry the live polling loop');
});
