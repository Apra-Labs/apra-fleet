// A pending operator decision is surfaced: GET /api/sprints/:id carries it in
// full with the paused-awaiting-decision state, the sprint page renders the
// banner (escaped), and POST /api/sprints/:id/decisions/:decisionId answers it
// through the real child viewer. Real viewer + real supervisor controller over
// loopback HTTP; only the answer sink is a fake.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createDashboardViewer } from '@apralabs/apra-fleet-workflow/viewer';
import {
    createDecisionsExtension, renderDecisionsBannerHtml, validateDecisionAnswerBody, DECISION_ANSWER_MAX_CHARS,
} from '../fleet-sprint/viewer-extensions.mjs';
import { createSprintController, ApiError } from '../src/supervisor/api.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';

const QUESTION = 'Which way? ' + 'A very long question body that must survive untruncated. '.repeat(30);
const OPTIONS = [
    { id: 'a', text: 'Option A text ' + 'y'.repeat(500) },
    { id: 'b', text: 'Option B text' },
    { id: 'c', text: 'Option C <b>bold</b>' },
];
const pendingRecord = (over = {}) => ({
    decisionId: 'decision-1-x-1', beadId: 'x-1', decisionBeadId: 'x-dec', question: QUESTION, options: OPTIONS,
    recommendation: 'a', raisedBy: 'doer', cycle: 1, round: 1,
    notification: { message: { status: 'sent' }, email: { status: 'failed', reason: 'no channel configured' } },
    ...over,
});

function request(port, method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch { /* not json */ }
                resolve({ status: res.statusCode, text, json });
            });
        });
        req.on('error', reject);
        req.end(data);
    });
}

