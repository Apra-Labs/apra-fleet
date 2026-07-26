import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';
import { createWatchdog } from '../src/supervisor/watchdog.mjs';
import { isPidAlive } from '../src/supervisor/reconcile.mjs';
import { createDashboard, registerDashboardRoutes } from '../src/supervisor/dashboard.mjs';
import { createBacklog } from '../src/supervisor/backlog.mjs';
import { buildLaunchRequestBody } from '../src/supervisor/launch-form.mjs';
import { createSprintController, registerSprintRoutes } from '../src/supervisor/api.mjs';
import { createLiveProxy, registerLiveRoutes } from '../src/supervisor/proxy.mjs';
import { createHistoryView, registerHistoryViewRoutes } from '../src/supervisor/history-view.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';

// =============================================================================
// apra-fleet-eft.6.6 -- dashboard integration: stack, backlog exclusion,
// partial-claim, live proxy, history.
//
// Wires the REAL eft.6 collaborators (dashboard, backlog, launch-form's target
// endpoint, live proxy, history-view) onto ONE supervisor instance and drives
// them end to end through a single sprint's lifecycle, launched via the REAL
// createSpawner()/createSprintController() production code path against a
// lightweight fixture child (test/fixtures/dashboard/viewer-child.mjs) standing
// in for bin/cli.mjs's HTTP viewer surface. Covers all eight acceptance cases:
//   (a) the index shows the sprint stack with live status badges, Backlog last
//   (b) the claimed bead is excluded from the Backlog and never duplicated
//   (c) a partial-claim annotation renders for the mixed epic
//   (d) the launch form produces a valid POST /api/sprints including the goal
//   (e) /sprints/:id/live proxies HTTP + SSE against the REAL running child
//   (f) the same URL serves the historical view once the sprint finishes
//   (g) that history render has zero live process, zero /events subscription
//   (h) the finished sprint is absent from the live stack
// Every spawned child pid is tracked and force-killed in an after() hook so no
// orphan survives even if a test fails mid-flight.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWER_FIXTURE = path.join(__dirname, 'fixtures/dashboard/viewer-child.mjs');

const silentLogger = { log() {}, error() {} };

// -- global pid/tmp-dir cleanup: tracked regardless of pass/fail -------------
/** @type {Set<number>} */
const spawnedPids = new Set();
/** @type {Set<string>} */
const tmpDirs = new Set();

function track(pid) {
    if (Number.isInteger(pid) && pid > 0) spawnedPids.add(pid);
    return pid;
}

function forceKill(pid) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

after(async () => {
    for (const pid of spawnedPids) forceKill(pid);
    spawnedPids.clear();
    for (const dir of tmpDirs) {
        // eslint-disable-next-line no-await-in-loop
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.clear();
});

function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function mkTmp(prefix) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpDirs.add(dir);
    return dir;
}

/** Poll until `pred()` is truthy or the deadline passes; throws on timeout. */
async function waitFor(pred, { timeoutMs = 10000, intervalMs = 50, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const val = await pred();
        if (val) return val;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        // eslint-disable-next-line no-await-in-loop
        await sleep(intervalMs);
    }
}

