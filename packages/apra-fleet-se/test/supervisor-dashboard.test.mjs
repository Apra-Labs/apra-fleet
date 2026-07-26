import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
    createDashboard,
    registerDashboardRoutes,
    renderIndexPageHtml,
    renderSprintStackHtml,
    renderSprintSection,
    statusBadge,
} from '../src/supervisor/dashboard.mjs';
import { WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';

// apra-fleet-eft.6.1 -- sprint-stack index dashboard. GET / renders one
// section per RUNNING sprint (branch, goal, status badge, claimed bead
// count, claimed members+roles, supervisor-relative live-view link);
// finished sprints are excluded; the page never throws with zero sprints.

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

describe('dashboard -- statusBadge', () => {
    test('badge text matches the classifier status string exactly', () => {
        for (const status of Object.values(WATCHDOG_STATUS)) {
            const html = statusBadge(status);
            assert.ok(html.includes('>' + status + '<'), `expected badge text '${status}' verbatim in: ${html}`);
        }
    });

    test('unrecognized status still renders (never throws), with a visible fallback', () => {
        assert.doesNotThrow(() => statusBadge('some-unknown-status'));
        assert.doesNotThrow(() => statusBadge(undefined));
        assert.ok(statusBadge(undefined).includes('unknown'));
    });
});

describe('dashboard -- renderSprintStackHtml / renderSprintSection', () => {
    test('zero running sprints renders an explicit empty state, not a blank/throw', () => {
        assert.doesNotThrow(() => renderSprintStackHtml([]));
        assert.doesNotThrow(() => renderSprintStackHtml(undefined));
        const html = renderSprintStackHtml([]);
        assert.ok(html.toLowerCase().includes('no sprints'));
    });

    test('renders branch, goal, status badge, bead count, and members+roles', () => {
        const html = renderSprintSection({
            sprintId: 'sprint-1',
            branch: 'auto-sprint/eft-service',
            goal: 'P1/P2',
            status: WATCHDOG_STATUS.RUNNING_HEALTHY,
            issueRoots: ['apra-fleet-eft.6'],
            beadCount: 7,
            members: [
                { name: 'alice', role: 'orchestrator' },
                { name: 'bob', role: null },
            ],
        });
        assert.ok(html.includes('sprint-1'));
        assert.ok(html.includes('auto-sprint/eft-service'));
        assert.ok(html.includes('P1/P2'));
        assert.ok(html.includes('>' + WATCHDOG_STATUS.RUNNING_HEALTHY + '<'));
        assert.ok(html.includes('7 bead'));
        assert.ok(html.includes('alice'));
        assert.ok(html.includes('orchestrator'));
        assert.ok(html.includes('bob'));
        // Supervisor-relative live-view link, never a bare child port.
        assert.ok(html.includes('/sprints/sprint-1/live'));
        assert.ok(!/:\d{2,5}\//.test(html), `must not leak a bare child port: ${html}`);
    });

    test('missing branch/goal/bead-count/members degrade to explicit "unknown" fallbacks, never throw', () => {
        const html = renderSprintSection({
            sprintId: 'sprint-2',
            branch: null,
            goal: null,
            status: WATCHDOG_STATUS.CRASHED,
            issueRoots: [],
            beadCount: null,
            members: [],
        });
        assert.ok(html.includes('unknown'));
        assert.ok(html.toLowerCase().includes('no members recorded'));
    });

    test('untrusted sprintId/branch/goal/member fields are HTML-escaped', () => {
        const html = renderSprintSection({
            sprintId: '<script>x</script>',
            branch: '<img src=x>',
            goal: '"><b>',
            status: WATCHDOG_STATUS.RUNNING_HEALTHY,
            issueRoots: [],
            beadCount: 0,
            members: [{ name: '<xss>', role: '<role>' }],
        });
        assert.ok(!html.includes('<script>x</script>'));
        assert.ok(!html.includes('<img src=x>'));
        assert.ok(!html.includes('<xss>'));
        assert.ok(!html.includes('<role>'));
    });
});

describe('dashboard -- createDashboard', () => {
    test('buildSprintViews excludes finished sprints from the live stack', async () => {
        const dashboard = createDashboard({
            ledger: fakeLedger([
                { sprintId: 'live-1', members: ['alice'], issueRoots: ['r1'], childPid: 1 },
                { sprintId: 'done-1', members: ['bob'], issueRoots: ['r2'], childPid: 2 },
            ]),
            watchdog: fakeWatchdog({ 'live-1': WATCHDOG_STATUS.RUNNING_HEALTHY, 'done-1': WATCHDOG_STATUS.FINISHED }),
            expandScope: async () => new Set(),
        });
        const views = await dashboard.buildSprintViews();
        assert.deepEqual(views.map((v) => v.sprintId), ['live-1']);
    });

    test('crashed and unresponsive sprints (not finished) still appear -- only finished is excluded', async () => {
        const dashboard = createDashboard({
            ledger: fakeLedger([
                { sprintId: 'crashed-1', members: [], issueRoots: [], childPid: 1 },
                { sprintId: 'hung-1', members: [], issueRoots: [], childPid: 2 },
            ]),
            watchdog: fakeWatchdog({
                'crashed-1': WATCHDOG_STATUS.CRASHED,
                'hung-1': WATCHDOG_STATUS.RUNNING_UNRESPONSIVE,
            }),
            expandScope: async () => new Set(),
        });
        const views = await dashboard.buildSprintViews();
        assert.deepEqual(views.map((v) => v.sprintId).sort(), ['crashed-1', 'hung-1']);
    });

    test('beadCount comes from the live-expanded scope size (reuses expandScope)', async () => {
        const dashboard = createDashboard({
            ledger: fakeLedger([{ sprintId: 's1', members: [], issueRoots: ['root'], childPid: 1 }]),
            watchdog: fakeWatchdog({ s1: WATCHDOG_STATUS.RUNNING_HEALTHY }),
            expandScope: async (roots) => {
                assert.deepEqual(roots, ['root']);
                return new Set(['root', 'child1', 'child2']);
            },
        });
        const [view] = await dashboard.buildSprintViews();
        assert.equal(view.beadCount, 3);
    });

    test('getSprintMeta supplies branch/goal/roles when injected; defaults to null/unknown otherwise', async () => {
        const withMeta = createDashboard({
            ledger: fakeLedger([{ sprintId: 's1', members: ['alice', 'bob'], issueRoots: [], childPid: 1 }]),
            watchdog: fakeWatchdog({ s1: WATCHDOG_STATUS.RUNNING_HEALTHY }),
            expandScope: async () => new Set(),
            getSprintMeta: async (id) => (id === 's1'
                ? { branch: 'feat/x', goal: 'P1', roles: { alice: 'orchestrator' } }
                : {}),
        });
        const [view] = await withMeta.buildSprintViews();
        assert.equal(view.branch, 'feat/x');
        assert.equal(view.goal, 'P1');
        assert.deepEqual(view.members.find((m) => m.name === 'alice').role, 'orchestrator');
        assert.deepEqual(view.members.find((m) => m.name === 'bob').role, null);

        const withoutMeta = createDashboard({
            ledger: fakeLedger([{ sprintId: 's2', members: ['carol'], issueRoots: [], childPid: 1 }]),
            watchdog: fakeWatchdog({ s2: WATCHDOG_STATUS.RUNNING_HEALTHY }),
            expandScope: async () => new Set(),
        });
        const [view2] = await withoutMeta.buildSprintViews();
        assert.equal(view2.branch, null);
        assert.equal(view2.goal, null);
        assert.equal(view2.members[0].role, null);
    });

    test('a throwing getSprintMeta/expandScope for one sprint does not take down the whole page (isolated fallback)', async () => {
        const dashboard = createDashboard({
            ledger: fakeLedger([{ sprintId: 's1', members: [], issueRoots: ['r'], childPid: 1 }]),
            watchdog: fakeWatchdog({ s1: WATCHDOG_STATUS.RUNNING_HEALTHY }),
            expandScope: async () => { throw new Error('boom'); },
            getSprintMeta: async () => { throw new Error('boom'); },
            logger: { log() {}, error() {} },
        });
        const views = await dashboard.buildSprintViews();
        assert.equal(views.length, 1);
        assert.equal(views[0].beadCount, null);
        assert.equal(views[0].branch, null);
    });

    test('createDashboard requires a ledger and a watchdog', () => {
        assert.throws(() => createDashboard({}), TypeError);
        assert.throws(() => createDashboard({ ledger: fakeLedger([]) }), TypeError);
    });

    test('renderIndexPage renders a full HTML document with zero running sprints', async () => {
        const dashboard = createDashboard({
            ledger: fakeLedger([]),
            watchdog: fakeWatchdog({}),
        });
        const html = await dashboard.renderIndexPage();
        assert.ok(html.startsWith('<!DOCTYPE html>'));
        assert.ok(html.includes('No sprints are currently running'));
    });
});

describe('dashboard -- registerDashboardRoutes / GET /', () => {
    function request(supervisor, method, path) {
        return new Promise((resolve, reject) => {
            const req = {
                method,
                url: path,
                on() {},
            };
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

    test('GET / serves the rendered index page as text/html', async () => {
        const dashboard = createDashboard({
            ledger: fakeLedger([{ sprintId: 'sprint-1', members: ['alice'], issueRoots: ['r1'], childPid: 1 }]),
            watchdog: fakeWatchdog({ 'sprint-1': WATCHDOG_STATUS.RUNNING_HEALTHY }),
            expandScope: async () => new Set(['r1']),
        });
        const supervisor = createSupervisor({ logger: { log() {}, error() {} } });
        registerDashboardRoutes(supervisor, dashboard);

        const res = await request(supervisor, 'GET', '/');
        assert.equal(res.statusCode, 200);
        assert.ok(res.headers['content-type'].includes('text/html'));
        assert.ok(res.body.includes('sprint-1'));
        assert.ok(res.body.includes('/sprints/sprint-1/live'));
    });
});

describe('dashboard -- renderIndexPageHtml', () => {
    test('never throws regardless of input shape', () => {
        assert.doesNotThrow(() => renderIndexPageHtml());
        assert.doesNotThrow(() => renderIndexPageHtml(null));
        assert.doesNotThrow(() => renderIndexPageHtml([]));
    });
});
