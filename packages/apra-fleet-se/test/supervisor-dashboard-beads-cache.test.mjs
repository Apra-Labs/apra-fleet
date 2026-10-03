// Dashboard (/state, GET /) and backlog panel served from the cached beads view:
// no bulk bd fetch per SSE tick, non-blocking stale refresh, visible freshness,
// backlog parity with the old open-only default fetch.
//
// Real createBeadsView + real doltPullBefore over a fake member command, real
// createDashboard/createBacklog and registerDashboardRoutes (fake route table).
//
// The dashboard and backlog are built through bin/serve.mjs's exported
// createBeadsBackedViews() -- the very function serveMain calls -- not rebuilt
// here. The "wiring reads the cache" test uses bead ids that exist only in the
// injected view. Reverting `listAllBeads: dashboardRows` (dashboard.mjs would
// default to bdListAllBeadsWithClosed) fails its /state beadCount assertion
// (root-only count 1, not 2); reverting `listAllBeads: backlogRows`
// (backlog.mjs defaults to bdListAllBeadsRaw) fails its backlog VIEW-ONLY-3
// assertion. Neither depends on bd being installed or on timing.

import { describe, test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBeadsView } from '../src/supervisor/beads-view.mjs';
import { registerDashboardRoutes } from '../src/supervisor/dashboard.mjs';
import { createBacklog } from '../src/supervisor/backlog.mjs';
import { createBeadsBackedViews } from '../bin/serve.mjs';
import { createLedger } from '../src/supervisor/ledger.mjs';
import { clearLastSyncedTip, clearTipProbeFailures, invalidateSyncRemoteCache } from '../fleet-sprint/dolt-sync.mjs';

const SHA_A = 'a'.repeat(40);
const QUIET = { log() {}, warn() {}, error() {} };
const T0 = Date.parse('2026-10-01T00:00:00Z');

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const reset = () => { clearLastSyncedTip(); clearTipProbeFailures(); invalidateSyncRemoteCache(); };
beforeEach(reset);
afterEach(reset);

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

const bead = (id, status = 'open', parent = null) => ({
    id, title: 'title ' + id, status, issue_type: 'task', priority: 2,
    dependencies: parent ? [{ type: 'parent-child', issue_id: id, depends_on_id: parent }] : [],
});
const ALL_ROWS = [bead('E-1'), bead('E-1.1', 'open', 'E-1'), bead('E-1.2', 'closed', 'E-1'), bead('E-2'), bead('E-3', 'closed')];
const OPEN_ROWS = ALL_ROWS.filter((r) => r.status !== 'closed');

function fakeCommand(state) {
    return async (cmd) => {
        if (cmd.startsWith('bd config get sync.remote')) return { ok: true, output: JSON.stringify({ key: 'sync.remote', value: 'git+https://example.test/o/b.git' }) };
        if (cmd.includes(' ls-remote ')) return { ok: true, output: `${SHA_A}\trefs/dolt/data\n` };
        if (cmd === 'bd dolt pull') { state.pulls += 1; return { ok: true, output: '' }; }
        return { ok: false, error: `unexpected command: ${cmd}` };
    };
}

