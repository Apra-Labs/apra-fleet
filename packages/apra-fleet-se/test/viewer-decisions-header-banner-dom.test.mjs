// Pending operator decisions show as a header-level banner on EVERY tab of the
// live sprint viewer, including when proxied by the supervisor under
// /sprints/:id/live.
//
// End to end over loopback: a real child viewer (createDashboardViewer with
// the real decisions extension), a real supervisor serving it through the
// real live proxy, and the page HTML the browser would receive. The page's
// OWN scripts (the decisions extension's client script and the viewer's
// switchTab) run against that markup parsed into a DOM tree (helpers/
// mini-dom.mjs -- the repo has no jsdom); state reaches the page the way the
// viewer's poll() delivers it (GET <live>/state, refs resolved, summary event
// then state event per namespace); the answer form's fetch goes to the real
// supervisor.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createDashboardViewer } from '@apralabs/apra-fleet-workflow/viewer';
import { resolveStringRefs } from '@apralabs/apra-fleet-workflow/viewer/lean-state';
import { createDecisionsExtension } from '../fleet-sprint/viewer-extensions.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { createLiveProxy, registerLiveRoutes } from '../src/supervisor/proxy.mjs';
import { parseDocument } from './helpers/mini-dom.mjs';

const DECISION_ID = 'decision-1-x-1';
const HOSTILE_QUESTION = 'Which way? <img src=x onerror="alert(1)"><script>alert(2)</script> ' + 'long question text '.repeat(40);
const pending = () => ({
    decisionId: DECISION_ID, beadId: 'x-1', decisionBeadId: 'x-dec', question: HOSTILE_QUESTION,
    options: [{ id: 'a', text: 'Upgrade the emulator' }, { id: 'b', text: 'Pin the old version <b>now</b>' }],
    recommendation: 'a', raisedBy: 'doer', cycle: 1, round: 1,
});

function httpCall(port, method, urlPath, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : Buffer.from(body);
        const h = { ...headers };
        if (data) h['content-length'] = data.length;
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: h }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end(data);
    });
}

