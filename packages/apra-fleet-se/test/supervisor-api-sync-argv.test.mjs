import { test, describe } from 'node:test';
import assert from 'node:assert';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';
import { createSprintController, registerSprintRoutes } from '../src/supervisor/api.mjs';
import { createTestSupervisor } from './helpers/supervisor-harness.mjs';

// apra-fleet-ky2l.3.2 (DQ-11): verifies the sync flag travels from an HTTP
// POST /api/sprints request body all the way to the argv the REAL
// createSpawner (spawner.mjs) argv builder hands the child process --
// distinct from supervisor-api.test.mjs's controller.launch()-level unit
// cases, which never go through an actual HTTP request/response or the auth
// guard. Only the low-level child_process spawn() call is stubbed (the
// pattern spawner.test.mjs uses to capture argv without launching node), so
// buildSprintArgv itself runs unmodified.
//
// FALSIFIABILITY: if api.mjs's launch() forwarding of body.sync into
// spawnOpts.extraArgs (the `...(body.sync === true ? { extraArgs: ['--sync'] }
// : {})` line) is reverted, the sync:true case below fails -- the captured
// argv would no longer contain --sync.

async function tmpDir() {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'eft-api-sync-argv-'));
}

/**
 * createTestSupervisor() mkdtemp's its OWN home dir when none is supplied
 * (supervisor-harness.mjs's resolveHomeDir) -- passed explicitly here so this
 * suite can clean it up itself rather than leaking one temp dir per test.
 */
async function tmpHomeDir() {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'eft-api-sync-argv-home-'));
}

/** Real ledger + history over a temp dir. */
async function stores(dir) {
    const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
    await ledger.start();
    const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
    await history.start();
    return { ledger, history };
}

/**
 * A spawner built on the REAL createSpawner, with the child_process boundary
 * (spawn()) stubbed so buildSprintArgv's own argv-construction logic runs
 * unmodified but no real process is ever launched.
 */
function recordingSpawner(captured) {
    let nextPid = 6000;
    let nextFd = 200;
    return createSpawner({
        basePort: 9200,
        isPortAvailable: async () => true,
        dataDir: 'fake-data-dir',
        fs: {
            mkdirSync() {},
            openSync() { return nextFd++; },
            closeSync() {},
        },
        spawn: (command, args) => {
            const pid = nextPid++;
            captured.push({ command, args, pid });
            const listeners = {};
            return {
                pid,
                once(ev, cb) { listeners[ev] = cb; return this; },
                unref() {},
            };
        },
    });
}

function mockReq(method, url, body, headers) {
    const chunks = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
    return {
        method,
        url,
        headers: headers ?? {},
        on(event, cb) {
            if (event === 'data') { for (const c of chunks) cb(c); }
            if (event === 'end') { cb(); }
            return this;
        },
    };
}
function mockRes() {
    return {
        statusCode: undefined,
        body: undefined,
        headersSent: false,
        writeHead(status) { this.statusCode = status; this.headersSent = true; },
        end(body) { this.body = body; },
    };
}
const payloadOf = (res) => JSON.parse(res.body);

