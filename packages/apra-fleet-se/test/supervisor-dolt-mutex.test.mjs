import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    createDoltMutex,
    registerDoltMutexRoutes,
    nullDoltPushMutexClient,
    DEFAULT_LEASE_MS,
} from '../src/supervisor/dolt-mutex.mjs';
import { createSupervisor, readJsonBody, sendJson } from '../src/supervisor/server.mjs';

// =============================================================================
// apra-fleet-eft.9.2 -- service-side global dolt push mutex serializing all
// cross-sprint dolt writes.
//
// Acceptance criteria proved here:
//   1. Two concurrent sprints never execute a dolt push at the same time (the
//      two-children non-overlapping-push-windows test).
//   2. The mutex is released on success, failure, and child crash (lease expiry
//      + dead-pid reclaim).
//   3. A crashed holder does not wedge the mutex permanently.
//   4. Acquisition is fair (FIFO) -- no starvation.
//   5. The mutex lives in the supervisor, not per-child (registered as a
//      supervisor route; one instance coordinates independent acquirers).
// =============================================================================

/** A controllable logical clock so lease-expiry tests are deterministic. */
function fakeClock(start = 1_000) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; }, set: (v) => { t = v; } };
}

describe('dolt-mutex -- mutual exclusion / non-overlapping push windows', () => {
    test('two concurrent sprints never hold the push mutex at the same time', async () => {
        const mutex = createDoltMutex({ leaseMs: 100_000, now: () => Date.now() });

        let activePushers = 0;
        let maxConcurrent = 0;
        const windows = [];

        // Simulate a sprint's guarded push: acquire, "push" (yield to the event
        // loop a few times to give any overlap a chance to manifest), release.
        async function guardedPush(sprintId) {
            const grant = await mutex.acquire(sprintId, { pid: process.pid });
            activePushers += 1;
            maxConcurrent = Math.max(maxConcurrent, activePushers);
            const start = performance.now();
            // Yield several times so a broken mutex would let a sibling in here.
            for (let i = 0; i < 5; i += 1) await Promise.resolve();
            windows.push({ sprintId, start, end: performance.now() });
            activePushers -= 1;
            assert.equal(mutex.release(grant.token), true);
        }

        // Fire ten pushes across two "sprints" concurrently.
        const jobs = [];
        for (let i = 0; i < 10; i += 1) {
            jobs.push(guardedPush(i % 2 === 0 ? 'sprint-A' : 'sprint-B'));
        }
        await Promise.all(jobs);

        assert.equal(maxConcurrent, 1, 'at most one pusher may ever hold the mutex');
        assert.equal(activePushers, 0, 'mutex fully drained at the end');
        // No two push windows overlap in wall-clock time.
        windows.sort((a, b) => a.start - b.start);
        for (let i = 1; i < windows.length; i += 1) {
            assert.ok(
                windows[i].start >= windows[i - 1].end - 1e-6,
                `push window ${i} started before window ${i - 1} finished`,
            );
        }
    });

    test('release hands the mutex to exactly one next waiter', async () => {
        const mutex = createDoltMutex({ leaseMs: 100_000 });
        const g1 = await mutex.acquire('A');
        let bToken = null;
        let cGranted = false;
        const pB = mutex.acquire('B').then((g) => { bToken = g.token; });
        const pC = mutex.acquire('C').then((g) => { cGranted = true; return g; });
        // Neither B nor C may proceed while A holds it.
        await Promise.resolve();
        assert.equal(bToken, null);
        assert.equal(cGranted, false);
        mutex.release(g1.token);
        await pB;
        assert.ok(bToken, 'B granted after A releases');
        assert.equal(cGranted, false, 'only ONE waiter granted per release');
        const status = mutex.status();
        assert.equal(status.holder.sprintId, 'B');
        assert.equal(status.queueDepth, 1, 'C still waiting');
        // Release B so C is served, then drain C.
        mutex.release(bToken);
        const gC = await pC;
        assert.equal(cGranted, true);
        mutex.release(gC.token);
    });
});

