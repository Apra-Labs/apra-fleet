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
    renderFinishedRunsHtml,
    buildStatePayload,
} from '../src/supervisor/dashboard.mjs';
import { WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { computeSprintProgress } from '../fleet-sprint/sprint-progress.mjs';

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
 * apra-fleet-i9ag.15.6: evaluates the REAL extracted live-refresh script and
 * returns its embedded `renderFinishedRunsHtml`/`renderSprintSection`
 * bindings directly (rather than driving them indirectly through poll()'s
 * mocked /state response), so a test can invoke either renderer with a
 * payload hand-picked to hit every branch, and compare the result
 * byte-for-byte against the server-rendered module function for the SAME
 * input. If a renderer calls a helper that was not ALSO embedded above it in
 * sprintStackLiveScript() (apra-fleet-i9ag.16.2's regression: `renderFinished
 * RunsHtml` calling `launchFailedBadge` before that helper was embedded),
 * this throws a `ReferenceError` here, at the call site, in the SAME way it
 * would throw in a real browser.
 */
function extractLiveScriptRenderers() {
    const script = extractLiveRefreshScript();
    // eslint-disable-next-line no-new-func
    const fn = new Function(
        'document', 'fetch', 'EventSource',
        script + '\nreturn { renderFinishedRunsHtml: renderFinishedRunsHtml, renderSprintSection: renderSprintSection };'
    );
    const noopDocument = { getElementById: () => null };
    const noopFetch = async () => ({ json: async () => ({}) });
    return fn(noopDocument, noopFetch, undefined);
}

/**
 * apra-fleet-i9ag.15.6: strips JS comments, string literals, and regex
 * literals from `source`, replacing each with a same-length-irrelevant,
 * empty-content placeholder (a quote/space, never removed outright) so
 * brace/paren balance in the REMAINING real code is unaffected. This is a
 * small hand-rolled scanner rather than a naive `/'...'/`-style
 * string-stripping regex, because a naive stripper misparses a regex
 * literal that itself contains a quote character -- e.g. escapeHtml's own
 * `.replace(/'/g, '&#039;')`, embedded verbatim into the live script below
 * -- as the START of a string, and then silently misinterprets a large,
 * arbitrary span of unrelated downstream code as "inside a string".
 *
 * Regex-vs-division ambiguity is resolved with the standard heuristic: a
 * `/` can start a regex literal unless the last significant (non-space)
 * character emitted so far is an identifier character, digit, `)`, or `]`
 * -- i.e. unless a VALUE was just produced, in which case `/` is division.
 * Every actual regex literal in the helpers this guard inspects
 * (escapeHtml, prLink, sprintCardAnchorId) is preceded by an operator/
 * punctuator (`(`, `,`, `=`, `!`), never a value, so this heuristic resolves
 * all of them correctly.
 */
function stripJsNoise(source) {
    let out = '';
    let i = 0;
    const n = source.length;
    let lastSignificant = '';
    while (i < n) {
        const ch = source[i];
        if (ch === '/' && source[i + 1] === '/') {
            while (i < n && source[i] !== '\n') i++;
            continue;
        }
        if (ch === '/' && source[i + 1] === '*') {
            i += 2;
            while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
            i += 2;
            out += ' ';
            continue;
        }
        if (ch === '\'' || ch === '"' || ch === '`') {
            const quote = ch;
            i++;
            while (i < n && source[i] !== quote) {
                if (source[i] === '\\') i++;
                i++;
            }
            i++; // consume the closing quote
            out += quote + quote; // empty string of the SAME quote kind
            lastSignificant = ']'; // a string is a "value" -- next `/` is division
            continue;
        }
        if (ch === '/' && !/[)\]A-Za-z0-9_$]/.test(lastSignificant)) {
            let j = i + 1;
            let inClass = false;
            let closed = false;
            while (j < n) {
                if (source[j] === '\\') { j += 2; continue; }
                if (source[j] === '\n') break; // unterminated -- not actually a regex
                if (source[j] === '[') { inClass = true; j++; continue; }
                if (source[j] === ']') { inClass = false; j++; continue; }
                if (source[j] === '/' && !inClass) { j++; closed = true; break; }
                j++;
            }
            if (closed) {
                while (j < n && /[a-z]/i.test(source[j])) j++; // flags
                out += ' ';
                i = j;
                lastSignificant = ']'; // a regex literal is also a "value"
                continue;
            }
            // Fall through: treat this '/' as an ordinary character (division).
        }
        out += ch;
        if (!/\s/.test(ch)) lastSignificant = ch;
        i++;
    }
    return out;
}

/** JS keywords that can be immediately followed by `(` without being a call. */
const JS_CONTROL_KEYWORDS = new Set([
    'if', 'while', 'for', 'switch', 'catch', 'function', 'return', 'typeof',
    'new', 'in', 'of', 'instanceof', 'delete', 'void', 'yield', 'await',
    'else', 'do', 'try', 'finally', 'var', 'let', 'const', 'throw',
]);

/**
 * Bare global identifiers this repo does not (and never needs to) declare
 * inside the live-refresh script itself -- real JS/browser builtins a
 * `new Function('document', 'fetch', 'EventSource', script)` sandbox
 * legitimately exposes. Anything called bare (not as `foo.bar(...)`) that is
 * NOT in this set must be a name the script itself declares (a `function`
 * or `var`/`let`/`const`), or the call is a live ReferenceError waiting to
 * happen the moment a browser actually reaches it.
 */
const JS_BUILTIN_CALLEES = new Set([
    'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math',
    'encodeURIComponent', 'decodeURIComponent', 'parseInt', 'parseFloat',
    'isNaN', 'isFinite', 'Date', 'RegExp', 'Promise', 'Set', 'Map',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'fetch',
    'console', 'EventSource', 'Function',
]);

/**
 * Bare `identifier(` call sites in `source` (already run through
 * stripJsNoise()) -- excludes `.foo(...)` method calls (those resolve
 * through a receiver, never a free identifier lookup, so they can never be
 * the "helper wasn't embedded" defect this guard targets) and a `function
 * name(...)` declaration's own name (a definition, not a call to itself).
 */
function extractBareCallIdentifiers(source) {
    const withoutDecls = source.replace(/\bfunction\s+[A-Za-z_$][\w$]*\s*\(/g, 'function(');
    const ids = new Set();
    const re = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(withoutDecls))) {
        if (!JS_CONTROL_KEYWORDS.has(m[1])) ids.add(m[1]);
    }
    return ids;
}

