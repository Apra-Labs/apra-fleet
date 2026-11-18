// Malformed or oversized JSON request bodies are client errors (400 / 413 with
// field "body", no stack text) on every route that reads a JSON body, answered
// once by the request catch-all. Ordinary handler errors stay 500.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSupervisor, sendJson, readJsonBody, RequestBodyError } from '../src/supervisor/server.mjs';
import { registerSprintRoutes } from '../src/supervisor/api.mjs';
import { registerDoltMutexRoutes } from '../src/supervisor/dolt-mutex.mjs';
import { registerIdAllocatorRoutes } from '../src/supervisor/id-allocator.mjs';
import { registerReservationRoutes } from '../src/supervisor/reconcile.mjs';

const STACK_RE = /\n\s+at\s|\.mjs:\d+/;
// An unescaped backslash, as in a pasted Windows path.
const MALFORMED = '{"branch": "C:\\Users\\me\\repo"}';

// The server may answer (and close) before the body is fully written, so the
// client writes in chunks, stops once the response arrives, tolerates
// EPIPE/ECONNRESET after the response, and resolves only after the request
// has closed -- no socket activity outlives the test.
const LATE_WRITE_ERRORS = new Set(['EPIPE', 'ECONNRESET', 'ECONNABORTED']);
function post(sup, path, body) {
    return new Promise((resolve, reject) => {
        const buf = Buffer.from(body);
        const CHUNK = 64 * 1024;
        let response = null;
        let ended = false;
        let closed = false;
        let failed = null;
        const settle = () => {
            if (failed) return;
            if (ended && closed) resolve(response);
        };
        const req = http.request({
            host: '127.0.0.1', port: sup.port, path, method: 'POST', agent: false,
            // keep-alive: so a `connection: close` answer is the server's own choice.
            headers: { 'content-type': 'application/json', 'content-length': buf.length, connection: 'keep-alive' },
        }, (res) => {
            response = { status: res.statusCode, headers: res.headers, text: '' };
            res.on('data', (c) => { response.text += c; });
            res.on('end', () => { ended = true; settle(); });
            res.on('error', () => { /* reset after the body was read */ });
        });
        req.on('socket', (s) => s.on('error', () => { /* surfaced via req */ }));
        req.on('error', (err) => {
            if (response && LATE_WRITE_ERRORS.has(err.code)) return;
            failed = err;
            reject(new Error(`request failed before any response: ${err.code || err.message}`));
        });
        req.on('close', () => {
            closed = true;
            if (response && !ended) ended = true; // closed mid-body: keep what arrived
            settle();
        });
        let off = 0;
        const pump = () => {
            while (off < buf.length && !response && !req.destroyed) {
                const piece = buf.subarray(off, off + CHUNK);
                off += piece.length;
                if (!req.write(piece)) { req.once('drain', pump); return; }
            }
            if (off >= buf.length || response) req.end();
        };
        pump();
    });
}

async function withSupervisor(register, fn) {
    const sup = createSupervisor({ port: 0, apiToken: null, host: '127.0.0.1', logger: { log() {}, error() {} } });
    register(sup);
    await sup.start();
    try { await fn(sup); } finally { await sup.stop(); }
}

const stubs = (sup) => {
    registerSprintRoutes(sup, {
        launch: async () => { throw new Error('boom'); },
        answerDecision: async () => ({}),
    });
    registerDoltMutexRoutes(sup, { acquire: async () => ({}), release: async () => ({}), renew: async () => ({}) }, { readJsonBody, sendJson });
    registerIdAllocatorRoutes(sup, { allocate: async () => ({}) }, { readJsonBody, sendJson });
    registerReservationRoutes(sup, { forceRelease: async () => ({}) });
};

const ROUTES = [
    '/api/sprints',
    '/api/sprints/s1/decisions/d1',
    '/api/dolt-push-mutex/s1/acquire',
    '/api/child-id-allocator/p1/allocate',
    '/api/reservations/s1/force-release',
];

