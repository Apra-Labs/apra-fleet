// apra-fleet-eft.43.3: DOM-level regression coverage for the eft.43 bug
// ("Scroll broken: stream container height unbounded + body overflow:hidden
// makes below-fold content unreachable"). eft.43.2's own test
// (viewer-template-scroll-perf.test.mjs) proves the min-height: 0 flex chain
// is present in the rendered markup/CSS text, but never asserts the actual
// DOM measurement contract a browser reports: #stream-list.scrollHeight
// exceeding #stream-list.clientHeight once content overflows (the scrollbar
// engaging), and #stream-list.scrollTop being able to reach the last
// activity row. That is the gap this file fills.
//
// There is no jsdom/browser dependency in this repo (see
// apra-fleet-workflow-viewer-more-output-button.test.mjs's header comment for
// the prior art on this) -- and even jsdom would not help here, since jsdom
// does not implement layout at all: scrollHeight/clientHeight/offsetHeight
// etc. are hardcoded to 0 for every element regardless of CSS, so a real
// regression test still has to model the box a browser would actually
// compute. This file does that with a minimal, deterministic box-model
// stand-in for #stream-list: a bounded panel height (representing the
// html/body/.main-content/.content-area/.panel chain collapsing to a fixed
// viewport-sized box once every rung carries min-height: 0, per eft.43.2),
// against which N activity rows of fixed height are stacked. The bounded/
// unbounded switch driving the model is not hand-picked -- it is read
// straight out of the real HTML_TEMPLATE() CSS text (the same rungs
// eft.43.2 already asserts individually), so a future regression that drops
// any rung's min-height: 0 flips this model back to the pre-fix
// "container grew instead of capping" shape and fails the assertions below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HTML_TEMPLATE } from '../src/viewer/index.mjs';

// Same rungs eft.43.2 pins structurally: every one of these must carry
// min-height: 0 (or, for #stream-list, flex: 1 + min-height: 0 +
// overflow-y: auto) for the ancestor chain between the viewport-bounded
// <body> and #stream-list to actually bound #stream-list's rendered height
// instead of letting it grow to fit its content.
function flexChainIsBounded(html) {
    const rungs = [
        /html,\s*body\s*\{[^}]*height:\s*100%;[^}]*\}/,
        /body\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*\}/,
        /\.main-content\s*\{[^}]*min-height:\s*0;/,
        /\.content-area\s*\{[^}]*min-height:\s*0;/,
        /\.tab-content\.active\s*\{[^}]*min-height:\s*0;/,
        /\.panel\s*\{[^}]*min-height:\s*0;/,
        /\.stream-list\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/
    ];
    return rungs.every((rule) => rule.test(html));
}

// A minimal stand-in for #stream-list's box model. When `bounded` is true it
// mirrors what a real browser reports once the min-height: 0 chain is
// intact: clientHeight stays pinned to the panel's allotted viewport space
// regardless of how much content is stacked inside, while scrollHeight keeps
// growing with content -- exactly the gap that lets overflow-y: auto engage
// a scrollbar. When `bounded` is false it mirrors the pre-fix bug: with
// nothing above it pinning its height, the element grows to its content's
// full size, so clientHeight == scrollHeight (no internal scrollbar; the
// element itself has "grown instead of capping", matching this task's own
// wording of the failure mode).
function buildStreamListBoxModel({ rowCount, rowHeight, panelHeight, bounded }) {
    const contentHeight = rowCount * rowHeight;
    const scrollHeight = contentHeight;
    const clientHeight = bounded ? Math.min(panelHeight, contentHeight) : contentHeight;
    let scrollTop = 0;
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
    return {
        scrollHeight,
        clientHeight,
        get scrollTop() {
            return scrollTop;
        },
        set scrollTop(v) {
            scrollTop = Math.min(Math.max(0, v), maxScrollTop);
        },
        // Whether row `i` (0-indexed, top-to-bottom, last one being the most
        // recent activity) falls within the currently visible window.
        rowVisible(i) {
            const top = i * rowHeight;
            const bottom = top + rowHeight;
            return top < scrollTop + clientHeight && bottom > scrollTop;
        }
    };
}

