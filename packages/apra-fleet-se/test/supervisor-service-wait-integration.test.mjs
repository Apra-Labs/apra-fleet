// A sprint rides out a short supervisor outage (REFUSED connection only) and
// names the supervisor when it stays down. Real supervisor dolt-mutex route,
// real createHttpDoltPushMutexClient.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { createSupervisor, readJsonBody, sendJson } from '../src/supervisor/server.mjs';
import { createDoltMutex, registerDoltMutexRoutes } from '../src/supervisor/dolt-mutex.mjs';
import { createHttpDoltPushMutexClient } from '../fleet-sprint/coordination.mjs';
import { SupervisorUnreachableError } from '../fleet-sprint/errors.mjs';
import { postDispatchSyncMessage } from '../fleet-sprint/git-sync.mjs';

const quiet = { log() {}, error() {} };

/** A port nothing listens on right now. */
function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}

describe('supervisor service-URL wait (real route, real client)', () => {
    test('1. supervisor comes up within the budget: one token, one lease, wait lines name the URL', async () => {
        const port = await freePort();
        const url = `http://127.0.0.1:${port}`;
        const logs = [];
        const client = createHttpDoltPushMutexClient({
            serviceUrl: url, sprintId: 'sprint-a', log: (l) => logs.push(l),
            supervisorWaitMs: 15_000, supervisorBackoffMs: 100,
        });
        const pending = client.acquire('sprint-a');
        await new Promise((r) => setTimeout(r, 450)); // several refused attempts first
        const mutex = createDoltMutex({ leaseMs: 100_000, logger: quiet });
        const sup = createSupervisor({ port, apiToken: null, host: '127.0.0.1', logger: quiet });
        registerDoltMutexRoutes(sup, mutex, { readJsonBody, sendJson });
        await sup.start();
        try {
            const grant = await pending;
            assert.ok(grant.token);
            const st = mutex.status();
            assert.equal(st.held, true);
            assert.equal(st.holder.sprintId, 'sprint-a');
            assert.equal(st.queueDepth, 0);
            const waitLines = logs.filter((l) => l.includes('refused the connection'));
            assert.ok(waitLines.length >= 1, 'expected wait log lines');
            for (const l of waitLines) assert.ok(l.includes(url), l);
            assert.equal(await client.release(grant.token), true);
        } finally {
            await sup.stop();
        }
    });

    test('2. nothing ever listens: typed error naming the URL, bounded by budget + one step', async () => {
        const port = await freePort();
        const url = `http://127.0.0.1:${port}`;
        const budget = 600; const step = 100;
        const client = createHttpDoltPushMutexClient({
            serviceUrl: url, sprintId: 'sprint-b', log() {}, supervisorWaitMs: budget, supervisorBackoffMs: step,
        });
        const t0 = Date.now();
        await assert.rejects(client.acquire('sprint-b'), (e) => {
            assert.ok(e instanceof SupervisorUnreachableError);
            assert.ok(e.message.includes(url));
            assert.ok(!/credential|remote/i.test(e.message));
            return true;
        });
        const elapsed = Date.now() - t0;
        assert.ok(elapsed >= budget - step, `elapsed ${elapsed}`);
        assert.ok(elapsed <= budget + step + 1500, `elapsed ${elapsed} exceeds budget + one step (+scheduling slack)`);
    });

    test('3. accept-then-destroy: exactly one request, thrown at once', async () => {
        let requests = 0;
        const server = http.createServer((req) => { requests += 1; req.socket.destroy(); });
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const url = `http://127.0.0.1:${server.address().port}`;
        const client = createHttpDoltPushMutexClient({
            serviceUrl: url, sprintId: 'sprint-c', log() {}, supervisorWaitMs: 30_000, supervisorBackoffMs: 1_000,
        });
        try {
            const t0 = Date.now();
            await assert.rejects(client.acquire('sprint-c'), (e) => e instanceof SupervisorUnreachableError && e.message.includes(url));
            assert.ok(Date.now() - t0 < 900, 'no backoff wait expected');
            assert.equal(requests, 1);
        } finally {
            server.closeAllConnections?.();
            await new Promise((r) => server.close(r));
        }
    });

    test('4. post-dispatch sync failure wrapping the typed error carries the supervisor remedy', () => {
        const typed = new SupervisorUnreachableError('http://127.0.0.1:8787', { detail: 'connection refused for 120s' });
        const msg = postDispatchSyncMessage('member-1', new Error('dolt push mutex acquire failed', { cause: typed }));
        assert.match(msg, /supervisor/i);
        assert.match(msg, /fleet-supervisor skill/);
        assert.ok(!msg.includes('credentials/remote'), msg);
    });
});
