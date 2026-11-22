import { test, describe } from 'node:test';
import assert from 'node:assert';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { createSprintController, registerSprintRoutes } from '../src/supervisor/api.mjs';
import { validateArgs, validateGoal } from '../fleet-sprint/sprint-args.mjs';

// POST /api/sprints validates goal / maxCycles / budget with the SAME
// validators validateArgs uses, so an invalid value is a 400 before any spawn
// or ledger claim (member reservation).

async function stores(dir) {
    const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
    await ledger.start();
    const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
    await history.start();
    return { ledger, history };
}

function recordingSpawner(captured) {
    let nextPid = 5000;
    let nextFd = 100;
    return createSpawner({
        basePort: 9100,
        isPortAvailable: async () => true,
        dataDir: 'fake-data-dir',
        fs: { mkdirSync() {}, openSync() { return nextFd++; }, closeSync() {} },
        spawn: (command, args) => {
            const pid = nextPid++;
            captured.push({ command, args, pid });
            return { pid, once() { return this; }, unref() {} };
        },
    });
}

function mockReq(method, url, body) {
    const chunks = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
    return {
        method,
        url,
        headers: { 'content-type': 'application/json' },
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

async function post(extra) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'uwv1-'));
    try {
        const { ledger, history } = await stores(dir);
        const captured = [];
        const supervisor = createSupervisor({ port: 0 });
        registerSprintRoutes(supervisor, createSprintController({
            ledger, history, spawner: recordingSpawner(captured),
            listMembers: () => ({ members: [] }), getBacklog: () => ({}),
        }));
        const res = mockRes();
        await supervisor.handleRequest(
            mockReq('POST', '/api/sprints', { issue: 'PROJ-1', members: ['a'], branch: 'feat/x', base: 'main', ...extra }),
            res,
        );
        return { res, captured, claims: ledger.list().length };
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
    }
}

describe('POST /api/sprints goal / maxCycles / budget validation', () => {
    test('free-text goal -> 400 field=goal, nothing spawned, no ledger claim', async () => {
        const { res, captured, claims } = await post({ goal: 'Sprint G: console Secrets page' });
        assert.equal(res.statusCode, 400);
        assert.equal(payloadOf(res).field, 'goal');
        assert.equal(captured.length, 0);
        assert.equal(claims, 0);
    });

    test('invalid maxCycles -> 400 field=maxCycles, nothing spawned', async () => {
        for (const maxCycles of [0, -1, 1.5, '3']) {
            const { res, captured, claims } = await post({ maxCycles });
            assert.equal(res.statusCode, 400, `maxCycles=${JSON.stringify(maxCycles)}`);
            assert.equal(payloadOf(res).field, 'maxCycles');
            assert.equal(captured.length, 0);
            assert.equal(claims, 0);
        }
    });

    test('invalid budget -> 400 field=budget, nothing spawned', async () => {
        for (const budget of [-1, '5', null]) {
            const { res, captured, claims } = await post({ budget });
            assert.equal(res.statusCode, 400, `budget=${JSON.stringify(budget)}`);
            assert.equal(payloadOf(res).field, 'budget');
            assert.equal(captured.length, 0);
            assert.equal(claims, 0);
        }
    });

    test('valid goal P1/P2 and omitted goal/maxCycles/budget launch as before', async () => {
        const withAll = await post({ goal: 'P1/P2', maxCycles: 3, budget: 10 });
        assert.equal(withAll.res.statusCode, 201, withAll.res.body);
        assert.equal(withAll.captured.length, 1);
        const omitted = await post({});
        assert.equal(omitted.res.statusCode, 201, omitted.res.body);
        assert.equal(omitted.captured.length, 1);
    });

    test('validateArgs rejects the same invalid goal with the same message (one shared validator)', () => {
        const base = { target_issues: ['x-1'], members: ['m'], branch: 'feat/x', base_branch: 'main' };
        let direct;
        assert.throws(() => validateGoal('Sprint G: console Secrets page'), (e) => { direct = e.message; return true; });
        assert.throws(() => validateArgs({ ...base, goal: 'Sprint G: console Secrets page' }), (e) => e.message === direct);
        assert.match(direct, /\[Arg Contract\] Invalid goal/);
    });
});