describe('dolt-mutex -- FIFO fairness / no starvation', () => {
    test('waiters are granted strictly in enqueue order', async () => {
        const mutex = createDoltMutex({ leaseMs: 100_000 });
        const order = [];
        const g0 = await mutex.acquire('holder');

        const ids = ['w1', 'w2', 'w3', 'w4', 'w5'];
        const tokens = new Map();
        const promises = ids.map((id) =>
            mutex.acquire(id).then((g) => { order.push(id); tokens.set(id, g.token); }),
        );

        // Release the initial holder, then release each grantee in turn so the
        // next FIFO waiter is served. A steady stream cannot jump the queue.
        mutex.release(g0.token);
        for (let i = 0; i < ids.length; i += 1) {
            // Wait until the i-th expected waiter has actually been granted.
            // eslint-disable-next-line no-await-in-loop
            await promises[i];
            const id = ids[i];
            mutex.release(tokens.get(id));
        }
        await Promise.all(promises);
        assert.deepEqual(order, ids, 'grants must follow enqueue order exactly');
    });

    test('a continuous stream of new acquirers cannot starve an early waiter', async () => {
        const mutex = createDoltMutex({ leaseMs: 100_000 });
        const g0 = await mutex.acquire('holder');
        let earlyGranted = false;
        const early = mutex.acquire('early').then((g) => { earlyGranted = true; return g; });
        // Enqueue a burst of latecomers AFTER 'early'.
        const late = [];
        for (let i = 0; i < 20; i += 1) late.push(mutex.acquire(`late-${i}`));
        assert.equal(earlyGranted, false);
        mutex.release(g0.token);
        const earlyGrant = await early;
        assert.equal(earlyGranted, true, 'the earliest waiter is served first, not the latecomers');
        assert.equal(mutex.status().holder.sprintId, 'early');
        mutex.release(earlyGrant.token);
        // Drain the latecomers in FIFO order so no promise dangles.
        for (let i = 0; i < late.length; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            const g = await late[i];
            assert.equal(mutex.status().holder.sprintId, `late-${i}`);
            mutex.release(g.token);
        }
        await mutex.stop();
    });
});

describe('dolt-mutex -- lease expiry / crash safety', () => {
    test('an expired lease is reclaimed and the mutex handed to the next waiter', async () => {
        const clock = fakeClock();
        const mutex = createDoltMutex({ leaseMs: 1_000, now: clock.now });
        const g0 = await mutex.acquire('crashed');
        // A second sprint queues while the first "crashes" (never releases).
        let bGranted = false;
        const pB = mutex.acquire('B').then((g) => { bGranted = true; return g; });
        await Promise.resolve();
        assert.equal(bGranted, false);

        // Before the lease expires, no reclaim.
        clock.advance(500);
        assert.equal(mutex.reclaimExpired(), false);
        assert.equal(bGranted, false);

        // Past the lease: reclaim on the next acquire attempt (or explicit sweep).
        clock.advance(600); // total 1100 > 1000ms lease
        assert.equal(mutex.reclaimExpired(), true);
        const gB = await pB;
        assert.equal(bGranted, true, 'the crashed holder no longer wedges the mutex');
        assert.equal(mutex.status().holder.sprintId, 'B');

        // The crashed holder's stale token can never evict the new holder.
        assert.equal(mutex.release(g0.token), false);
        assert.equal(mutex.status().holder.sprintId, 'B');
        mutex.release(gB.token);
    });

    test('a dead pid is reclaimed immediately without waiting out the full lease', async () => {
        const clock = fakeClock();
        const deadPids = new Set([4242]);
        const mutex = createDoltMutex({
            leaseMs: 100_000,
            now: clock.now,
            isPidAlive: (pid) => !deadPids.has(pid),
        });
        const g0 = await mutex.acquire('holder', { pid: 4242 });
        assert.equal(mutex.status().holder.sprintId, 'holder');
        // Lease is nowhere near expired, but the holder's pid is dead. An
        // explicit sweep reclaims it immediately -- no need to wait out the lease.
        clock.advance(10);
        assert.equal(mutex.reclaimExpired(), true, 'dead pid reclaimed before lease expiry');
        assert.equal(mutex.status().held, false, 'dead holder no longer wedges the mutex');
        // A fresh acquire also opportunistically reclaims a dead holder: even if
        // the sweep had not run, B's own acquire() clears the crashed holder.
        const gB = await mutex.acquire('B', { pid: process.pid });
        assert.equal(mutex.status().holder.sprintId, 'B');
        mutex.release(gB.token);
        // The crashed holder's stale token cannot evict anyone.
        assert.equal(mutex.release(g0.token), false);
    });

    test('renew extends the lease so a legitimately long push is not reclaimed', async () => {
        const clock = fakeClock();
        const mutex = createDoltMutex({ leaseMs: 1_000, now: clock.now });
        const g = await mutex.acquire('long-push'); // expires at now+1000
        clock.advance(800); // 800ms elapsed, lease not yet expired
        assert.equal(mutex.reclaimExpired(), false);
        const renewed = mutex.renew(g.token); // lease reset: expires at now+1000
        assert.ok(renewed && renewed.expiresAt === clock.now() + 1_000);
        clock.advance(500); // 500ms since renew, still valid
        assert.equal(mutex.reclaimExpired(), false, 'renewed lease is not yet expired');
        clock.advance(400); // 900ms since renew, still valid
        assert.equal(mutex.reclaimExpired(), false);
        clock.advance(200); // 1100ms since renew > 1000 -> expired
        assert.equal(mutex.reclaimExpired(), true);
    });
});

