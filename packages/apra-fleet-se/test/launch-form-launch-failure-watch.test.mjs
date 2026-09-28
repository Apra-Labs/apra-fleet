// apra-fleet-i9ag.16.5 -- dedicated regression coverage for the launch form's
// post-launch watch (apra-fleet-i9ag.16.4): the form must never leave a green
// "Launched sprint <id>." line standing for a run that actually died in its
// launch window, and it must never invent a failure from an inconclusive
// poll. Two layers, both driving the REAL shipped code, never a
// reimplementation of the polling/classification logic:
//
//   1. classifyLaunchWatch() -- a pure, DOM-free function -- is unit-tested
//      directly against a table of GET /api/sprints/:id response shapes.
//   2. The scheduling/DOM-update loop around it (watchLaunch(), only ever
//      defined inside clientScriptSource()) is exercised by slicing the
//      ACTUAL <script> body out of renderLaunchFormHtml()'s rendered HTML and
//      running it via `new Function(...)` against a hand-rolled DOM stub, a
//      fake fetch, and node:test's virtual clock -- the same no-jsdom
//      technique supervisor-dashboard-live-refresh.test.mjs uses for
//      sprintStackLiveScript() and supervisor-launch-form.test.mjs already
//      uses for this same watch. This file adds the one scenario that
//      coverage was missing: mount-prefix correctness for the poll URL and
//      the raw-log anchor.

import { test, describe } from 'node:test';
import assert from 'node:assert';

import { classifyLaunchWatch, renderLaunchFormHtml } from '../src/supervisor/launch-form.mjs';

// =============================================================================
// Layer 1: classifyLaunchWatch() -- pure classifier unit table
// =============================================================================

describe('launch-form-launch-failure-watch: classifyLaunchWatch() classifier table', () => {
    test('a launch-failed latest event classifies failed, carrying its reason', () => {
        const result = classifyLaunchWatch({
            sprintId: 's-1', live: false, history: [],
            latest: { event: 'launch-failed', reason: 'spawn ENOENT' },
        });
        assert.deepEqual(result, { status: 'failed', reason: 'spawn ENOENT' });
    });

    test('a launch-failed latest event with no/empty reason still classifies failed, with a non-empty fallback reason', () => {
        const noReason = classifyLaunchWatch({ sprintId: 's-1', live: false, latest: { event: 'launch-failed' } });
        assert.equal(noReason.status, 'failed');
        assert.ok(noReason.reason.length > 0);

        const emptyReason = classifyLaunchWatch({ sprintId: 's-1', live: false, latest: { event: 'launch-failed', reason: '' } });
        assert.equal(emptyReason.status, 'failed');
        assert.ok(emptyReason.reason.length > 0);
    });

    test('a child-exited history event with a non-zero exit code classifies failed', () => {
        const result = classifyLaunchWatch({
            sprintId: 's-1', live: false,
            history: [{ event: 'child-exited', exitCode: 1, signal: null }],
        });
        assert.equal(result.status, 'failed');
        assert.ok(/1/.test(result.reason), result.reason);
    });

    test('a child-exited history event with a signal classifies failed', () => {
        const result = classifyLaunchWatch({
            sprintId: 's-1', live: false,
            history: [{ event: 'child-exited', exitCode: null, signal: 'SIGKILL' }],
        });
        assert.equal(result.status, 'failed');
        assert.ok(/SIGKILL/.test(result.reason), result.reason);
    });

    test('a clean child-exited event (exitCode 0, no signal) is never classified failed', () => {
        const result = classifyLaunchWatch({
            sprintId: 's-1', live: false,
            history: [{ event: 'child-exited', exitCode: 0, signal: null }],
        });
        assert.notEqual(result.status, 'failed');
    });

    test('live with no terminal event classifies live', () => {
        assert.deepEqual(classifyLaunchWatch({ sprintId: 's-1', live: true, state: {} }), { status: 'live' });
    });

    test('a 404 / empty / garbage body classifies unknown -- never invents a failure', () => {
        assert.equal(classifyLaunchWatch(null).status, 'unknown');
        assert.equal(classifyLaunchWatch(undefined).status, 'unknown');
        assert.equal(classifyLaunchWatch({}).status, 'unknown');
        assert.equal(classifyLaunchWatch('not an object').status, 'unknown');
        assert.equal(classifyLaunchWatch(42).status, 'unknown');
        assert.equal(classifyLaunchWatch({ sprintId: 's-1', live: false, history: [] }).status, 'unknown');
    });
});

