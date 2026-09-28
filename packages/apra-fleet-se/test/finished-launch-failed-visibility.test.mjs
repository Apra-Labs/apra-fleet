// apra-fleet-i9ag.16.3 -- proves a launch-failed run is no longer invisible to
// an operator: it must reach BOTH HTTP surfaces the dashboard actually uses,
// GET / (first paint) and GET /state (the payload the live-refresh client
// re-renders from), driven through the REAL route layer (createSupervisor +
// registerDashboardRoutes, exactly like i9ag4-dashboard-finished-sprints.test
// .mjs's request() helper) with a temp data dir and a REAL sprint-history.json
// log (history.mjs's createHistory(), not a fake `{ list: () => [...] }`
// collaborator) recording a genuine LAUNCH_FAILED event for a sprint that
// never wrote a terminal state file.
//
// apra-fleet-i9ag.16.1 (history-view.mjs) and apra-fleet-i9ag.16.2
// (dashboard.mjs's renderFinishedRunsHtml()/buildStatePayload()) already carry
// thorough pure-function/fake-collaborator unit coverage in
// i9ag4-dashboard-finished-sprints.test.mjs; this file's job is the missing
// piece those call out explicitly: end-to-end HTTP-route coverage plus a
// real (not fake) history log, so a regression in how createDashboard/
// registerDashboardRoutes actually wire history.mjs to history-view.mjs would
// be caught here even if the two units in isolation still pass.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
    createDashboard,
    registerDashboardRoutes,
    renderFinishedRunsHtml,
    buildStatePayload,
} from '../src/supervisor/dashboard.mjs';
import { createFinishedRunsIndex } from '../src/supervisor/history-view.mjs';
import { createHistory, HISTORY_EVENTS } from '../src/supervisor/history.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';

const PASS_RUN = {
    workflowName: 'fleet-sprint',
    runId: 'sprint-pass',
    status: 'success',
    result: { verdict: 'PASS', prUrl: null },
    startedAt: '2026-09-20T00:00:00.000Z',
    endedAt: '2026-09-20T02:00:00.000Z',
    extensions: {},
};

/** Every href="..." value in an HTML string. */
function hrefs(html) {
    return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
}

/** The single finished-sprint card for one id, or null. */
function finishedCard(html, id) {
    const start = html.indexOf('data-finished-sprint-id="' + id + '"');
    if (start === -1) return null;
    const end = html.indexOf('</section>', start);
    return html.slice(start, end);
}

/**
 * Minimal in-process request driver (no socket) against a supervisor -- the
 * same style i9ag4-dashboard-finished-sprints.test.mjs uses.
 */
function request(supervisor, method, urlPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = { method, url: urlPath, headers, on() {} };
        const chunks = [];
        const res = {
            statusCode: 0,
            headers: {},
            writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
            setHeader(k, v) { this.headers[k] = v; },
            write(chunk) { chunks.push(chunk); },
            end(chunk) {
                if (chunk) chunks.push(chunk);
                resolve({ statusCode: this.statusCode, body: Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString('utf-8') });
            },
        };
        Promise.resolve(supervisor.handleRequest(req, res)).catch(reject);
    });
}

function fakeLedger(entries) {
    return { list: () => entries, get: (id) => entries.find((e) => e.sprintId === id) };
}

/**
 * Creates a fresh temp fleet data dir (with old_runs/) plus a REAL,
 * file-backed history log rooted in the SAME dir. Every test gets its own
 * dir/history instance so tests never see each other's events.
 */
async function makeFixture() {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'i9ag16-3-'));
    await fs.mkdir(path.join(dataDir, 'old_runs'), { recursive: true });
    const env = { APRA_FLEET_DATA_DIR: dataDir };
    const history = createHistory({ dataDir, now: () => '2026-09-28T00:00:00.000Z' });
    await history.start();
    return { dataDir, env, history };
}

async function cleanupFixture(dataDir) {
    await fs.rm(dataDir, { recursive: true, force: true });
}

function buildDashboard({ env, history, ledgerEntries = [] }) {
    const dashboard = createDashboard({
        ledger: fakeLedger(ledgerEntries),
        watchdog: { classifySprint: async () => ({ status: WATCHDOG_STATUS.RUNNING_HEALTHY }) },
        listAllBeads: async () => [],
        driftCheck: async () => null,
        finishedRuns: createFinishedRunsIndex({ env, history, logger: { error() {} } }),
        logger: { log() {}, error() {} },
    });
    const supervisor = createSupervisor({ logger: { log() {}, error() {} } });
    registerDashboardRoutes(supervisor, dashboard);
    return supervisor;
}

