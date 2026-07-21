// Tests for apra-fleet-eft.38: surfacing GET /activities/:id/output (added
// in apra-fleet-eft.27.4 but never wired up client-side until now) as a
// 'more...' button on the individual activity widget.
//
// apra-fleet-eft.27.4 caps a `command` activity's stored output/error to a
// head+tail excerpt and marks the capped field via `${field}Truncated` (plus
// the true `${field}ByteLength`) -- see command-output-cap.mjs. Per the
// eft.27.4 USER FEEDBACK addendum this scope covers: the button lives ONLY
// on the individual activity widget's body (never the summary/header, which
// stays a plain expand/collapse toggle), and only one activity's full output
// is ever held expanded in the DOM at a time.
//
// HTML_TEMPLATE embeds its client-side script as a literal JS source string
// (there's no jsdom in this repo to execute it against a real DOM), so these
// are structural/string assertions on that source, in the same style as
// viewer-template-scroll-perf.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HTML_TEMPLATE } from '../src/viewer/index.mjs';

test('a capped field renders a dedicated .more-btn, gated on <field>Truncated, never on the summary/header', () => {
    const html = HTML_TEMPLATE([]);

    // The button markup is generated per-field (output/error), keyed off the
    // activity id and the capped field's *Truncated flag -- not baked into
    // the summary/header template (which only ever carries the toggle-icon
    // expand/collapse affordance).
    assert.ok(html.includes("class=\"more-btn\""), 'template must define more-btn markup');
    assert.ok(html.includes("data-activity-id="), 'more-btn must carry the activity id so the click handler knows what to fetch');
    assert.ok(html.includes("data-field=\""), 'more-btn must carry which field (output/error) it expands');
    assert.ok(html.includes("act[field + 'Truncated']") || html.includes('act[field + "Truncated"]'), 'more-btn must be gated on <field>Truncated, not shown unconditionally');

    // The summary/header block (activity-header) must not itself become a
    // fetch trigger -- it stays the plain <details> toggle it always was.
    const summaryMatch = html.match(/<summary class="activity-header">[\s\S]*?<\/summary>/);
    assert.ok(summaryMatch, 'template must still render the activity summary/header');
    assert.ok(!summaryMatch[0].includes('more-btn'), 'the more-btn must never live inside the activity summary/header');
});

test('clicking more fetches GET /activities/:id/output, scoped to the .more-btn element only', () => {
    const html = HTML_TEMPLATE([]);
    assert.ok(html.includes("e.target.closest('.more-btn')"), 'click handling must be scoped to .more-btn, not any click in the activity widget');
    assert.ok(html.includes("fetch('/activities/' + encodeURIComponent(activityId) + '/output')"), 'must fetch the on-demand full-output endpoint by activity id');
    assert.ok(html.includes('data[field]'), 'must read the response field matching the button that was clicked (output vs error)');
});

test('only one activity full-output block is ever held expanded at a time', () => {
    const html = HTML_TEMPLATE([]);
    assert.ok(html.includes('let expandedMoreBtn = null;'), 'must track a single globally-expanded more-btn');
    assert.ok(
        html.includes('if (expandedMoreBtn && expandedMoreBtn !== btn) {') &&
        html.includes('collapseMoreBtn(expandedMoreBtn);'),
        'expanding a new block must collapse whichever block was previously expanded'
    );
});

test('a collapsed/failed fetch never leaves the DOM in a stuck loading state', () => {
    const html = HTML_TEMPLATE([]);
    // Loading state is guarded against double-dispatch, and the catch path
    // always resets state/disabled so a failed fetch remains clickable again.
    assert.ok(html.includes("if (btn.dataset.state === 'loading') return;"), 'must not double-dispatch a fetch already in flight');
    assert.ok(html.includes('btn.dataset.state = \'\';') && html.includes('btn.disabled = false;'), 'a failed fetch must reset the button back to a clickable state');
});

test('history view (no live process) still renders the more-btn markup unconditionally with the rest of the template', () => {
    // The button's presence is data-driven client-side (act.outputTruncated/
    // errorTruncated), not server-render-mode-driven -- both live and
    // history views share the exact same HTML_TEMPLATE script.
    const live = HTML_TEMPLATE([]);
    const history = HTML_TEMPLATE([], { history: true, state: { workflowName: 'x', status: 'success', stats: {}, tree: [] } });
    assert.ok(live.includes('class="more-btn"'));
    assert.ok(history.includes('class="more-btn"'));
});