describe('dolt-mutex -- release semantics', () => {
    test('release is idempotent and token-guarded', async () => {
        const mutex = createDoltMutex({ leaseMs: 100_000 });
        const g = await mutex.acquire('A');
        assert.equal(mutex.release('wrong-token'), false, 'a wrong token is a no-op');
        assert.equal(mutex.status().holder.sprintId, 'A', 'still held after a wrong-token release');
        assert.equal(mutex.release(g.token), true);
        assert.equal(mutex.release(g.token), false, 'double release is a no-op');
        assert.equal(mutex.status().held, false);
    });

    test('cancelWaiter drops a queued waiter without disturbing the holder', async () => {
        const mutex = createDoltMutex({ leaseMs: 100_000 });
        const g = await mutex.acquire('holder');
        const pB = mutex.acquire('B');
        assert.equal(mutex.status().queueDepth, 1);
        const dropped = mutex.cancelWaiter('B');
        assert.equal(dropped, 1);
        await assert.rejects(pB, /cancelled/);
        assert.equal(mutex.status().queueDepth, 0);
        assert.equal(mutex.status().holder.sprintId, 'holder', 'the holder is untouched');
        mutex.release(g.token);
    });
});

/** Minimal mock req/res for driving supervisor.handleRequest directly (same
 *  convention as supervisor-reconcile.test.mjs -- no real socket binding). */
function mockReq(method, url, body) {
    const chunks = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
    return {
        method,
        url,
        on(event, cb) {
            if (event === 'data') { for (const c of chunks) cb(c); }
            if (event === 'end') { cb(); }
            // 'close' is registered by the acquire handler; never fired here.
            return this;
        },
    };
}
function mockRes() {
    return {
        statusCode: undefined,
        headers: undefined,
        body: undefined,
        headersSent: false,
        writableEnded: false,
        writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
        end(body) { this.body = body; this.writableEnded = true; },
    };
}

describe('dolt-mutex -- supervisor-owned HTTP surface (not per-child)', () => {
    test('acquire/release coordinate two independent clients over one supervisor mutex', async () => {
        const mutex = createDoltMutex({ leaseMs: 100_000 });
        const supervisor = createSupervisor({ port: 0 });
        registerDoltMutexRoutes(supervisor, mutex, { readJsonBody, sendJson });

        // Client A acquires -- resolves immediately (mutex free).
        const aRes = mockRes();
        await supervisor.handleRequest(
            mockReq('POST', '/api/dolt-push-mutex/sprint-A/acquire', { pid: process.pid }),
            aRes,
        );
        assert.equal(aRes.statusCode, 200);
        const aGrant = JSON.parse(aRes.body);
        assert.equal(aGrant.status, 'acquired');
        assert.ok(aGrant.token);

        // Client B's acquire long-polls -- its handleRequest promise must NOT
        // resolve while A holds the (single, supervisor-owned) mutex.
        const bRes = mockRes();
        let bDone = false;
        const bReq = supervisor.handleRequest(
            mockReq('POST', '/api/dolt-push-mutex/sprint-B/acquire', { pid: process.pid }),
            bRes,
        ).then(() => { bDone = true; });
        await new Promise((r) => setImmediate(r));
        assert.equal(bDone, false, 'B is blocked while A holds the supervisor mutex');
        assert.equal(bRes.statusCode, undefined);

        // Status shows A holding and B waiting -- one shared mutex, two clients.
        const statusRes = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/dolt-push-mutex'), statusRes);
        const status = JSON.parse(statusRes.body);
        assert.equal(status.holder.sprintId, 'sprint-A');
        assert.equal(status.queueDepth, 1);

        // A releases -> B is granted.
        const relRes = mockRes();
        await supervisor.handleRequest(
            mockReq('POST', '/api/dolt-push-mutex/sprint-A/release', { token: aGrant.token }),
            relRes,
        );
        assert.deepEqual(JSON.parse(relRes.body), { released: true });

        await bReq;
        assert.equal(bDone, true);
        assert.equal(bRes.statusCode, 200);
        const bGrant = JSON.parse(bRes.body);
        assert.equal(bGrant.status, 'acquired');
        assert.ok(bGrant.token);

        await mutex.stop();
    });

    test('release route rejects a missing token with 400', async () => {
        const mutex = createDoltMutex({ leaseMs: 100_000 });
        const supervisor = createSupervisor({ port: 0 });
        registerDoltMutexRoutes(supervisor, mutex, { readJsonBody, sendJson });
        const res = mockRes();
        await supervisor.handleRequest(
            mockReq('POST', '/api/dolt-push-mutex/sprint-A/release', {}),
            res,
        );
        assert.equal(res.statusCode, 400);
        await mutex.stop();
    });
});

describe('dolt-mutex -- null client for supervisor-less runs', () => {
    test('nullDoltPushMutexClient acquire/release are safe no-ops', async () => {
        const client = nullDoltPushMutexClient();
        const grant = await client.acquire('anything', { pid: 1 });
        assert.equal(grant.token, null);
        assert.equal(await client.release(grant.token), true);
    });

    test('DEFAULT_LEASE_MS is a positive duration', () => {
        assert.ok(DEFAULT_LEASE_MS > 0);
    });
});