// =============================================================================
// Layer 2: the REAL extracted client script, driven end-to-end
// =============================================================================

/** A minimal element stub good enough for the form's id lookups. */
function makeContainer(id) {
    return {
        id,
        textContent: '',
        innerHTML: '',
        style: {},
        querySelector: () => null,
        querySelectorAll: () => [],
        appendChild: () => {},
    };
}

/**
 * Slices the REAL <script> body out of renderLaunchFormHtml()'s rendered
 * HTML, wires it against a hand-rolled DOM stub (with a real-enough
 * createElement() to inspect the raw-log anchor watchLaunch() appends) and a
 * configurable fetch stub, and returns a small driver: select an issue,
 * submit the form, and inspect the result line / every fetch call made.
 *
 * `mountPrefix` is forwarded to renderLaunchFormHtml() itself (apra-fleet-
 * i9ag.3.2's per-request mount-prefix contract) so a test can assert the
 * poll URL and raw-log href both carry it.
 *
 * `pollResponder(url)` answers every GET poll to /api/sprints/<id>.
 * `launchSprintId` picks the sprintId the mocked POST /api/sprints 201
 * returns -- either a fixed string, or a function of the 0-based POST call
 * index (for the "second submit" scenario, which must launch a DIFFERENT id).
 */
function buildLaunchWatchSandbox({ pollResponder, launchSprintId, mountPrefix } = {}) {
    const html = renderLaunchFormHtml(mountPrefix);
    const scriptStart = html.indexOf('<script>') + '<script>'.length;
    const scriptEnd = html.indexOf('</script>', scriptStart);
    assert.ok(scriptStart > -1 && scriptEnd > -1, 'renderLaunchFormHtml must emit a <script> block');
    const script = html.slice(scriptStart, scriptEnd);

    const resultEl = {
        style: {},
        textContent: '',
        children: [],
        appendChild(el) { this.children.push(el); },
    };
    const membersContainer = makeContainer('launch-members');
    membersContainer.querySelectorAll = () => [{ checked: true, value: 'alice' }];
    let submitHandler = null;
    let changeHandler = null;
    const elementsById = {
        'launch-members': membersContainer,
        'launch-selected-issues': makeContainer('launch-selected-issues'),
        'launch-result': resultEl,
        'launch-sprint-form': { addEventListener: (type, handler) => { if (type === 'submit') submitHandler = handler; } },
        'launch-goal': { value: 'P1' },
        'launch-branch': { value: 'feat/x' },
        'launch-base': { value: 'main' },
    };

    const fetchCalls = [];
    let launchCallCount = 0;
    const fetchImpl = async (url, opts) => {
        fetchCalls.push(url);
        if (opts && opts.method === 'POST') {
            const sprintId = typeof launchSprintId === 'function' ? launchSprintId(launchCallCount) : (launchSprintId ?? 's-1');
            launchCallCount += 1;
            return { status: 201, json: async () => ({ sprintId }) };
        }
        // GET /api/members on script init, or watchLaunch()'s own GET poll.
        if (typeof pollResponder === 'function' && url.indexOf('/api/sprints/') !== -1) {
            return pollResponder(url);
        }
        return { ok: true, json: async () => ({ members: [] }) };
    };

    const mockDocument = {
        getElementById: (id) => elementsById[id] || null,
        addEventListener: (type, handler) => { if (type === 'change') changeHandler = handler; },
        querySelectorAll: () => [],
        createElement: () => ({ style: {}, textContent: '' }),
    };

    // eslint-disable-next-line no-new-func
    const fn = new Function('document', 'fetch', 'window', script);
    fn(mockDocument, fetchImpl, {});

    return {
        resultEl,
        fetchCalls,
        selectIssue(id) {
            assert.ok(changeHandler, 'the document-level change listener must be wired');
            changeHandler({
                target: {
                    classList: { contains: (c) => c === 'bead-select-checkbox' },
                    getAttribute: (name) => (name === 'data-bead-id' ? id : null),
                    checked: true,
                    closest: () => null,
                },
            });
        },
        submit() {
            assert.ok(submitHandler, 'submit handler must be wired');
            submitHandler({ preventDefault() {} });
        },
    };
}

