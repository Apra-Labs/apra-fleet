import { test, describe } from 'node:test';
import assert from 'node:assert';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { createSpawner, resolveSprintLogPath, MAX_LOG_STEM_LENGTH } from '../src/supervisor/spawner.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { createSprintController, registerSprintRoutes, MAX_SPRINT_ID_LENGTH, defaultGenerateSprintId } from '../src/supervisor/api.mjs';

// A multi-issue launch must not embed every issue id in the sprint id / log
// file name (Windows MAX_PATH ENOENT), and a launch failure must name its
// cause instead of the generic "internal supervisor error".

const TWENTY = Array.from({ length: 20 }, (_, i) => `apra-fleet-b4g.${100 + i}.1`);

function stores(dir) {
    const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
    const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
    return Promise.all([ledger.start(), history.start()]).then(() => ({ ledger, history }));
}

function spawnerWith(fs, captured = []) {
    let pid = 7000;
    return createSpawner({
        basePort: 9300,
        isPortAvailable: async () => true,
        dataDir: 'fake-data-dir',
        fs,
        spawn: (command, args) => {
            captured.push({ command, args });
            return { pid: pid++, once() { return this; }, unref() {} };
        },
    });
}
const okFs = { mkdirSync() {}, openSync: () => 11, closeSync() {} };

const mockReq = (method, url, body) => ({
    method, url,
    on(ev, cb) {
        if (ev === 'data') cb(Buffer.from(JSON.stringify(body)));
        if (ev === 'end') cb();
        return this;
    },
});
const mockRes = () => ({
    statusCode: undefined, body: undefined, headersSent: false,
    writeHead(s) { this.statusCode = s; this.headersSent = true; },
    end(b) { this.body = b; },
});

describe('supervisor launch -- bounded sprint id / log path', () => {
    test('20 issue ids: sprint id and log basename are bounded, full list kept in the record', async () => {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'launch-bound-'));
        try {
            const { ledger, history } = await stores(dir);
            const captured = [];
            const controller = createSprintController({
                ledger, history, spawner: spawnerWith(okFs, captured),
                listMembers: () => ({ members: [] }), getBacklog: () => ({ tasks: [] }),
            });
            const result = await controller.launch({ issue: TWENTY.join(','), members: ['a'], branch: 'feat/x', base: 'main' });

            assert.ok(result.sprintId.length <= MAX_SPRINT_ID_LENGTH, `sprint id too long (${result.sprintId.length}): ${result.sprintId}`);
            const base = path.basename(result.logPath);
            assert.ok(base.length <= MAX_LOG_STEM_LENGTH + '.log'.length, `log basename too long (${base.length}): ${base}`);
            assert.deepEqual(result.issueRoots, TWENTY, 'API result keeps the full 20-id list');
            assert.deepEqual(ledger.get(result.sprintId).issueRoots, TWENTY, 'ledger record keeps the full 20-id list');
            // child argv still carries the whole list and the same bounded run id.
            const args = captured[0].args;
            assert.equal(args[args.indexOf('--issue') + 1], TWENTY.join(','));
            assert.equal(args[args.indexOf('--run-id') + 1], result.sprintId);

            assert.notEqual(defaultGenerateSprintId(TWENTY.join(',')), defaultGenerateSprintId(TWENTY.join(',')), 'ids stay unique per launch');
        } finally {
            await fsp.rm(dir, { recursive: true, force: true });
        }
    });

    test('resolveSprintLogPath bounds any stem and does not collide for different long stems', () => {
        const a = `${'x'.repeat(400)}-A`;
        const b = `${'x'.repeat(400)}-B`;
        const pa = resolveSprintLogPath('d', a);
        const pb = resolveSprintLogPath('d', b);
        for (const p of [pa, pb, resolveSprintLogPath('d', 'y'.repeat(5000))]) {
            assert.ok(path.basename(p).length <= MAX_LOG_STEM_LENGTH + 4);
        }
        assert.notEqual(pa, pb);
        assert.equal(path.basename(resolveSprintLogPath('d', 'short-id')), 'short-id.log', 'short stems are untouched');
    });

    test('full Windows-style log path for the 20-id case stays under 260 characters', () => {
        const dataDir = 'C:\\Users\\a-rather-long-windows-user-name\\AppData\\Roaming\\.apra-fleet-se';
        const logPath = resolveSprintLogPath(dataDir, TWENTY.join(','));
        const winPath = path.win32.join(dataDir, 'logs', path.basename(logPath));
        assert.ok(winPath.length < 260, `${winPath.length} chars: ${winPath}`);
    });
});

describe('supervisor launch -- failure cause surfaced', () => {
    test('openSync ENOENT -> POST /api/sprints body names the ENOENT cause, not the generic message', async () => {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'launch-enoent-'));
        try {
            const { ledger, history } = await stores(dir);
            const enoent = Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\too\\long\\path.log'"), { code: 'ENOENT' });
            const fs = { mkdirSync() {}, openSync() { throw enoent; }, closeSync() {} };
            const supervisor = createSupervisor({ port: 0 });
            registerSprintRoutes(supervisor, createSprintController({
                ledger, history, spawner: spawnerWith(fs),
                listMembers: () => ({ members: [] }), getBacklog: () => ({}),
            }));
            const res = mockRes();
            await supervisor.handleRequest(
                mockReq('POST', '/api/sprints', { issue: 'epic-1', members: ['a'], branch: 'feat/x', base: 'main' }),
                res,
            );
            const body = JSON.parse(res.body);
            assert.equal(res.statusCode, 500);
            assert.notEqual(body.error, 'internal supervisor error');
            assert.match(body.error, /ENOENT/);
            assert.match(body.error, /too\\long\\path\.log/);
            assert.match(body.error, /spawn sprint child/);
            assert.equal(ledger.list().length, 0, 'no ledger claim for a failed launch');
        } finally {
            await fsp.rm(dir, { recursive: true, force: true });
        }
    });
});
