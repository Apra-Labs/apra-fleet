import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { FleetWorkflow } from '../src/workflow/index.mjs';
import { createDashboardViewer, HTML_TEMPLATE } from '../src/viewer/index.mjs';
import { escapeHtml } from '../src/viewer/html-utils.mjs';
import { buildListStatePayload, resolveStringRefs } from '../src/viewer/lean-state.mjs';

// (apra-fleet-p2to.2.1) Tests for the generic viewer Pause/Resume UX: the
// POST /pause and /resume routes, the workflow.on('pause:requested'|
// 'paused'|'resumed') -> state.pause wiring, that state.pause survives GET
// /state's lean-state projection (buildListStatePayload/dedupeStrings), and
// the client-side Pause/Resume button + "paused since" banner state
// machine. Addresses the review gap noted on the prior round: the routes
// and DOM wiring existed but had zero test coverage.

// File-wide cwd guard: the /pause and /resume handlers call
// debouncedWriter.flushSync() (same as /stop, see
// apra-fleet-workflow-viewer-lifecycle.test.mjs), which persists to
// workflow-logs/ under process.cwd() by default. Run every test in this
// file against a fresh temp cwd so nothing is written into the real repo
// checkout.
let __cwdGuardOriginal;
let __cwdGuardTemp;
beforeEach(() => {
    __cwdGuardTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-viewer-pause-test-cwd-'));
    __cwdGuardOriginal = process.cwd();
    process.chdir(__cwdGuardTemp);
});
afterEach(() => {
    process.chdir(__cwdGuardOriginal);
    fs.rmSync(__cwdGuardTemp, { recursive: true, force: true });
});

const KNOWN_MEMBERS = new Set(['fleet-dev']);

/**
 * A mock fleetApi whose executePrompt()/executeCommand() block on a gate the
 * test controls, so a dispatch can be held "in flight" deterministically --
 * same helper as apra-fleet-workflow-pause-resume.test.mjs (the engine-level
 * pause tests), reused here to drive the viewer's 'pause:requested' ->
 * 'paused' transition through a real drain rather than an idle no-op.
 */