test('apra-fleet-eft.43.3: the real template still carries every rung of the bounded flex chain', () => {
    // Sanity anchor: the box-model simulation below is only meaningful
    // against the REAL HTML_TEMPLATE() markup/CSS, not a hardcoded flag.
    // This must independently be true before the DOM-measurement assertions
    // that follow can mean anything.
    assert.equal(flexChainIsBounded(HTML_TEMPLATE([])), true, 'the eft.43 flex chain must still be intact in the rendered template');
});

test('apra-fleet-eft.43.3: #stream-list.scrollHeight exceeds clientHeight once activity rows exceed the viewport (scrollbar engaged)', () => {
    const bounded = flexChainIsBounded(HTML_TEMPLATE([]));
    const ROW_HEIGHT = 60;
    const PANEL_HEIGHT = 800;
    // Enough rows to exceed the viewport several times over, as the
    // acceptance criteria calls for.
    const ROW_COUNT = 40;
    assert.ok(ROW_COUNT * ROW_HEIGHT > PANEL_HEIGHT, 'fixture must actually exceed the viewport to exercise the scrollbar');

    const streamList = buildStreamListBoxModel({ rowCount: ROW_COUNT, rowHeight: ROW_HEIGHT, panelHeight: PANEL_HEIGHT, bounded });

    assert.ok(
        streamList.scrollHeight > streamList.clientHeight,
        `expected #stream-list.scrollHeight (${streamList.scrollHeight}) > clientHeight (${streamList.clientHeight}); equal means the container grew instead of capping`
    );
});

test('apra-fleet-eft.43.3: setting #stream-list.scrollTop reaches/exposes the last activity row', () => {
    const bounded = flexChainIsBounded(HTML_TEMPLATE([]));
    const ROW_HEIGHT = 60;
    const PANEL_HEIGHT = 800;
    const ROW_COUNT = 40;
    const lastRowIndex = ROW_COUNT - 1;

    const streamList = buildStreamListBoxModel({ rowCount: ROW_COUNT, rowHeight: ROW_HEIGHT, panelHeight: PANEL_HEIGHT, bounded });

    // Before scrolling, the last (most recent) activity row is below the
    // fold -- not vacuously already visible.
    assert.equal(streamList.rowVisible(lastRowIndex), false, 'sanity: last row must start out-of-view, or scrolling to reach it proves nothing');

    // Scroll to the bottom (a real user drags the scrollbar / hits End; here
    // we drive scrollTop directly, clamped the same way a browser clamps it).
    streamList.scrollTop = streamList.scrollHeight;

    assert.equal(
        streamList.scrollTop,
        streamList.scrollHeight - streamList.clientHeight,
        'scrollTop must be able to reach the container max (scrollHeight - clientHeight), i.e. the scrollbar is not stuck at 0'
    );
    assert.ok(streamList.rowVisible(lastRowIndex), 'the last activity row must be reachable/exposed once scrollTop is at max');
});

test('harness sanity: the box model correctly reproduces the pre-fix failure (container grew instead of capping) when the chain is broken', () => {
    // Not asserted against the real template -- this proves the simulator
    // above is not vacuously true, i.e. it is actually capable of failing
    // the way the acceptance criteria describes ("Fail the test if
    // scrollHeight == clientHeight") when the flex chain is NOT bounded.
    const ROW_HEIGHT = 60;
    const PANEL_HEIGHT = 800;
    const ROW_COUNT = 40;
    const broken = buildStreamListBoxModel({ rowCount: ROW_COUNT, rowHeight: ROW_HEIGHT, panelHeight: PANEL_HEIGHT, bounded: false });
    assert.equal(broken.scrollHeight, broken.clientHeight, 'pre-fix shape: the container grows to its content size, so scrollHeight == clientHeight');
});
