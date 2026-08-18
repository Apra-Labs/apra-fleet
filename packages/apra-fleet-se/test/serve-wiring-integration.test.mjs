import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

// =============================================================================
// apra-fleet-eft.4.8.3 -- verification for eft.4.8: boots the REAL
// `bin/serve.mjs` (not the seams directly) on an ephemeral port and proves
// the dashboard/backlog/launch-form/sprint-api/watchdog seams eft.4.8.1 wired
// in are genuinely live, not the inert server.mjs stubs.
//
// This intentionally does NOT construct the seams in-process the way
// supervisor-dashboard-integration.test.mjs does -- that suite proves the
// seams work together; THIS suite proves bin/serve.mjs itself imports,
// constructs, and registers them. Run against the pre-fix stub serve.mjs
// (no real watchdog/dashboard collaborators, no registerSprintRoutes()/
// registerDashboardRoutes() calls) every assertion below fails: /api/health
// reports "watchdog:stub"/"dashboard:stub", GET / 404s (no dashboard route
// registered), and POST /api/sprints 404s (no sprint routes registered).
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVE_BIN = path.join(__dirname, '../bin/serve.mjs');
const SE_PKG_ROOT = path.join(__dirname, '..');

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

/** Allocate a currently-free TCP port by binding to 0 and reading it back. */
function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

/** Poll until `pred()` is truthy or the deadline passes; throws on timeout. */
async function waitFor(pred, { timeoutMs = scaledTimeout(15000), intervalMs = 100, label = 'condition' } = {}) {
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

/** GET a path against a given host:port, resolving `{ status, headers, body }`. */
function httpGet(port, urlPath, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const req = http.request({ host, port, path: urlPath, method: 'GET', timeout: scaledTimeout(5000) }, (res) => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('timeout', () => { req.destroy(new Error('request timeout')); });
        req.on('error', reject);
        req.end();
    });
}

/** POST a JSON body against a given host:port, resolving `{ status, json }`. */
function httpPostJson(port, urlPath, payload, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const body = Buffer.from(JSON.stringify(payload ?? {}), 'utf-8');
        const req = http.request({
            host, port, path: urlPath, method: 'POST', timeout: scaledTimeout(5000),
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
        req.on('timeout', () => { req.destroy(new Error('request timeout')); });
        req.on('error', reject);
        req.end(body);
    });
}