/**
 * Every name `scriptText` (already run through stripJsNoise()) itself
 * declares: named `function` declarations, `var`/`let`/`const` bindings
 * (top-level OR inside any nested function -- this deliberately does NOT
 * try to reproduce real lexical scoping, just "is this name declared
 * SOMEWHERE in the emitted script text", matching this guard's stated
 * scope), and every named/anonymous function's own formal parameters.
 */
function extractDeclaredNames(scriptText) {
    const names = new Set();
    for (const m of scriptText.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
    for (const m of scriptText.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of scriptText.matchAll(/function\s*[A-Za-z_$]*\s*\(([^)]*)\)/g)) {
        m[1].split(',').map((p) => p.trim()).filter(Boolean).forEach((p) => {
            const name = p.split('=')[0].trim();
            if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
        });
    }
    return names;
}

/**
 * Every named top-level `function name(...) { ... }` declaration in
 * `scriptText` (already run through stripJsNoise(), so brace-depth counting
 * -- the only way to find a function's own closing brace -- is never thrown
 * off by a `{`/`}` inside a string or comment), each with its own full
 * source slice. Covers every `.toString()`-embedded renderer/helper
 * (escapeHtml, mountHref, ..., renderSprintSection) PLUS the script's own
 * renderSprintStackFromState/schedulePoll/poll -- this guard makes no
 * assumption about which names exist, so a NEW helper embedded here in the
 * future is automatically covered too, without editing this test.
 */
function extractTopLevelFunctionBlocks(scriptText) {
    const blocks = [];
    const declRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
    let m;
    while ((m = declRe.exec(scriptText))) {
        const braceStart = scriptText.indexOf('{', m.index);
        let depth = 0;
        let i = braceStart;
        for (; i < scriptText.length; i++) {
            if (scriptText[i] === '{') depth++;
            else if (scriptText[i] === '}') { depth--; if (depth === 0) break; }
        }
        blocks.push({ name: m[1], source: scriptText.slice(m.index, i + 1) });
    }
    return blocks;
}

/** The `#finished-sprints` element poll() replaces wholesale via .innerHTML -- see MockContainer's own innerHTML setter for the same shape, just without the Sprint Stack's per-section reconciliation. */
class MockFinishedContainer {
    constructor(initialHtml) {
        this.innerHTML = initialHtml ?? '';
    }
}

