// apra-fleet-36l.2: DOM-level regression coverage for apra-fleet-36l.1 (the
// client-side heartbeat interval added for quiet-period liveness).
//
// There is no jsdom/browser dependency in this repo (see
// apra-fleet-workflow-viewer-more-output-button.test.mjs's header comment for
// the prior art) -- so, same technique as the other viewer-*-dom test files,
// this extracts the ACTUAL polling setup (POLL_COALESCE_MS/schedulePoll(),
// the EventSource('/events').onmessage handler, and the
// HEARTBEAT_INTERVAL_MS setInterval) verbatim out of HTML_TEMPLATE()'s
// emitted client script and executes it against mocked EventSource/
// setTimeout/setInterval, rather than reimplementing the logic here (which
// would drift out of sync with the real client code and stop catching
// regressions).
//
// node:test's built-in mock.timers gives a virtual clock: setTimeout/
// setInterval scheduled by the extracted script are captured and only fire
// when the test explicitly advances the clock via mock.timers.tick(), so
// these tests run instantly instead of waiting out a real 5-10s cadence.
// Node's mock.timers do NOT cascade newly-scheduled timers within a single
// tick() call (a timer scheduled by a callback that itself ran during a
// tick() only fires on a LATER tick() call, even if its deadline falls
// within the already-advanced window) -- so every test below advances the
// clock in separate, deadline-aligned tick() steps rather than one large
// jump.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { HTML_TEMPLATE } from '../src/viewer/index.mjs';

// Pulls HEARTBEAT_INTERVAL_MS's actual configured value out of the template
// instead of hardcoding it, so this test both (a) never drifts out of sync
// with the real constant and (b) still enforces the bead's "5-10s cadence"
// acceptance criterion against whatever that real value is.
function extractHeartbeatIntervalMs(html) {
    const m = html.match(/const HEARTBEAT_INTERVAL_MS = (\d+);/);
    assert.ok(m, 'template must define HEARTBEAT_INTERVAL_MS');
    return Number(m[1]);
}

// Builds a runnable sandbox around the actual polling setup block (from
// `const POLL_COALESCE_MS` through the heartbeat `setInterval(...)` call),
// with a mock EventSource whose constructed instance is captured so tests
// can simulate an incoming SSE message via `getSource().onmessage(...)`.
// setTimeout/setInterval are deliberately left unbound function parameters
// -- new Function()'s body resolves them from the (test-mocked) global scope
// at call time, so node:test's mock.timers controls them transparently.
function buildPollingSandbox(poll) {
    const html = HTML_TEMPLATE([]);
    const start = html.indexOf('const POLL_COALESCE_MS');
    assert.ok(start !== -1, 'template must define POLL_COALESCE_MS');
    const end = html.indexOf('function renderTreeIncremental', start);
    assert.ok(end !== -1, 'must find the end of the polling setup block');
    const script = html.slice(start, end);

    let capturedSource = null;
    class MockEventSource {
        constructor(url) {
            this.url = url;
            this.onmessage = null;
            capturedSource = this;
        }
    }
    class MockCustomEvent {
        constructor(type, init) {
            this.type = type;
            this.detail = init && init.detail;
        }
    }
    const mockDocument = { dispatchEvent: () => {} };

    // eslint-disable-next-line no-new-func
    const fn = new Function('EventSource', 'CustomEvent', 'document', 'poll', script);
    fn(MockEventSource, MockCustomEvent, mockDocument, poll);

    return {
        heartbeatIntervalMs: extractHeartbeatIntervalMs(html),
        fireSseMessage(payload = { type: 'log' }) {
            assert.ok(capturedSource, 'EventSource must have been constructed');
            assert.ok(typeof capturedSource.onmessage === 'function', 'onmessage handler must be wired');
            capturedSource.onmessage({ data: JSON.stringify(payload) });
        }
    };
}