/** Lets any already-settled promise chains (fetch/.json() awaits) drain. */
function flushMicrotasks() {
    return new Promise((resolve) => setImmediate(resolve));
}

describe('launch-form-launch-failure-watch: the REAL extracted client script', () => {
    test('submit -> 201 (green) -> a launch-failed poll flips the line to red with the sprint id, reason, and a /sprints/<id>/log anchor; polling then stops', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        try {
            const sandbox = buildLaunchWatchSandbox({
                pollResponder: async () => ({
                    ok: true,
                    json: async () => ({
                        sprintId: 's-1', live: false, history: [],
                        latest: { event: 'launch-failed', reason: 'spawn ENOENT' },
                    }),
                }),
            });
            sandbox.selectIssue('apra-fleet-lfw.1');
            sandbox.submit();
            await flushMicrotasks();
            assert.equal(sandbox.resultEl.textContent, 'Launched sprint s-1.', 'the initial 201 success line renders first, in green');
            assert.equal(sandbox.resultEl.style.color, '#22c55e');

            // The form polls every 2s; the watchdog's own launch-failed
            // classification cadence is ~5s, so this window comfortably
            // observes at least one classification.
            t.mock.timers.tick(2000);
            await flushMicrotasks();

            assert.equal(sandbox.resultEl.style.color, '#ef4444', 'the line must flip to red on a launch-failed classification');
            assert.ok(sandbox.resultEl.textContent.includes('s-1'), sandbox.resultEl.textContent);
            assert.ok(sandbox.resultEl.textContent.includes('spawn ENOENT'), sandbox.resultEl.textContent);
            assert.equal(sandbox.resultEl.children.length, 1, 'a raw-log anchor must be appended');
            assert.ok(sandbox.resultEl.children[0].href.endsWith('/sprints/s-1/log'), sandbox.resultEl.children[0].href);
            assert.equal(sandbox.resultEl.children[0].textContent, 'Raw log');

            const pollsSoFar = sandbox.fetchCalls.filter((u) => u.indexOf('/api/sprints/s-1') !== -1).length;
            assert.equal(pollsSoFar, 1, 'exactly one poll before the failure was observed');

            // Polling must actually stop -- no further poll after another tick.
            t.mock.timers.tick(2000);
            await flushMicrotasks();
            assert.equal(sandbox.fetchCalls.filter((u) => u.indexOf('/api/sprints/s-1') !== -1).length, 1, 'no poll after a failure was already classified');
        } finally {
            t.mock.timers.reset();
        }
    });

    test('submit -> 201 followed by only live responses: the line stays green, and fetching stops by the end of the window', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        try {
            const sandbox = buildLaunchWatchSandbox({
                pollResponder: async () => ({ ok: true, json: async () => ({ sprintId: 's-1', live: true, state: {} }) }),
            });
            sandbox.selectIssue('apra-fleet-lfw.2');
            sandbox.submit();
            await flushMicrotasks();
            const successText = sandbox.resultEl.textContent;
            assert.equal(successText, 'Launched sprint s-1.');

            t.mock.timers.tick(2000);
            await flushMicrotasks();
            assert.equal(sandbox.resultEl.textContent, successText, 'the success line is untouched by a live classification');
            assert.equal(sandbox.resultEl.style.color, '#22c55e');
            assert.equal(sandbox.fetchCalls.filter((u) => u.indexOf('/api/sprints/s-1') !== -1).length, 1, 'polling stops the moment the run is confirmed live');

            // No further polling for the rest of the (30s) window, or beyond it.
            t.mock.timers.tick(30000);
            await flushMicrotasks();
            assert.equal(sandbox.fetchCalls.filter((u) => u.indexOf('/api/sprints/s-1') !== -1).length, 1, 'fetching must have stopped by the end of the window');
        } finally {
            t.mock.timers.reset();
        }
    });

    test('submit -> 201 followed by inconclusive responses for the whole window: the line is still the original success text, and fetching has stopped (bounded, no leak)', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        try {
            const sandbox = buildLaunchWatchSandbox({
                // Not .ok -- the client's own `(r && r.ok) ? r.json() : null`
                // guard yields null, so classifyLaunchWatch(null) -> unknown.
                pollResponder: async () => ({ ok: false, json: async () => ({}) }),
            });
            sandbox.selectIssue('apra-fleet-lfw.3');
            sandbox.submit();
            await flushMicrotasks();
            const successText = sandbox.resultEl.textContent;

            // 30s window / 2s interval = 15 ticks to close the window.
            for (let i = 0; i < 15; i += 1) {
                t.mock.timers.tick(2000);
                // eslint-disable-next-line no-await-in-loop
                await flushMicrotasks();
            }

            assert.equal(sandbox.resultEl.textContent, successText, 'an all-inconclusive window must never invent a failure');
            assert.equal(sandbox.resultEl.style.color, '#22c55e');
            assert.equal(sandbox.fetchCalls.filter((u) => u.indexOf('/api/sprints/s-1') !== -1).length, 15, 'exactly one poll per tick across the full window');

            // Bounded: nothing further once the window has closed.
            t.mock.timers.tick(10000);
            await flushMicrotasks();
            assert.equal(sandbox.fetchCalls.filter((u) => u.indexOf('/api/sprints/s-1') !== -1).length, 15, 'polling must stop once the window closes, never continue indefinitely');
        } finally {
            t.mock.timers.reset();
        }
    });

    test('a second submit cancels the first watch -- only one poll sequence is ever in flight', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        try {
            let callIndex = 0;
            const sandbox = buildLaunchWatchSandbox({
                launchSprintId: () => (callIndex++ === 0 ? 's-1' : 's-2'),
                pollResponder: async () => ({ ok: true, json: async () => ({ live: true, state: {} }) }),
            });
            sandbox.selectIssue('apra-fleet-lfw.4');
            sandbox.submit();
            await flushMicrotasks();
            assert.equal(sandbox.resultEl.textContent, 'Launched sprint s-1.');

            // A second launch before the first watch's own first tick fires.
            sandbox.selectIssue('apra-fleet-lfw.4b');
            sandbox.submit();
            await flushMicrotasks();
            assert.equal(sandbox.resultEl.textContent, 'Launched sprint s-2.');

            t.mock.timers.tick(2000);
            await flushMicrotasks();
            assert.equal(sandbox.fetchCalls.filter((u) => u.indexOf('/api/sprints/s-1') !== -1).length, 0, 'the superseded first watch must never poll');
            assert.equal(sandbox.fetchCalls.filter((u) => u.indexOf('/api/sprints/s-2') !== -1).length, 1, 'only the second (current) watch polls');

            t.mock.timers.tick(2000);
            await flushMicrotasks();
            assert.equal(sandbox.fetchCalls.filter((u) => u.indexOf('/api/sprints/s-1') !== -1).length, 0, 'still no poll from the cancelled first watch, going forward');
        } finally {
            t.mock.timers.reset();
        }
    });

    test('mount-prefix correctness: under a prefix, the polled URL and the raw-log href are both prefixed', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        try {
            const sandbox = buildLaunchWatchSandbox({
                mountPrefix: '/ext/se',
                pollResponder: async () => ({
                    ok: true,
                    json: async () => ({
                        sprintId: 's-1', live: false, history: [],
                        latest: { event: 'launch-failed', reason: 'spawn ENOENT' },
                    }),
                }),
            });
            sandbox.selectIssue('apra-fleet-lfw.5');
            sandbox.submit();
            await flushMicrotasks();
            // The launch POST itself is prefixed too (pre-existing i9ag.3.2
            // contract) -- asserted here only as sanity context, not this
            // test's own subject.
            assert.ok(sandbox.fetchCalls.includes('/ext/se/api/sprints'));

            t.mock.timers.tick(2000);
            await flushMicrotasks();

            const pollUrls = sandbox.fetchCalls.filter((u) => u.indexOf('/api/sprints/s-1') !== -1);
            assert.equal(pollUrls.length, 1);
            assert.equal(pollUrls[0], '/ext/se/api/sprints/s-1', 'the poll URL must carry the mount prefix');

            assert.equal(sandbox.resultEl.children.length, 1, 'a raw-log anchor must be appended');
            assert.equal(sandbox.resultEl.children[0].href, '/ext/se/sprints/s-1/log', 'the raw-log href must carry the mount prefix');
        } finally {
            t.mock.timers.reset();
        }
    });
});