describe('apra-fleet-i9ag.16.3: a launch-failed run reaches GET / and GET /state through the real route layer', () => {
    test('GET / renders the launch-failed card with its (escaped) reason and a raw-log anchor, and NO History anchor for it', async () => {
        const { dataDir, env, history } = await makeFixture();
        try {
            await history.record({
                sprintId: 'sprint-launch-dead',
                event: HISTORY_EVENTS.LAUNCH_FAILED,
                reason: 'watchdog: <script>alert(1)</script> child exited within launch window',
                at: '2026-09-28T00:00:00.000Z',
            });
            const supervisor = buildDashboard({ env, history });

            const html = (await request(supervisor, 'GET', '/')).body;
            const card = finishedCard(html, 'sprint-launch-dead');
            assert.ok(card, 'the launch-failed sprint must render a finished-sprint card');

            // Escaping: the raw reason markup must never appear verbatim.
            assert.ok(!card.includes('<script>alert(1)</script>'));
            assert.ok(card.includes('Reason: watchdog: &lt;script&gt;alert(1)&lt;/script&gt; child exited within launch window'));

            // Raw-log anchor present; History anchor absent (no terminal file exists).
            assert.ok(hrefs(card).includes('/sprints/sprint-launch-dead/log'), 'must link the raw log');
            assert.ok(!hrefs(card).includes('/sprints/sprint-launch-dead/history'), 'must not link a nonexistent History page');
            assert.ok(!card.includes('class="history-link"'), 'no History anchor for a run with no terminal state file');
            assert.ok(card.includes('LAUNCH FAILED</span>'), 'must carry the launch-failed badge, not a verdict badge');
        } finally {
            await cleanupFixture(dataDir);
        }
    });

    test("GET /state's finished[] entry carries status 'launch-failed', the reason, and hasTerminalState false", async () => {
        const { dataDir, env, history } = await makeFixture();
        try {
            await history.record({
                sprintId: 'sprint-launch-dead',
                event: HISTORY_EVENTS.LAUNCH_FAILED,
                reason: 'member "alice" not registered',
                at: '2026-09-28T00:00:00.000Z',
            });
            const supervisor = buildDashboard({ env, history });

            const res = await request(supervisor, 'GET', '/state');
            assert.equal(res.statusCode, 200);
            const payload = JSON.parse(res.body);
            const entry = payload.finished.find((r) => r.sprintId === 'sprint-launch-dead');
            assert.ok(entry, 'the launch-failed sprint must appear in /state\'s finished[] list');
            assert.equal(entry.status, 'launch-failed');
            assert.equal(entry.reason, 'member "alice" not registered');
            assert.equal(entry.hasTerminalState, false);
            assert.equal(entry.verdict, null);
            assert.equal(entry.prUrl, null);
        } finally {
            await cleanupFixture(dataDir);
        }
    });

    test("re-rendering GET /state's finished[] through renderFinishedRunsHtml() reproduces GET /'s first-paint card byte-for-byte (live-refresh parity)", async () => {
        const { dataDir, env, history } = await makeFixture();
        try {
            await history.record({
                sprintId: 'sprint-launch-dead',
                event: HISTORY_EVENTS.LAUNCH_FAILED,
                reason: 'watchdog: child exited within launch window (exited 1)',
                at: '2026-09-28T00:00:00.000Z',
            });
            const supervisor = buildDashboard({ env, history });

            const indexHtml = (await request(supervisor, 'GET', '/')).body;
            const firstPaintCard = finishedCard(indexHtml, 'sprint-launch-dead');
            assert.ok(firstPaintCard);

            const statePayload = JSON.parse((await request(supervisor, 'GET', '/state')).body);
            const clientReRendered = renderFinishedRunsHtml(statePayload.finished);
            const reRenderedCard = finishedCard(clientReRendered, 'sprint-launch-dead');
            assert.ok(reRenderedCard);

            assert.equal(reRenderedCard, firstPaintCard, 'the client-side re-render off /state must match the server first paint exactly');
        } finally {
            await cleanupFixture(dataDir);
        }
    });

    test('a sprint with BOTH a real terminal state file and a LAUNCH_FAILED event still renders as a normal finished run (verdict badge + History link), not duplicated', async () => {
        const { dataDir, env, history } = await makeFixture();
        try {
            await fs.writeFile(path.join(dataDir, 'old_runs', 'sprint-pass.json'), JSON.stringify(PASS_RUN));
            // A stale LAUNCH_FAILED event for the SAME sprintId -- e.g. an early
            // watchdog observation later superseded by a clean finish.
            await history.record({
                sprintId: 'sprint-pass',
                event: HISTORY_EVENTS.LAUNCH_FAILED,
                reason: 'stale, superseded by the finished run',
                at: '2026-09-19T00:00:00.000Z',
            });
            await history.record({ sprintId: 'sprint-pass', event: HISTORY_EVENTS.FINISHED, verdict: 'PASS' });
            const supervisor = buildDashboard({ env, history });

            const html = (await request(supervisor, 'GET', '/')).body;
            const cards = [...html.matchAll(/data-finished-sprint-id="sprint-pass"/g)];
            assert.equal(cards.length, 1, 'exactly one card for sprint-pass -- no synthesized duplicate');
            const card = finishedCard(html, 'sprint-pass');
            assert.ok(card.includes('>PASS</span>'));
            assert.ok(hrefs(card).includes('/sprints/sprint-pass/history'));
            assert.ok(!card.includes('launch-failed-badge'));
            assert.ok(!card.includes('raw-log-link'));

            const payload = JSON.parse((await request(supervisor, 'GET', '/state')).body);
            const entries = payload.finished.filter((r) => r.sprintId === 'sprint-pass');
            assert.equal(entries.length, 1);
            assert.equal(entries[0].status, 'finished');
            assert.equal(entries[0].hasTerminalState, true);
        } finally {
            await cleanupFixture(dataDir);
        }
    });

    test('index merge/dedupe/order/limit: a real history log with two file-backed runs and one launch-failed run merges newest-first and the limit caps the total', async () => {
        const { dataDir, env, history } = await makeFixture();
        try {
            const FAIL_RUN = {
                workflowName: 'fleet-sprint', runId: 'sprint-fail', status: 'failed',
                result: { verdict: 'FAIL', prUrl: null },
                startedAt: '2026-09-21T00:00:00.000Z', endedAt: '2026-09-21T03:00:00.000Z', extensions: {},
            };
            await fs.writeFile(path.join(dataDir, 'old_runs', 'sprint-pass.json'), JSON.stringify(PASS_RUN));
            await fs.writeFile(path.join(dataDir, 'old_runs', 'sprint-fail.json'), JSON.stringify(FAIL_RUN));
            await history.record({ sprintId: 'sprint-pass', event: HISTORY_EVENTS.FINISHED, verdict: 'PASS' });
            await history.record({ sprintId: 'sprint-fail', event: HISTORY_EVENTS.FINISHED, verdict: 'FAIL' });
            await history.record({
                sprintId: 'sprint-launch-dead',
                event: HISTORY_EVENTS.LAUNCH_FAILED,
                reason: 'r',
                at: '2026-09-29T00:00:00.000Z', // newest of the three
            });

            const rows = await createFinishedRunsIndex({ env, history, logger: { error() {} } }).list();
            assert.deepEqual(rows.map((r) => r.sprintId), ['sprint-launch-dead', 'sprint-fail', 'sprint-pass'], 'merged set is ordered newest first');

            const limited = await createFinishedRunsIndex({ env, history, limit: 1, logger: { error() {} } }).list();
            assert.deepEqual(limited.map((r) => r.sprintId), ['sprint-launch-dead'], 'limit caps the merged (file-backed + synthesized) total');
        } finally {
            await cleanupFixture(dataDir);
        }
    });

    test('index: with no history collaborator injected, a real (persisted) LAUNCH_FAILED event never surfaces and file-backed rows are unchanged', async () => {
        const { dataDir, env, history } = await makeFixture();
        try {
            await fs.writeFile(path.join(dataDir, 'old_runs', 'sprint-pass.json'), JSON.stringify(PASS_RUN));
            // Persisted for real to disk -- proves the omission is because no
            // `history` collaborator was passed to createFinishedRunsIndex, not
            // because the event was never recorded in the first place.
            await history.record({
                sprintId: 'sprint-launch-dead',
                event: HISTORY_EVENTS.LAUNCH_FAILED,
                reason: 'r',
                at: '2026-09-29T00:00:00.000Z',
            });

            const rows = await createFinishedRunsIndex({ env, logger: { error() {} } }).list();
            assert.deepEqual(rows.map((r) => r.sprintId), ['sprint-pass']);
            assert.ok(rows.every((r) => r.status === 'finished' && r.hasTerminalState === true));
        } finally {
            await cleanupFixture(dataDir);
        }
    });

    test("buildStatePayload()'s finished[] mapping matches the real index row for a launch-failed sprint field-for-field", async () => {
        const { dataDir, env, history } = await makeFixture();
        try {
            await history.record({
                sprintId: 'sprint-launch-dead',
                event: HISTORY_EVENTS.LAUNCH_FAILED,
                reason: 'watchdog: child exited within launch window (exited 1)',
                at: '2026-09-28T00:00:00.000Z',
            });
            const rows = await createFinishedRunsIndex({ env, history, logger: { error() {} } }).list();
            const payload = buildStatePayload([], rows);
            assert.deepEqual(payload.finished, [{
                sprintId: 'sprint-launch-dead',
                verdict: null,
                prUrl: null,
                endedAt: '2026-09-28T00:00:00.000Z',
                goal: null,
                status: 'launch-failed',
                reason: 'watchdog: child exited within launch window (exited 1)',
                hasTerminalState: false,
            }]);
        } finally {
            await cleanupFixture(dataDir);
        }
    });
});