/** GET a path against a given host:port, resolving the full body once ended. */
function httpGet(port, urlPath, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const req = http.request({ host, port, path: urlPath, method: 'GET' }, (res) => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

/** POST a JSON body against a given host:port, resolving `{ status, json }`. */
function httpPostJson(port, urlPath, payload, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const body = Buffer.from(JSON.stringify(payload ?? {}), 'utf-8');
        const req = http.request({
            host, port, path: urlPath, method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': body.length },
        }, (res) => {
            let raw = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                let json = null;
                try { json = raw.length ? JSON.parse(raw) : null; } catch { json = null; }
                resolve({ status: res.statusCode, json });
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

/** Raw `bd list --json` row builder (parent-child grouping edge, eft.6.2 shape). */
function trackerBead(id, title, parentId, issueType = 'task') {
    const deps = parentId
        ? [{ issue_id: id, depends_on_id: parentId, type: 'parent-child' }]
        : [];
    return { id, title, issue_type: issueType, status: 'open', dependencies: deps };
}

describe('dashboard integration (apra-fleet-eft.6.6) -- stack, backlog, launch, live proxy, history', () => {
    let dataDir;
    let ledger;
    let history;
    let spawner;
    let watchdog;
    let backlog;
    let dashboard;
    let sprintController;
    let historyView;
    let liveProxy;
    let supervisor;
    let port;

    // A small mixed tracker: epic E with 5 children (c1..c5) plus a free root
    // f0 -- exactly the "mixed epic" shape acceptance case (c) needs.
    const allBeads = [
        trackerBead('E', 'Epic', null, 'epic'),
        trackerBead('c1', 'Child one', 'E'),
        trackerBead('c2', 'Child two', 'E'),
        trackerBead('c3', 'Child three', 'E'),
        trackerBead('c4', 'Child four', 'E'),
        trackerBead('c5', 'Child five', 'E'),
        trackerBead('f0', 'Free root', null),
    ];

    // Populated by the '(d) launch' test, consumed by every later test.
    let sprintId;
    let childPid;
    let childPort;

    before(async () => {
        dataDir = await mkTmp('eft66-dashboard-');

        ledger = createLedger({ filePath: path.join(dataDir, LEDGER_FILENAME) });
        await ledger.start();
        history = createHistory({ filePath: path.join(dataDir, HISTORY_FILENAME) });
        await history.start();

        // The REAL spawner, launching the lightweight viewer-child.mjs fixture in
        // place of bin/cli.mjs -- a genuine detached OS process, not an in-test
        // http.createServer, satisfies case (e)'s "real child process".
        spawner = createSpawner({
            command: process.execPath,
            cliPath: VIEWER_FIXTURE,
            env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir },
            logger: silentLogger,
        });

        // Mirrors proxy.mjs's own defaultResolvePort: sprintId -> ledger childPid
        // -> spawner's live pid->port bookkeeping.
        function resolvePort(id) {
            const entry = ledger.get(id);
            const pid = entry && entry.childPid;
            if (!Number.isInteger(pid)) return undefined;
            const live = spawner.getLiveEntry(pid);
            return live && Number.isInteger(live.port) ? live.port : undefined;
        }

        watchdog = createWatchdog({
            ledger,
            env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir },
            resolvePort,
            logger: silentLogger,
        });

        backlog = createBacklog({
            ledger,
            listAllBeads: () => allBeads,
            expandScope: async (roots) => new Set(roots),
            watchdog,
            logger: silentLogger,
        });

        dashboard = createDashboard({
            ledger,
            watchdog,
            expandScope: async (roots) => new Set(roots),
            backlog,
            logger: silentLogger,
        });

        sprintController = createSprintController({
            ledger,
            history,
            spawner,
            listMembers: () => ({ members: [{ name: 'alice' }] }),
            getBacklog: () => ({ tasks: [] }),
        });

        historyView = createHistoryView({ env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir }, logger: silentLogger });
        liveProxy = createLiveProxy({
            ledger,
            spawner,
            renderHistory: (id) => historyView.renderForSprint(id),
            logger: silentLogger,
        });

        supervisor = createSupervisor({ port: 0, ledger, spawner, watchdog, dashboard, logger: silentLogger });
        registerDashboardRoutes(supervisor, dashboard);
        registerSprintRoutes(supervisor, sprintController);
        registerLiveRoutes(supervisor, liveProxy);
        registerHistoryViewRoutes(supervisor, historyView);

        await supervisor.start();
        port = supervisor.server.address().port;
    });

    after(async () => {
        await supervisor.stop('test');
    });

    // -------------------------------------------------------------------------
    // (d) launch form -> POST /api/sprints, including the goal; spawns the
    // real child every later test drives.
    // -------------------------------------------------------------------------
    test('(d) the launch form produces a valid POST /api/sprints body, including the goal', async () => {
        const built = buildLaunchRequestBody({
            selectedRoots: ['c1'],
            members: ['alice'],
            goal: 'P1',
            branch: 'feat/eft66-itest',
            base: 'main',
        });
        assert.equal(built.ok, true, `expected a valid request body: ${built.error}`);
        assert.deepEqual(built.body, {
            issue: 'c1', members: ['alice'], branch: 'feat/eft66-itest', base: 'main', goal: 'P1',
        });

        const res = await httpPostJson(port, '/api/sprints', built.body);
        assert.equal(res.status, 201, JSON.stringify(res.json));
        assert.equal(res.json.goal, 'P1', 'the per-request goal must be forwarded and echoed back');
        assert.deepEqual(res.json.issueRoots, ['c1']);
        assert.ok(typeof res.json.sprintId === 'string' && res.json.sprintId.length > 0);
        assert.ok(Number.isInteger(res.json.pid) && res.json.pid > 0);
        assert.ok(Number.isInteger(res.json.port) && res.json.port > 0);

        sprintId = res.json.sprintId;
        childPid = track(res.json.pid);
        childPort = res.json.port;

        // Wait for the real child to actually be answering before any later test
        // depends on it.
        await waitFor(async () => {
            try {
                const r = await httpGet(childPort, '/state');
                return r.status === 200;
            } catch {
                return false;
            }
        }, { label: 'viewer-child /state to answer' });
    });

    // -------------------------------------------------------------------------
    // (a) index shows the sprint stack with a live status badge, Backlog last
    // -------------------------------------------------------------------------
    test('(a) GET / shows the live sprint in the stack with a status badge, Backlog rendered last', async () => {
        const res = await httpGet(port, '/');
        assert.equal(res.status, 200);
        assert.ok(res.headers['content-type'].includes('text/html'));

        const stackIdx = res.body.indexOf('id="sprint-stack"');
        const backlogIdx = res.body.indexOf('id="backlog"');
        assert.ok(stackIdx !== -1 && backlogIdx !== -1);
        assert.ok(backlogIdx > stackIdx, 'Backlog must render after the sprint stack');

        assert.ok(res.body.includes('data-sprint-id="' + sprintId + '"'), 'the launched sprint must appear in the stack');
        // The watchdog probes real PID liveness + real HTTP reachability -- the
        // child is genuinely up, so it must classify running-healthy.
        assert.ok(res.body.includes('>running-healthy<'), res.body);
        assert.ok(res.body.includes('/sprints/' + sprintId + '/live'), 'a supervisor-relative live-view link must be present');
    });

    // -------------------------------------------------------------------------
    // (b) claimed bead excluded from Backlog, never duplicated
    // -------------------------------------------------------------------------
    test('(b) the claimed bead (c1) is excluded from the Backlog and never duplicated', async () => {
        const res = await httpGet(port, '/');
        assert.equal(res.status, 200);
        // c1 is claimed by the just-launched sprint: it must not appear anywhere
        // in the Backlog tree.
        assert.ok(!res.body.includes('data-bead-id="c1"'), 'claimed bead c1 must not appear in the Backlog');
        // The free root and the free siblings are still present, each exactly once.
        for (const id of ['f0', 'c2', 'c3', 'c4', 'c5']) {
            const marker = 'data-bead-id="' + id + '"';
            const first = res.body.indexOf(marker);
            const last = res.body.lastIndexOf(marker);
            assert.notEqual(first, -1, `${id} should still be free in the Backlog`);
            assert.equal(first, last, `${id} must not be duplicated on the page`);
        }
    });

    // -------------------------------------------------------------------------
    // (c) partial-claim annotation on the mixed epic
    // -------------------------------------------------------------------------
    test('(c) the partially-claimed epic E carries a partial-claim annotation naming the sprint', async () => {
        const res = await httpGet(port, '/');
        assert.equal(res.status, 200);
        assert.ok(res.body.includes('data-bead-id="E"'), 'the free (partially-claimed) epic must stay in the Backlog');
        assert.ok(res.body.includes('data-partial-claim="true"'));
        assert.ok(
            res.body.includes('1 of 5 children claimed by ' + sprintId + '; 4 free'),
            'expected the exact "N of M children claimed by <sprint>; K free" annotation',
        );
    });

    // -------------------------------------------------------------------------
    // (e) /sprints/:id/live proxies HTTP + SSE against the REAL running child
    // -------------------------------------------------------------------------
    test('(e) /sprints/:id/live proxies the HTML (rewritten, no port leak) and streams SSE incrementally', async () => {
        const htmlRes = await httpGet(port, `/sprints/${sprintId}/live`);
        assert.equal(htmlRes.status, 200);
        assert.ok(htmlRes.headers['content-type'].includes('text/html'));
        const prefix = `/sprints/${sprintId}/live`;
        assert.ok(htmlRes.body.includes(`'${prefix}/events'`), htmlRes.body);
        assert.ok(!htmlRes.body.includes(String(childPort)), 'the real child port must never leak into the served HTML');

        // SSE: the first event must arrive before the (never-ending) stream
        // closes -- proving incremental, non-buffered delivery through the
        // supervisor proxy against the genuine child process.
        const first = await new Promise((resolve, reject) => {
            const req = http.request(
                { host: '127.0.0.1', port, path: `/sprints/${sprintId}/live/events`, method: 'GET' },
                (res) => {
                    assert.ok(res.headers['content-type'].includes('text/event-stream'));
                    res.setEncoding('utf-8');
                    res.once('data', (chunk) => resolve({ chunk, req }));
                    res.on('error', () => { /* aborted on purpose below */ });
                },
            );
            req.on('error', () => { /* client abort races the assertion; ignored */ });
            req.end();
        });
        assert.ok(first.chunk.includes('data: one'), first.chunk);
        // Disconnect before the second (delayed) event proves this was a live
        // stream, not a buffered whole-response write.
        first.req.destroy();
    });

    // -------------------------------------------------------------------------
    // (f)/(g) the sprint finishes -> the SAME URL serves the process-free
    // historical view, with zero live process and zero live-view controls.
    // -------------------------------------------------------------------------
    test('(f) once the sprint finishes, the same /sprints/:id/live URL serves the historical view', async () => {
        // Tell the real child (directly, on its own port -- the supervisor
        // generated sprintId only after spawning it, so the child could not know
        // its own id up front) to record its terminal state and exit, modeling a
        // completed sprint.
        const finishRes = await httpPostJson(childPort, '/finish', { sprintId });
        assert.equal(finishRes.status, 200, JSON.stringify(finishRes.json));

        // Wait for the real process to actually be gone AND its terminal state to
        // be on disk (both are genuine, not simulated).
        await waitFor(() => !isPidAlive(childPid), { label: 'viewer-child pid to exit' });
        await waitFor(async () => {
            try {
                await fsp.access(path.join(dataDir, 'old_sprints', `${sprintId}.json`));
                return true;
            } catch {
                return false;
            }
        }, { label: 'terminal state file to be written' });

        const res = await httpGet(port, `/sprints/${sprintId}/live`);
        assert.equal(res.status, 200);
        assert.ok(res.headers['content-type'].includes('text/html'));
        assert.ok(res.body.includes('data-view="history"'), 'the same URL must fall through to the History template');
    });

    test('(g) the historical render has zero live process and zero /events polling (Save/Stop absent)', async () => {
        // The real child pid stayed dead across this test too.
        assert.equal(isPidAlive(childPid), false, 'the sprint child must genuinely be gone (zero live process)');

        const res = await httpGet(port, `/sprints/${sprintId}/live`);
        assert.equal(res.status, 200);
        assert.ok(!res.body.includes("new EventSource('/events')"), 'must never open an SSE subscription');
        assert.ok(!res.body.includes('<button class="btn btn-save"'), 'Save control must be absent');
        assert.ok(!res.body.includes('<button class="btn btn-stop"'), 'Stop control must be absent');
        // The frozen terminal state's own content is embedded (proves the render
        // came from old_sprints/, not a live proxy pass-through).
        assert.ok(res.body.includes('itest sprint'), res.body);
    });

    // -------------------------------------------------------------------------
    // (h) finished sprints are absent from the live stack
    // -------------------------------------------------------------------------
    test('(h) the finished sprint no longer appears in the live sprint-stack', async () => {
        const res = await httpGet(port, '/');
        assert.equal(res.status, 200);
        assert.ok(
            !res.body.includes('data-sprint-id="' + sprintId + '"'),
            'a finished sprint must be excluded from the live stack entirely',
        );
        // Directly on the seam too, not just the rendered page.
        const views = await dashboard.buildSprintViews();
        assert.ok(!views.some((v) => v.sprintId === sprintId));

        // Bonus consistency check: since the sprint is no longer active (per the
        // watchdog), its claimed bead returns to the Backlog.
        assert.ok(res.body.includes('data-bead-id="c1"'), 'c1 should return to the Backlog once its sprint has finished');
    });
});
