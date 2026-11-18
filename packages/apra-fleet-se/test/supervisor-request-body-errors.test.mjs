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

function post(sup, path, body) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: sup.port, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, text }));
        });
        req.on('error', reject);
        req.end(body);
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

    test('a body above the size cap -> 413 field body', async () => {
        await withSupervisor(stubs, async (sup) => {
            const big = JSON.stringify({ pad: 'x'.repeat(1_100_000) });
            const out = await post(sup, '/api/sprints', big);
            assert.equal(out.status, 413);
            const j = JSON.parse(out.text);
            assert.equal(j.field, 'body');
            assert.match(j.error, /exceeds 1000000 byte limit/);
        });
    });

    test('an ordinary handler Error is still 500 internal supervisor error', async () => {
        await withSupervisor(stubs, async (sup) => {
            const out = await post(sup, '/api/sprints', '{}');
            assert.equal(out.status, 500);
            assert.equal(JSON.parse(out.text).error, 'internal supervisor error');
        });
    });

    test('RequestBodyError carries its status and field', () => {
        const e = new RequestBodyError('x', 413);
        assert.equal(e.status, 413);
        assert.equal(e.field, 'body');
    });
});