function createGatedFleetApi() {
    let releaseFn;
    let gate = new Promise((resolve) => { releaseFn = resolve; });
    return {
        release() { releaseFn(); },
        async executePrompt(payload) {
            await gate;
            const memberKey = payload.member_name || payload.member_id;
            if (!KNOWN_MEMBERS.has(memberKey)) {
                return { content: [{ text: `Member "${memberKey}" not found.` }] };
            }
            return {
                content: [{ text: `echo: ${payload.prompt}` }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
            };
        },
        async executeCommand(payload) {
            await gate;
            return { content: [{ text: payload.command }], isError: false };
        }
    };
}

function httpGet(port, urlPath) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

function httpPost(port, urlPath) {
    return new Promise((resolve, reject) => {
        const req = http.request(`http://127.0.0.1:${port}${urlPath}`, { method: 'POST' }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.end();
    });
}

// Fetches GET /state and undoes dedupeStrings()'s `{ $ref }` substitution
// (via the same resolveStringRefs() the real client embeds), so assertions
// below compare against actual field values rather than tripping over the
// dedup table whenever two fields happen to carry an identical string (e.g.
// two timestamps minted in the same millisecond during a fast test run).
async function getState(port) {
    const payload = JSON.parse(await httpGet(port, '/state'));
    return resolveStringRefs(payload, payload._strings || []);
}

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('waitFor() timed out');
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

async function withServer(server, fn) {
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    try {
        return await fn(server.address().port);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

describe('apra-fleet-p2to.2.1: POST /pause and /resume routes + state.pause wiring', () => {
    test('GET /state starts with pause.status "none"', async () => {
        const wf = new FleetWorkflow(createGatedFleetApi());
        const server = createDashboardViewer(wf, { port: 0, name: 'Pause Wiring Test' });
        await withServer(server, async (port) => {
            const state = await getState(port);
            assert.ok(state.pause, 'GET /state must always carry a pause field');
            assert.strictEqual(state.pause.status, 'none');
            assert.strictEqual(state.pause.reason, null);
            assert.strictEqual(state.pause.since, null);
        });
    });

    test('POST /pause forwards to workflow.requestPause(); state.pause goes none -> pausing while an activity is in flight, then -> paused only once it drains, carrying reason/phase/group; POST /resume forwards to requestResume() and clears it back to none', async () => {
        const api = createGatedFleetApi();
        const wf = new FleetWorkflow(api);
        wf.phase('build');
        wf.group('groupA');

        const server = createDashboardViewer(wf, { port: 0, name: 'Pause Wiring Test' });
        await withServer(server, async (port) => {
            // Hold an activity in flight so the pause is genuinely deferred,
            // not an idle no-op.
            const inflight = wf.agent('hello', { member_name: 'fleet-dev' });
            await nextTick();
            assert.strictEqual(wf._inFlight, 1, 'dispatch should be in flight before pausing');

            const { statusCode } = await httpPost(port, '/pause');
            assert.strictEqual(statusCode, 200);
            assert.strictEqual(wf._pauseRequested, true, '/pause must call the real workflow.requestPause(), not just flip viewer-local state');

            const pausing = await getState(port);
            assert.strictEqual(pausing.pause.status, 'pausing', "'paused' must not fire while an activity is still in flight");
            assert.strictEqual(pausing.pause.reason, 'Pause requested via dashboard /pause endpoint');
            assert.strictEqual(pausing.pause.phase, 'build');
            assert.strictEqual(pausing.pause.group, 'groupA');
            assert.strictEqual(pausing.pause.since, null, 'since is only stamped once the pause actually engages');

            // Drain the in-flight activity: the deferred pause now engages.
            api.release();
            await inflight;

            await waitFor(() => wf._paused === true);
            const paused = await getState(port);
            assert.strictEqual(paused.pause.status, 'paused');
            assert.strictEqual(paused.pause.reason, 'Pause requested via dashboard /pause endpoint', 'reason set at pause:requested must survive through to the paused state');
            assert.strictEqual(paused.pause.phase, 'build');
            assert.strictEqual(paused.pause.group, 'groupA');
            assert.strictEqual(typeof paused.pause.since, 'string', 'since must be stamped once the pause actually engages');
            assert.ok(!Number.isNaN(Date.parse(paused.pause.since)), 'since must be a parseable timestamp');

            const { statusCode: resumeStatus } = await httpPost(port, '/resume');
            assert.strictEqual(resumeStatus, 200);
            assert.strictEqual(wf._paused, false, '/resume must call the real workflow.requestResume()');

            const resumed = await getState(port);
            assert.deepStrictEqual(resumed.pause, { status: 'none', reason: null, since: null, phase: null, group: null });
        });
    });

    test('POST /pause while idle (nothing in flight) engages the pause immediately', async () => {
        const wf = new FleetWorkflow(createGatedFleetApi());
        const server = createDashboardViewer(wf, { port: 0, name: 'Pause Idle Test' });
        await withServer(server, async (port) => {
            const { statusCode } = await httpPost(port, '/pause');
            assert.strictEqual(statusCode, 200);
            const state = await getState(port);
            assert.strictEqual(state.pause.status, 'paused', 'an idle workflow has zero in-flight activities, so the pause engages right away');
        });
    });

    test('POST /resume is a no-op (200, no crash) when nothing is paused or pause-requested', async () => {
        const wf = new FleetWorkflow(createGatedFleetApi());
        const server = createDashboardViewer(wf, { port: 0, name: 'Resume No-op Test' });
        await withServer(server, async (port) => {
            const { statusCode } = await httpPost(port, '/resume');
            assert.strictEqual(statusCode, 200);
            const state = await getState(port);
            assert.strictEqual(state.pause.status, 'none');
        });
    });
});

describe('apra-fleet-p2to.2.1: state.pause survives the GET /state lean-state projection', () => {
    test('buildListStatePayload() (leanifyState + dedupeStrings) passes pause fields through unchanged when not duplicated elsewhere', () => {
        const state = {
            tree: [],
            extensions: {},
            pause: { status: 'paused', reason: 'manual pause for maintenance', since: '2026-08-11T05:00:00.000Z', phase: 'build', group: 'groupA' }
        };
        const payload = buildListStatePayload(state);
        assert.deepStrictEqual(payload.pause, state.pause, 'pause is a plain small object with no heavy fields -- must round-trip verbatim');
    });

    test('a pause.reason that happens to duplicate another long string elsewhere in state is deduped like any other string, and resolves back to the original via resolveStringRefs()', () => {
        const repeated = 'this exact reason text is long enough to trip the dedup threshold';
        const state = {
            tree: [{ type: 'log', msg: repeated }],
            extensions: {},
            pause: { status: 'paused', reason: repeated, since: '2026-08-11T05:00:00.000Z', phase: null, group: null }
        };
        const payload = buildListStatePayload(state);
        assert.deepStrictEqual(payload.pause.reason, { $ref: 0 }, 'a 2+-occurrence long string must be deduped even when it lives under pause.reason');
        assert.strictEqual(resolveStringRefs(payload.pause, payload._strings).reason, repeated, 'resolveStringRefs must recover the original reason text');
    });
});

describe('apra-fleet-p2to.2.1: Pause/Resume buttons render beside Save/Stop, generically', () => {
    test('the live view renders Pause beside Save and Stop, and a hidden paused-since banner; the history view (a finished run) renders neither', () => {
        const live = HTML_TEMPLATE([]);
        assert.ok(live.includes('class="btn btn-save"'));
        assert.ok(live.includes('id="btn-pause"'));
        assert.ok(live.includes('id="pause-banner"'));
        assert.ok(live.includes('class="btn btn-stop"'));

        const saveClassIdx = live.indexOf('class="btn btn-save"');
        const pauseBtnIdx = live.indexOf('id="btn-pause"');
        const stopClassIdx = live.indexOf('class="btn btn-stop"');
        assert.ok(saveClassIdx < pauseBtnIdx && pauseBtnIdx < stopClassIdx, 'Pause must render between Save and Stop');

        const history = HTML_TEMPLATE([], { history: true, state: { status: 'success' } });
        assert.ok(!history.includes('id="btn-pause"'), 'a finished run (History view) has no live workflow to pause');
        assert.ok(!history.includes('id="pause-banner"'));
        assert.ok(!history.includes('class="btn btn-save"'));
        assert.ok(!history.includes('class="btn btn-stop"'));
    });

    test('the template is workflow-agnostic: rendering with zero dashboard extensions still emits the Pause/Resume controls (no fleet-sprint-specific coupling)', () => {
        const html = HTML_TEMPLATE([]);
        assert.ok(html.includes('id="btn-pause"'));
        assert.ok(html.includes('id="pause-banner"'));
        assert.ok(!/fleet-sprint/i.test(html), 'the generic viewer template must not reference any specific workflow script');
    });
});

describe('apra-fleet-p2to.2.1: client-side Pause/Resume button + banner state machine (extracted from HTML_TEMPLATE)', () => {
    // Same technique as viewer-phase-duration-dom.test.mjs / viewer-running-
    // elapsed-dom.test.mjs: there is no jsdom/browser dependency in this repo,
    // so this extracts the ACTUAL renderState() pause-button/banner block
    // verbatim out of HTML_TEMPLATE()'s emitted client script (rather than
    // reimplementing the logic here, which would drift out of sync with the
    // real render code and stop catching regressions).
    function extractPauseRenderBlock() {
        const html = HTML_TEMPLATE([]);
        const blockStart = html.indexOf("const pauseBtn = document.getElementById('btn-pause');");
        assert.ok(blockStart !== -1, 'template must define the pause button render block (apra-fleet-p2to.2.1)');
        const blockEnd = html.indexOf("const dur = state.status === 'running'", blockStart);
        assert.ok(blockEnd !== -1, 'must find the end of the pause render block');
        return html.slice(blockStart, blockEnd);
    }

    function renderPause(state) {
        const pauseBtn = { textContent: '', onclick: 'unset', disabled: false };
        const pauseBanner = { innerHTML: '', style: { display: '' } };
        const fakeDocument = {
            getElementById(id) {
                if (id === 'btn-pause') return pauseBtn;
                if (id === 'pause-banner') return pauseBanner;
                return null;
            }
        };
        const resumeWorkflow = () => 'RESUME_SENTINEL';
        const pauseWorkflow = () => 'PAUSE_SENTINEL';
        // eslint-disable-next-line no-new-func
        const fn = new Function('document', 'state', 'resumeWorkflow', 'pauseWorkflow', 'escapeHtml', extractPauseRenderBlock());
        fn(fakeDocument, state, resumeWorkflow, pauseWorkflow, escapeHtml);
        return { pauseBtn, pauseBanner, resumeWorkflow, pauseWorkflow };
    }

    test('status "none": Pause button enabled only while the run is live; no banner', () => {
        const { pauseBtn, pauseBanner, pauseWorkflow } = renderPause({ status: 'running', pause: { status: 'none' } });
        assert.strictEqual(pauseBtn.textContent, 'Pause');
        assert.strictEqual(pauseBtn.onclick, pauseWorkflow);
        assert.strictEqual(pauseBtn.disabled, false);
        assert.strictEqual(pauseBanner.style.display, 'none');
        assert.strictEqual(pauseBanner.innerHTML, '');
    });

    test('status "none" on a finished run: Pause button disabled (nothing left to pause)', () => {
        const { pauseBtn } = renderPause({ status: 'success', pause: { status: 'none' } });
        assert.strictEqual(pauseBtn.textContent, 'Pause');
        assert.strictEqual(pauseBtn.disabled, true);
    });

    test("status 'pausing': button shows 'Pausing...', disabled, no click handler; banner still hidden (nothing has engaged yet)", () => {
        const { pauseBtn, pauseBanner } = renderPause({ status: 'running', pause: { status: 'pausing', reason: 'x', since: null, phase: 'build', group: null } });
        assert.strictEqual(pauseBtn.textContent, 'Pausing...');
        assert.strictEqual(pauseBtn.onclick, null);
        assert.strictEqual(pauseBtn.disabled, true);
        assert.strictEqual(pauseBanner.style.display, 'none');
    });

    test("status 'paused': button shows 'Resume' and is enabled; banner shows 'Paused since' + reason + phase, HTML-escaped", () => {
        const since = new Date('2026-08-11T05:00:00.000Z').toISOString();
        const { pauseBtn, pauseBanner, resumeWorkflow } = renderPause({
            status: 'running',
            pause: { status: 'paused', reason: '<script>alert(1)</script>', since, phase: 'build<x>', group: 'groupA' }
        });
        assert.strictEqual(pauseBtn.textContent, 'Resume');
        assert.strictEqual(pauseBtn.onclick, resumeWorkflow);
        assert.strictEqual(pauseBtn.disabled, false);

        assert.strictEqual(pauseBanner.style.display, 'flex');
        assert.ok(pauseBanner.innerHTML.includes('Paused since'));
        assert.ok(pauseBanner.innerHTML.includes('Reason:'));
        assert.ok(pauseBanner.innerHTML.includes('Phase:'));
        assert.ok(!pauseBanner.innerHTML.includes('<script>alert(1)</script>'), 'a malicious pause reason must render inert, not as a live <script> tag');
        assert.ok(pauseBanner.innerHTML.includes(escapeHtml('<script>alert(1)</script>')));
        assert.ok(pauseBanner.innerHTML.includes(escapeHtml('build<x>')));
    });

    test('resuming (paused -> none) hides the banner again and re-enables the Pause label', () => {
        const paused = renderPause({ status: 'running', pause: { status: 'paused', reason: 'r', since: new Date().toISOString(), phase: null, group: null } });
        assert.strictEqual(paused.pauseBanner.style.display, 'flex');

        const resumed = renderPause({ status: 'running', pause: { status: 'none', reason: null, since: null, phase: null, group: null } });
        assert.strictEqual(resumed.pauseBtn.textContent, 'Pause');
        assert.strictEqual(resumed.pauseBanner.style.display, 'none');
        assert.strictEqual(resumed.pauseBanner.innerHTML, '');
    });

    test('a state payload with no pause field at all (defensive default) is treated as status "none", not a crash', () => {
        assert.doesNotThrow(() => renderPause({ status: 'running' }));
        const { pauseBtn, pauseBanner } = renderPause({ status: 'running' });
        assert.strictEqual(pauseBtn.textContent, 'Pause');
        assert.strictEqual(pauseBanner.style.display, 'none');
    });
});
