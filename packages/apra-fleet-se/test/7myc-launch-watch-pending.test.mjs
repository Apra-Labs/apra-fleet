import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { createSprintController, registerSprintRoutes } from '../src/supervisor/api.mjs';
import { classifyLaunchWatch } from '../src/supervisor/launch-form.mjs';
import { createTestSupervisor } from './helpers/supervisor-harness.mjs';

// apra-fleet-7myc.1 / .2: while a launched sprint child is not listening yet the
// supervisor answers GET /api/sprints/:id with a below-400 pending marker, never a
// 5xx (a 5xx is logged to the browser console on every launch-watcher poll).

const cleanups = [];
after(async () => { for (const c of cleanups.splice(0)) await c(); });

async function freePort() {
    return new Promise((resolve, reject) => {
        const s = http.createServer();
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
        s.on('error', reject);
    });
}

async function setup({ claim = true } = {}) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), '7myc-'));
    const now = () => '2026-07-18T00:00:00.000Z';
    const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now });
    await ledger.start();
    const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now });
    await history.start();
    if (claim) await ledger.claim('s1', { members: ['a'], issueRoots: ['R'], childPid: 42 });
    const port = await freePort();
    const { supervisor, headers, dispose } = await createTestSupervisor({ port: 0, dataDir: dir });
    registerSprintRoutes(supervisor, createSprintController({
        ledger, history,
        spawner: { spawnSprint: async () => { throw new Error('unused'); } },
        listMembers: () => ({}), getBacklog: () => ({}),
        hasTerminalState: () => null,
        resolvePort: (pid) => (pid === 42 ? port : undefined),
    }));
    const { port: supPort } = await supervisor.start();
    cleanups.push(async () => {
        await supervisor.stop('test');
        await dispose();
        await fsp.rm(dir, { recursive: true, force: true });
    });
    const get = (p) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: supPort, path: p, headers: headers() }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
        }).on('error', reject);
    });
    return { get, port, history };
}

describe('7myc: launch watcher poll while the child is not listening yet', () => {
    test('every poll before the child listens is below 400 with a pending marker; watcher keeps polling; real state once listening', async () => {
        const { get, port } = await setup();
        for (let i = 0; i < 4; i++) {
            const r = await get('/api/sprints/s1');
            assert.ok(r.status < 400, `poll ${i} got ${r.status}`);
            const body = JSON.parse(r.body);
            assert.equal(body.pending, true);
            assert.equal(body.starting, true);
            assert.equal(body.live, false);
            // The watcher must treat it as inconclusive (keep polling), not failed.
            assert.deepEqual(classifyLaunchWatch(body), { status: 'unknown' });
        }
        const child = http.createServer((req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'running' }));
        });
        await new Promise((r) => child.listen(port, '127.0.0.1', r));
        try {
            const r = await get('/api/sprints/s1');
            assert.equal(r.status, 200);
            const body = JSON.parse(r.body);
            assert.equal(body.live, true);
            assert.equal(body.state.status, 'running');
            assert.equal(body.pending, undefined);
            assert.deepEqual(classifyLaunchWatch(body), { status: 'live' });
        } finally {
            await new Promise((r) => child.close(r));
        }
    });

    test('a reservation whose port is not known yet is pending, not 404', async () => {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), '7myc-'));
        cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
        const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME) });
        await ledger.start();
        const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME) });
        await history.start();
        await ledger.claim('s2', { members: ['a'], issueRoots: ['R'], childPid: 7 });
        const c = createSprintController({
            ledger, history, spawner: { spawnSprint: async () => { throw new Error('unused'); } }, listMembers: () => ({}), getBacklog: () => ({}),
            hasTerminalState: () => null, resolvePort: () => undefined,
        });
        const out = await c.getSprint('s2');
        assert.equal(out.pending, true);
    });

    test('a child that exited / launch-failed still reports failure even though its port refuses', async () => {
        const { get, history } = await setup();
        await history.record({ sprintId: 's1', event: 'launch-failed', reason: 'spawn ENOENT', members: ['a'], issueRoots: ['R'] });
        const r = await get('/api/sprints/s1');
        assert.ok(r.status < 400);
        const body = JSON.parse(r.body);
        assert.equal(body.pending, undefined);
        assert.equal(body.latest.event, 'launch-failed');
        assert.deepEqual(classifyLaunchWatch(body), { status: 'failed', reason: 'spawn ENOENT' });
    });

    test('a non-connection proxy error is still a server error (not masked as pending)', async () => {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), '7myc-'));
        cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
        const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME) });
        await ledger.start();
        const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME) });
        await history.start();
        await ledger.claim('s3', { members: ['a'], issueRoots: ['R'], childPid: 9 });
        const c = createSprintController({
            ledger, history, spawner: { spawnSprint: async () => { throw new Error('unused'); } }, listMembers: () => ({}), getBacklog: () => ({}),
            hasTerminalState: () => null, resolvePort: () => 1234,
            proxyState: async () => { throw new Error('child /state returned invalid JSON'); },
        });
        await assert.rejects(() => c.getSprint('s3'), /invalid JSON/);
    });
});
