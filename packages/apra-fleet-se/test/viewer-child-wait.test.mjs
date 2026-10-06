import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { createSpawner } from '../src/supervisor/spawner.mjs';
import { isPidAlive } from '../src/supervisor/reconcile.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { waitForChildUp } from './helpers/viewer-child-wait.mjs';

// =============================================================================
// Pins the pid-verifying viewer-child readiness wait shared by
// supervisor-dashboard-integration.test.mjs and
// supervisor-stop-restart-integration.test.mjs.
//
// The failure it guards against: both suites used to spawn their viewer
// children from the shared default spawner base port, so under the parallel
// runner one suite's child lost the port (EADDRINUSE, process gone) while the
// OTHER suite's child answered GET /state there. A wait that accepted any 200
// passed, and the later isPidAlive(pid) assertion failed. The wait now accepts
// only a /state body carrying the launched child's own pid.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWER_FIXTURE = path.join(__dirname, 'fixtures/dashboard/viewer-child.mjs');
const silentLogger = { log() {}, error() {} };

/** Starts a loopback listener answering every GET /state with 200 and `body`. */
async function startForeignStateServer(body) {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    return server;
}

function closeServer(server) {
    return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
    });
}

describe('viewer-child readiness wait rejects a foreign /state responder', () => {
    const servers = [];
    const spawnedPids = [];
    let dataDir;

    before(async () => {
        dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'viewer-child-wait-'));
    });

    after(async () => {
        for (const server of servers) {
            // eslint-disable-next-line no-await-in-loop
            await closeServer(server);
        }
        for (const pid of spawnedPids) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
        if (dataDir) await fsp.rm(dataDir, { recursive: true, force: true });
    });

    test('a 200 /state from a process reporting a DIFFERENT pid is never accepted as the launched child', async () => {
        const foreign = await startForeignStateServer({ state: 'running', pid: process.pid });
        servers.push(foreign);
        const port = foreign.address().port;
        const expectedPid = process.pid + 1;

        await assert.rejects(
            waitForChildUp(port, expectedPid, { timeoutMs: 300, intervalMs: 20, label: 'foreign responder' }),
            /timed out waiting for foreign responder/,
            'a foreign process answering /state on the child port must not satisfy the wait',
        );
    });

    test('a 200 /state with no pid at all (any-200 responder) is never accepted either', async () => {
        const foreign = await startForeignStateServer({ state: 'running' });
        servers.push(foreign);

        await assert.rejects(
            waitForChildUp(foreign.address().port, process.pid, { timeoutMs: 300, intervalMs: 20, label: 'pid-less responder' }),
            /timed out waiting for pid-less responder/,
        );
    });

    test('a REAL viewer-child fixture on its own port is accepted when its own pid is expected', async () => {
        const spawner = createSpawner({
            command: process.execPath,
            cliPath: VIEWER_FIXTURE,
            env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir },
            logger: silentLogger,
            dataDir,
            // Its own --viewer-port band, distinct from every other basePort
            // under test/.
            basePort: 19881,
        });
        const { pid, port } = await spawner.spawnSprint({
            issue: 'wait-pin', members: 'alice', branch: 'feat/wait-pin', base: 'main', runId: 'viewer-child-wait-pin',
        });
        spawnedPids.push(pid);

        await waitForChildUp(port, pid, { timeoutMs: scaledTimeout(10000), label: 'real viewer-child' });
        assert.ok(isPidAlive(pid), 'the accepted responder is the live launched child');
    });
});
