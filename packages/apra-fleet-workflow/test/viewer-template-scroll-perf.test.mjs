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
