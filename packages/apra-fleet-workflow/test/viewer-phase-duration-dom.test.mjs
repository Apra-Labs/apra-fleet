// apra-fleet-eft.53.3: DOM-level regression coverage for apra-fleet-eft.53.2
// ("render phase-header duration: live tick and frozen total"), rounding out
// the four AC cases from the parent feature (apra-fleet-eft.53):
//
//   (a) a completed-phase fixture renders the formatted duration right-aligned
//       in the phase header;
//   (b) a live-phase fixture renders elapsed from phaseStartedAt against a
//       mocked clock, and advancing the clock + firing the ticker (a
//       re-render) updates the text WITHOUT a server fetch;
//   (c) GET /state carries phaseStartedAt/phaseEndedAt per phase -- already
//       covered end-to-end by apra-fleet-workflow-phase-timestamps.test.mjs
//       (written alongside apra-fleet-eft.53.1, the engine-side stamping
//       task); not duplicated here;
//   (d) after a simulated reload, earlier (already-completed) phases still
//       show their frozen durations rather than recomputing from a live
//       clock.
//
// Same technique as viewer-running-elapsed-dom.test.mjs (eft.45.2) and
// apra-fleet-workflow-viewer-more-output-button.test.mjs: there is no
// jsdom/browser dependency in this repo, so this test extracts the ACTUAL
// formatTime/formatUptime helpers and the ACTUAL phase-duration render block
// (the "const phaseDurationEl = phaseEl.querySelector('.phase-duration')..."
// logic added in apra-fleet-eft.53.2) verbatim out of HTML_TEMPLATE()'s
// emitted client script, rather than reimplementing it here (which would
// drift out of sync with the real render code and stop catching
// regressions). The extracted logic addresses a DOM element via
// `phaseEl.querySelector('.phase-duration')` and mutates its
// `.textContent`/`.dataset.rendered` directly (unlike the activity-row
// helper in eft.45.1, which only builds a string), so the harness below
// supplies a minimal fake `phaseEl` exposing just that surface instead of a
// real DOM node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HTML_TEMPLATE } from '../src/viewer/index.mjs';

function extractPhaseDurationRenderer() {
    const html = HTML_TEMPLATE([]);

    const ftStart = html.indexOf('function formatTime(ms) {');
    assert.ok(ftStart !== -1, 'template must define formatTime');
    const helpersEnd = html.indexOf('// Shared with dashboard extensions', ftStart);
    assert.ok(helpersEnd !== -1, 'must find end of the formatTime/formatUptime helper block');
    const helpers = html.slice(ftStart, helpersEnd);

    const blockStart = html.indexOf("const phaseDurationEl = phaseEl.querySelector('.phase-duration');");
    assert.ok(blockStart !== -1, 'template must define the phase-duration render block (apra-fleet-eft.53.2)');
    const blockEnd = html.indexOf('const phaseBody', blockStart);
    assert.ok(blockEnd !== -1, 'must find the end of the phase-duration render block');
    const renderBlock = html.slice(blockStart, blockEnd);

    // eslint-disable-next-line no-new-func
    const fn = new Function('phaseEl', 'phase', `${helpers}\n${renderBlock}`);
    return (phaseEl, phase) => fn(phaseEl, phase);
}

// Minimal fake standing in for the real `phaseEl` DOM node: only exposes the
// `.querySelector('.phase-duration')` surface the extracted render block
// actually touches, returning a fake element with the `.dataset`/
// `.textContent` the block reads and writes.
function createFakePhaseEl() {
    const durationEl = { dataset: {}, textContent: '' };
    return {
        querySelector(sel) {
            return sel === '.phase-duration' ? durationEl : null;
        },
        durationEl
    };
}

test('(a) a completed-phase fixture renders the formatted duration', () => {
    const render = extractPhaseDurationRenderer();
    const phaseEl = createFakePhaseEl();

    const phase = {
        phaseStartedAt: new Date(1_700_000_000_000).toISOString(),
        phaseEndedAt: new Date(1_700_000_005_000).toISOString()
    };
    render(phaseEl, phase);

    assert.equal(phaseEl.durationEl.textContent, '5s', 'a completed phase must show formatTime(phaseEndedAt - phaseStartedAt)');
    assert.equal(phaseEl.durationEl.dataset.rendered, 'done', 'a completed phase must be marked as frozen so later re-renders never recompute it');
});

test('(b) a live-phase fixture ticks from the mocked clock, with no server fetch on advance', () => {
    const render = extractPhaseDurationRenderer();
    const phaseEl = createFakePhaseEl();

    const realNow = Date.now;
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (...args) => {
        fetchCalls += 1;
        throw new Error('unexpected server fetch: ' + JSON.stringify(args));
    };
    try {
        let mockNow = 1_700_000_000_000;
        Date.now = () => mockNow;

        const phase = { phaseStartedAt: new Date(mockNow).toISOString() };

        render(phaseEl, phase);
        assert.equal(phaseEl.durationEl.textContent, '0s', 'at t=0 elapsed is 0s');
        assert.equal(phaseEl.durationEl.dataset.rendered, undefined, 'a live phase must not be marked frozen');

        // Simulate the ticker firing 15s later (per the parent feature's own
        // wording: "advancing the mocked clock by 15s and firing the ticker").
        mockNow += 15_000;
        render(phaseEl, phase);
        assert.equal(phaseEl.durationEl.textContent, '15s', 'a re-render after the clock advances must recompute a larger elapsed value');

        mockNow += 65_000; // total 80s
        render(phaseEl, phase);
        assert.equal(phaseEl.durationEl.textContent, '1m 20s', 'elapsed keeps increasing monotonically across further re-renders');

        assert.equal(fetchCalls, 0, 'ticking a live phase-header duration must never trigger a server fetch');
    } finally {
        Date.now = realNow;
        if (realFetch === undefined) {
            delete globalThis.fetch;
        } else {
            globalThis.fetch = realFetch;
        }
    }
});

test('(d) after a simulated reload, an earlier completed phase still shows its frozen duration, not a live tick', () => {
    const render = extractPhaseDurationRenderer();

    const realNow = Date.now;
    try {
        let mockNow = 1_700_000_100_000;
        Date.now = () => mockNow;

        // A finished run reloaded from persisted state: the phase already has
        // both timestamps, but the DOM is being freshly built (a brand-new
        // phaseEl/durationEl, exactly like a page reload creates), so
        // dataset.rendered starts unset.
        const earlierPhase = {
            phaseStartedAt: new Date(1_700_000_000_000).toISOString(),
            phaseEndedAt: new Date(1_700_000_042_000).toISOString()
        };
        const phaseEl = createFakePhaseEl();

        render(phaseEl, earlierPhase);
        assert.equal(phaseEl.durationEl.textContent, '42s', 'reloaded earlier phase must show its frozen total, not elapsed-since-reload');
        assert.equal(phaseEl.durationEl.dataset.rendered, 'done', 'reloaded earlier phase must be marked frozen immediately');

        // Further re-renders (e.g. the normal refresh/SSE cadence continuing
        // to tick other, still-live phases) must not perturb it.
        mockNow += 60_000;
        render(phaseEl, earlierPhase);
        assert.equal(phaseEl.durationEl.textContent, '42s', 'a frozen earlier-phase duration must not keep counting up after reload');
    } finally {
        Date.now = realNow;
    }
});