describe('RequestBodyError mapping in the catch-all', () => {
    test('POST /api/sprints with malformed JSON: 400, parse message, field body, no stack', async () => {
        await withSupervisor(stubs, async (sup) => {
            const out = await post(sup, '/api/sprints', MALFORMED);
            assert.equal(out.status, 400);
            const j = JSON.parse(out.text);
            assert.match(j.error, /invalid JSON request body: .*position \d+/);
            assert.equal(j.field, 'body');
            assert.doesNotMatch(out.text, STACK_RE);
        });
    });

    for (const route of ROUTES.slice(1)) {
        test(`${route}: malformed JSON -> 400 field body`, async () => {
            await withSupervisor(stubs, async (sup) => {
                const out = await post(sup, route, MALFORMED);
                assert.equal(out.status, 400, out.text);
                assert.equal(JSON.parse(out.text).field, 'body');
                assert.doesNotMatch(out.text, STACK_RE);
            });
        });
    }

    test('a body above the size cap -> 413 field body, Connection: close (repeated)', async () => {
        const big = JSON.stringify({ pad: 'x'.repeat(1_100_000) });
        for (let i = 0; i < 20; i++) {
            await withSupervisor(stubs, async (sup) => {
                const out = await post(sup, '/api/sprints', big);
                assert.equal(out.status, 413, `iteration ${i}`);
                assert.equal(out.headers.connection, 'close', `iteration ${i}`);
                const j = JSON.parse(out.text);
                assert.equal(j.field, 'body');
                assert.match(j.error, /exceeds 1000000 byte limit/);
            });
        }
    });

    test('a client that never stops writing is disconnected after the 413', { timeout: 30_000 }, async () => {
        await withSupervisor(stubs, async (sup) => {
            const chunk = Buffer.alloc(64 * 1024, 0x78);
            let timer = null;
            try {
                const outcome = await new Promise((resolve) => {
                    let status = null;
                    const req = http.request({
                        host: '127.0.0.1', port: sup.port, path: '/api/sprints', method: 'POST', agent: false,
                        headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked', connection: 'keep-alive' },
                    }, (res) => { status = res.statusCode; res.resume(); res.on('error', () => {}); });
                    req.on('socket', (s) => s.on('error', () => {}));
                    req.on('error', () => { /* expected: the server closed the connection */ });
                    req.on('close', () => resolve({ status, closed: true }));
                    // Keep writing regardless of the response, as a hostile client would.
                    timer = setInterval(() => { if (!req.destroyed && !req.writableNeedDrain) req.write(chunk); }, 1);
                    // Well under the server's 5 s keep-alive idle timeout, so
                    // only an explicit close after the 413 passes.
                    setTimeout(() => resolve({ status, closed: false }), 3_000).unref();
                });
                assert.equal(outcome.closed, true, 'the server must close the connection right after the 413');
                // A peer that keeps writing may lose the 413 to the reset
                // (Windows discards unread data on RST); if it saw a status,
                // it must be the 413.
                assert.ok(outcome.status === null || outcome.status === 413, `status ${outcome.status}`);
            } finally {
                if (timer) clearInterval(timer);
            }
        });
    });

    test('an ordinary handler Error is still 500 internal supervisor error', async () => {
        await withSupervisor(stubs, async (sup) => {
            const out = await post(sup, '/api/sprints', '{}');
            assert.equal(out.status, 500);
            assert.equal(JSON.parse(out.text).error, 'internal supervisor error');
        });
    });

    test('readJsonBody holds the 413 until end within the drain budget, and answers at once past it', async () => {
        const { PassThrough } = await import('node:stream');
        const state = (p) => Promise.race([p.then(() => 'resolved', (e) => e), new Promise((r) => setImmediate(() => r('pending')))]);

        const within = new PassThrough();
        const p1 = readJsonBody(within, { maxBytes: 10, drainBytes: 10 });
        within.write(Buffer.alloc(15));
        assert.equal(await state(p1), 'pending', 'still draining inside the budget');
        within.end(Buffer.alloc(4));
        const e1 = await state(p1);
        assert.ok(e1 instanceof RequestBodyError && e1.status === 413);

        const past = new PassThrough();
        const p2 = readJsonBody(past, { maxBytes: 10, drainBytes: 10 });
        past.write(Buffer.alloc(25));
        const e2 = await state(p2);
        assert.ok(e2 instanceof RequestBodyError && e2.status === 413, 'answered before end once past the budget');
        past.destroy();
    });

    test('RequestBodyError carries its status and field', () => {
        const e = new RequestBodyError('x', 413);
        assert.equal(e.status, 413);
        assert.equal(e.field, 'body');
    });
});
