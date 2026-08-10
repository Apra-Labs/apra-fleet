// apra-fleet-4wr.2: verification for apra-fleet-4wr.1 ("apply the h/m/s
// duration formatter uniformly to closed and parent activity rows"). Before
// 4wr.1, live (running) rows used the h/m/s formatUptime() while closed/
// historical rows printed raw seconds (e.g. '6390s') via a second formatter
// -- the same elapsed value rendered two different ways depending on
// whether the row was still running. 4wr.1 made formatUptime() delegate to
// formatTime() for the actual formatting, so there is now exactly ONE
// shared h/m/s formatter behind both paths.
//
// There is no jsdom/browser dependency in this repo (see
// apra-fleet-workflow-viewer-more-output-button.test.mjs's header comment
// for the prior art) -- so, same technique as
// viewer-running-elapsed-dom.test.mjs / viewer-phase-duration-dom.test.mjs,
// this test extracts the ACTUAL formatTime/formatUptime helpers and the
// ACTUAL activity-row isRunning/duration render branch verbatim out of
// HTML_TEMPLATE()'s emitted client script, rather than reimplementing the
// logic here (which would drift out of sync with the real render code and
// stop catching regressions -- e.g. a future change that reintroduces a raw
// '+ "s"' seconds path).
import test from 'node:test';
import assert from 'node:assert/strict';
import { HTML_TEMPLATE } from '../src/viewer/index.mjs';

function extractHelpers(html) {
    const ftStart = html.indexOf('function formatTime(ms) {');
    assert.ok(ftStart !== -1, 'template must define formatTime');
    const helpersEnd = html.indexOf('// Shared with dashboard extensions', ftStart);
    assert.ok(helpersEnd !== -1, 'must find end of the formatTime/formatUptime helper block');
    return html.slice(ftStart, helpersEnd);
}

// formatTime/formatUptime as real, callable functions (extracted verbatim,
// not reimplemented) for direct numeric assertions.
function extractFormatters() {
    const html = HTML_TEMPLATE([]);
    const helpers = extractHelpers(html);
    // eslint-disable-next-line no-new-func
    const factory = new Function(`${helpers}\nreturn { formatTime, formatUptime };`);
    return factory();
}

// The actual activity-row isRunning/duration branch (same extraction as
// viewer-running-elapsed-dom.test.mjs's extractDurationHtmlBuilder) -- built
// independently here so this file pins the apra-fleet-4wr.2 regression on
// its own, without depending on another test file's helper.
function extractActivityDurationHtmlBuilder() {
    const html = HTML_TEMPLATE([]);
    const helpers = extractHelpers(html);

    const durStart = html.indexOf("let durationHtml = '';");
    assert.ok(durStart !== -1, 'template must define the isRunning/duration durationHtml branch (apra-fleet-eft.45.1)');
    const durEnd = html.indexOf('evEl.innerHTML', durStart);
    assert.ok(durEnd !== -1, 'must find the end of the durationHtml branch');
    const durationLogic = html.slice(durStart, durEnd);

    // eslint-disable-next-line no-new-func
    const fn = new Function('act', `${helpers}\n${durationLogic}\nreturn durationHtml;`);
    return (act) => fn(act);
}

test('formatTime: fixed h/m/s conversions (regression pin for the reported 6390s raw-seconds bug)', () => {
    const { formatTime } = extractFormatters();
    assert.equal(formatTime(6390000), '1hr 46m 30s', '6390000ms (the reported "6390s" case) must render h/m/s, never raw seconds');
    assert.equal(formatTime(125000), '2m 5s');
    assert.equal(formatTime(9000), '9s');
    assert.equal(formatTime(0), '0s');
});

test('formatTime: grep-style regression -- no render path may fall back to raw seconds concatenation', () => {
    const { formatTime } = extractFormatters();
    // A large multi-hour duration must never render as e.g. "23070s"; it
    // must always be decomposed into hr/m/s components.
    const sixHoursTwentyOneMin10s = ((6 * 60 + 21) * 60 + 10) * 1000;
    const rendered = formatTime(sixHoursTwentyOneMin10s);
    assert.equal(rendered, '6hr 21m 10s');
    assert.ok(!/^\d+s$/.test(rendered) || sixHoursTwentyOneMin10s < 60000, 'a multi-minute/hour duration must never render as a bare raw-seconds string');
});

test('a CLOSED activity row and a RUNNING activity row with the same elapsed value render an IDENTICAL duration string (the actual apra-fleet-4wr regression)', () => {
    const build = extractActivityDurationHtmlBuilder();
    const realNow = Date.now;
    try {
        const mockNow = 1_700_000_000_000;
        Date.now = () => mockNow;
        const elapsedMs = 6390000; // the reported '6390s' case

        const runningAct = { isRunning: true, startTime: mockNow - elapsedMs };
        const closedAct = { isRunning: false, duration: elapsedMs };

        const runningRendered = build(runningAct);
        const closedRendered = build(closedAct);

        assert.equal(runningRendered, '1hr 46m 30s', 'running row must render h/m/s');
        assert.equal(closedRendered, '1hr 46m 30s', 'closed row must render h/m/s');
        assert.equal(runningRendered, closedRendered, 'live and closed rows for the same elapsed value must render byte-identical duration strings');
    } finally {
        Date.now = realNow;
    }
});

test('a CLOSED and RUNNING row also agree on a small (sub-minute) elapsed value', () => {
    const build = extractActivityDurationHtmlBuilder();
    const realNow = Date.now;
    try {
        const mockNow = 1_700_000_000_000;
        Date.now = () => mockNow;
        const elapsedMs = 9000;

        const runningAct = { isRunning: true, startTime: mockNow - elapsedMs };
        const closedAct = { isRunning: false, duration: elapsedMs };

        assert.equal(build(runningAct), '9s');
        assert.equal(build(closedAct), '9s');
        assert.equal(build(runningAct), build(closedAct));
    } finally {
        Date.now = realNow;
    }
});

test('formatTime: a fixture with no duration (null/undefined) renders the "-" placeholder, never "0s"', () => {
    const { formatTime } = extractFormatters();
    assert.equal(formatTime(null), '-');
    assert.equal(formatTime(undefined), '-');
    assert.notEqual(formatTime(undefined), '0s');
});

test('formatTime: a genuine zero-duration fixture still renders "0s", not "-" (distinct from the missing-value case above)', () => {
    const { formatTime } = extractFormatters();
    assert.equal(formatTime(0), '0s');
});
