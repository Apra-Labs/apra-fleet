// apra-fleet-i9ag.4 -- finished-sprints (History) list plus verdict/PR on
// sprint cards in the supervisor dashboard.
//
// Fixture: two finished runs persisted under old_runs/ in a temp fleet data
// dir -- one PASS with a prUrl, one FAIL without -- driven through the REAL
// createFinishedRunsIndex() (history-view.mjs) and createDashboard()
// (dashboard.mjs), then asserted on the rendered GET / page, the GET /state
// payload, and a finished card rendered by renderSprintSection().

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
    createDashboard,
    registerDashboardRoutes,
    renderFinishedRunsHtml,
    renderSprintSection,
    renderIndexPageHtml,
    verdictBadge,
    prLink,
} from '../src/supervisor/dashboard.mjs';
import { createFinishedRunsIndex, summarizeFinishedRun } from '../src/supervisor/history-view.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';

const PR_URL = 'https://github.com/example/repo/pull/42';

const PASS_RUN = {
    workflowName: 'fleet-sprint',
    runId: 'sprint-pass',
    status: 'success',
    result: { verdict: 'PASS', prUrl: PR_URL },
    startedAt: '2026-09-20T00:00:00.000Z',
    endedAt: '2026-09-20T02:00:00.000Z',
    args: { goal: 'P1' },
    extensions: {},
};

