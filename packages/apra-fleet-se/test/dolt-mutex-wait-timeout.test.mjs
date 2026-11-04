import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Agent, fetch as undiciFetch } from 'undici';

import { createDoltMutex, registerDoltMutexRoutes } from '../src/supervisor/dolt-mutex.mjs';
import { createSupervisor, readJsonBody, sendJson } from '../src/supervisor/server.mjs';
import { createHttpDoltPushMutexClient } from '../fleet-sprint/coordination.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

// =============================================================================
// apra-fleet-pz0h -- a mutex wait longer than the HTTP client's timeouts must
// not fail the dispatch. Global fetch (undici) gives up after 300s without
// response headers, and after 300s without a body chunk. Everything here runs
// against the real route over a real socket, with those limits shortened.
// =============================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Shortened stand-in for undici's 300s headers/body timeouts. */
const CLIENT_TIMEOUT_MS = scaledTimeout(200, { concurrency: TEST_CONCURRENCY });
const HOLD_MS = Math.round(CLIENT_TIMEOUT_MS * 1.5);
const HEARTBEAT_MS = 40;

async function withServer(fn, { heartbeatMs = HEARTBEAT_MS } = {}) {
    const mutex = createDoltMutex({ leaseMs: 100_000 });
    const supervisor = createSupervisor({ port: 0 });
    registerDoltMutexRoutes(supervisor, mutex, { readJsonBody, sendJson, heartbeatMs });
    const server = http.createServer((req, res) => { supervisor.handleRequest(req, res); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
        return await fn({ mutex, server, port, serviceUrl: `http://127.0.0.1:${port}` });
    } finally {
        await mutex.stop();
        await new Promise((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
        });
    }
}

/**
 * fetch-shaped client over node:http with undici's two timeout rules: reject
 * when headers take longer than timeoutMs, and when the gap between body
 * chunks is longer than timeoutMs. Records when bytes arrived.
 */
function timeoutEnforcingFetch(timeoutMs, trace = {}) {
    return (url, init) => new Promise((resolve, reject) => {
        const req = http.request(url, { method: init.method, headers: init.headers });
        const failWith = (code) => {
            req.destroy();
            reject(Object.assign(new Error(`fetch failed (${code})`), { code }));
        };
        let timer = setTimeout(() => failWith('UND_ERR_HEADERS_TIMEOUT'), timeoutMs);
        req.on('error', reject);
        req.on('response', (res) => {
            clearTimeout(timer);
            trace.headersAt = Date.now();
            trace.chunks = [];
            const arm = () => {
                clearTimeout(timer);
                timer = setTimeout(() => failWith('UND_ERR_BODY_TIMEOUT'), timeoutMs);
            };
            arm();
            res.setEncoding('utf-8');
            res.on('data', (c) => { trace.chunks.push(c); arm(); });
            res.on('end', () => {
                clearTimeout(timer);
                const text = trace.chunks.join('');
                resolve({ ok: res.statusCode < 400, status: res.statusCode, json: async () => JSON.parse(text) });
            });
        });
        req.end(init.body);
    });
}

describe('dolt mutex acquire -- a wait longer than the client timeouts', () => {
    test('keeps waiting, keeps its queue place, logs that it waits, and is granted', async () => {
        await withServer(async ({ mutex, serviceUrl }) => {
            const held = await mutex.acquire('holder');
            const trace = {};
            const logs = [];
            const client = createHttpDoltPushMutexClient({
                serviceUrl,
                sprintId: 'waiter',
                fetch: timeoutEnforcingFetch(CLIENT_TIMEOUT_MS, trace),
                log: (m) => logs.push(m),
                waitLogMs: 50,
            });
            let settled = false;
            const waiting = client.acquire('waiter', { pid: process.pid }).finally(() => { settled = true; });
            // Surface a pre-fix timeout rejection as a test failure right away.
            waiting.catch(() => {});

            await sleep(HOLD_MS);
            if (settled) await waiting;

            assert.equal(settled, false, 'still waiting: the holder has not released');
            assert.deepEqual(mutex.status().waiting.map((w) => w.sprintId), ['waiter'], 'queue place kept');
            assert.ok(trace.headersAt, 'headers arrived before the grant');
            const heartbeats = trace.chunks.length;
            assert.ok(heartbeats >= 2, `expected heartbeats while waiting, saw ${heartbeats}`);
            assert.ok(trace.chunks.every((c) => c.trim() === ''), 'nothing but whitespace before the grant');
            assert.ok(logs.some((m) => /still waiting/.test(m)), `expected a waiting log line, saw ${JSON.stringify(logs)}`);

            mutex.release(held.token);
            const grant = await waiting;
            assert.ok(grant.token, 'the grant carries a token');
            assert.equal(mutex.status().holder.sprintId, 'waiter');

            const logsAtGrant = logs.length;
            await sleep(150);
            assert.equal(logs.length, logsAtGrant, 'the waiting log stops at the grant');
        });
    });

    test('FIFO order is preserved across a long wait', async () => {
        await withServer(async ({ mutex, serviceUrl }) => {
            const held = await mutex.acquire('holder');
            const granted = [];
            const start = (id) => createHttpDoltPushMutexClient({
                serviceUrl,
                sprintId: id,
                fetch: timeoutEnforcingFetch(CLIENT_TIMEOUT_MS),
            }).acquire(id).then((g) => { granted.push(id); return g; });

            const first = start('first');
            while (mutex.status().queueDepth < 1) await sleep(5);
            const second = start('second');
            while (mutex.status().queueDepth < 2) await sleep(5);

            await sleep(HOLD_MS);
            mutex.release(held.token);
            const g1 = await first;
            assert.deepEqual(granted, ['first']);
            mutex.release(g1.token);
            await second;
            assert.deepEqual(granted, ['first', 'second']);
        });
    });

    test('real global fetch parses a grant that follows heartbeat whitespace', async () => {
        await withServer(async ({ mutex, serviceUrl }) => {
            const held = await mutex.acquire('holder');
            const client = createHttpDoltPushMutexClient({ serviceUrl, sprintId: 'waiter' });
            const waiting = client.acquire('waiter');
            await sleep(HEARTBEAT_MS * 4);
            mutex.release(held.token);
            const grant = await waiting;
            assert.match(grant.token, /^waiter#/);
        });
    });

    test('an uncontended acquire answers immediately with the grant', async () => {
        await withServer(async ({ serviceUrl }) => {
            const client = createHttpDoltPushMutexClient({ serviceUrl, sprintId: 'solo' });
            const grant = await client.acquire('solo');
            assert.match(grant.token, /^solo#/);
            assert.equal(await client.release(grant.token), true);
        });
    });
});

describe('dolt mutex acquire -- failures stay loud', () => {
    test('an error after the headers went out rejects the client', async () => {
        await withServer(async ({ mutex, serviceUrl }) => {
            await mutex.acquire('holder');
            const client = createHttpDoltPushMutexClient({ serviceUrl, sprintId: 'waiter' });
            const waiting = client.acquire('waiter');
            while (mutex.status().queueDepth < 1) await sleep(5);
            await mutex.stop();
            await assert.rejects(waiting, /acquire failed: dolt mutex is shutting down/);
        });
    });

    test('a 200 payload with no token rejects instead of reading as a grant', async () => {
        const client = createHttpDoltPushMutexClient({
            serviceUrl: 'http://svc',
            sprintId: 'waiter',
            fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
        });
        await assert.rejects(client.acquire('waiter'), /no token/);
    });

    test('an unreachable supervisor rejects', async () => {
        const probe = http.createServer();
        await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
        const { port } = probe.address();
        await new Promise((resolve) => probe.close(resolve));
        const client = createHttpDoltPushMutexClient({ serviceUrl: `http://127.0.0.1:${port}`, sprintId: 'waiter' });
        await assert.rejects(client.acquire('waiter'), /fetch failed/);
    });

    test('a supervisor that dies mid-wait rejects the waiter', async () => {
        await withServer(async ({ mutex, server, serviceUrl }) => {
            await mutex.acquire('holder');
            const client = createHttpDoltPushMutexClient({ serviceUrl, sprintId: 'waiter' });
            const waiting = client.acquire('waiter');
            while (mutex.status().queueDepth < 1) await sleep(5);
            await sleep(HEARTBEAT_MS * 2);
            server.closeAllConnections();
            await assert.rejects(waiting);
        });
    });

    test('a supervisor that sends headers and then goes silent rejects after a bound', async () => {
        // Headers go out at once, so the body timeout is the only thing bounding
        // a hung supervisor. Real undici with that limit shortened from 300s; the
        // client's own init wins over this dispatcher, so a client that turned
        // the timeout off would fail here too.
        const BODY_TIMEOUT_MS = 300;
        const agent = new Agent({ bodyTimeout: BODY_TIMEOUT_MS });
        const silent = http.createServer((req, res) => {
            req.resume();
            res.writeHead(200, { 'content-type': 'application/json' });
            res.flushHeaders();
        });
        await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
        let deadline;
        try {
            const client = createHttpDoltPushMutexClient({
                serviceUrl: `http://127.0.0.1:${silent.address().port}`,
                sprintId: 'waiter',
                fetch: (url, init) => undiciFetch(url, { dispatcher: agent, ...init }),
            });
            const hung = new Promise((_, reject) => {
                deadline = setTimeout(
                    () => reject(new Error('acquire still pending: nothing bounds a silent supervisor')),
                    scaledTimeout(5000, { concurrency: TEST_CONCURRENCY }),
                );
            });
            const err = await Promise.race([client.acquire('waiter'), hung]).then(
                () => assert.fail('acquire resolved against a silent supervisor'),
                (e) => e,
            );
            assert.equal(err.cause?.code, 'UND_ERR_BODY_TIMEOUT', `unexpected rejection: ${err.stack}`);
        } finally {
            clearTimeout(deadline);
            silent.closeAllConnections();
            await new Promise((resolve) => silent.close(resolve));
            await agent.destroy();
        }
    });
});

describe('dolt mutex acquire -- a client that hangs up', () => {
    test('is dropped from the queue and never handed the mutex', async () => {
        await withServer(async ({ mutex, serviceUrl }) => {
            const held = await mutex.acquire('holder');
            const aborter = new AbortController();
            const gone = fetch(`${serviceUrl}/api/dolt-push-mutex/gone/acquire`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{}',
                signal: aborter.signal,
            }).then((res) => res.json());
            gone.catch(() => {});
            while (mutex.status().queueDepth < 1) await sleep(5);

            aborter.abort();
            const deadline = Date.now() + scaledTimeout(2000, { concurrency: TEST_CONCURRENCY });
            while (mutex.status().queueDepth > 0 && Date.now() < deadline) await sleep(5);
            assert.equal(mutex.status().queueDepth, 0, 'the waiter left the queue on disconnect');

            mutex.release(held.token);
            assert.equal(mutex.status().held, false, 'no grant went to the departed client');
        });
    });

    test('a grant that lands after the client left goes straight back', async () => {
        const mutex = createDoltMutex({ leaseMs: 100_000 });
        const supervisor = createSupervisor({ port: 0 });
        registerDoltMutexRoutes(supervisor, mutex, { readJsonBody, sendJson });
        const req = {
            method: 'POST',
            url: '/api/dolt-push-mutex/gone/acquire',
            on(event, cb) { if (event === 'end') cb(); return this; },
        };
        const written = [];
        const res = {
            destroyed: true,
            writableEnded: false,
            writeHead() {},
            flushHeaders() {},
            on() { return this; },
            write(c) { written.push(c); },
            end(c) { written.push(c); },
        };
        await supervisor.handleRequest(req, res);
        assert.equal(mutex.status().held, false, 'the grant was released');
        assert.deepEqual(written, [], 'nothing written to the departed client');
        await mutex.stop();
    });
});
