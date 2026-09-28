// apra-fleet-i9ag.4 -- finished-sprints (History) list plus verdict/PR on
// sprint cards in the supervisor dashboard.
//
// Fixture: two finished runs persisted under old_runs/ in a temp fleet data
// dir -- one PASS with a prUrl, one FAIL without -- driven through the REAL
// createFinishedRunsIndex() (history-view.mjs) and createDashboard()
// (dashboard.mjs), then asserted on the rendered GET / page, the GET /state
// payload, and a finished card rendered by renderSprintSection().
//
// MOUNT CONTRACT (apra-fleet-i9ag.3.2): every app-path this feature emits is
// ROOT-ABSOLUTE and passed through mountHref() against the prefix
// resolveMountPrefix() derives from the console proxy's MOUNT_PATH_HEADER --
// never a relative './sprints/...'. The two shapes are asserted side by side
// below: with no header the page is bit-for-bit the serve-direct render
// ('/sprints/<id>/history'), and with the header every app-path (and only the
// app-paths -- an external PR URL stays untouched) carries the prefix.

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
    launchFailedBadge,
    buildStatePayload,
} from '../src/supervisor/dashboard.mjs';
import { createFinishedRunsIndex, summarizeFinishedRun } from '../src/supervisor/history-view.mjs';
import { MOUNT_PATH_HEADER } from '../src/supervisor/mount-prefix.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';
import { HISTORY_EVENTS } from '../src/supervisor/history.mjs';

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