describe('api -- POST /api/sprints sync flag reaches the real spawner argv', () => {
    test('sync:true -> exactly one --sync in the captured child argv, and it is recorded on the ledger', async () => {
        const dir = await tmpDir();
        const home = await tmpHomeDir();
        const { ledger, history } = await stores(dir);
        const captured = [];
        const { supervisor, headers } = await createTestSupervisor({ port: 0, dataDir: dir, home });
        registerSprintRoutes(supervisor, createSprintController({
            ledger, history, spawner: recordingSpawner(captured),
            listMembers: () => ({ members: [] }), getBacklog: () => ({ tasks: [] }),
        }));

        const res = mockRes();
        await supervisor.handleRequest(
            mockReq('POST', '/api/sprints', {
                issue: 'PROJ-1', members: ['alice', 'bob'], branch: 'feat/x', base: 'main', sync: true,
            }, headers()),
            res,
        );
        assert.equal(res.statusCode, 201);
        const { sprintId } = payloadOf(res);

        assert.equal(captured.length, 1);
        const args = captured[0].args;
        assert.equal(args.filter((a) => a === '--sync').length, 1, 'child argv must contain exactly one --sync');
        // --sync is appended AFTER the issue/members etc. flags (extraArgs is
        // pushed last by buildSprintArgv).
        const issueIdx = args.indexOf('--issue');
        assert.ok(issueIdx >= 0);
        assert.ok(args.indexOf('--sync') > issueIdx, '--sync must appear after --issue');

        // Persisted launch metadata: a future Restart control reproduces the
        // same synced-topology mode.
        assert.equal(ledger.get(sprintId).sync, true);

        await fsp.rm(dir, { recursive: true, force: true });
        await fsp.rm(home, { recursive: true, force: true });
    });

    test('sync absent -> no --sync in the captured argv, and the ledger records sync:false', async () => {
        const dir = await tmpDir();
        const home = await tmpHomeDir();
        const { ledger, history } = await stores(dir);
        const captured = [];
        const { supervisor, headers } = await createTestSupervisor({ port: 0, dataDir: dir, home });
        registerSprintRoutes(supervisor, createSprintController({
            ledger, history, spawner: recordingSpawner(captured),
            listMembers: () => ({ members: [] }), getBacklog: () => ({ tasks: [] }),
        }));

        const res = mockRes();
        await supervisor.handleRequest(
            mockReq('POST', '/api/sprints', { issue: 'PROJ-1', members: ['alice'], branch: 'feat/x', base: 'main' }, headers()),
            res,
        );
        assert.equal(res.statusCode, 201);
        const { sprintId } = payloadOf(res);

        assert.equal(captured.length, 1);
        assert.equal(captured[0].args.includes('--sync'), false);
        assert.equal(ledger.get(sprintId).sync, false);

        await fsp.rm(dir, { recursive: true, force: true });
        await fsp.rm(home, { recursive: true, force: true });
    });

    test('sync:1 (non-boolean) -> 400 naming sync, and the spawner is never called', async () => {
        const dir = await tmpDir();
        const home = await tmpHomeDir();
        const { ledger, history } = await stores(dir);
        const captured = [];
        const { supervisor, headers } = await createTestSupervisor({ port: 0, dataDir: dir, home });
        registerSprintRoutes(supervisor, createSprintController({
            ledger, history, spawner: recordingSpawner(captured),
            listMembers: () => ({ members: [] }), getBacklog: () => ({ tasks: [] }),
        }));

        const res = mockRes();
        await supervisor.handleRequest(
            mockReq('POST', '/api/sprints', { issue: 'PROJ-1', members: ['alice'], branch: 'feat/x', base: 'main', sync: 1 }, headers()),
            res,
        );
        assert.equal(res.statusCode, 400);
        const payload = payloadOf(res);
        assert.equal(payload.field, 'sync');
        assert.ok(/sync/.test(payload.error));
        assert.ok(/boolean/.test(payload.error));
        assert.equal(captured.length, 0);

        await fsp.rm(dir, { recursive: true, force: true });
        await fsp.rm(home, { recursive: true, force: true });
    });

    // Leftover-artifacts check: everything this suite touches lives under the
    // temp `dir` created per test (ledger/history files, the fake spawner's
    // fake dataDir string never resolves to a real path) -- nothing is
    // written outside it. Verified structurally rather than by a filesystem
    // diff: the ledger/history stores() helper is only ever pointed at
    // `dir`, and recordingSpawner's injected `fs` never calls a real fs API.
    test('no leftover artifacts outside the temp dir', async () => {
        const dir = await tmpDir();
        const home = await tmpHomeDir();
        const before = await fsp.readdir(dir);
        assert.deepEqual(before, []);
        const { ledger, history } = await stores(dir);
        const captured = [];
        const { supervisor, headers } = await createTestSupervisor({ port: 0, dataDir: dir, home });
        registerSprintRoutes(supervisor, createSprintController({
            ledger, history, spawner: recordingSpawner(captured),
            listMembers: () => ({ members: [] }), getBacklog: () => ({ tasks: [] }),
        }));
        const res = mockRes();
        await supervisor.handleRequest(
            mockReq('POST', '/api/sprints', { issue: 'PROJ-1', members: ['alice'], branch: 'feat/x', base: 'main', sync: true }, headers()),
            res,
        );
        assert.equal(res.statusCode, 201);
        const after = await fsp.readdir(dir);
        // Only the ledger/history/private-token artifacts this dataDir owns.
        for (const entry of after) {
            assert.ok(
                entry === LEDGER_FILENAME || entry === HISTORY_FILENAME || entry === 'private',
                `unexpected artifact in temp dir: ${entry}`,
            );
        }
        await fsp.rm(dir, { recursive: true, force: true });
        await fsp.rm(home, { recursive: true, force: true });
    });
});
