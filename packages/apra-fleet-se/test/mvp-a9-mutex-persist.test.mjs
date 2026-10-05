import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

import { createDoltMutex, registerDoltMutexRoutes } from '../src/supervisor/dolt-mutex.mjs';
import { readJsonBody, sendJson } from '../src/supervisor/server.mjs';

// apra-fleet-oiuf.1.3 -- the holder survives an in-process supervisor restart.
// Each "supervisor" is a real HTTP listener (startTestSupervisor) on a NEW
// ephemeral port; the mutex dataDir is the same mkdtemp dir across restarts.
// startTestSupervisor takes no route-registration hook, so routes are added
// via a createSupervisor built here (see boot()).

import { createSupervisor } from '../src/supervisor/server.mjs';
import { resolveServiceToken } from '../src/supervisor/auth.mjs';

const tmpDirs = [];
const mutexes = [];
function tmp(prefix) {
    const d = mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
}
after(async () => {
    await Promise.all(mutexes.map((m) => m.flush()));
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

async function boot(dataDir, home) {
    const mutex = createDoltMutex({ dataDir, leaseMs: 60_000 });
    mutexes.push(mutex);
    const { token } = resolveServiceToken(tmp('mvp-a9-auth-'), { home });
    const supervisor = createSupervisor({ port: 0, token });
    registerDoltMutexRoutes(supervisor, mutex, { readJsonBody, sendJson });
    await mutex.start();
    const { port } = await supervisor.start();
    const base = `http://127.0.0.1:${port}`;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    return {
        mutex,
        port,
        post: (p, body, signal) => fetch(`${base}${p}`, { method: 'POST', headers, body: JSON.stringify(body), signal }),
        async stop() { await supervisor.stop('test'); await mutex.stop(); },
    };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe('part 1: mvp-a9 mutex persistence', () => {
    test('part 1: holder is honoured across an in-process supervisor restart (new port, same dataDir)', async () => {
        const dataDir = tmp('mvp-a9-data-');
        const home = tmp('mvp-a9-home-');
        const first = await boot(dataDir, home);
        const hRes = await first.post('/api/dolt-push-mutex/H/acquire', { pid: process.pid });
        assert.equal(hRes.status, 200);
        const h = await hRes.json();
        await first.mutex.flush();
        await first.stop();

        const second = await boot(dataDir, home);
        try {
            // (1) H's original token still renews.
            const renew = await second.post('/api/dolt-push-mutex/H/renew', { token: h.token });
            assert.equal(renew.status, 200);
            assert.equal((await renew.json()).renewed, true);

            // (2) another sprint stays pending while H's lease is live.
            const ac = new AbortController();
            let wStatus = null;
            const wP = second.post('/api/dolt-push-mutex/W/acquire', { pid: process.pid }, ac.signal)
                .then(async (r) => { wStatus = r.status; return r.json(); }, () => null);
            const x = second.post('/api/dolt-push-mutex/X/acquire', { pid: process.pid }, ac.signal)
                .then(() => 'granted', () => 'aborted');
            await settle();
            assert.equal(wStatus, null, 'W is not granted while the restored holder is live');
            assert.equal(second.mutex.status().holder.sprintId, 'H');
            assert.equal(second.mutex.status().queueDepth, 2);

            // (3) H releases -> W (front of FIFO) is granted.
            const rel = await second.post('/api/dolt-push-mutex/H/release', { token: h.token });
            assert.deepEqual(await rel.json(), { released: true });
            const w = await wP;
            assert.equal(wStatus, 200);
            assert.equal(w.status, 'acquired');
            assert.equal(second.mutex.status().holder.sprintId, 'W');
            ac.abort();
            await x;
        } finally {
            await second.stop();
        }
    });

    test('part 1: a third sprint is never granted while the restored holder lease is live', async () => {
        const dataDir = tmp('mvp-a9-data-');
        const home = tmp('mvp-a9-home-');
        const first = await boot(dataDir, home);
        const h = await (await first.post('/api/dolt-push-mutex/H/acquire', { pid: process.pid })).json();
        await first.mutex.flush();
        await first.stop();

        const second = await boot(dataDir, home);
        try {
            const ac = new AbortController();
            let granted = false;
            const p = second.post('/api/dolt-push-mutex/T/acquire', { pid: process.pid }, ac.signal)
                .then(() => { granted = true; }, () => {});
            await settle();
            assert.equal(granted, false);
            assert.equal(second.mutex.status().holder.sprintId, 'H');
            ac.abort();
            await p;
            assert.equal((await second.post('/api/dolt-push-mutex/H/release', { token: h.token }).then((r) => r.json())).released, true);
        } finally {
            await second.stop();
        }
    });
});
