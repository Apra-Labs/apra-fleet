// apra-fleet-siqi.1.3: coverage for the supervisor dashboard's live-refresh
// loop apra-fleet-siqi.1.1 (GET /state + GET /events) and apra-fleet-siqi.1.2
// (the client wiring, SPRINT_STACK_LIVE_SCRIPT in dashboard.mjs) landed.
//
// There is no jsdom/browser dependency in this repo -- same technique as
// apra-fleet-workflow/test/viewer-heartbeat-quiet-period-dom.test.mjs and
// apra-fleet-se/test/4yr-stop-modal.test.mjs: extract the ACTUAL client
// script verbatim out of renderIndexPageHtml()'s emitted HTML and execute it
// against mocked EventSource/fetch/document + node:test's virtual clock,
// rather than reimplementing the poll/render logic here (which would drift
// out of sync with the real client code and stop catching regressions).
//
// The "document" mock below is a minimal, hand-rolled DOM stub (getElementById
// -> a single #sprint-stack container supporting querySelectorAll('section
// [data-sprint-id]'), querySelector('p'), insertAdjacentHTML('beforeend', ..),
// and per-section outerHTML get/set + remove()) -- just enough surface for
// renderSprintStackFromState() (dashboard.mjs), never a general-purpose DOM.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    createDashboard,
    registerDashboardRoutes,
    renderIndexPageHtml,
    renderSprintSection,
    buildStatePayload,
} from '../src/supervisor/dashboard.mjs';
import { WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';

/** Minimal in-memory ledger exposing only list(). */
function fakeLedger(entries) {
    return { list: () => entries.map((e) => ({ ...e })) };
}

/** Watchdog stub returning a fixed status per sprintId. */
function fakeWatchdog(statusBySprintId) {
    return {
        classifySprint: async (entry) => ({ status: statusBySprintId[entry.sprintId] ?? WATCHDOG_STATUS.CRASHED }),
    };
}

// Same request() helper as supervisor-dashboard.test.mjs's own registerDashboardRoutes
// describe block, duplicated here so this file can exercise the real HTTP
// route layer (GET /state) independently.
function request(supervisor, method, path) {
    return new Promise((resolve, reject) => {
        const req = { method, url: path, on() {} };
        const chunks = [];
        const res = {
            headers: null,
            statusCode: null,
            headersSent: false,
            writeHead(status, headers) {
                this.statusCode = status;
                this.headers = headers;
                this.headersSent = true;
            },
            write(chunk) { chunks.push(chunk); },
            end(chunk) {
                if (chunk) chunks.push(chunk);
                resolve({ statusCode: this.statusCode, headers: this.headers, body: Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString('utf-8') });
            },
        };
        Promise.resolve(supervisor.handleRequest(req, res)).catch(reject);
    });
}

/** A single Sprint Stack `<section data-sprint-id>` row, as the client would hold it. */
class MockSection {
    constructor(container, html) {
        this._container = container;
        this._setHtml(html);
    }
    _setHtml(html) {
        this._html = html;
        const m = /data-sprint-id="([^"]*)"/.exec(html);
        this._sprintId = m ? m[1] : null;
    }
    getAttribute(name) {
        return name === 'data-sprint-id' ? this._sprintId : null;
    }
    get outerHTML() { return this._html; }
    set outerHTML(html) { this._setHtml(html); }
    remove() {
        const idx = this._container.children.indexOf(this);
        if (idx !== -1) this._container.children.splice(idx, 1);
    }
}

/** The `#sprint-stack` container element renderSprintStackFromState() targets. */
class MockContainer {
    constructor(initialHtml) {
        this._innerHTML = initialHtml ?? '';
        this.children = [];
    }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(html) {
        this._innerHTML = html;
        this.children = [];
    }
    querySelectorAll(selector) {
        if (selector === 'section[data-sprint-id]') return this.children.slice();
        throw new Error(`unsupported selector: ${selector}`);
    }
    querySelector(selector) {
        if (selector === 'p') {
            return this.children.length === 0 && /<p[\s>]/.test(this._innerHTML) ? {} : null;
        }
        throw new Error(`unsupported selector: ${selector}`);
    }
    insertAdjacentHTML(position, html) {
        if (position !== 'beforeend') throw new Error(`unsupported position: ${position}`);
        this.children.push(new MockSection(this, html));
    }
}

