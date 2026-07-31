import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME, HISTORY_EVENTS } from '../src/supervisor/history.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';
import { createWatchdog } from '../src/supervisor/watchdog.mjs';
import { createDashboard, registerDashboardRoutes } from '../src/supervisor/dashboard.mjs';
import { createLogView, registerLogViewRoutes } from '../src/supervisor/log-view.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';

// =============================================================================
// apra-fleet-ou7.3 -- integration test for apra-fleet-ou7 (tee sprint child
// stdout/stderr to log files, link from dashboard): drives a REAL spawned OS
// child process (test/fixtures/spawner/stdout-stderr-exit-nonzero.mjs, never
// a fake child_process.spawn), a REAL ledger/history, a REAL log-view HTTP
// route, and a REAL dashboard render -- the same collaborator wiring
// bin/serve.mjs uses (apra-fleet-k7b.7's real-process posture, apra-fleet-
// ou7.2's log-view/dashboard seams) -- to prove the full chain end to end:
//
//   1. A sprint child writes to stdout AND stderr, then exits nonzero.
//   2. After exit, the per-sprint log file exists on disk, contains BOTH the
//      stdout and stderr lines (single-fd tee, apra-fleet-ou7.1), and its
//      path is recorded in the ledger reservation AND the history's
//      CHILD_EXITED event.
//   3. GET /sprints/:id/log (a REAL HTTP server) returns those exact
//      contents for the now-ended (CRASHED) sprint.
//   4. The dashboard's real GET / render includes a "Raw log" link pointing
//      at that same sprint's log route.
//   5. A crafted :id containing path-traversal segments is rejected (400),
//      never reaching the filesystem.
//
// Deterministic throughout: every wait is a bounded poll (waitFor()) on real
// state, never a fixed sleep. This suite fails against pre-ou7 code (no
// spawner-level log tee, no log-view route, no dashboard link) and passes
// once apra-fleet-ou7.1/ou7.2 are in place. ASCII only.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, 'fixtures/spawner/stdout-stderr-exit-nonzero.mjs');

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