describe('decisions surface through a real child viewer and the supervisor controller', () => {
    let tmpDir; let server; let port; let wf; let controller; const answers = [];

    before(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-se-decisions-surface-'));
        wf = new EventEmitter();
        const ext = createDecisionsExtension({
            answer: async (decisionId, answer) => {
                answers.push({ decisionId, answer });
                wf.emit('state', { namespace: 'decisions', data: { state: 'running', pending: [], waitingSince: null } });
                return { released: ['x-1'] };
            },
        });
        server = createDashboardViewer(wf, {
            port: 0, runId: 'dec-surface', name: 'Decisions', dashboardExtensions: [ext],
            debouncedStatePath: path.join(tmpDir, 'running.json'), debounceMs: 200, stateSnapshotDir: path.join(tmpDir, 'snaps'),
        });
        if (!server.listening) await new Promise((r, j) => { server.once('listening', r); server.once('error', j); });
        port = server.address().port;
        const ledger = createLedger({ filePath: path.join(tmpDir, LEDGER_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
        await ledger.start();
        const history = createHistory({ filePath: path.join(tmpDir, HISTORY_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
        await history.start();
        await ledger.claim('s1', { members: ['a'], issueRoots: ['R'], childPid: 42 });
        const { createSpawner } = await import('../src/supervisor/spawner.mjs');
        controller = createSprintController({
            ledger, history, spawner: createSpawner({ basePort: 9100, isPortAvailable: async () => true, dataDir: 'x', fs: { mkdirSync() {}, openSync() { return 1; }, closeSync() {} }, spawn: () => ({ pid: 1, on() {}, unref() {} }) }),
            listMembers: () => ({}), getBacklog: () => ({}),
            resolvePort: (pid) => (pid === 42 ? port : undefined),
        });
    });

    after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('GET /api/sprints/:id returns the paused state and the full decision; ?summary=1 does not truncate', async () => {
        wf.emit('state', { namespace: 'decisions', data: { state: 'paused-awaiting-decision', pending: [pendingRecord()], waitingSince: 't' } });
        const out = await controller.getSprint('s1');
        assert.equal(out.decisionState, 'paused-awaiting-decision');
        assert.equal(out.runState, 'paused-awaiting-decision');
        assert.equal(out.pendingDecisions.length, 1);
        const d = out.pendingDecisions[0];
        assert.equal(d.question, QUESTION);
        assert.deepEqual(d.options, OPTIONS);
        assert.equal(d.notification.email.status, 'failed');
        const summary = await request(port, 'GET', '/state?summary=1');
        const sd = summary.json.extensions.decisions.pending[0];
        assert.equal(sd.question, QUESTION);
        assert.deepEqual(sd.options, OPTIONS);
    });

    test('banner HTML shows question, every option, recommendation and per-channel status, and escapes HTML', () => {
        const html = renderDecisionsBannerHtml({
            state: 'paused-awaiting-decision',
            pending: [pendingRecord({ question: 'Q <script>alert(1)</script>' })],
        });
        assert.ok(html.includes('data-decisions-banner'));
        assert.ok(html.includes('Q &lt;script&gt;alert(1)&lt;/script&gt;'));
        assert.ok(!html.includes('<script>alert(1)</script>'));
        assert.ok(html.includes('Option C &lt;b&gt;bold&lt;/b&gt;'));
        for (const o of OPTIONS) assert.ok(html.includes(`data-decision-option="${o.id}"`));
        assert.ok(html.includes('Recommendation: a'));
        assert.ok(html.includes('message: sent'));
        assert.ok(html.includes('email: notification failed'));
        assert.ok(html.includes('no channel configured'));
        assert.equal(renderDecisionsBannerHtml({ pending: [] }), '');
        // the live page embeds the banner renderer
        return request(port, 'GET', '/').then((page) => {
            assert.ok(page.text.includes('renderDecisionsBannerHtml'));
            assert.ok(page.text.includes('extension-decisions'));
        });
    });

    test('answer route: invalid decision id -> 404, malformed body -> 400, valid -> answered and resumed', async () => {
        wf.emit('state', { namespace: 'decisions', data: { state: 'paused-awaiting-decision', pending: [pendingRecord()], waitingSince: 't' } });
        await assert.rejects(() => controller.answerDecision('s1', 'decision-nope', { answer: 'a' }), (e) => e instanceof ApiError && e.status === 404);
        await assert.rejects(() => controller.answerDecision('s1', 'decision-1-x-1', null), (e) => e instanceof ApiError && e.status === 400);
        await assert.rejects(() => controller.answerDecision('s1', 'decision-1-x-1', { answer: '   ' }), (e) => e instanceof ApiError && e.status === 400);
        await assert.rejects(() => controller.answerDecision('s1', 'decision-1-x-1', { answer: 'z'.repeat(DECISION_ANSWER_MAX_CHARS + 1) }), (e) => e instanceof ApiError && e.status === 400);
        await assert.rejects(() => controller.answerDecision('ghost', 'decision-1-x-1', { answer: 'a' }), (e) => e instanceof ApiError && e.status === 404);
        assert.equal(answers.length, 0, 'no answer reached the run on a rejected request');

        const ok = await controller.answerDecision('s1', 'decision-1-x-1', { answer: 'a: upgrade the emulator' });
        assert.equal(ok.status, 'answered');
        assert.deepEqual(answers, [{ decisionId: 'decision-1-x-1', answer: 'a: upgrade the emulator' }]);
        const after = await controller.getSprint('s1');
        assert.deepEqual(after.pendingDecisions, []);
        assert.notEqual(after.decisionState, 'paused-awaiting-decision');
    });

    test('child action route: unknown extension/action -> 404, bad JSON -> 400', async () => {
        assert.equal((await request(port, 'POST', '/extensions/nope/actions/answer', {})).status, 404);
        assert.equal((await request(port, 'POST', '/extensions/decisions/actions/nope', {})).status, 404);
        assert.equal((await request(port, 'POST', '/extensions/decisions/actions/answer', '{bad')).status, 400);
        assert.equal((await request(port, 'POST', '/extensions/decisions/actions/answer', { decisionId: 'q' })).status, 400);
    });

    test('validateDecisionAnswerBody bounds the answer', () => {
        assert.equal(validateDecisionAnswerBody({ decisionId: 'd', answer: 'ok' }).ok, true);
        assert.equal(validateDecisionAnswerBody({ decisionId: 'd', answer: 'z'.repeat(DECISION_ANSWER_MAX_CHARS + 1) }).ok, false);
        assert.equal(validateDecisionAnswerBody('x').ok, false);
    });
});
