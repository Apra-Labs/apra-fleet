import { test, describe } from 'node:test';
import assert from 'node:assert';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';
import { createSprintController, ApiError } from '../src/supervisor/api.mjs';
import { buildRunnerArgs } from '../bin/cli.mjs';

// POST /api/sprints `decisionNotify`: validated with validateDecisionNotify,
// forwarded to the child as --decision-notify.

async function setup(captured) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dn-api-'));
    const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
    await ledger.start();
    const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
    await history.start();
    let fd = 100;
    let pid = 7000;
    const spawner = createSpawner({
        basePort: 9300,
        isPortAvailable: async () => true,
        dataDir: 'fake-data-dir',
        fs: { mkdirSync() {}, openSync() { return fd++; }, closeSync() {} },
        spawn: (command, args) => {
            captured.push({ command, args });
            return { pid: pid++, once() { return this; }, unref() {} };
        },
    });
    const controller = createSprintController({
        ledger, history, spawner,
        listMembers: () => ({ members: [] }),
        getBacklog: () => ({ tasks: [] }),
    });
    return { dir, controller };
}

const base = { issue: 'PROJ-1', members: ['alice'], branch: 'feat/x', base: 'main' };

describe('POST /api/sprints decisionNotify', () => {
    test('a valid object is forwarded to the child as --decision-notify and reaches buildRunnerArgs', async () => {
        const captured = [];
        const { dir, controller } = await setup(captured);
        const cfg = { message_member: 'orch', dashboard_url: 'http://localhost:8787' };
        await controller.launch({ ...base, decisionNotify: cfg });
        const args = captured[0].args;
        const i = args.indexOf('--decision-notify');
        assert.ok(i >= 0, 'child argv must contain --decision-notify');
        assert.deepEqual(JSON.parse(args[i + 1]), cfg);
        const runnerArgs = buildRunnerArgs({
            targetIssues: ['PROJ-1'], members: ['alice'], branch: 'feat/x', baseBranch: 'main',
            decisionNotify: args[i + 1],
        });
        assert.equal(runnerArgs.decision_notify, args[i + 1]);
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('omitted => no --decision-notify flag', async () => {
        const captured = [];
        const { dir, controller } = await setup(captured);
        await controller.launch(base);
        assert.equal(captured[0].args.includes('--decision-notify'), false);
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('an invalid value (unknown key) => 400 field decisionNotify, nothing spawned', async () => {
        const captured = [];
        const { dir, controller } = await setup(captured);
        await assert.rejects(
            () => controller.launch({ ...base, decisionNotify: { message_member: 'o', password: 'x' } }),
            (err) => err instanceof ApiError && err.status === 400 && err.field === 'decisionNotify',
        );
        await assert.rejects(
            () => controller.launch({ ...base, decisionNotify: '{not json' }),
            (err) => err instanceof ApiError && err.status === 400 && err.field === 'decisionNotify',
        );
        assert.equal(captured.length, 0);
        await fsp.rm(dir, { recursive: true, force: true });
    });
});