describe('decision banner on every live viewer tab (proxied through the supervisor)', () => {
    let tmpDir; let viewer; let wf; let supervisor; let port; let doc; let switchTo;
    const answers = []; const fetchCalls = []; const timers = [];

    const LIVE = '/sprints/s1/live';

    /** The viewer's poll(): GET state, resolve refs, summary event then state event per namespace. */
    async function syncFromServer() {
        const res = await httpCall(port, 'GET', `${LIVE}/state?_t=1`);
        assert.equal(res.status, 200);
        const raw = JSON.parse(res.text);
        const state = resolveStringRefs(raw, raw._strings || []);
        const summaryExts = (state.summary && state.summary.extensions) || {};
        for (const ns of new Set([...Object.keys(state.extensions || {}), ...Object.keys(summaryExts)])) {
            doc.dispatchEvent({ type: 'workflow:summary:' + ns, detail: summaryExts[ns] || null });
        }
        for (const [ns, data] of Object.entries(state.extensions || {})) {
            doc.dispatchEvent({ type: 'workflow:state:' + ns, detail: data });
        }
    }

    /** The page's fetch: same-origin request to the supervisor that served it. */
    async function pageFetch(url, opts = {}) {
        const headers = { ...(opts.headers || {}), origin: `http://127.0.0.1:${port}` };
        fetchCalls.push({ url, method: opts.method, headers: opts.headers || {}, body: opts.body });
        const res = await httpCall(port, opts.method || 'GET', url, { headers, body: opts.body });
        return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => JSON.parse(res.text) };
    }

    const banner = () => doc.getElementById('extension-banner-decisions');
    const tabButtons = () => doc.querySelectorAll('.tab-btn');

    function assertBannerShownOnEveryTab() {
        assert.ok(tabButtons().length >= 3, 'the page has the core tab plus one per extension');
        for (const btn of tabButtons()) {
            const id = /switchTab\('([^']+)'\)/.exec(btn.getAttribute('onclick'))[1];
            switchTo(id, btn);
            assert.ok(doc.getElementById('tab-' + id).isVisible(), `tab ${id} is the visible one`);
            const el = banner();
            assert.ok(el, 'the banner slot exists');
            assert.equal(el.closest('.tab-content'), null, 'the banner lives outside every tab panel');
            assert.ok(el.isVisible(), `banner visible on tab ${id}`);
            const shown = el.querySelector('[data-decisions-banner]');
            assert.ok(shown && shown.isVisible(), `banner content visible on tab ${id}`);
            assert.ok(el.querySelector(`[data-decision-id=${DECISION_ID}]`), 'names the decision');
            assert.ok(el.textContent.includes('Bead x-1'), 'shows the work bead');
            assert.ok(el.querySelector('[data-decision-question]').textContent.includes(HOSTILE_QUESTION.trim()), 'shows the full question');
            assert.equal(el.querySelectorAll('[data-decision-option]').length, 2, 'lists every option');
            assert.ok(el.textContent.includes('Pin the old version <b>now</b>'));
            assert.ok(el.querySelector('[data-decision-recommendation]').textContent.includes('Recommendation: a'), 'marks the recommendation');
            const form = el.querySelector(`form[data-decision-form=${DECISION_ID}]`);
            assert.ok(form, 'has an answer form');
            assert.equal(form.querySelectorAll('input[type=radio]').length, 2, 'option pick');
            assert.ok(form.querySelector('textarea'), 'free text');
        }
    }

    function assertNoBannerOnAnyTab() {
        for (const btn of tabButtons()) {
            const id = /switchTab\('([^']+)'\)/.exec(btn.getAttribute('onclick'))[1];
            switchTo(id, btn);
            const el = banner();
            assert.ok(!el.isVisible(), `no banner on tab ${id}`);
            assert.equal(el.querySelector('[data-decisions-banner]'), null);
        }
    }

    before(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-se-decision-banner-'));
        wf = new EventEmitter();
        const ext = createDecisionsExtension({
            answer: async (decisionId, answer) => { answers.push({ decisionId, answer }); return { released: ['x-1'] }; },
        });
        const other = { id: 'other', title: 'Other', js: '' };
        viewer = createDashboardViewer(wf, {
            port: 0, runId: 'decision-banner', name: 'Decision banner', dashboardExtensions: [ext, other],
            debouncedStatePath: path.join(tmpDir, 'running.json'), debounceMs: 200, stateSnapshotDir: path.join(tmpDir, 'snaps'),
        });
        if (!viewer.listening) await new Promise((r, j) => { viewer.once('listening', r); viewer.once('error', j); });
        const childPort = viewer.address().port;
        supervisor = createSupervisor({ port: 0, apiToken: null, logger: { log() {}, error() {} } });
        registerLiveRoutes(supervisor, createLiveProxy({ resolvePort: (id) => (id === 's1' ? childPort : undefined), logger: { log() {}, error() {} } }));
        await supervisor.start();
        port = supervisor.port;

        const page = await httpCall(port, 'GET', LIVE);
        assert.equal(page.status, 200);
        doc = parseDocument(page.text);
        const scripts = doc.scripts();
        const extScript = scripts.find((s) => s.includes('renderDecisionsHeaderBanner'));
        assert.ok(extScript, 'the served page carries the decisions extension script');
        // eslint-disable-next-line no-new-func
        new Function('document', 'fetch', 'setTimeout', extScript)(doc, pageFetch, (fn) => { timers.push(fn); return timers.length; });
        const main = scripts.find((s) => s.includes('function switchTab(id)'));
        const start = main.indexOf('function switchTab(id)');
        const end = main.indexOf('\n    }\n', start) + 6;
        // eslint-disable-next-line no-new-func
        switchTo = new Function('document', `let event = null; ${main.slice(start, end)}; return (id, btn) => { event = { currentTarget: btn }; switchTab(id); };`)(doc);
    });

    after(async () => {
        await supervisor.stop();
        await new Promise((resolve) => viewer.close(resolve));
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('no banner while nothing is pending', async () => {
        wf.emit('state', { namespace: 'decisions', data: { state: 'running', pending: [], waitingSince: null } });
        await syncFromServer();
        assertNoBannerOnAnyTab();
    });

    test('a pending decision shows the banner with bead, question, options, recommendation and answer form on every tab', async () => {
        wf.emit('state', { namespace: 'decisions', data: { state: 'paused-awaiting-decision', pending: [pending()], waitingSince: 't' } });
        await syncFromServer();
        assertBannerShownOnEveryTab();
    });

    test('decision text containing HTML is rendered escaped: no injected element', () => {
        const el = banner();
        assert.equal(el.querySelectorAll('img').length, 0, 'no <img> injected');
        assert.equal(el.querySelectorAll('script').length, 0, 'no <script> injected');
        assert.equal(el.querySelectorAll('b').length, 0, 'no <b> injected from option text');
        assert.ok(el.querySelector('[data-decision-question]').textContent.includes('<img src=x onerror="alert(1)"><script>alert(2)</script>'), 'shown as literal text');
    });

    test('submitting the banner form POSTs JSON same-origin to the answer action and shows the result; the banner goes once the decision is gone', async () => {
        const form = banner().querySelector(`form[data-decision-form=${DECISION_ID}]`);
        form.querySelector('input[type=radio][value=b]').checked = true;
        form.querySelector('textarea').value = 'keep CI green';
        doc.dispatchEvent({ type: 'submit', target: form, preventDefault() {} });
        const result = form.querySelector('[data-decision-result]');
        for (let i = 0; i < 200 && !result.textContent; i++) await new Promise((r) => setTimeout(r, 10));

        assert.equal(fetchCalls.length, 1);
        const call = fetchCalls[0];
        assert.equal(call.url, `${LIVE}/extensions/decisions/actions/answer`, 'the proxied page posts to the live-prefixed action');
        assert.equal(call.method, 'POST');
        assert.equal(call.headers['Content-Type'], 'application/json');
        assert.deepEqual(JSON.parse(call.body), { decisionId: DECISION_ID, answer: 'b: keep CI green' });
        assert.deepEqual(answers, [{ decisionId: DECISION_ID, answer: 'b: keep CI green' }], 'the supervisor guard admitted it and the run recorded it');
        assert.equal(result.textContent, 'Answer recorded; the sprint resumes.');

        // The run drops the answered decision; the inline result stays readable
        // until the deferred re-render, then the banner disappears everywhere.
        wf.emit('state', { namespace: 'decisions', data: { state: 'running', pending: [], waitingSince: null } });
        await syncFromServer();
        assert.ok(banner().isVisible(), 'result still readable right after the answer');
        assert.equal(timers.length, 1);
        timers.shift()();
        assertNoBannerOnAnyTab();
    });

    test('a refused answer shows the error inline and keeps the banner', async () => {
        wf.emit('state', { namespace: 'decisions', data: { state: 'paused-awaiting-decision', pending: [pending()], waitingSince: 't' } });
        await syncFromServer();
        assertBannerShownOnEveryTab();
        // The run no longer knows the decision (e.g. answered elsewhere) but
        // the page has not re-synced: the action answers 404.
        wf.emit('state', { namespace: 'decisions', data: { state: 'running', pending: [], waitingSince: null } });
        const form = banner().querySelector(`form[data-decision-form=${DECISION_ID}]`);
        form.querySelector('textarea').value = 'late answer';
        doc.dispatchEvent({ type: 'submit', target: form, preventDefault() {} });
        const result = form.querySelector('[data-decision-result]');
        for (let i = 0; i < 200 && !result.textContent; i++) await new Promise((r) => setTimeout(r, 10));
        assert.match(result.textContent, /^Failed: no such pending decision/);
        assert.equal(timers.length, 0, 'a failed answer releases the form at once');
        assert.ok(banner().isVisible());
    });
});