const FAIL_RUN = {
    workflowName: 'fleet-sprint',
    runId: 'sprint-fail',
    status: 'failed',
    result: { verdict: 'FAIL', prUrl: null },
    startedAt: '2026-09-21T00:00:00.000Z',
    endedAt: '2026-09-21T03:00:00.000Z',
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

/** Minimal in-process request driver (no socket) against a supervisor. */
function request(supervisor, method, urlPath) {
    return new Promise((resolve, reject) => {
        const req = { method, url: urlPath, headers: {}, on() {} };
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

describe('apra-fleet-i9ag.4: finished-sprints list and verdict/PR on sprint cards', () => {
    let dataDir;
    let env;

    before(async () => {
        dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'i9ag4-'));
        env = { APRA_FLEET_DATA_DIR: dataDir };
        const oldRuns = path.join(dataDir, 'old_runs');
        await fs.mkdir(oldRuns, { recursive: true });
        await fs.writeFile(path.join(oldRuns, 'sprint-pass.json'), JSON.stringify(PASS_RUN));
        await fs.writeFile(path.join(oldRuns, 'sprint-fail.json'), JSON.stringify(FAIL_RUN));
        // A non-JSON file and a corrupt run must be skipped, never crash the list.
        await fs.writeFile(path.join(oldRuns, 'notes.txt'), 'ignore me');
        await fs.writeFile(path.join(oldRuns, 'broken.json'), '{not json');
    });

    after(async () => {
        await fs.rm(dataDir, { recursive: true, force: true });
    });

    test('createFinishedRunsIndex lists both runs newest first with verdict and prUrl', async () => {
        const index = createFinishedRunsIndex({ env, logger: { error() {} } });
        const rows = await index.list();
        assert.deepEqual(rows.map((r) => r.sprintId), ['sprint-fail', 'sprint-pass']);
        const pass = rows.find((r) => r.sprintId === 'sprint-pass');
        const fail = rows.find((r) => r.sprintId === 'sprint-fail');
        assert.equal(pass.verdict, 'PASS');
        assert.equal(pass.prUrl, PR_URL);
        assert.equal(pass.goal, 'P1');
        assert.equal(fail.verdict, 'FAIL');
        assert.equal(fail.prUrl, null);
    });

    test('a history collaborator narrows the list to runs this supervisor recorded, and backfills a missing verdict', async () => {
        const noVerdict = { ...FAIL_RUN, runId: 'sprint-nov', result: null, endedAt: '2026-09-22T00:00:00.000Z' };
        const other = { ...FAIL_RUN, runId: 'other-workflow', endedAt: '2026-09-23T00:00:00.000Z' };
        const oldRuns = path.join(dataDir, 'old_runs');
        await fs.writeFile(path.join(oldRuns, 'sprint-nov.json'), JSON.stringify(noVerdict));
        await fs.writeFile(path.join(oldRuns, 'other-workflow.json'), JSON.stringify(other));
        try {
            const history = {
                list: () => [
                    { sprintId: 'sprint-pass', event: 'finished', verdict: 'PASS' },
                    { sprintId: 'sprint-fail', event: 'finished', verdict: null },
                    { sprintId: 'sprint-nov', event: 'finished', verdict: 'ABORTED' },
                ],
            };
            const rows = await createFinishedRunsIndex({ env, history, logger: { error() {} } }).list();
            assert.deepEqual(rows.map((r) => r.sprintId), ['sprint-nov', 'sprint-fail', 'sprint-pass']);
            assert.equal(rows[0].verdict, 'ABORTED', 'verdict falls back to the sprint-history FINISHED event');
        } finally {
            await fs.rm(path.join(oldRuns, 'sprint-nov.json'));
            await fs.rm(path.join(oldRuns, 'other-workflow.json'));
        }
    });

    test('summarizeFinishedRun reads legacy top-level verdict/prUrl and extensions.terminal.verdict, and drops a non-http prUrl', () => {
        const legacy = summarizeFinishedRun('a', { verdict: 'PASS', prUrl: PR_URL });
        assert.equal(legacy.verdict, 'PASS');
        assert.equal(legacy.prUrl, PR_URL);
        const terminal = summarizeFinishedRun('b', { result: {}, extensions: { terminal: { verdict: 'ABORTED' } } });
        assert.equal(terminal.verdict, 'ABORTED');
        const hostile = summarizeFinishedRun('c', { result: { verdict: 'PASS', prUrl: 'javascript:alert(1)' } });
        assert.equal(hostile.prUrl, null);
        assert.equal(summarizeFinishedRun('d', {}).verdict, null);
    });

    test('GET / renders both finished runs with history links, verdict text, and a PR anchor only for the run with a prUrl', async () => {
        const dashboard = createDashboard({
            ledger: fakeLedger([]),
            watchdog: { classifySprint: async () => ({ status: WATCHDOG_STATUS.RUNNING_HEALTHY }) },
            listAllBeads: async () => [],
            driftCheck: async () => null,
            finishedRuns: createFinishedRunsIndex({ env, logger: { error() {} } }),
            logger: { log() {}, error() {} },
        });
        const supervisor = createSupervisor({ logger: { log() {}, error() {} } });
        registerDashboardRoutes(supervisor, dashboard);
        const res = await request(supervisor, 'GET', '/');
        assert.equal(res.statusCode, 200);
        const html = res.body;

        const passCard = finishedCard(html, 'sprint-pass');
        const failCard = finishedCard(html, 'sprint-fail');
        assert.ok(passCard && failCard, 'both finished runs must render in the history list');
        assert.ok(html.indexOf('data-finished-sprint-id="sprint-fail"') < html.indexOf('data-finished-sprint-id="sprint-pass"'), 'newest first');

        assert.ok(hrefs(passCard).includes('./sprints/sprint-pass/history'));
        assert.ok(hrefs(failCard).includes('./sprints/sprint-fail/history'));
        assert.ok(passCard.includes('>PASS</span>'));
        assert.ok(failCard.includes('>FAIL</span>'));
        assert.ok(hrefs(passCard).includes(PR_URL), 'PASS run must carry its PR anchor');
        assert.ok(!failCard.includes('class="pr-link"'), 'FAIL run has no prUrl, so no PR anchor');

        // Finished runs never masquerade as live Sprint Stack rows.
        assert.ok(!html.includes('data-sprint-id="sprint-pass"'));

        // No rendered link may start with an absolute root path: under the
        // console's /ext/se/ mount a '/...' href escapes the mount.
        const rootAbsolute = hrefs(html).filter((h) => h.startsWith('/'));
        assert.deepEqual(rootAbsolute, [], 'root-absolute hrefs break under /ext/se/');
        // Same for the client scripts' own request URLs.
        assert.ok(!/fetch\('\//.test(html), 'client fetch() URLs must be relative');
        assert.ok(!/EventSource\('\//.test(html), 'EventSource URL must be relative');
    });

    test('GET /state carries the finished list and per-card verdict/prUrl', async () => {
        const dashboard = createDashboard({
            ledger: fakeLedger([{ sprintId: 'sprint-pass', members: ['m1'], issueRoots: ['x-1'], childPid: null }]),
            watchdog: { classifySprint: async () => ({ status: WATCHDOG_STATUS.CRASHED }) },
            listAllBeads: async () => [],
            driftCheck: async () => null,
            finishedRuns: createFinishedRunsIndex({ env, logger: { error() {} } }),
            logger: { log() {}, error() {} },
        });
        const supervisor = createSupervisor({ logger: { log() {}, error() {} } });
        registerDashboardRoutes(supervisor, dashboard);
        const res = await request(supervisor, 'GET', '/state');
        const payload = JSON.parse(res.body);
        assert.deepEqual(payload.finished.map((r) => [r.sprintId, r.verdict, r.prUrl]), [
            ['sprint-fail', 'FAIL', null],
            ['sprint-pass', 'PASS', PR_URL],
        ]);
        // A card still in the ledger whose terminal state exists shows its outcome.
        assert.equal(payload.sprints[0].verdict, 'PASS');
        assert.equal(payload.sprints[0].prUrl, PR_URL);
    });

    test('a finished card shows the same verdict and PR link as the history list', () => {
        const base = {
            sprintId: 'sprint-pass', branch: 'feat/x', goal: 'P1', status: WATCHDOG_STATUS.FINISHED,
            issueRoots: ['x-1'], beadCount: 1, progress: null, members: [], base: 'main', baseDrift: null,
        };
        const card = renderSprintSection({ ...base, verdict: 'PASS', prUrl: PR_URL });
        assert.ok(card.includes(verdictBadge('PASS')));
        assert.ok(card.includes(prLink(PR_URL)));
        const listCard = renderFinishedRunsHtml([{ sprintId: 'sprint-pass', verdict: 'PASS', prUrl: PR_URL }]);
        assert.ok(listCard.includes(verdictBadge('PASS')) && listCard.includes(prLink(PR_URL)));

        const failCard = renderSprintSection({ ...base, sprintId: 'sprint-fail', verdict: 'FAIL', prUrl: null });
        assert.ok(failCard.includes('>FAIL</span>'));
        assert.ok(!failCard.includes('class="pr-link"'));

        // A live card with no outcome yet renders neither.
        const live = renderSprintSection({ ...base, status: WATCHDOG_STATUS.RUNNING_HEALTHY, verdict: null, prUrl: null });
        assert.ok(!live.includes('verdict-badge'));
        assert.ok(!live.includes('class="pr-link"'));
        assert.deepEqual(hrefs(live).filter((h) => h.startsWith('/')), []);
    });

    test('verdict badge covers PASS / FAIL / ABORTED / unknown and the empty history state renders', () => {
        assert.ok(verdictBadge('ABORTED').includes('>ABORTED</span>'));
        assert.ok(verdictBadge(null).includes('>unknown</span>'));
        assert.equal(prLink('javascript:alert(1)'), '');
        assert.ok(renderFinishedRunsHtml([]).includes('No finished sprints yet.'));
        assert.ok(renderIndexPageHtml([]).includes('id="finished-sprints"'));
    });
});