describe('serve.mjs wiring integration (apra-fleet-eft.4.8.3) -- boot the real supervisor process', () => {
    let serve;
    let port;

    // The suite shares ONE real `fleet-se serve` subprocess across every
    // assertion below (matching supervisor-lifecycle.test.mjs's (a) case):
    // each test below exercises a different route against the same live
    // process, so a single boot proves all the seams together.
    test('boots bin/serve.mjs as a real subprocess on an ephemeral port', async () => {
        const dataDir = await mkTmp('eft483-serve-data-');
        const seDataDir = await mkTmp('eft483-serve-se-');
        port = await getFreePort();

        serve = spawn(process.execPath, [SERVE_BIN, '--port', String(port)], {
            cwd: SE_PKG_ROOT,
            stdio: ['ignore', 'ignore', 'ignore'],
            env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir, FLEET_SE_DATA_DIR: seDataDir },
        });
        track(serve.pid);

        // apra-fleet-ryk / apra-fleet-33c.1: same contention-starvation fix
        // already applied to the GET / wait below -- this boot-wait must also
        // pass concurrency explicitly, since plain `npm test` (unlike
        // scripts/run-tests.mjs) invokes `node --test --test-concurrency=8`
        // without exporting APRA_FLEET_TEST_CONCURRENCY, so scaledTimeout()
        // silently fell back to its unscaled 15s baseMs while genuinely
        // running 8-wide, starving the real-subprocess boot under contention
        // (observed CI failure: timed out at ~15116ms).
        await waitFor(async () => {
            try {
                const res = await httpGet(port, '/api/health');
                return res.status === 200;
            } catch {
                return false;
            }
        }, { timeoutMs: scaledTimeout(15000, { concurrency: 8 }), label: 'supervisor /api/health to answer' });
    });

    after(async () => {
        if (!serve) return;
        try {
            await httpGet(port, '/api/health');
            await httpPostJson(port, '/api/shutdown', {});
        } catch { /* already gone */ }
        if (serve.pid) forceKill(serve.pid);
    });

    test('GET /api/health reports the watchdog and dashboard seams as real modules, not stubs', async () => {
        const res = await httpGet(port, '/api/health');
        assert.equal(res.status, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.status, 'ok');
        assert.ok(body.seams, 'expected a seams map in the health payload');

        // The eft.4.8.1 fix is specifically that these two collaborators are no
        // longer server.mjs's inert makeSeamStub() default (which self-reports
        // as "<name>:stub").
        assert.equal(body.seams.watchdog, 'watchdog', `watchdog seam must be the real module, got ${body.seams.watchdog}`);
        assert.notEqual(body.seams.watchdog, 'watchdog:stub');
        assert.equal(body.seams.dashboard, 'dashboard', `dashboard seam must be the real module, got ${body.seams.dashboard}`);
        assert.notEqual(body.seams.dashboard, 'dashboard:stub');
    });

    test('GET / returns 200 with the Sprint Stack, Backlog, and Launch Sprint markers', async () => {
        // apra-fleet-04g.3.1: unlike /api/health above, the '/' route renders
        // the full dashboard (renderBeadsHtml over real bd), which on first
        // hit under CPU contention (e.g. --test-concurrency=8) can exceed the
        // per-request scaledTimeout(5000) in httpGet. Retry via the same
        // waitFor() pattern used for the /api/health boot-check above until
        // the route answers 200, then run the body-marker assertions once
        // against that response -- this tolerates first-render latency
        // without weakening any assertion below.
        //
        // apra-fleet-33c.1: the package's plain `npm test` script (unlike
        // scripts/run-tests.mjs's test:unit/test:integration/test:record
        // modes) invokes `node --test --test-concurrency=8 ...` directly
        // without exporting APRA_FLEET_TEST_CONCURRENCY, so scaledTimeout()
        // silently fell back to its unscaled 15s baseMs even though the
        // suite really was running 8-wide -- starving this real-subprocess
        // boot under contention and making `npm test` non-deterministic.
        // Pass the concurrency explicitly (matching the --test-concurrency
        // value both the plain `test` script and run-tests.mjs use) so this
        // boot-check always gets the full contention-aware budget regardless
        // of which script invoked the suite or whether that env var is set.
        const res = await waitFor(async () => {
            try {
                const attempt = await httpGet(port, '/');
                return attempt.status === 200 ? attempt : false;
            } catch {
                return false;
            }
        }, { timeoutMs: scaledTimeout(15000, { concurrency: 8 }), label: 'GET / to render the dashboard' });
        assert.equal(res.status, 200, res.body);
        assert.ok(res.headers['content-type'].includes('text/html'), res.headers['content-type']);
        // supervisor-viewer-parity: section labels are now `.panel-header`
        // text inside a Sprints/Backlog tab layout (matching apra-fleet-
        // workflow's per-sprint viewer chrome -- see dashboard.mjs's
        // DASHBOARD_CSS), not standalone <h1> tags; the page's one <h1> is
        // the page title.
        assert.ok(res.body.includes('class="panel-header">Sprint Stack</div>'), 'expected the Sprint Stack section');
        assert.ok(res.body.includes('class="panel-header">Backlog</div>'), 'expected the Backlog section');
        assert.ok(res.body.includes('id="backlog"'), 'expected the Backlog seam-rendered container');
        assert.ok(res.body.includes('id="backlog-table"'), 'expected the rich beads-tree table container (renderBeadsHtml)');
        assert.ok(res.body.includes('class="panel-header"'), 'expected launch-sprint panel-header markup');
        assert.ok(res.body.includes('>Launch Sprint</div>'), 'expected the Launch Sprint form section');
        assert.ok(res.body.includes('id="tab-sprints"') && res.body.includes('id="tab-backlog"'), 'expected the Sprints/Backlog tabs');

        // supervisor-viewer-parity (quick-tasks follow-up): Launch Sprint now
        // lives in the Backlog tab, below the backlog table -- launching
        // starts from picking rows out of the Backlog, so the two share a
        // tab. Sprint Stack (its own tab) still renders first in raw
        // document order, then Backlog, then Launch Sprint within it.
        const stackIdx = res.body.indexOf('id="sprint-stack"');
        const backlogIdx = res.body.indexOf('id="backlog"');
        const launchIdx = res.body.indexOf('id="launch-form"');
        assert.ok(stackIdx < backlogIdx, 'expected Sprint Stack before the Backlog tab');
        assert.ok(backlogIdx < launchIdx, 'expected Launch Sprint after the Backlog table, within the Backlog tab');
    });

    test('POST /api/sprints reaches the real sprint controller (validation error, not 404)', async () => {
        // An intentionally-invalid body (no issue/branch/base/members): the
        // pre-fix stub serve.mjs never called registerSprintRoutes(), so this
        // route did not exist at all and every request 404'd. Once wired, the
        // request reaches createSprintController()'s validateLaunchRequest()
        // and fails with a real 400 naming the missing field -- proving the
        // controller (and its ledger/spawner/history collaborators) is live
        // without needing to actually spawn a sprint child.
        const res = await httpPostJson(port, '/api/sprints', {});
        assert.notEqual(res.status, 404, JSON.stringify(res.json));
        assert.equal(res.status, 400, JSON.stringify(res.json));
        assert.ok(res.json && typeof res.json.error === 'string' && res.json.error.length > 0);
        assert.equal(res.json.field, 'issue');
    });
});
