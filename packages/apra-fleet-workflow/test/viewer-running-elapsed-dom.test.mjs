// apra-fleet-eft.45.2: DOM-level regression coverage for apra-fleet-eft.45.1
// ("render elapsed-since-start on running activity rows"). eft.45.1 added a
// durationHtml branch to the activity-row render logic in
// src/viewer/index.mjs: while act.isRunning is true, the right-edge label
// shows formatUptime(Date.now() - act.startTime) instead of sitting empty
// until completion; once isRunning flips false, the existing
// formatTime(act.duration) branch takes over unchanged.
//
// There is no jsdom/browser dependency in this repo (see
// apra-fleet-workflow-viewer-more-output-button.test.mjs's header comment for
// the prior art) -- so, same technique as that file, this test extracts the
// ACTUAL formatTime/formatUptime helpers and the ACTUAL isRunning/duration
// branch verbatim out of HTML_TEMPLATE()'s emitted client script and
// executes them against real `act` fixtures with a mocked Date.now, rather
// than reimplementing the logic here (which would drift out of sync with the
// real render code and stop catching regressions).
import test from 'node:test';
import assert from 'node:assert/strict';
import { HTML_TEMPLATE } from '../src/viewer/index.mjs';

function extractDurationHtmlBuilder() {
    const html = HTML_TEMPLATE([]);

    const ftStart = html.indexOf('function formatTime(ms) {');
    assert.ok(ftStart !== -1, 'template must define formatTime');
    const helpersEnd = html.indexOf('// Shared with dashboard extensions', ftStart);
    assert.ok(helpersEnd !== -1, 'must find end of the formatTime/formatUptime helper block');
    const helpers = html.slice(ftStart, helpersEnd);

    const durStart = html.indexOf("let durationHtml = '';");
    assert.ok(durStart !== -1, 'template must define the isRunning/duration durationHtml branch (apra-fleet-eft.45.1)');
    const durEnd = html.indexOf('evEl.innerHTML', durStart);
    assert.ok(durEnd !== -1, 'must find the end of the durationHtml branch');
    const durationLogic = html.slice(durStart, durEnd);

    // eslint-disable-next-line no-new-func
    const fn = new Function('act', `${helpers}\n${durationLogic}\nreturn durationHtml;`);
    return (act) => fn(act);
}

test('a running row (isRunning true, has startTime, no duration yet) renders nonzero elapsed since start', () => {
    const build = extractDurationHtmlBuilder();
    const realNow = Date.now;
    try {
        let mockNow = 1_700_000_000_000;
        Date.now = () => mockNow;

        const act = { isRunning: true, startTime: mockNow - 5000 };
        assert.equal(build(act), '5s', 'elapsed must be formatUptime(now - startTime)');
    } finally {
        Date.now = realNow;
    }
});

test('elapsed increases across successive re-renders as the mocked clock advances (poll/refresh cycle)', () => {
    const build = extractDurationHtmlBuilder();
    const realNow = Date.now;
    try {
        let mockNow = 1_700_000_000_000;
        Date.now = () => mockNow;

        const act = { isRunning: true, startTime: mockNow };

        const first = build(act);
        assert.equal(first, '0s', 'at t=0 elapsed is 0s');

        mockNow += 10_000; // simulate a poll firing 10s later
        const second = build(act);
        assert.equal(second, '10s', 'a re-render after the clock advances must recompute a larger elapsed value');

        mockNow += 70_000; // simulate another poll firing 70s after that (total 80s)
        const third = build(act);
        assert.equal(third, '1m 20s', 'elapsed keeps increasing monotonically across further re-renders, using the same short form as formatUptime');
    } finally {
        Date.now = realNow;
    }
});

test('on completion (isRunning false) the final duration replaces the elapsed label exactly as before', () => {
    const build = extractDurationHtmlBuilder();
    const realNow = Date.now;
    try {
        let mockNow = 1_700_000_000_000;
        Date.now = () => mockNow;

        const act = { isRunning: true, startTime: mockNow };
        mockNow += 45_000;
        assert.equal(build(act), '45s', 'still running: elapsed label shown');

        // The activity finishes: isRunning flips false and duration is set,
        // exactly what the real workflow emits on activity:end.
        act.isRunning = false;
        act.duration = 842;
        assert.equal(build(act), '0s', 'once complete, the final duration (formatTime) replaces the elapsed label, not the last elapsed value -- a sub-second duration renders "0s", per apra-fleet-4wr.1');

        // Further clock advances must have no further effect once complete --
        // the label is pinned to the final duration, not still ticking.
        mockNow += 60_000;
        assert.equal(build(act), '0s', 'a completed row must not keep counting up on later re-renders');
    } finally {
        Date.now = realNow;
    }
});

test('a running row with no startTime yet renders no elapsed label (nothing to compute from)', () => {
    const build = extractDurationHtmlBuilder();
    const act = { isRunning: true };
    assert.equal(build(act), '', 'without a startTime there is nothing to render yet');
});