async function setup({ rows = ALL_ROWS, roots = ['E-1'], backlogMember, viewOpts = {} } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-cache-'));
    tmpDirs.push(dir);
    const ledger = createLedger({ filePath: path.join(dir, 'ledger.json') });
    await ledger.start();
    await ledger.claim('S-1', { issueRoots: roots, members: ['zed'], childPid: null });
    const mem = { pulls: 0 };
    const list = { calls: 0 };
    const clock = { now: T0 };
    const view = createBeadsView({
        backlogMember: backlogMember ?? { get: () => ({ member: { name: 'bm' }, status: 'ready', reason: null }) },
        ledger,
        command: fakeCommand(mem),
        repoRoot: dir,
        listAllBeads: async () => { list.calls += 1; return rows; },
        now: () => clock.now,
        logger: QUIET,
        ...viewOpts,
    });
    const watchdog = { classifySprint: async () => ({ status: 'running' }) };
    const probe = { snapshots: 0, refreshChecks: 0 };
    const countingView = {
        ...view,
        snapshot: () => { probe.snapshots += 1; return view.snapshot(); },
        refreshIfStale: (...a) => { probe.refreshChecks += 1; return view.refreshIfStale(...a); },
    };
    const { backlog, dashboard } = createBeadsBackedViews({
        ledger, watchdog, beadsView: countingView,
        resolvePort: () => undefined,
        driftCheck: () => null,
        logger: QUIET,
    });
    const routes = {};
    registerDashboardRoutes({ route: (m, p, h) => { routes[`${m} ${p}`] = h; } }, dashboard);
    async function get(p) {
        const res = { head: null, body: null, writeHead(s, h) { this.head = { s, h }; }, end(b) { this.body = b; } };
        await routes[`GET ${p}`]({}, res);
        return { status: res.head.s, text: res.body.toString('utf-8') };
    }
    return { ledger, mem, list, clock, view, probe, dashboard, backlog, get };
}

describe('dashboard serves the cached beads view: no bulk fetch per render', () => {
    test('serve.mjs wiring reads the cache: view-only rows reach /state and the backlog tree, via snapshot()', async () => {
        const t = await setup({
            roots: ['VIEW-ONLY-1'],
            rows: [bead('VIEW-ONLY-1'), bead('VIEW-ONLY-1.1', 'open', 'VIEW-ONLY-1'), bead('VIEW-ONLY-2', 'closed'), bead('VIEW-ONLY-3')],
        });
        await t.view.refresh();
        const before = t.probe.snapshots;
        const page = await t.get('/');
        assert.equal(page.status, 200);
        assert.ok(t.probe.snapshots > before, 'dashboard render consulted the view snapshot');
        assert.ok(t.probe.refreshChecks > 0, 'stale refresh kicked through the view');
        assert.match(page.text, /VIEW-ONLY-3/, 'backlog rows came from the cache, not a default bd fetch');
        const state = JSON.parse((await t.get('/state')).text);
        assert.equal(state.sprints[0].beadCount, 2, 'dashboard claimed-scope count came from cached rows (root + child exist only in the view)');
        assert.doesNotMatch(page.text, /VIEW-ONLY-2/, 'closed bead excluded from the backlog');
    });

    test('10 GET /state renders inside the stale window cause 0 listAllBeads / pull calls beyond the view\'s own refresh', async () => {
        const t = await setup();
        await t.view.refresh();
        assert.equal(t.list.calls, 1);
        const pulls = t.mem.pulls;
        for (let i = 0; i < 10; i += 1) {
            const res = await t.get('/state');
            assert.equal(res.status, 200);
        }
        assert.equal(t.list.calls, 1, 'no list beyond the refresh');
        assert.equal(t.mem.pulls, pulls, 'no pull either');
        // The claimed-scope count came from the cached rows (E-1 + 2 descendants).
        const body = JSON.parse((await t.get('/state')).text);
        assert.equal(body.sprints[0].beadCount, 3);
    });

    test('stale cache: /state returns while the refresh is pending; exactly one background refresh under concurrent requests', async () => {
        const gate = deferred();
        let armed = false;
        let pullCalls = 0;
        const t = await setup({
            viewOpts: {
                doltPullBefore: async () => { pullCalls += 1; if (armed) await gate.promise; return { skipped: false }; },
            },
        });
        await t.view.refresh();
        assert.equal(pullCalls, 1);
        armed = true;
        t.clock.now += 16_000; // older than the 15s bound
        const reqs = await Promise.race([
            Promise.all([t.get('/state'), t.get('/state'), t.get('/state')]),
            new Promise((_, rej) => setTimeout(() => rej(new Error('/state blocked on the refresh')), 2000)),
        ]);
        for (const r of reqs) assert.equal(r.status, 200);
        assert.equal(pullCalls, 2, 'exactly one background refresh for 3 concurrent stale requests');
        assert.equal(t.view.snapshot().refreshing, true, 'the refresh is still pending');
        gate.resolve();
        await t.view.refresh();
        assert.equal(t.view.snapshot().refreshing, false);
    });

    test('empty cache (no rows yet): /state and the page render succeed with unknown claimed counts', async () => {
        const t = await setup({ backlogMember: { get: () => ({ member: null, status: 'degraded', reason: 'no member' }) } });
        const state = await t.get('/state');
        assert.equal(state.status, 200);
        assert.equal(JSON.parse(state.text).sprints[0].beadCount, 1, 'degraded: scope is just the roots');
        const page = await t.get('/');
        assert.equal(page.status, 200);
        assert.match(page.text, /Fleet-Sprint Supervisor/);
        assert.equal(t.list.calls, 0);
    });
});

