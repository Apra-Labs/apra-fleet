import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME, HISTORY_EVENTS } from '../src/supervisor/history.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';
import { createWatchdog, WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';
import { createSprintController, registerSprintRoutes } from '../src/supervisor/api.mjs';
import { createLogView, registerLogViewRoutes } from '../src/supervisor/log-view.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';

// =============================================================================
// apra-fleet-gey.3 -- end-to-end integration test for apra-fleet-gey (launch-
// failure fast path + diagnose-before-relaunch gate): drives a REAL spawned
// OS child process (test/fixtures/spawner/exit1-stderr-launch-fail.mjs, never
// a fake child_process.spawn), a REAL ledger/history/watchdog, and the REAL
// POST /api/sprints HTTP route (api.mjs), through the SAME collaborator
// wiring bin/serve.mjs uses, to prove -- against the real code, not mocks --
// that:
//
//   1. A sprint child exiting within the launch-failed window (apra-fleet-
//      gey.1) has its reservation auto-released, is classified LAUNCH_FAILED
//      (never the generic CRASHED), and its real captured stderr is reachable
//      as a "tail" via the already-shipped apra-fleet-ou7.2 GET
//      /sprints/:id/log?tail= route -- degrading to an explicit, never-silent
//      marker once that capture is no longer available on disk.
//   2. A same-issueRoot relaunch request (apra-fleet-gey.2) is refused with a
//      409 that names the prior incarnation and its failure reason, unless
//      the request carries the documented overrideRelaunchGate: true escape
//      hatch, which lets it proceed.
//   3. A relaunch response reports buildVersionWarning when the running
//      supervisor's stamped build differs from what is on disk right now.
//
// Deterministic throughout: the one genuinely async wait (the real OS child
// actually exiting) is a bounded poll (waitFor()), never a fixed sleep.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, 'fixtures/spawner/exit1-stderr-launch-fail.mjs');

async function tmpDir(prefix) {
    return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Poll until `predicate()` is truthy or the deadline passes; throws on timeout. */
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- intentional bounded poll
        const val = await predicate();
        if (val) return val;
        if (Date.now() >= deadline) {
            throw new Error(`timed out waiting for ${label}`);
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

/** GET a supervisor path, resolving the full body once the response ends. */
function getText(port, urlPath) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

/** POST a JSON body to a supervisor path, resolving the parsed JSON response. */
function postJson(port, urlPath, payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload ?? {});
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: urlPath,
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        }, (res) => {
            let raw = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                let parsed;
                try { parsed = raw.length > 0 ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

describe('apra-fleet-gey.3: launch-failure fast path and relaunch gate end to end', () => {
    let dir;
    let ledger;
    let history;
    let sup;

    after(async () => {
        for (const step of [
            () => sup?.stop('test'),
            () => ledger?.stop(),
            () => history?.stop(),
            () => (dir ? fsp.rm(dir, { recursive: true, force: true }) : undefined),
        ]) {
            try {
                // eslint-disable-next-line no-await-in-loop -- cleanup is intentionally sequential
                await step();
            } catch (err) {
                // eslint-disable-next-line no-console -- surfaced as TAP diagnostics, never a hook failure
                console.error('[gey3 cleanup] non-fatal:', err && err.message);
            }
        }
    });

    test('a real child exiting 1 in under 1s: auto-released, LAUNCH_FAILED (not CRASHED), a real stderr tail, and the relaunch gate', async () => {
        dir = await tmpDir('gey3-');
        ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME) });
        await ledger.start();
        history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME) });
        await history.start();

        // apra-fleet-gey.2: the running supervisor's stamped build (captured
        // ONCE at controller creation, the first call) differs from what
        // getBuildVersion() reports on every SUBSEQUENT call (what's "on disk
        // now") -- so every launch() through this controller reports a
        // buildVersionWarning, exercising criterion 3 without depending on
        // this module's own real on-disk mtime (which never changes mid-test).
        let buildVersionCalls = 0;
        const getBuildVersion = () => {
            buildVersionCalls += 1;
            return buildVersionCalls === 1 ? 'gey3-stamped-build' : 'gey3-ondisk-build';
        };

        // Mirrors bin/serve.mjs's real onChildExit wiring exactly (history
        // FIRST, ledger SECOND -- apra-fleet-xuo.6.1 ordering).
        const spawner = createSpawner({
            command: process.execPath,
            cliPath: fixturePath,
            basePort: 19481,
            dataDir: dir,
            onChildExit: async ({ runId, exitCode, signal, at, logPath }) => {
                if (!runId) return;
                await history.record({ sprintId: runId, event: HISTORY_EVENTS.CHILD_EXITED, exitCode, signal, at, logPath });
                await ledger.recordExit(runId, { exitCode, signal, at });
            },
        });

        const controller = createSprintController({
            ledger,
            spawner,
            history,
            getBuildVersion,
            listMembers: () => ({ members: [] }),
            getBacklog: () => ({ tasks: [] }),
        });

        const issue = 'apra-fleet-gey3fast';

        // ---------------------------------------------------------------
        // 1) Launch a sprint child that exits 1 in under 1s.
        // ---------------------------------------------------------------
        const launch1 = await controller.launch({ issue, members: ['alice'], branch: 'gey3/fast-1', base: 'main' });
        const sprintId1 = launch1.sprintId;

        // Criterion 3: a build-version mismatch is reported.
        assert.ok(launch1.buildVersionWarning, 'a build-version mismatch must be reported on launch');
        assert.match(launch1.buildVersionWarning, /gey3-stamped-build/);
        assert.match(launch1.buildVersionWarning, /gey3-ondisk-build/);

        // Real OS process exit -- bounded poll, never a fixed sleep. Once the
        // ledger shows an exitCode, the spawner's real 'exit' listener has
        // already closed the per-sprint log fd (spawner.mjs's exit handler
        // closes it BEFORE invoking onChildExit), so the log file below is
        // guaranteed fully written -- no further poll needed for its content.
        await waitFor(
            () => ledger.get(sprintId1)?.exitCode !== null && ledger.get(sprintId1)?.exitCode !== undefined,
            { label: 'the real child to exit' },
        );

        const reservation1 = ledger.get(sprintId1);
        assert.strictEqual(reservation1.exitCode, 1, 'the fixture must exit with code 1');
        assert.ok(typeof reservation1.logPath === 'string' && reservation1.logPath.length > 0, 'a real per-sprint log path must be recorded');
        const logPath1 = reservation1.logPath;

        // ---------------------------------------------------------------
        // 2) The real watchdog classifies it LAUNCH_FAILED, not CRASHED.
        // ---------------------------------------------------------------
        const watchdog = createWatchdog({ ledger, history });
        const results = await watchdog.classifyAll();
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].sprintId, sprintId1);
        assert.strictEqual(results[0].status, WATCHDOG_STATUS.LAUNCH_FAILED, `expected LAUNCH_FAILED, got ${results[0].status}`);
        assert.notStrictEqual(results[0].status, WATCHDOG_STATUS.CRASHED, 'a fast-exit launch failure must never be reported as the generic CRASHED');

        // (a) the reservation is auto-released.
        assert.strictEqual(ledger.get(sprintId1), undefined, 'the reservation must be auto-released once classified LAUNCH_FAILED');

        // (b) the event is recorded as launch-failed (not CRASHED), and the
        // auto-release itself is durably recorded too. Both history.record()
        // calls are DELIBERATELY fire-and-forget from classifySprint()'s own
        // perspective (watchdog.mjs's own doc comments: "a rejection must
        // never take the classifier down with it") -- bounded poll, never a
        // fixed sleep, for their durable persist to land.
        const launchFailedEvents = await waitFor(
            () => {
                const hits = history.list().filter((e) => e.sprintId === sprintId1 && e.event === HISTORY_EVENTS.LAUNCH_FAILED);
                return hits.length > 0 ? hits : false;
            },
            { label: 'the LAUNCH_FAILED history event to persist' },
        );
        assert.strictEqual(launchFailedEvents.length, 1, 'exactly one LAUNCH_FAILED history event expected');
        const autoReleasedEvents = await waitFor(
            () => {
                const hits = history.list().filter((e) => e.sprintId === sprintId1 && e.event === HISTORY_EVENTS.AUTO_RELEASED);
                return hits.length > 0 ? hits : false;
            },
            { label: 'the AUTO_RELEASED history event to persist' },
        );
        assert.strictEqual(autoReleasedEvents.length, 1, 'the auto-release must itself be durably recorded');
        assert.match(autoReleasedEvents[0].reason, /launch-failed/);

        // ---------------------------------------------------------------
        // 3) (c) A stderr tail is attached -- reachable via the real,
        // already-shipped apra-fleet-ou7.2 GET /sprints/:id/log?tail= route,
        // reading the REAL per-sprint log file the spawner teed this child's
        // stderr into. Then prove the graceful degrade: once that capture is
        // no longer available on disk, the route reports it with an explicit
        // marker -- never a silent empty body.
        // ---------------------------------------------------------------
        const logView = createLogView({ ledger, history });
        sup = createSupervisor({ port: 0 });
        registerLogViewRoutes(sup, logView);
        registerSprintRoutes(sup, controller);
        await sup.start();
        const port = sup.server.address().port;

        const logRes = await getText(port, `/sprints/${sprintId1}/log?tail=5`);
        assert.strictEqual(logRes.status, 200);
        assert.ok(
            logRes.body.includes('gey3-fixture: fatal: missing member beads DB'),
            'the log tail must include the real stderr the child wrote',
        );

        await fsp.rm(logPath1, { force: true });
        const missingLogRes = await getText(port, `/sprints/${sprintId1}/log`);
        assert.strictEqual(missingLogRes.status, 404);
        assert.match(
            missingLogRes.body,
            /missing on disk/i,
            'once the captured log is unavailable, the route must report it with an explicit marker, never silently return nothing',
        );

        // ---------------------------------------------------------------
        // 4) The relaunch gate: a same-issueRoot relaunch is refused and
        // names the prior failure, until the documented override is passed.
        // ---------------------------------------------------------------
        const blocked = await postJson(port, '/api/sprints', { issue, members: ['alice'], branch: 'gey3/fast-2', base: 'main' });
        assert.strictEqual(blocked.status, 409, 'a same-root relaunch after a deterministic LAUNCH_FAILED prior incarnation must be refused');
        assert.ok(blocked.body && typeof blocked.body.error === 'string', 'the 409 response must carry an error message');
        assert.ok(blocked.body.error.includes(sprintId1), 'the refusal must name the prior incarnation');
        assert.match(blocked.body.error, /launch window|launch-failed/i, 'the refusal must name the prior failure reason');

        const overridden = await postJson(port, '/api/sprints', {
            issue, members: ['alice'], branch: 'gey3/fast-3', base: 'main', overrideRelaunchGate: true,
        });
        assert.strictEqual(overridden.status, 201, 'the documented override must let the relaunch proceed');
        assert.ok(overridden.body && typeof overridden.body.sprintId === 'string');
        assert.notStrictEqual(overridden.body.sprintId, sprintId1, 'the override must produce a fresh incarnation, not reuse the failed one');
        assert.ok(overridden.body.buildVersionWarning, 'the overridden relaunch must still report the same build-version mismatch');
    });
});