/**
 * Runs the actual SPRINT_STACK_LIVE_SCRIPT (renderSprintStackFromState() +
 * schedulePoll()/poll() + the EventSource/heartbeat wiring) against mocked
 * document/fetch/EventSource. `eventSourceCtor: undefined` simulates an
 * environment with no EventSource global (the `typeof EventSource !==
 * 'undefined'` guard in the real script then evaluates false).
 *
 * `finishedContainer` (apra-fleet-i9ag.16.2), when supplied, is returned for
 * `document.getElementById('finished-sprints')` -- poll()'s OTHER DOM target
 * alongside `#sprint-stack`, replaced wholesale via renderFinishedRunsHtml()'s
 * output. Omitted -> getElementById('finished-sprints') returns null, exactly
 * as it would on a page render with no finished-sprints element (poll()'s own
 * `if (finishedEl && ...)` guard skips that branch, matching every
 * pre-i9ag.16.2 test in this file that never touched it).
 */
function runLiveRefreshScript({ container, fetchImpl, eventSourceCtor, finishedContainer }) {
    const script = extractLiveRefreshScript();
    const mockDocument = {
        getElementById: (id) => {
            if (id === 'sprint-stack') return container;
            if (id === 'finished-sprints') return finishedContainer ?? null;
            return null;
        },
    };
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

describe('apra-fleet-siqi.4.2: Sprint Stack progress bar M/N updates in place from /state as beads close', () => {
    test('a bead closing between two /state polls updates the row\'s progress bar M/N in place (same section, no full page reload), sourced from the same computeSprintProgress() data that feeds /state', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        try {
            // Two beads in this sprint's scope, both open at first poll -- one
            // closes between the first and second poll, simulating real
            // engine progress (the thing apra-fleet-siqi.4's bug report says
            // the row never picked up without a full page reload).
            const beads = [
                { id: 'b1', status: 'open', parentId: null },
                { id: 'b2', status: 'open', parentId: null },
            ];
            const dashboard = createDashboard({
                ledger: fakeLedger([{ sprintId: 'sprint-1', members: [], issueRoots: ['b1'], childPid: 1 }]),
                watchdog: fakeWatchdog({ 'sprint-1': WATCHDOG_STATUS.RUNNING_HEALTHY }),
                expandScope: async () => new Set(['b1', 'b2']),
                // A fresh snapshot per call (mutated below) -- exactly like a
                // real `bd list --json` re-fetch would see the live bead
                // store's current state on each buildSprintViews() call.
                listAllBeads: async () => beads.map((b) => ({ ...b })),
                driftCheck: async () => null,
            });
            const supervisor = createSupervisor({ logger: { log() {}, error() {} } });
            registerDashboardRoutes(supervisor, dashboard);

            // The client's poll() always fetches through the real GET /state
            // route (not a canned payload) -- so both polls below reflect
            // whatever buildSprintViews()/computeSprintProgress() actually
            // compute server-side at that moment, the SAME data source /state
            // serves and the row bar reads from (acceptance criterion).
            const fetchCalls = [];
            const fetchImpl = async (url) => {
                fetchCalls.push(url);
                const httpRes = await request(supervisor, 'GET', url.split('?')[0]);
                return { json: async () => JSON.parse(httpRes.body) };
            };

            const container = new MockContainer(EMPTY_STATE_HTML);
            runLiveRefreshScript({ container, fetchImpl, eventSourceCtor: undefined });
            await flushMicrotasks();

            assert.equal(fetchCalls.length, 1, 'poll() fetches /state exactly once on load');
            assert.equal(container.children.length, 1, 'exactly one Sprint Stack row for the one running sprint');
            const rowBeforeClose = container.children[0];
            // Snapshot the markup NOW -- `rowBeforeClose` stays the SAME live
            // MockSection object across the second poll (that is exactly the
            // "updated in place" behavior under test), so its `.outerHTML`
            // getter would otherwise reflect the POST-close markup too by the
            // time we compare below.
            const initialRowHtml = rowBeforeClose.outerHTML;
            assert.ok(initialRowHtml.includes('Required: 0/2'), 'initial row bar reads 0/2, matching the two open beads in scope');

            // Sanity: /state's own payload right now agrees with a direct
            // computeSprintProgress() call over the SAME bead snapshot -- one
            // shared data source, not two independently-computed M/N values.
            const directProgressBefore = computeSprintProgress(beads);
            assert.equal(directProgressBefore.closed, 0);
            assert.equal(directProgressBefore.required, 2);

            // A real bead in this sprint's scope closes server-side, between
            // polls (e.g. the engine finished a task) -- nothing here touches
            // the client at all yet.
            beads[0].status = 'closed';
            const directProgressAfter = computeSprintProgress(beads);
            assert.equal(directProgressAfter.closed, 1);
            assert.equal(directProgressAfter.required, 2);

            // Drive the next poll the SAME way production does: the heartbeat
            // interval fires, schedulePoll() coalesces, then poll() re-fetches
            // /state and re-renders the row in place.
            const heartbeatMs = extractHeartbeatIntervalMs();
            t.mock.timers.tick(heartbeatMs);
            t.mock.timers.tick(400); // schedulePoll()'s own coalesce timer
            await flushMicrotasks();

            assert.equal(fetchCalls.length, 2, 'exactly one additional /state poll after the heartbeat interval elapses');
            assert.equal(container.children.length, 1, 'still exactly one row -- updated in place, not duplicated or removed/re-added');
            assert.equal(container.children[0], rowBeforeClose, 'the SAME row object is updated in place -- never a full container/page re-render that would replace it');

            const rowAfterClose = container.children[0];
            assert.ok(rowAfterClose.outerHTML.includes('Required: 1/2'), 'the row bar picks up the closed bead -- M/N now reads 1/2');
            assert.notEqual(rowAfterClose.outerHTML, initialRowHtml, 'the row markup actually changed to reflect the new M/N');

            // And the client-rendered row after the close is still
            // byte-identical to renderSprintSection() over the SAME view the
            // server computed for the second poll -- confirming the row bar
            // and /state never drift into two different M/N values.
            const secondHttpRes = await request(supervisor, 'GET', '/state');
            const secondPayload = JSON.parse(secondHttpRes.body);
            assert.equal(secondPayload.sprints[0].progress.closed, 1);
            assert.equal(secondPayload.sprints[0].progress.required, 2);
            assert.equal(rowAfterClose.outerHTML, renderSprintSection(secondPayload.sprints[0]));
        } finally {
            t.mock.timers.reset();
        }
    });
});

