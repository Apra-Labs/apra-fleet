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
import { buildLaunchRequestBody } from '../src/supervisor/launch-form.mjs';

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

describe('POST /api/sprints top-level field allowlist', () => {
    test('(a) unknown key -> 400 naming it, no spawn, no ledger claim', async () => {
        const { res, captured, claims } = await post({ bogusOverride: 'x' });
        assert.equal(res.statusCode, 400);
        const p = payloadOf(res);
        assert.equal(p.field, 'bogusOverride');
        assert.match(p.error, /bogusOverride/);
        assert.equal(captured.length, 0);
        assert.equal(claims, 0);
    });

    test('(b) azdevops_pat_secret_name -> 400 saying the launch API does not accept it', async () => {
        const { res, captured, claims } = await post({ azdevops_pat_secret_name: 'pat' });
        assert.equal(res.statusCode, 400);
        const p = payloadOf(res);
        assert.equal(p.field, 'azdevops_pat_secret_name');
        assert.match(p.error, /launch API does not accept/);
        assert.equal(captured.length, 0);
        assert.equal(claims, 0);
    });

    test('(c) the dashboard launch-form body launches (201)', async () => {
        const built = buildLaunchRequestBody({
            selectedRoots: ['PROJ-1'], members: ['a'], goal: 'P1/P2', branch: 'feat/x', base: 'main',
            roleMap: { doer: ['a'] }, overrideRelaunchGate: true,
        });
        assert.equal(built.ok, true);
        const { res, captured } = await post(built.body);
        assert.equal(res.statusCode, 201, res.body);
        assert.equal(captured.length, 1);
    });

    test('(d) the fleet-supervisor SKILL.md curl example body launches (201)', async () => {
        const { res } = await post({ goal: 'P1/P2' });
        assert.equal(res.statusCode, 201, res.body);
    });

    test('every documented field and alias is accepted', async () => {
        const all = await post({
            maxCycles: 3, allowMissingMembers: true, requirementsFile: '/tmp/r.md', roleMap: { doer: ['a'] },
            budget: 5, phases: { regression: 'skip' }, kbDemotionLoop: 'off', tierPolicy: 'economy',
            tierOverrides: { planner: 'cheap' }, overrideRelaunchGate: true,
        });
        assert.equal(all.res.statusCode, 201, all.res.body);
        const aliases = await post({ issue: undefined, target_issue: 'PROJ-2', base: undefined, base_branch: 'main' });
        assert.equal(aliases.res.statusCode, 201, aliases.res.body);
    });
});
