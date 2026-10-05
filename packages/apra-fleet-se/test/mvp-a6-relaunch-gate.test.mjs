import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { getTerminalRunStatePath } from '@apralabs/apra-fleet-workflow/viewer/run-state-paths';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME, HISTORY_EVENTS } from '../src/supervisor/history.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';
import { createSprintController, registerSprintRoutes } from '../src/supervisor/api.mjs';
import { createWatchdog, WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';
import { createTestSupervisor } from './helpers/supervisor-harness.mjs';

// End to end relaunch gate with the terminal record shaped exactly as the
// engine + viewer write it: the engine's reason ONLY under
// extensions.terminal.terminalReason, the viewer's error message in the
// top-level terminalReason. Chain: POST launch -> child dies -> REAL watchdog
// finalises (FINISHED in sprint-history.json) -> same-root POST 409 (field
// 'issue') -> overrideRelaunchGate:true 201.
//
// FALSIFIABILITY (recorded manual check, see commit message): reverting
// watchdog.mjs defaultRecordFinished/formatFinishedDetail to read only the
// top-level state.terminalReason makes the FINISHED event carry the viewer
// message, so the 409 assertion below gets 201 instead.

const mkdtemp = (p) => fsp.mkdtemp(path.join(os.tmpdir(), p));

function mockReq(method, url, body, headers) {
    const chunks = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
    return {
        method, url, headers: headers ?? {},
        on(event, cb) {
            if (event === 'data') { for (const c of chunks) cb(c); }
            if (event === 'end') { cb(); }
            return this;
        },
    };
}
function mockRes() {
    return {
        statusCode: undefined, body: undefined, headersSent: false,
        writeHead(status) { this.statusCode = status; this.headersSent = true; },
        end(body) { this.body = body; },
    };
}

describe('relaunch gate: engine-shaped terminal record -> watchdog FINISHED -> 409 -> override 201', () => {
    test('BEADS_SYNC_CONFLICT only under extensions.terminal gates a same-root relaunch', async () => {
        const dir = await mkdtemp('mvp-a6-');
        const home = await mkdtemp('mvp-a6-home-');
        const dataDir = await mkdtemp('mvp-a6-fleetdata-');
        try {
            const deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
            assert.ok(Number.isInteger(deadPid) && deadPid > 0);

            const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME) });
            await ledger.start();
            const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME) });
            await history.start();

            const captured = [];
            let nextFd = 300;
            const spawner = createSpawner({
                basePort: 9300,
                isPortAvailable: async () => true,
                dataDir: 'fake-data-dir',
                fs: { mkdirSync() {}, openSync() { return nextFd++; }, closeSync() {} },
                spawn: (command, args) => {
                    captured.push({ command, args });
                    return { pid: deadPid, once() { return this; }, unref() {} };
                },
            });
            const { supervisor, headers } = await createTestSupervisor({ port: 0, dataDir: dir, home });
            registerSprintRoutes(supervisor, createSprintController({
                ledger, history, spawner,
                listMembers: () => ({ members: [] }), getBacklog: () => ({ tasks: [] }),
            }));

            const post = async (extra = {}) => {
                const res = mockRes();
                await supervisor.handleRequest(
                    mockReq('POST', '/api/sprints', { issue: 'PROJ-1', members: ['alice'], branch: 'feat/x', base: 'main', ...extra }, headers()),
                    res,
                );
                return { status: res.statusCode, payload: JSON.parse(res.body) };
            };

            // 1. First launch.
            const first = await post();
            assert.equal(first.status, 201);
            const sprintId = first.payload.sprintId;
            assert.equal(captured.length, 1);

            // 2. The engine's terminal write, viewer-shaped.
            const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
            const statePath = getTerminalRunStatePath(sprintId, env);
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            fs.writeFileSync(statePath, JSON.stringify({
                status: 'failed',
                terminalReason: 'Error: DOLT_DIVERGED push rejected (viewer error message)',
                extensions: { terminal: {
                    verdict: 'ABORTED', terminalReason: 'BEADS_SYNC_CONFLICT',
                    message: 'beads sync conflict', conflictDump: { operation: 'push' },
                } },
            }));

            // 3. REAL watchdog finalises it.
            const pending = [];
            const trackingHistory = { record: (e) => { const p = history.record(e); pending.push(p); return p; } };
            const watchdog = createWatchdog({ ledger, env, history: trackingHistory, logger: { log() {}, error() {}, warn() {} } });
            const [classification] = await watchdog.classifyAll();
            await Promise.all(pending);
            assert.equal(classification.status, WATCHDOG_STATUS.FINISHED);

            const persisted = JSON.parse(await fsp.readFile(path.join(dir, HISTORY_FILENAME), 'utf8'));
            const events = Array.isArray(persisted) ? persisted : (persisted.events ?? []);
            const finished = events.filter((e) => e.event === HISTORY_EVENTS.FINISHED && e.sprintId === sprintId);
            assert.equal(finished.length, 1);
            assert.equal(finished[0].terminalReason, 'BEADS_SYNC_CONFLICT');

            // 4. Same-root relaunch is refused.
            const refused = await post();
            assert.equal(refused.status, 409);
            assert.equal(refused.payload.field, 'issue');
            assert.equal(captured.length, 1, 'a refused relaunch must not spawn');

            // 5. Explicit override is the only way through.
            const overridden = await post({ overrideRelaunchGate: true });
            assert.equal(overridden.status, 201);
            assert.equal(captured.length, 2, 'the override spawns exactly one more child');
        } finally {
            await fsp.rm(dir, { recursive: true, force: true });
            await fsp.rm(home, { recursive: true, force: true });
            await fsp.rm(dataDir, { recursive: true, force: true });
        }
    });
});