const EMPTY_STATE_HTML = '<p style="color:#71717a; font-style: italic;">No sprints are currently running.</p>';

/**
 * Extracts the ACTUAL SPRINT_STACK_LIVE_SCRIPT verbatim out of
 * renderIndexPageHtml()'s emitted HTML: from its first embedded helper
 * (`function escapeHtml(`) through the closing `</script>` tag -- this is the
 * LAST `<script>` block the page emits (dashboard.mjs registers it last), so
 * this captures the whole live-refresh loop including its unconditional
 * `poll();` call on load.
 */
function extractLiveRefreshScript() {
    const html = renderIndexPageHtml([]);
    const start = html.indexOf('function escapeHtml(');
    assert.ok(start !== -1, 'renderIndexPageHtml() must embed the live-refresh client script');
    const end = html.indexOf('</script>', start);
    assert.ok(end !== -1, 'must find the end of the live-refresh script block');
    return html.slice(start, end);
}

/** Pulls HEARTBEAT_INTERVAL_MS's actual configured value out of the script. */
function extractHeartbeatIntervalMs() {
    const script = extractLiveRefreshScript();
    const m = script.match(/var HEARTBEAT_INTERVAL_MS = (\d+);/);
    assert.ok(m, 'live-refresh script must define HEARTBEAT_INTERVAL_MS');
    return Number(m[1]);
}

/**
 * Runs the actual SPRINT_STACK_LIVE_SCRIPT (renderSprintStackFromState() +
 * schedulePoll()/poll() + the EventSource/heartbeat wiring) against mocked
 * document/fetch/EventSource. `eventSourceCtor: undefined` simulates an
 * environment with no EventSource global (the `typeof EventSource !==
 * 'undefined'` guard in the real script then evaluates false).
 */
function runLiveRefreshScript({ container, fetchImpl, eventSourceCtor }) {
    const script = extractLiveRefreshScript();
    const mockDocument = { getElementById: (id) => (id === 'sprint-stack' ? container : null) };
    // eslint-disable-next-line no-new-func
    const fn = new Function('document', 'fetch', 'EventSource', script);
    fn(mockDocument, fetchImpl, eventSourceCtor);
}

/** Lets any already-settled promise chains (e.g. poll()'s fetch/.json() awaits) drain. */
function flushMicrotasks() {
    return new Promise((resolve) => setImmediate(resolve));
}

describe('apra-fleet-siqi.1.3: GET /state serves the payload that drives the Sprint Stack client render', () => {
    test('the JSON GET /state actually returns is the SAME data buildStatePayload()/the client poll() consume -- one shared data path, not a second computation', async (t) => {
        // The live-refresh script unconditionally sets up a real setInterval()
        // heartbeat on load -- mock the timer APIs here too (even though this
        // test never ticks them) so that interval is never a REAL OS timer left
        // running after the test finishes (it would otherwise keep the process
        // alive / leak across tests).
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        try {
            const dashboard = createDashboard({
                ledger: fakeLedger([{ sprintId: 'sprint-1', members: ['alice'], issueRoots: ['r1'], childPid: 1 }]),
                watchdog: fakeWatchdog({ 'sprint-1': WATCHDOG_STATUS.RUNNING_HEALTHY }),
                expandScope: async () => new Set(['r1']),
                listAllBeads: async () => [],
                driftCheck: async () => null,
            });
            const supervisor = createSupervisor({ logger: { log() {}, error() {} } });
            registerDashboardRoutes(supervisor, dashboard);

            const httpRes = await request(supervisor, 'GET', '/state');
            assert.equal(httpRes.statusCode, 200);
            const httpPayload = JSON.parse(httpRes.body);

            // The SAME shape buildStatePayload() produces off buildSprintViews() --
            // GET /state is just that function serialized, never a second
            // "what does the dashboard currently look like" computation.
            const directPayload = buildStatePayload(await dashboard.buildSprintViews());
            assert.deepEqual(
                httpPayload.sprints,
                directPayload.sprints,
                'GET /state must serve exactly buildStatePayload(buildSprintViews()) -- the same data the client renders from'
            );

            // Now feed that EXACT payload through the real client script's poll()
            // path and confirm it drives the Sprint Stack row's DOM render.
            const container = new MockContainer(EMPTY_STATE_HTML);
            const fetchCalls = [];
            const fetchImpl = async (url) => {
                fetchCalls.push(url);
                return { json: async () => httpPayload };
            };
            runLiveRefreshScript({ container, fetchImpl, eventSourceCtor: undefined });
            await flushMicrotasks();

            assert.equal(fetchCalls.length, 1, 'poll() fetches /state exactly once on load');
            assert.match(fetchCalls[0], /^\/state\?_t=\d+$/);
            assert.equal(container.children.length, 1, 'the /state payload must produce exactly one Sprint Stack row');
            assert.equal(container.children[0].getAttribute('data-sprint-id'), 'sprint-1');
            // The client-rendered row is byte-identical to renderSprintSection() --
            // the SAME function GET / uses server-side for the initial render, so a
            // live-refreshed row can never visually drift from a freshly-loaded one.
            assert.equal(container.children[0].outerHTML, renderSprintSection(httpPayload.sprints[0]));
        } finally {
            t.mock.timers.reset();
        }
    });
});