describe('apra-fleet-i9ag.16.2: a launch-failed row in a /state poll re-renders through the REAL extracted client script, not just the imported module binding', () => {
    test('poll() feeds a launch-failed finished row through the shipped script\'s embedded renderFinishedRunsHtml()/launchFailedBadge() and produces the SAME markup the server-rendered first paint would', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        try {
            const finishedRow = {
                sprintId: 'sprint-dead',
                verdict: null,
                prUrl: null,
                endedAt: '2026-09-28T00:00:00.000Z',
                goal: null,
                status: 'launch-failed',
                reason: 'spawn ENOENT',
                hasTerminalState: false,
            };
            const httpPayload = buildStatePayload([], [finishedRow]);

            const container = new MockContainer(EMPTY_STATE_HTML);
            const finishedContainer = new MockFinishedContainer('<p>placeholder</p>');
            const fetchImpl = async () => ({ json: async () => httpPayload });

            // This is the exact reproduction of the reviewed regression: before
            // the fix, executing the shipped script threw "launchFailedBadge is
            // not defined" inside its embedded renderFinishedRunsHtml() call,
            // which poll()'s try/catch swallows -- leaving finishedContainer's
            // innerHTML at its stale placeholder forever. If this throws (or the
            // assertion below fails), the live-refresh path is broken again.
            runLiveRefreshScript({ container, fetchImpl, eventSourceCtor: undefined, finishedContainer });
            await flushMicrotasks();

            assert.notEqual(finishedContainer.innerHTML, '<p>placeholder</p>', 'poll() must actually replace the Finished Sprints markup, not silently swallow a render error');
            assert.equal(
                finishedContainer.innerHTML,
                renderFinishedRunsHtml(httpPayload.finished, ''),
                'the live-refreshed Finished Sprints markup for a launch-failed row must be byte-identical to the server-rendered first paint'
            );
            assert.ok(finishedContainer.innerHTML.includes('LAUNCH FAILED'), 'the re-rendered row must carry the launch-failed badge text');
            assert.ok(finishedContainer.innerHTML.includes('spawn ENOENT'), 'the re-rendered row must carry the escaped reason text');
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

describe('apra-fleet-i9ag.15.6: every helper called by a toString-embedded dashboard renderer is itself embedded in the live script', () => {
    test('the embedded renderFinishedRunsHtml renders BOTH a file-backed row and a launch-failed row byte-identically to the server-rendered module function -- proves launchFailedBadge() (and every other helper renderFinishedRunsHtml calls) is actually embedded, not merely referenced by name', (t) => {
        // extractLiveScriptRenderers() runs the WHOLE script (it is the only
        // way to get real, correctly-scoped bindings for its embedded
        // functions), which unconditionally starts a real setInterval()
        // heartbeat and fires poll() on load -- mock the timer APIs so that
        // interval is never a real OS timer left running after this test
        // (same discipline every other test in this file already follows).
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        try {
            const runs = [
                {
                    sprintId: 'sprint-ok', verdict: 'merged', prUrl: 'https://example.com/pr/1',
                    endedAt: '2026-09-28T00:00:00.000Z', goal: 'ship the thing', status: 'finished',
                    hasTerminalState: true,
                },
                {
                    sprintId: 'sprint-dead', verdict: null, prUrl: null,
                    endedAt: '2026-09-28T01:00:00.000Z', goal: null, status: 'launch-failed',
                    reason: 'spawn ENOENT', hasTerminalState: false,
                },
            ];
            const { renderFinishedRunsHtml: liveRenderFinishedRunsHtml } = extractLiveScriptRenderers();

            let liveHtml;
            assert.doesNotThrow(
                () => { liveHtml = liveRenderFinishedRunsHtml(runs, ''); },
                'the embedded renderFinishedRunsHtml must not throw a ReferenceError for any helper it calls (e.g. launchFailedBadge)'
            );
            assert.equal(
                liveHtml,
                renderFinishedRunsHtml(runs, ''),
                'the embedded renderFinishedRunsHtml must be byte-identical to the server-rendered module function for the SAME input, covering both the file-backed and launch-failed branches'
            );
        } finally {
            t.mock.timers.reset();
        }
    });

    test('the embedded renderSprintSection renders a live row (outcome badge, members, pause/resume, base-drift, beads prefix) byte-identically to the server-rendered module function', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        try {
            const view = {
                sprintId: 'sprint-1', branch: 'feat/x', base: 'v0.5_dashboard', goal: 'ship it',
                status: WATCHDOG_STATUS.PAUSED, issueRoots: ['r1', 'r2'], beadCount: 5,
                progress: { closed: 1, required: 2, fraction: 0.5 },
                members: [{ name: 'alice', role: 'doer' }, { name: 'bob' }],
                verdict: 'merged', prUrl: 'https://example.com/pr/2',
                baseDrift: 3, beadsPrefix: 'apra-fleet',
            };
            const { renderSprintSection: liveRenderSprintSection } = extractLiveScriptRenderers();

            let liveHtml;
            assert.doesNotThrow(
                () => { liveHtml = liveRenderSprintSection(view, ''); },
                'the embedded renderSprintSection must not throw a ReferenceError for any helper it calls'
            );
            assert.equal(
                liveHtml,
                renderSprintSection(view, ''),
                'the embedded renderSprintSection must be byte-identical to the server-rendered module function for the SAME live-row input'
            );
        } finally {
            t.mock.timers.reset();
        }
    });

    test('every bare identifier CALLED inside each embedded top-level helper is either a JS builtin or itself declared somewhere in the emitted script -- a generic guard that fails the moment a renderer gains a helper call without that helper being embedded too', () => {
        const script = stripJsNoise(extractLiveRefreshScript());
        const declaredNames = extractDeclaredNames(script);
        const blocks = extractTopLevelFunctionBlocks(script);
        // Sanity on the guard itself: if this ever drops to a handful of
        // blocks, extractTopLevelFunctionBlocks()'s brace-matching broke
        // silently and the checks below would pass vacuously.
        assert.ok(blocks.length >= 10, `sanity: expected the live-refresh script to embed many named top-level helper functions, found ${blocks.length}`);

        const missing = [];
        for (const { name, source } of blocks) {
            for (const calleeId of extractBareCallIdentifiers(source)) {
                if (JS_BUILTIN_CALLEES.has(calleeId)) continue;
                if (declaredNames.has(calleeId)) continue;
                missing.push(`${name}() calls "${calleeId}(...)" but "${calleeId}" is neither a JS builtin nor declared anywhere in the emitted live-refresh script`);
            }
        }
        assert.deepEqual(missing, [], missing.join('\n'));
    });
});