test('apra-fleet-36l.2: quiet period (no SSE messages) -- the heartbeat interval alone drives poll() at its configured cadence, which is within the 5-10s range', () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    try {
        const pollCalls = [];
        const sandbox = buildPollingSandbox(() => pollCalls.push('poll'));

        assert.ok(
            sandbox.heartbeatIntervalMs >= 5000 && sandbox.heartbeatIntervalMs <= 10000,
            `HEARTBEAT_INTERVAL_MS (${sandbox.heartbeatIntervalMs}) must be within the 5-10s cadence range`
        );

        // Before the heartbeat interval elapses: no SSE messages, no poll.
        mock.timers.tick(sandbox.heartbeatIntervalMs - 1);
        assert.deepEqual(pollCalls, [], 'no poll() before the heartbeat interval has elapsed');

        // The interval fires (schedulePoll()'s own 400ms coalesce timer then
        // needs its own separate tick to resolve -- see file header).
        mock.timers.tick(1);
        mock.timers.tick(400);
        assert.deepEqual(pollCalls, ['poll'], 'the quiet-period heartbeat alone must trigger exactly one poll()');

        // The cadence recurs: a second full interval later, poll() fires again.
        mock.timers.tick(sandbox.heartbeatIntervalMs);
        mock.timers.tick(400);
        assert.deepEqual(pollCalls, ['poll', 'poll'], 'the heartbeat must keep firing poll() on every subsequent interval, not just once');
    } finally {
        mock.timers.reset();
    }
});

test('apra-fleet-36l.2: an incoming EventSource message still drives poll() exactly as before (event-driven path unchanged by the heartbeat)', () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    try {
        const pollCalls = [];
        const sandbox = buildPollingSandbox(() => pollCalls.push('poll'));

        // Well before the heartbeat would ever fire (< 5s, the low end of the
        // cadence range), a real SSE event arrives.
        mock.timers.tick(1000);
        sandbox.fireSseMessage({ type: 'log' });
        assert.deepEqual(pollCalls, [], 'poll() is coalesced (400ms), not called synchronously from onmessage');

        mock.timers.tick(400);
        assert.deepEqual(pollCalls, ['poll'], 'the event-driven poll() must still fire, exactly as before apra-fleet-36l.1');
    } finally {
        mock.timers.reset();
    }
});

test('apra-fleet-36l.2: the heartbeat landing while an event-driven poll is already pending does not double-fire (coalescing honored)', () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    try {
        const pollCalls = [];
        const sandbox = buildPollingSandbox(() => pollCalls.push('poll'));
        const heartbeatMs = sandbox.heartbeatIntervalMs;

        // Advance to just before the first heartbeat tick, then a real SSE
        // event lands -- schedulePoll() sets its 400ms coalesce timer
        // (pending, deadline = heartbeatMs + 300).
        mock.timers.tick(heartbeatMs - 100);
        sandbox.fireSseMessage({ type: 'log' });
        assert.deepEqual(pollCalls, [], 'poll() not yet fired -- still coalescing');

        // The heartbeat's own setInterval now fires (t = heartbeatMs) WHILE
        // that event-driven poll is still pending. It calls schedulePoll()
        // too, but schedulePoll()'s `if (pollTimer) return;` guard must no-op
        // -- it must NOT schedule a second, concurrent poll.
        mock.timers.tick(100);
        assert.deepEqual(pollCalls, [], 'still coalescing after the heartbeat lands on top of the pending event-driven poll');

        // The original (event-driven) coalesce timer resolves: exactly ONE
        // poll(), not two, proves the heartbeat did not double-fire it.
        mock.timers.tick(300);
        assert.deepEqual(pollCalls, ['poll'], 'exactly one poll() -- the heartbeat must not cause a duplicate concurrent poll');

        // Sanity: the heartbeat's own recurring cadence still works normally
        // afterwards (it wasn't left in a broken/one-shot state by the
        // coalesced tick).
        mock.timers.tick(heartbeatMs);
        mock.timers.tick(400);
        assert.deepEqual(pollCalls, ['poll', 'poll'], 'the heartbeat keeps ticking normally after a coalesced overlap');
    } finally {
        mock.timers.reset();
    }
});