describe('apra-fleet-siqi.1.3: /events change signal schedules a poll that re-renders Sprint Stack rows from /state', () => {
    test('a server state change followed by an /events message re-fetches /state (after the debounce) and updates the row in place', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        try {
            const container = new MockContainer(EMPTY_STATE_HTML);
            let currentView = {
                sprintId: 'sprint-1', branch: 'feat/x', goal: null,
                status: WATCHDOG_STATUS.RUNNING_HEALTHY, issueRoots: [], beadCount: 0,
                progress: null, members: [], base: null, baseDrift: null,
            };
            const fetchCalls = [];
            const fetchImpl = async (url) => {
                fetchCalls.push(url);
                return { json: async () => buildStatePayload([currentView]) };
            };
            let capturedSource = null;
            function MockEventSource(url) {
                this.url = url;
                this.onmessage = null;
                capturedSource = this;
            }

            runLiveRefreshScript({ container, fetchImpl, eventSourceCtor: MockEventSource });
            // Drain the unconditional initial poll() the script fires on load.
            await flushMicrotasks();
            assert.equal(fetchCalls.length, 1);
            assert.equal(container.children.length, 1);
            const initialRowHtml = container.children[0].outerHTML;
            assert.ok(initialRowHtml.includes(WATCHDOG_STATUS.RUNNING_HEALTHY));

            assert.ok(capturedSource, 'EventSource(\'/events\') must have been constructed');
            assert.equal(capturedSource.url, '/events');
            assert.equal(typeof capturedSource.onmessage, 'function', 'onmessage must be wired to schedule a poll');

            // A real server-side state change (e.g. the watchdog reclassified
            // this sprint), THEN the dashboard's GET /events relays its generic
            // change signal for it.
            currentView = { ...currentView, status: WATCHDOG_STATUS.PAUSED };
            capturedSource.onmessage({ data: JSON.stringify({ type: 'update' }) });

            assert.equal(fetchCalls.length, 1, 'the SSE message must coalesce (debounced), not poll synchronously');
            t.mock.timers.tick(400);
            await flushMicrotasks();

            assert.equal(fetchCalls.length, 2, 'exactly one additional poll after the debounce window elapses');
            assert.equal(container.children.length, 1, 'the existing row is updated in place, not duplicated');
            const updatedRowHtml = container.children[0].outerHTML;
            assert.notEqual(updatedRowHtml, initialRowHtml, 'the row must re-render to reflect the server-side state change');
            assert.ok(updatedRowHtml.includes(WATCHDOG_STATUS.PAUSED), 'the re-rendered row must reflect the new status');
        } finally {
            t.mock.timers.reset();
        }
    });

    test('an EventSource message landing while the heartbeat also fires does not double-poll (one shared schedulePoll()/poll() path, not two independent pollers)', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        try {
            const container = new MockContainer(EMPTY_STATE_HTML);
            const view = {
                sprintId: 'sprint-1', branch: null, goal: null,
                status: WATCHDOG_STATUS.RUNNING_HEALTHY, issueRoots: [], beadCount: 0,
                progress: null, members: [], base: null, baseDrift: null,
            };
            const fetchCalls = [];
            const fetchImpl = async (url) => {
                fetchCalls.push(url);
                return { json: async () => buildStatePayload([view]) };
            };
            let capturedSource = null;
            function MockEventSource(url) { this.url = url; this.onmessage = null; capturedSource = this; }

            runLiveRefreshScript({ container, fetchImpl, eventSourceCtor: MockEventSource });
            await flushMicrotasks();
            assert.equal(fetchCalls.length, 1);

            const heartbeatMs = extractHeartbeatIntervalMs();

            // Just before the heartbeat fires, a real SSE message lands --
            // schedulePoll() sets its debounce timer (pending).
            t.mock.timers.tick(heartbeatMs - 100);
            capturedSource.onmessage({ data: JSON.stringify({ type: 'update' }) });
            assert.equal(fetchCalls.length, 1, 'still coalescing -- no poll yet');

            // The heartbeat's own setInterval now fires WHILE that event-driven
            // poll is still pending; it calls schedulePoll() too, but the
            // pending-timer guard must no-op, not schedule a second, concurrent
            // poll.
            t.mock.timers.tick(100);
            assert.equal(fetchCalls.length, 1, 'the heartbeat landing on top of a pending debounce must not add a second poll');

            // The original debounce timer resolves: exactly ONE additional poll.
            t.mock.timers.tick(300);
            await flushMicrotasks();
            assert.equal(fetchCalls.length, 2, 'exactly one poll -- the heartbeat must not cause a duplicate concurrent poll');
        } finally {
            t.mock.timers.reset();
        }
    });
});