describe('dashboard shows the view freshness', () => {
    test('asOf renders "Beads as of"; /state carries it', async () => {
        const t = await setup();
        await t.view.refresh();
        const page = (await t.get('/')).text.split('<script>')[0]; // markup only: the inline live-refresh script also embeds these strings
        assert.match(page, /Beads as of 2026-10-01T00:00:00\.000Z/);
        assert.doesNotMatch(page, /Beads refresh failed/);
        const state = JSON.parse((await t.get('/state')).text);
        assert.equal(typeof state.beadsFreshness.asOf, 'string');
        assert.equal(state.beadsFreshness.lastError, null);
    });

    test('lastError renders a visible failure notice with the reason', async () => {
        const t = await setup({ backlogMember: { get: () => ({ member: null, status: 'degraded', reason: 'no member' }) } });
        await t.view.refresh();
        const page = (await t.get('/')).text.split('<script>')[0];
        assert.match(page, /Beads refresh failed/);
        assert.match(page, /no member/);
        assert.match(page, /Beads as of \(not yet synced\)/);
        assert.ok(/^[\x00-\x7F]*$/.test(page.match(/<div id="beads-freshness"[\s\S]*?<\/div><\/div>/)[0]), 'ASCII only');
    });

    test('a busy-skip is shown distinctly, not as a failure', async () => {
        let n = 0;
        const t = await setup({
            viewOpts: { doltPullBefore: async () => { n += 1; if (n === 2) throw new Error('database is locked'); return { skipped: false }; } },
        });
        await t.view.refresh();
        await t.view.refresh(); // busy skip
        const page = (await t.get('/')).text.split('<script>')[0];
        assert.match(page, /refresh deferred/);
        assert.doesNotMatch(page, /Beads refresh failed/);
    });

    test('after one successful view refresh, scopeFreshness.lastSyncedAt is non-null', async () => {
        const t = await setup();
        assert.equal(t.ledger.getScopeFreshness().lastSyncedAt, null);
        await t.view.refresh();
        assert.equal(typeof t.ledger.getScopeFreshness().lastSyncedAt, 'string');
    });
});

describe('backlog parity over the cached rows', () => {
    test('cache with open AND closed beads yields the same tree and task set as the old open-only fetch', async () => {
        const t = await setup({ rows: ALL_ROWS });
        await t.view.refresh();
        const old = createBacklog({ ledger: t.ledger, watchdog: { classifySprint: async () => ({ status: 'running' }) }, listAllBeads: async () => OPEN_ROWS });
        assert.deepEqual(await t.backlog.buildTree(), await old.buildTree());
        assert.deepEqual(await t.backlog.buildBacklogTasks(), await old.buildBacklogTasks());
        const ids = (await t.backlog.buildBacklogTasks()).tasks.map((x) => x.id);
        assert.ok(!ids.includes('E-3') && !ids.includes('E-1.2'), 'closed beads absent');
        assert.ok(ids.includes('E-2'));
    });

    test('backlog reads never spawn a list (reader serves the snapshot)', async () => {
        const t = await setup();
        await t.view.refresh();
        for (let i = 0; i < 5; i += 1) await t.backlog.buildBacklogTasks();
        assert.equal(t.list.calls, 1);
    });
});
