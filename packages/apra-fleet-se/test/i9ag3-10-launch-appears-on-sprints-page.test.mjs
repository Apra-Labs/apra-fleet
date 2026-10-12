// apra-fleet-i9ag.3.10 -- a sprint launched from the embedded launch form
// (GET + POST on <mount>/api/sprints) then shows up as a card on the embedded
// Sprints page, with live/log hrefs rooted under the mount prefix.
//
// i9ag34-sprints-console-hop-e2e.test.mjs asserts the launch POST target is
// reachable and authorised but deliberately launches nothing. THIS file closes
// the other half: it launches a REAL mock sprint -- a real detached OS child
// (test/fixtures/spawner/viewer-state-stub.mjs, spawned by the REAL spawner,
// listening on its viewer port) -- through the REAL sprint controller routes,
// then polls the REAL dashboard (/state and the Sprints page) until the card
// appears. The console /ext hop itself is simulated by stamping the same mount
// path header it stamps (MOUNT_PATH_HEADER); the console side of the hop is
// covered by tests/i9ag34-sprints-console-hop-e2e.test.ts.
//
// Real child spawn => registered in the serial lane (serial-process-suites.mjs).
// Every wait is a bounded poll on real state; no fixed sleeps; ports bind :0 or
// are probed free; the child is killed and temp dirs removed in after().

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME, HISTORY_EVENTS } from '../src/supervisor/history.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';
import { createWatchdog } from '../src/supervisor/watchdog.mjs';
import { createDashboard, registerDashboardRoutes } from '../src/supervisor/dashboard.mjs';
import { createSprintController, registerSprintRoutes } from '../src/supervisor/api.mjs';
import { createChildPortResolver } from '../src/supervisor/child-port.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { MOUNT_PATH_HEADER } from '../src/supervisor/mount-prefix.mjs';
import { SPRINTS_UI_PATH, PACKAGE_ID } from '../src/registration/manifest.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures/spawner/viewer-state-stub.mjs');
const MOUNT_PREFIX = `/ext/${PACKAGE_ID}`;
const WAIT_MS = scaledTimeout(20000, { concurrency: TEST_CONCURRENCY, multiplier: 4 });

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    });
}

function req(port, method, urlPath, { body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const h = { [MOUNT_PATH_HEADER]: MOUNT_PREFIX, ...headers };
        if (payload) { h['content-type'] = 'application/json'; h['content-length'] = payload.length; }
        const r = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: h, timeout: 8000 }, (res) => {
            let raw = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { raw += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: raw }));
        });
        r.on('timeout', () => r.destroy(new Error('request timeout: ' + method + ' ' + urlPath)));
        r.on('error', reject);
        if (payload) r.write(payload);
        r.end();
    });
}

async function waitFor(pred, label) {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const v = await pred();
        if (v) return v;
        if (Date.now() > deadline) throw new Error(`timed out after ${WAIT_MS}ms waiting for ${label}`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 100));
    }
}

describe('apra-fleet-i9ag.3.10: a sprint launched from the embedded launch form appears on the embedded Sprints page', () => {
    let dir;
    let sup;
    let ledger;
    let history;
    let spawner;
    let supPort;
    const pids = new Set();

    before(async () => {
        dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'i9ag3-10-'));
        ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME) });
        await ledger.start();
        history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME) });
        await history.start();
        spawner = createSpawner({
            command: process.execPath,
            cliPath: FIXTURE,
            basePort: await freePort(),
            dataDir: dir,
            onChildExit: async ({ runId, exitCode, signal, at, logPath }) => {
                if (!runId) return;
                await history.record({ sprintId: runId, event: HISTORY_EVENTS.CHILD_EXITED, exitCode, signal, at, logPath });
                await ledger.recordExit(runId, { exitCode, signal, at });
            },
        });
        const resolvePort = createChildPortResolver({ ledger, spawner });
        const watchdog = createWatchdog({ ledger, resolvePort, history });
        const dashboard = createDashboard({
            ledger, watchdog, resolvePort,
            listAllBeads: async () => [],
            expandScope: async (roots) => new Set(roots),
            logger: { log() {}, error() {} },
        });
        const controller = createSprintController({
            ledger, history, spawner,
            listMembers: () => ({ members: [] }),
            getBacklog: () => ({ tasks: [] }),
            // The controller maps a child PID (not a sprintId) to its viewer port.
            resolvePort: (pid) => spawner.getLiveEntry(pid)?.port,
        });
        sup = createSupervisor({ port: 0 });
        registerSprintRoutes(sup, controller);
        registerDashboardRoutes(sup, dashboard, { extraIndexPaths: [SPRINTS_UI_PATH] });
        await sup.start();
        supPort = sup.server.address().port;
    });

    after(async () => {
        for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
        for (const step of [() => sup?.stop('test'), () => ledger?.stop(), () => history?.stop()]) {
            try { await step(); } catch { /* best-effort cleanup */ }
        }
        if (dir) await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    });

    test('GET + POST /api/sprints launches a real mock sprint whose card then appears with mount-rooted live/log hrefs', async () => {
        const before_ = await req(supPort, 'GET', '/api/sprints');
        assert.equal(before_.status, 200);
        assert.deepEqual(JSON.parse(before_.body).sprints, []);

        const launched = await req(supPort, 'POST', '/api/sprints', {
            body: { issue: 'EPIC-1', members: ['alice'], branch: 'feat/i9ag3-10', base: 'main' },
        });
        assert.equal(launched.status, 201, `launch answered ${launched.status}: ${launched.body}`);
        const { sprintId, pid } = JSON.parse(launched.body);
        assert.ok(sprintId, 'launch must return a sprintId');
        if (Number.isInteger(pid)) pids.add(pid);
        const reservation = ledger.get(sprintId);
        if (reservation && Number.isInteger(reservation.childPid)) pids.add(reservation.childPid);

        const state = await waitFor(async () => {
            const r = await req(supPort, 'GET', '/state');
            if (r.status !== 200) return false;
            const body = JSON.parse(r.body);
            return body.sprints.some((s) => s.sprintId === sprintId) ? body : false;
        }, `sprint ${sprintId} in GET /state`);
        assert.ok(state.sprints.find((s) => s.sprintId === sprintId));

        // ... and in the embedded Sprints page's HTML, with mount-rooted links.
        const html = await waitFor(async () => {
            const r = await req(supPort, 'GET', SPRINTS_UI_PATH);
            return r.status === 200 && r.body.includes(`/sprints/${sprintId}/live`) ? r.body : false;
        }, `sprint ${sprintId}'s card on ${SPRINTS_UI_PATH}`);
        const liveHref = `${MOUNT_PREFIX}/sprints/${sprintId}/live`;
        const logHref = `${MOUNT_PREFIX}/sprints/${sprintId}/log`;
        assert.ok(html.includes(`href="${liveHref}"`), `live href must be rooted under ${MOUNT_PREFIX}`);
        assert.ok(html.includes(`href="${logHref}"`), `log href must be rooted under ${MOUNT_PREFIX}`);
        assert.ok(!html.includes(`href="/sprints/${sprintId}/`), 'no card link may be rooted at the bare /');

        // The launch watcher's own poll is never a 5xx and reports the child live.
        const watch = await waitFor(async () => {
            const r = await req(supPort, 'GET', `/api/sprints/${encodeURIComponent(sprintId)}`);
            assert.ok(r.status < 500, `watcher poll got ${r.status}`);
            const body = JSON.parse(r.body);
            return body.live === true ? body : false;
        }, 'the launch watcher to see the child live');
        assert.equal(watch.state.status, 'running');
    });
});