describe('apra-fleet-siqi.1.3: EventSource unavailable degrades to the heartbeat-interval poll', () => {
    test('with no EventSource global, schedulePoll()/poll() is still driven by the heartbeat interval alone (never goes silently stale)', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        try {
            const container = new MockContainer(EMPTY_STATE_HTML);
            const view = {
                sprintId: 'sprint-1', branch: null, goal: null,
                status: WATCHDOG_STATUS.RUNNING_HEALTHY, issueRoots: [], beadCount: 0,
                progress: null, members: [], base: null, baseDrift: null,
            };
            const fetchCalls = [];
            const fetchImpl = async (url) => {
                fetchCalls.push(url);
                return { json: async () => buildStatePayload([view]) };
            };

            const heartbeatMs = extractHeartbeatIntervalMs();
            assert.ok(heartbeatMs >= 5000 && heartbeatMs <= 10000, `HEARTBEAT_INTERVAL_MS (${heartbeatMs}) should be a several-second cadence`);

            // eventSourceCtor: undefined -- `typeof EventSource !== 'undefined'`
            // evaluates false inside the real script, exactly as it would in a
            // browser/environment lacking EventSource entirely.
            runLiveRefreshScript({ container, fetchImpl, eventSourceCtor: undefined });
            await flushMicrotasks();
            assert.equal(fetchCalls.length, 1, 'the unconditional initial poll() still fires even with EventSource unavailable');
            assert.equal(container.children.length, 1);

            // No SSE messages are possible in this environment -- only the
            // heartbeat can drive any further poll.
            t.mock.timers.tick(heartbeatMs - 1);
            assert.equal(fetchCalls.length, 1, 'no poll before the heartbeat interval elapses');

            t.mock.timers.tick(1);
            t.mock.timers.tick(400); // schedulePoll()'s own coalesce timer
            await flushMicrotasks();
            assert.equal(fetchCalls.length, 2, 'the heartbeat interval alone must still trigger poll() with EventSource unavailable');

            // And it keeps recurring, not a one-shot fallback.
            t.mock.timers.tick(heartbeatMs);
            t.mock.timers.tick(400);
            await flushMicrotasks();
            assert.equal(fetchCalls.length, 3, 'the heartbeat fallback must keep firing on every subsequent interval');
        } finally {
            t.mock.timers.reset();
        }
    });
});
