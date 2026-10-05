import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import {
    registerDoltMutexRoutes,
    nullDoltPushMutexClient,
    DEFAULT_LEASE_MS,
} from '../src/supervisor/dolt-mutex.mjs';
import { createSupervisor, readJsonBody, sendJson } from '../src/supervisor/server.mjs';
import { tempDoltMutexFactory } from './helpers/temp-dolt-mutex.mjs';

// Every mutex persists mutex.json into its own temp dir, never the shared
// isolated HOME (see helpers/temp-dolt-mutex.mjs).
const mutexes = tempDoltMutexFactory();
after(() => mutexes.cleanup());

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
        const mutex = mutexes.make({ leaseMs: 100_000, now: () => Date.now() });

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
        const mutex = mutexes.make({ leaseMs: 100_000 });
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
        const mutex = mutexes.make({ leaseMs: 100_000 });
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
        const mutex = mutexes.make({ leaseMs: 100_000 });
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
        const mutex = mutexes.make({ leaseMs: 1_000, now: clock.now });
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
        const mutex = mutexes.make({
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
        const mutex = mutexes.make({ leaseMs: 1_000, now: clock.now });
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
        const mutex = mutexes.make({ leaseMs: 100_000 });
        const g = await mutex.acquire('A');
        assert.equal(mutex.release('wrong-token'), false, 'a wrong token is a no-op');
        assert.equal(mutex.status().holder.sprintId, 'A', 'still held after a wrong-token release');
        assert.equal(mutex.release(g.token), true);
        assert.equal(mutex.release(g.token), false, 'double release is a no-op');
        assert.equal(mutex.status().held, false);
    });

    test('cancelWaiter drops a queued waiter without disturbing the holder', async () => {
        const mutex = mutexes.make({ leaseMs: 100_000 });
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
        const mutex = mutexes.make({ leaseMs: 100_000 });
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
        const mutex = mutexes.make({ leaseMs: 100_000 });
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

// =============================================================================
// apra-fleet-oiuf.1.1 -- the holder is persisted to <dataDir>/mutex.json on
// every holder transition and restored by start(), so a supervisor restart
// mid-push cannot let a second sprint in.
// =============================================================================

function captureLogger() {
    const lines = { log: [], warn: [], error: [] };
    return {
        lines,
        log: (...a) => lines.log.push(a.join(' ')),
        warn: (...a) => lines.warn.push(a.join(' ')),
        error: (...a) => lines.error.push(a.join(' ')),
    };
}

function readMutexFile(dataDir) {
    return JSON.parse(readFileSync(path.join(dataDir, 'mutex.json'), 'utf-8'));
}

function newDataDir() {
    return mkdtempSync(path.join(os.tmpdir(), 'dolt-mutex-persist-'));
}

/** Let a pending acquire() promise settle if it is going to. */
async function settleTicks() {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

describe('dolt-mutex -- holder persisted to mutex.json', () => {
    test('acquire, renew, release and reclaim each rewrite the holder on disk', async () => {
        const dataDir = newDataDir();
        const clock = fakeClock(10_000);
        try {
            const mutex = mutexes.make({ dataDir, leaseMs: 1_000, now: clock.now, logger: captureLogger() });
            const g = await mutex.acquire('A', { pid: process.pid });
            await mutex.flush();
            const afterAcquire = readMutexFile(dataDir);
            assert.deepEqual(afterAcquire, {
                version: 1,
                holder: { sprintId: 'A', pid: process.pid, token: g.token, acquiredAt: 10_000, leaseExpiresAt: 11_000 },
            });

            clock.advance(500);
            assert.ok(mutex.renew(g.token));
            await mutex.flush();
            assert.equal(readMutexFile(dataDir).holder.leaseExpiresAt, 11_500, 'renew updates leaseExpiresAt on disk');

            assert.equal(mutex.release(g.token), true);
            await mutex.flush();
            assert.deepEqual(readMutexFile(dataDir), { version: 1, holder: null }, 'release nulls the holder on disk');

            // A holder whose lease runs out is reclaimed and nulled on disk.
            await mutex.acquire('B', { pid: null });
            clock.advance(5_000);
            assert.equal(mutex.reclaimExpired(), true);
            await mutex.flush();
            assert.equal(readMutexFile(dataDir).holder, null, 'a reclaimed expired holder is nulled on disk');

            // A holder whose pid is dead is reclaimed and nulled on disk.
            let alive = true;
            const m2 = mutexes.make({ dataDir, leaseMs: 100_000, isPidAlive: () => alive, logger: captureLogger() });
            await m2.acquire('C', { pid: 424242 });
            await m2.flush();
            assert.equal(readMutexFile(dataDir).holder.sprintId, 'C');
            alive = false;
            assert.equal(m2.reclaimExpired(), true);
            await m2.flush();
            assert.equal(readMutexFile(dataDir).holder, null, 'a reclaimed dead-pid holder is nulled on disk');
        } finally {
            await mutexes.cleanup();
            rmSync(dataDir, { recursive: true, force: true });
        }
    });

    test('a NEW instance on the same dataDir restores a live holder: it blocks others, renews and hands off', async () => {
        const dataDir = newDataDir();
        try {
            const first = mutexes.make({ dataDir, leaseMs: 100_000, logger: captureLogger() });
            await first.start();
            const h = await first.acquire('H', { pid: process.pid });
            await first.stop();
            assert.equal(readMutexFile(dataDir).holder.token, h.token, 'stop() leaves the holder on disk');

            const logger = captureLogger();
            const second = mutexes.make({ dataDir, leaseMs: 100_000, logger });
            await second.start();
            const st = second.status();
            assert.equal(st.held, true);
            assert.equal(st.holder.sprintId, 'H');
            assert.equal(st.holder.pid, process.pid);
            assert.ok(logger.lines.log.some((l) => /restored holder 'H'/.test(l)), 'the restore is logged');

            let wGrant = null;
            const pW = second.acquire('W', { pid: process.pid }).then((g) => { wGrant = g; });
            await settleTicks();
            assert.equal(wGrant, null, 'a different sprint stays pending while the restored lease is live');
            assert.equal(second.status().queueDepth, 1);

            assert.ok(second.renew(h.token), 'renew with the restored token succeeds');
            assert.equal(second.release(h.token), true, 'release with the restored token succeeds');
            await pW;
            assert.equal(wGrant.sprintId, 'W', 'release hands the mutex to the waiter');
            assert.notEqual(wGrant.token, h.token, 'a token minted after restart never equals the restored one');
            await second.flush();
            assert.equal(readMutexFile(dataDir).holder.sprintId, 'W');
            await second.stop();
        } finally {
            await mutexes.cleanup();
            rmSync(dataDir, { recursive: true, force: true });
        }
    });

    test('start() discards an expired lease or a dead pid with a log line', async () => {
        for (const [label, holder, isAlive, why] of [
            ['expired', { sprintId: 'old', pid: null, token: 'old#1#x', acquiredAt: 1, leaseExpiresAt: Date.now() - 1 }, () => true, /lease expired/],
            ['dead-pid', { sprintId: 'gone', pid: 99999999, token: 'gone#1#x', acquiredAt: 1, leaseExpiresAt: Date.now() + 600_000 }, () => false, /not alive/],
        ]) {
            const dataDir = newDataDir();
            try {
                writeFileSync(path.join(dataDir, 'mutex.json'), JSON.stringify({ version: 1, holder }));
                const logger = captureLogger();
                const mutex = mutexes.make({ dataDir, isPidAlive: isAlive, logger });
                await mutex.start();
                assert.equal(mutex.status().held, false, `${label}: holder discarded`);
                const line = logger.lines.log.find((l) => l.includes(`discarding persisted holder '${holder.sprintId}'`));
                assert.ok(line, `${label}: discard is logged naming the sprintId`);
                assert.match(line, why);
                await mutex.stop();
                assert.equal(readMutexFile(dataDir).holder, null, `${label}: the stale holder is cleared on disk`);
                const g = await mutex.acquire('fresh');
                assert.equal(g.sprintId, 'fresh', `${label}: a new acquirer is granted immediately`);
            } finally {
                await mutexes.cleanup();
                rmSync(dataDir, { recursive: true, force: true });
            }
        }
    });

    test('corrupt JSON or an unknown version -> start() resolves with no holder and a warning', async () => {
        for (const [label, content] of [
            ['corrupt', '{ not json'],
            ['unknown-version', JSON.stringify({ version: 99, holder: { sprintId: 'x', pid: null, token: 't', acquiredAt: 1, leaseExpiresAt: Date.now() + 600_000 } })],
        ]) {
            const dataDir = newDataDir();
            try {
                writeFileSync(path.join(dataDir, 'mutex.json'), content);
                const logger = captureLogger();
                const mutex = mutexes.make({ dataDir, logger });
                await mutex.start();
                assert.equal(mutex.status().held, false, `${label}: empty holder`);
                assert.equal(logger.lines.warn.length, 1, `${label}: exactly one warning`);
                assert.match(logger.lines.warn[0], /WARNING/);
                await mutex.stop();
            } finally {
                await mutexes.cleanup();
                rmSync(dataDir, { recursive: true, force: true });
            }
        }
    });

    test('a missing file starts silently with no holder; a write failure is logged, never thrown', async () => {
        const dataDir = newDataDir();
        try {
            const logger = captureLogger();
            const failingFs = {
                mkdir: async () => {},
                readFile: async () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; },
                writeFile: async () => { throw new Error('disk full'); },
                rename: async () => {},
            };
            const mutex = mutexes.make({ dataDir, fs: failingFs, logger });
            await mutex.start();
            assert.equal(mutex.status().held, false);
            assert.equal(logger.lines.warn.length, 0, 'a missing file is not a warning');
            const g = await mutex.acquire('A');
            assert.equal(mutex.release(g.token), true, 'sync contract unchanged despite failing writes');
            await mutex.flush();
            assert.ok(logger.lines.error.some((l) => /failed to persist holder/.test(l) && /disk full/.test(l)));
            await mutex.stop();
        } finally {
            await mutexes.cleanup();
            rmSync(dataDir, { recursive: true, force: true });
        }
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

// =============================================================================
// apra-fleet-oiuf.1.2 -- route semantics: retryable 503 on stop, 409 not-holder
// on a non-matching renew, and token-proven idempotent re-acquire.
// =============================================================================

describe('dolt-mutex routes -- stop / not-holder / token-proven re-acquire', () => {
    function setup(opts = {}) {
        const dataDir = newDataDir();
        const mutex = mutexes.make({ leaseMs: 1_000, dataDir, ...opts });
        const supervisor = createSupervisor({ port: 0 });
        registerDoltMutexRoutes(supervisor, mutex, { readJsonBody, sendJson });
        const call = async (url, body) => {
            const res = mockRes();
            await supervisor.handleRequest(mockReq('POST', url, body), res);
            return { res, json: res.body ? JSON.parse(res.body) : undefined };
        };
        const acquireP = (sprintId, body) => {
            const res = mockRes();
            const done = supervisor.handleRequest(mockReq('POST', `/api/dolt-push-mutex/${sprintId}/acquire`, body), res);
            return { res, done };
        };
        return { dataDir, mutex, call, acquireP };
    }

    test('a waiter pending when stop() runs gets 503 supervisor-stopping, retryable', async () => {
        const { mutex, call, acquireP } = setup();
        const a = await call('/api/dolt-push-mutex/A/acquire', { pid: process.pid });
        assert.equal(a.res.statusCode, 200);
        const w = acquireP('B', { pid: process.pid });
        await settleTicks();
        assert.equal(w.res.statusCode, undefined);
        await mutex.stop();
        await w.done;
        assert.equal(w.res.statusCode, 503);
        const body = JSON.parse(w.res.body);
        assert.equal(body.error, 'supervisor-stopping');
        assert.equal(body.retryable, true);
        assert.match(body.message, /shutting down/);
    });

    test('a cancelled waiter keeps the plain 503 shape (not supervisor-stopping)', async () => {
        const { mutex, call, acquireP } = setup();
        await call('/api/dolt-push-mutex/A/acquire', { pid: process.pid });
        const w = acquireP('B', { pid: process.pid });
        await settleTicks();
        mutex.cancelWaiter('B');
        await w.done;
        assert.equal(w.res.statusCode, 503);
        const body = JSON.parse(w.res.body);
        assert.match(body.error, /^acquire failed:/);
        assert.equal(body.retryable, undefined);
        await mutex.stop();
    });

    test('renew: unknown/stale token -> 409 not-holder; holder token -> 200 renewed', async () => {
        const { mutex, call } = setup();
        const a = await call('/api/dolt-push-mutex/A/acquire', { pid: process.pid });
        const bad = await call('/api/dolt-push-mutex/A/renew', { token: 'nope' });
        assert.equal(bad.res.statusCode, 409);
        assert.deepEqual(bad.json, { error: 'not-holder' });
        const ok = await call('/api/dolt-push-mutex/A/renew', { token: a.json.token });
        assert.equal(ok.res.statusCode, 200);
        assert.equal(ok.json.renewed, true);
        await call('/api/dolt-push-mutex/A/release', { token: a.json.token });
        const stale = await call('/api/dolt-push-mutex/A/renew', { token: a.json.token });
        assert.equal(stale.res.statusCode, 409);
        await mutex.stop();
    });

    test('acquire with the live holder token returns the same token, refreshed, lease moves, queue unchanged', async () => {
        const clock = fakeClock(10_000);
        const { mutex, dataDir, call, acquireP } = setup({ now: clock.now });
        const a = await call('/api/dolt-push-mutex/A/acquire', { pid: process.pid });
        const w = acquireP('B', { pid: process.pid });
        await settleTicks();
        assert.equal(mutex.status().queueDepth, 1);
        clock.advance(400);
        const re = await call('/api/dolt-push-mutex/A/acquire', { pid: process.pid, token: a.json.token });
        assert.equal(re.res.statusCode, 200);
        assert.equal(re.json.token, a.json.token);
        assert.equal(re.json.refreshed, true);
        assert.ok(re.json.expiresAt > a.json.expiresAt, 'lease moved forward');
        assert.equal(re.json.expiresAt, 10_400 + 1_000);
        assert.equal(mutex.status().queueDepth, 1, 'waiter queue untouched');
        await mutex.flush();
        assert.equal(readMutexFile(dataDir).holder.leaseExpiresAt, re.json.expiresAt);
        await mutex.stop();
        await w.done;
    });

    test('acquire with the holder sprintId+pid but NO token still queues', async () => {
        const { mutex, call, acquireP } = setup();
        await call('/api/dolt-push-mutex/A/acquire', { pid: process.pid });
        const second = acquireP('A', { pid: process.pid });
        await settleTicks();
        assert.equal(second.res.statusCode, undefined, 'not granted while holder holds');
        assert.equal(mutex.status().queueDepth, 1);
        await mutex.stop();
        await second.done;
    });

    test('acquire with a stale token is a fresh acquire: queues, then gets a NEW token', async () => {
        const { mutex, call, acquireP } = setup();
        const a = await call('/api/dolt-push-mutex/A/acquire', { pid: process.pid });
        const stale = 'A#stale-token';
        const w = acquireP('A', { pid: process.pid, token: stale });
        await settleTicks();
        assert.equal(w.res.statusCode, undefined, 'queues behind the live holder');
        await call('/api/dolt-push-mutex/A/release', { token: a.json.token });
        await w.done;
        assert.equal(w.res.statusCode, 200);
        const g = JSON.parse(w.res.body);
        assert.notEqual(g.token, stale);
        assert.notEqual(g.token, a.json.token);
        assert.equal(g.refreshed, undefined);
        await mutex.stop();
    });

    test('a token that matches the holder but on a different sprintId is not idempotent', async () => {
        const { mutex, call, acquireP } = setup();
        const a = await call('/api/dolt-push-mutex/A/acquire', { pid: process.pid });
        const w = acquireP('B', { pid: process.pid, token: a.json.token });
        await settleTicks();
        assert.equal(w.res.statusCode, undefined);
        await mutex.stop();
        await w.done;
    });

    test('a non-string acquire token is a 400', async () => {
        const { mutex, call } = setup();
        const r = await call('/api/dolt-push-mutex/A/acquire', { pid: process.pid, token: 42 });
        assert.equal(r.res.statusCode, 400);
        await mutex.stop();
    });
});