describe('apra-fleet-ou7.3: every sprint has a traceable stdout/stderr log reachable from the dashboard', () => {
    let dir;
    let sup;
    let port;
    let ledger;
    let history;
    const runId = `ou7-3-run-${process.pid}-${Date.now()}`;

    // apra-fleet-xuo.6.1: cleanup must never fail the hook, and must never
    // race an in-flight persist. If the test body above threw partway, `sup`
    // (and even `ledger`/`history`) may be unset, and the ledger/history
    // transaction chains may still have an atomic tmp-write + rename in
    // flight -- deleting `dir` underneath that used to blow up here (ENOENT
    // on sprint-history.json.tmp) and cascade a real assertion failure into a
    // second, unrelated "failed running after hook" failure. Drain both seams
    // (stop() is `await txChain`) before removing the dir, and treat every
    // cleanup step as best-effort.
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
                console.error('[ou7.3 cleanup] non-fatal:', err && err.message);
            }
        }
    });

    test('a real child that writes stdout+stderr and exits nonzero leaves a log file on disk, recorded in the ledger and history', async () => {
        dir = await tmpDir('ou7-3-');
        ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME) });
        await ledger.start();
        history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME) });
        await history.start();

        const spawner = createSpawner({
            command: process.execPath,
            cliPath: fixturePath,
            basePort: 19281,
            dataDir: dir,
            // apra-fleet-xuo.6.1: history FIRST, ledger SECOND -- mirroring
            // bin/serve.mjs's own (now likewise ordered) wiring. Both seams
            // commit in memory only after their atomic persist, and the
            // readiness poll below watches the LEDGER, so recording the ledger
            // first left a window one history-persist wide where the ledger
            // already showed an exitCode but history had no CHILD_EXITED event
            // yet -- the ledger/history mismatch of apra-fleet-xuo.6.
            onChildExit: async ({ runId: exitedRunId, exitCode, signal, at, logPath }) => {
                if (!exitedRunId) return;
                await history.record({ sprintId: exitedRunId, event: HISTORY_EVENTS.CHILD_EXITED, exitCode, signal, at, logPath });
                await ledger.recordExit(exitedRunId, { exitCode, signal, at });
            },
        });

        // Real spawn, matching api.mjs's launch() sequence: spawn first, then
        // claim ONE reservation carrying both childPid and the real logPath.
        const spawned = await spawner.spawnSprint({
            issue: 'apra-fleet-ou7.3', members: 'alice', branch: 'b1', base: 'main', runId,
        });
        await ledger.claim(runId, { members: ['alice'], issueRoots: ['apra-fleet-ou7'], childPid: spawned.pid, logPath: spawned.logPath });

        assert.ok(typeof spawned.logPath === 'string' && spawned.logPath.length > 0, 'spawnSprint must return a real logPath');

        // Real OS process exit -- wait for the ledger annotation (fired
        // asynchronously by the spawner's real 'exit' listener), never a
        // fixed sleep.
        await waitFor(() => ledger.get(runId)?.exitCode !== null && ledger.get(runId)?.exitCode !== undefined, { label: 'ledger to record the real child exit' });

        const reservation = ledger.get(runId);
        assert.strictEqual(reservation.exitCode, 3, 'ledger must record the real nonzero exit code');
        assert.strictEqual(reservation.logPath, spawned.logPath, 'the ledger reservation must carry the same logPath spawnSprint() returned');

        const childExitedEvents = history.list().filter((e) => e.sprintId === runId && e.event === HISTORY_EVENTS.CHILD_EXITED);
        assert.strictEqual(childExitedEvents.length, 1);
        assert.strictEqual(childExitedEvents[0].logPath, spawned.logPath, 'the CHILD_EXITED history event must carry the same logPath too');
        assert.strictEqual(childExitedEvents[0].exitCode, 3, 'the CHILD_EXITED history event must carry the same nonzero exit code as the ledger');

        // Poll the real log file (never a fixed sleep) until BOTH the stdout
        // and stderr lines the child wrote have landed -- proving the
        // spawner's single-fd tee (stdio: ['ignore', fd, fd]) captured both
        // streams into the SAME file.
        const content = await waitFor(() => {
            let text = '';
            try { text = fs.readFileSync(spawned.logPath, 'utf-8'); } catch { /* not flushed yet */ }
            return text.includes('SPRINT STDOUT LINE') && text.includes('SPRINT STDERR LINE') ? text : false;
        }, { label: 'the log file to contain both the stdout and stderr lines' });

        assert.ok(content.includes('SPRINT STDOUT LINE'), 'log file must contain the written stdout line');
        assert.ok(content.includes('SPRINT STDERR LINE'), 'log file must contain the written stderr line');

        // --- Wire the REAL log-view + dashboard HTTP routes against this SAME
        // ledger/history, exactly as bin/serve.mjs does, then exercise them.
        const resolveSprintPort = () => undefined; // child has already exited; no live port to resolve.
        const watchdog = createWatchdog({ ledger, resolvePort: resolveSprintPort, history });
        const dashboard = createDashboard({
            ledger,
            watchdog,
            expandScope: async (roots) => new Set(roots), // avoid a real `bd` call for this HTTP-layer assertion
            logger: { log: () => {}, error: () => {} },
        });
        const logView = createLogView({ ledger, history });

        sup = createSupervisor({ port: 0 });
        registerDashboardRoutes(sup, dashboard);
        registerLogViewRoutes(sup, logView);
        await sup.start();
        port = sup.server.address().port;

        // 2) GET /sprints/:id/log returns the ended sprint's real log content.
        const logRes = await getText(port, `/sprints/${runId}/log`);
        assert.strictEqual(logRes.status, 200);
        assert.ok(logRes.headers['content-type'].includes('text/plain'));
        assert.ok(logRes.body.includes('SPRINT STDOUT LINE'));
        assert.ok(logRes.body.includes('SPRINT STDERR LINE'));

        // 3) The dashboard's real GET / render links to that same log route.
        // The sprint is CRASHED (real exit, no engine terminal state written
        // by the fixture) -- only FINISHED rows are dropped from the stack,
        // so this row (and its Raw log link) must still be present.
        const dashRes = await getText(port, '/');
        assert.strictEqual(dashRes.status, 200);
        assert.ok(dashRes.body.includes(`/sprints/${runId}/log`), 'dashboard page must link to this sprint\'s raw log');
        assert.ok(dashRes.body.includes('Raw log'));

        // 4) A crafted :id containing path-traversal segments is rejected
        // before ever touching the filesystem.
        const traversalRes = await getText(port, '/sprints/' + encodeURIComponent('../../etc/passwd') + '/log');
        assert.strictEqual(traversalRes.status, 400);

        // A raw (unencoded) '..' path-separator segment never even reaches
        // this route as a single :id -- the request itself resolves to a
        // different path outside /sprints/*/log, which must 404, not serve
        // anything.
        const traversalRes2 = await getText(port, `/sprints/${runId}/../../../etc/passwd`);
        assert.strictEqual(traversalRes2.status, 404);
    });
});