/**
 * Minimal in-process request driver (no socket) against a supervisor.
 * `headers` is how a test plays the console proxy and sends MOUNT_PATH_HEADER.
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

    test('apra-fleet-i9ag.16.1: file-backed rows gain status/reason/hasTerminalState, unchanged otherwise', async () => {
        const rows = await createFinishedRunsIndex({ env, logger: { error() {} } }).list();
        const pass = rows.find((r) => r.sprintId === 'sprint-pass');
        assert.equal(pass.status, 'finished');
        assert.equal(pass.reason, null);
        assert.equal(pass.hasTerminalState, true);
        assert.equal(pass.verdict, 'PASS');
        assert.equal(pass.prUrl, PR_URL);
        assert.equal(pass.goal, 'P1');
    });

    test('apra-fleet-i9ag.16.1: a LAUNCH_FAILED event with no terminal file is reported as one launch-failed row', async () => {
        const history = {
            list: () => [
                { sprintId: 'sprint-pass', event: HISTORY_EVENTS.FINISHED, verdict: 'PASS' },
                { sprintId: 'sprint-fail', event: HISTORY_EVENTS.FINISHED, verdict: 'FAIL' },
                {
                    sprintId: 'sprint-launch-dead',
                    event: HISTORY_EVENTS.LAUNCH_FAILED,
                    reason: 'watchdog: child exited within launch window (exited 1)',
                    at: '2026-09-25T00:00:00.000Z',
                },
            ],
        };
        const rows = await createFinishedRunsIndex({ env, history, logger: { error() {} } }).list();
        const launchDead = rows.filter((r) => r.sprintId === 'sprint-launch-dead');
        assert.equal(launchDead.length, 1, 'exactly one synthesized row for the launch-failed sprint');
        assert.deepEqual(launchDead[0], {
            sprintId: 'sprint-launch-dead',
            verdict: null,
            prUrl: null,
            endedAt: '2026-09-25T00:00:00.000Z',
            goal: null,
            workflowName: null,
            status: 'launch-failed',
            reason: 'watchdog: child exited within launch window (exited 1)',
            hasTerminalState: false,
        });
        // Newest first across the merged set: sprint-launch-dead's endedAt
        // (2026-09-25) sorts ahead of sprint-fail (2026-09-21).
        assert.deepEqual(rows.map((r) => r.sprintId), ['sprint-launch-dead', 'sprint-fail', 'sprint-pass']);
    });

    test('apra-fleet-i9ag.16.1: a sprint with BOTH a LAUNCH_FAILED event and a terminal file yields only the file-backed row', async () => {
        const history = {
            list: () => [
                { sprintId: 'sprint-pass', event: HISTORY_EVENTS.LAUNCH_FAILED, reason: 'stale, superseded by the finished run' },
                { sprintId: 'sprint-pass', event: HISTORY_EVENTS.FINISHED, verdict: 'PASS' },
            ],
        };
        const rows = await createFinishedRunsIndex({ env, history, logger: { error() {} } }).list();
        const passRows = rows.filter((r) => r.sprintId === 'sprint-pass');
        assert.equal(passRows.length, 1, 'the file-backed row wins; no synthesized duplicate');
        assert.equal(passRows[0].status, 'finished');
        assert.equal(passRows[0].hasTerminalState, true);
    });

    test('apra-fleet-i9ag.16.1: with no history collaborator injected, no launch-failed rows are synthesized', async () => {
        const rows = await createFinishedRunsIndex({ env, logger: { error() {} } }).list();
        assert.deepEqual(rows.map((r) => r.sprintId), ['sprint-fail', 'sprint-pass']);
        assert.ok(rows.every((r) => r.status === 'finished' && r.hasTerminalState === true));
    });

    test('apra-fleet-i9ag.16.1: limit caps the merged total across file-backed and synthesized rows', async () => {
        const history = {
            list: () => [
                { sprintId: 'sprint-pass', event: HISTORY_EVENTS.FINISHED, verdict: 'PASS' },
                { sprintId: 'sprint-fail', event: HISTORY_EVENTS.FINISHED, verdict: 'FAIL' },
                { sprintId: 'sprint-launch-dead', event: HISTORY_EVENTS.LAUNCH_FAILED, reason: 'r', at: '2026-09-26T00:00:00.000Z' },
            ],
        };
        const rows = await createFinishedRunsIndex({ env, history, limit: 1, logger: { error() {} } }).list();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].sprintId, 'sprint-launch-dead', 'newest row survives the cap');
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

        // No MOUNT_PATH_HEADER on this request -> the serve-direct render:
        // every app-path stays ROOT-ABSOLUTE, exactly as it was pre-i9ag.3.2.
        assert.ok(hrefs(passCard).includes('/sprints/sprint-pass/history'));
        assert.ok(hrefs(failCard).includes('/sprints/sprint-fail/history'));
        assert.ok(passCard.includes('>PASS</span>'));
        assert.ok(failCard.includes('>FAIL</span>'));
        assert.ok(hrefs(passCard).includes(PR_URL), 'PASS run must carry its PR anchor');
        assert.ok(!failCard.includes('class="pr-link"'), 'FAIL run has no prUrl, so no PR anchor');

        // Finished runs never masquerade as live Sprint Stack rows.
        assert.ok(!html.includes('data-sprint-id="sprint-pass"'));

        // No app-path may be written RELATIVE: the mount-prefix contract is
        // what makes the embedded render work, and a './...' href would
        // silently opt this feature out of it.
        assert.ok(!hrefs(html).some((h) => h.startsWith('./')), 'no relative hrefs -- app-paths go through mountHref()');
        assert.ok(!/fetch\('(?!\/)[a-zA-Z.]/.test(html), 'client fetch() URLs must be root-absolute app-paths');
        assert.equal(html.includes("EventSource('/events')"), true, 'EventSource target is the root-absolute /events');
    });

    test('with MOUNT_PATH_HEADER set, every finished-list app-path carries the mount prefix and the external PR URL does not', async () => {
        for (const mount of ['/ext/se', '/ui/sprints']) {
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
            const res = await request(supervisor, 'GET', '/', { [MOUNT_PATH_HEADER]: mount });
            assert.equal(res.statusCode, 200);
            const html = res.body;

            const passCard = finishedCard(html, 'sprint-pass');
            const failCard = finishedCard(html, 'sprint-fail');
            assert.ok(passCard && failCard, mount + ': both finished runs must still render');
            assert.ok(hrefs(passCard).includes(mount + '/sprints/sprint-pass/history'), mount + ': History link is prefixed');
            assert.ok(hrefs(failCard).includes(mount + '/sprints/sprint-fail/history'), mount + ': History link is prefixed');

            // The PR link is EXTERNAL -- it must survive verbatim, never
            // rewritten into '<mount>https://...' or otherwise prefixed.
            assert.ok(hrefs(passCard).includes(PR_URL), mount + ': external PR URL stays absolute');
            assert.ok(!html.includes(mount + PR_URL), mount + ': external PR URL is never prefixed');
            assert.ok(!html.includes(mount + 'https://'), mount + ': no https URL was prefixed');

            // The client poll that re-renders this list must reach the mounted
            // routes too -- a bare '/state' there hits the CONSOLE root.
            assert.ok(html.includes("fetch('" + mount + "/state?_t="), mount + ': /state poll is prefixed');
            assert.ok(html.includes("EventSource('" + mount + "/events')"), mount + ': /events source is prefixed');
            // MOUNT_PREFIX is shipped into the page so the live-refreshed
            // finished list rebuilds its History links with the same prefix.
            assert.ok(html.includes("var MOUNT_PREFIX = '" + mount + "'"), mount + ': prefix is shipped to the client');
            assert.ok(html.includes('renderFinishedRunsHtml(data.finished, MOUNT_PREFIX)'), mount + ': live refresh re-prefixes the list');
        }
    });

    test('a hostile or malformed mount header fails closed to the serve-direct render', async () => {
        for (const hostile of ['//evil.example', 'http://evil.example', '/ext/../admin', 'ext/se', "/ext/'+alert(1)+'"]) {
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
            const html = (await request(supervisor, 'GET', '/', { [MOUNT_PATH_HEADER]: hostile })).body;
            const passCard = finishedCard(html, 'sprint-pass');
            assert.ok(hrefs(passCard).includes('/sprints/sprint-pass/history'), hostile + ': falls back to the root-absolute path');
            assert.ok(!html.includes(hostile), hostile + ': the rejected value is never interpolated into the page');
        }
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
        // Same rows, rendered under a mount prefix: only the History app-path moves.
        const mounted = renderFinishedRunsHtml([{ sprintId: 'sprint-pass', verdict: 'PASS', prUrl: PR_URL }], '/ui/sprints');
        assert.ok(hrefs(mounted).includes('/ui/sprints/sprints/sprint-pass/history'));
        assert.ok(hrefs(mounted).includes(PR_URL));

        const failCard = renderSprintSection({ ...base, sprintId: 'sprint-fail', verdict: 'FAIL', prUrl: null });
        assert.ok(failCard.includes('>FAIL</span>'));
        assert.ok(!failCard.includes('class="pr-link"'));

        // A live card with no outcome yet renders neither.
        const live = renderSprintSection({ ...base, status: WATCHDOG_STATUS.RUNNING_HEALTHY, verdict: null, prUrl: null });
        assert.ok(!live.includes('verdict-badge'));
        assert.ok(!live.includes('class="pr-link"'));
        // Serve-direct: root-absolute app-paths, exactly as pre-i9ag.4.
        assert.ok(hrefs(live).includes('/sprints/sprint-pass/live'));
        assert.ok(!hrefs(live).some((h) => h.startsWith('./')));
        // Under a prefix the same card's links move with it.
        const liveMounted = renderSprintSection({ ...base, status: WATCHDOG_STATUS.RUNNING_HEALTHY, verdict: null, prUrl: null }, '/ext/se');
        assert.ok(hrefs(liveMounted).includes('/ext/se/sprints/sprint-pass/live'));
        assert.ok(hrefs(liveMounted).includes('/ext/se/sprints/sprint-pass/log'));
    });

    test('verdict badge covers PASS / FAIL / ABORTED / unknown and the empty history state renders', () => {
        assert.ok(verdictBadge('ABORTED').includes('>ABORTED</span>'));
        assert.ok(verdictBadge(null).includes('>unknown</span>'));
        assert.equal(prLink('javascript:alert(1)'), '');
        assert.ok(renderFinishedRunsHtml([]).includes('No finished sprints yet.'));
        assert.ok(renderIndexPageHtml([]).includes('id="finished-sprints"'));
    });
});

// apra-fleet-i9ag.16.2 -- a launch-failed row (history-view.mjs's
// `status: 'launch-failed'`, `hasTerminalState: false`; see apra-fleet-i9ag.16.1)
// renders a failure badge, its reason and a raw-log link instead of the
// verdict/PR/History trio a file-backed row gets. Full HTTP-route-level
// coverage (first paint + /state parity, dedupe against a file-backed row for
// the same id) is apra-fleet-i9ag.16.3's dedicated test file; these are the
// direct, pure-function unit assertions for the two functions this task
// changed.
describe('apra-fleet-i9ag.16.2: launch-failed rows in the finished-sprints list', () => {
    const LAUNCH_FAILED_ROW = {
        sprintId: 'sprint-launch-failed',
        verdict: null,
        prUrl: null,
        endedAt: '2026-09-28T00:00:00.000Z',
        goal: null,
        status: 'launch-failed',
        reason: 'member "alice" not registered',
        hasTerminalState: false,
    };

    test('renders the reason, a raw-log link, and the launch-failed badge -- no History link', () => {
        const html = renderFinishedRunsHtml([LAUNCH_FAILED_ROW]);
        assert.ok(html.includes('data-finished-sprint-id="sprint-launch-failed"'));
        assert.ok(!html.includes('data-sprint-id='), 'must never emit the live stack\'s row-key attribute');
        assert.ok(html.includes(launchFailedBadge()));
        assert.ok(html.includes('Reason: member &quot;alice&quot; not registered'));
        assert.ok(hrefs(html).includes('/sprints/sprint-launch-failed/log'), 'must link the raw log');
        assert.ok(!html.includes('class="history-link"'), 'a row with no terminal state file has nothing for History to render');
        assert.ok(!html.includes('class="pr-link"'), 'a launch-failed run has no PR');
    });

    test('the launch-failed badge is a different CSS class than the verdict badge, and never grey/unknown-styled', () => {
        assert.ok(launchFailedBadge().includes('class="launch-failed-badge"'));
        assert.ok(!launchFailedBadge().includes('verdict-badge'));
        assert.ok(launchFailedBadge().includes('var(--danger)'));
    });

    test('a raw reason with HTML is escaped in the rendered output', () => {
        const html = renderFinishedRunsHtml([{ ...LAUNCH_FAILED_ROW, reason: '<script>alert(1)</script>' }]);
        assert.ok(!html.includes('<script>alert(1)</script>'));
        assert.ok(html.includes('&lt;script&gt;'));
    });

    test('a row with no reason text omits the reason line entirely', () => {
        const html = renderFinishedRunsHtml([{ ...LAUNCH_FAILED_ROW, reason: null }]);
        assert.ok(!html.includes('launch-failed-reason'));
    });

    test('a file-backed finished row (status "finished") is completely unaffected: verdict badge, PR link, History link', () => {
        const fileBackedRow = { sprintId: 'sprint-pass', verdict: 'PASS', prUrl: PR_URL, endedAt: null, goal: null, status: 'finished', reason: null, hasTerminalState: true };
        const html = renderFinishedRunsHtml([fileBackedRow]);
        assert.ok(html.includes(verdictBadge('PASS')));
        assert.ok(html.includes(prLink(PR_URL)));
        assert.ok(hrefs(html).includes('/sprints/sprint-pass/history'));
        assert.ok(!html.includes('launch-failed-badge'));
        assert.ok(!html.includes('raw-log-link'));
    });

    test('a row missing the status field entirely (older/un-migrated caller) still renders the file-backed shape, not launch-failed', () => {
        const html = renderFinishedRunsHtml([{ sprintId: 'sprint-legacy', verdict: 'FAIL', prUrl: null, endedAt: null, goal: null }]);
        assert.ok(html.includes(verdictBadge('FAIL')));
        assert.ok(hrefs(html).includes('/sprints/sprint-legacy/history'));
    });

    test('buildStatePayload() carries status/reason/hasTerminalState through finished[] entries', () => {
        const payload = buildStatePayload([], [LAUNCH_FAILED_ROW]);
        assert.deepEqual(payload.finished, [{
            sprintId: 'sprint-launch-failed',
            verdict: null,
            prUrl: null,
            endedAt: '2026-09-28T00:00:00.000Z',
            goal: null,
            status: 'launch-failed',
            reason: 'member "alice" not registered',
            hasTerminalState: false,
        }]);
    });

    test('feeding buildStatePayload()\'s finished[] entries back through renderFinishedRunsHtml() reproduces the server-rendered card byte-for-byte, for both a launch-failed and a file-backed row', () => {
        const fileBackedRow = { sprintId: 'sprint-pass', verdict: 'PASS', prUrl: PR_URL, endedAt: '2026-09-19T00:00:00.000Z', goal: 'P1', status: 'finished', reason: null, hasTerminalState: true };
        const rows = [LAUNCH_FAILED_ROW, fileBackedRow];
        const serverRendered = renderFinishedRunsHtml(rows, '/ext/se');
        const payload = buildStatePayload([], rows);
        const clientReRendered = renderFinishedRunsHtml(payload.finished, '/ext/se');
        assert.equal(clientReRendered, serverRendered);
    });
});
