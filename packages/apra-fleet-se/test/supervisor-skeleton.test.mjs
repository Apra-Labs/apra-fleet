import { test, describe } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';

import {
    createSupervisor,
    makeSeamStub,
    readJsonBody,
    sendJson,
    DEFAULT_SERVICE_PORT,
} from '../src/supervisor/server.mjs';
import { parseServeArgs, serveMain } from '../bin/serve.mjs';

// apra-fleet-eft.4.1 -- supervisor skeleton: always-on process, HTTP server
// bootstrap, POST /api/shutdown, error-isolated dispatcher, documented seams.

/** Tiny promise-based HTTP client so tests don't pull in a dep. */
function request(port, method, path, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const req = http.request(
            { host: '127.0.0.1', port, method, path,
              headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {} },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf-8');
                    let json;
                    try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
                    resolve({ status: res.statusCode, json });
                });
            },
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

describe('createSupervisor -- HTTP bootstrap + lifecycle', () => {
    test('starts, answers /api/health, and stays up with zero sprints', async () => {
        const supervisor = createSupervisor({ port: 0, logger: { log() {}, error() {} } });
        await supervisor.start();
        const port = supervisor.server.address().port;

        const health = await request(port, 'GET', '/api/health');
        assert.equal(health.status, 200);
        assert.equal(health.json.status, 'ok');
        // Server is still listening -- nothing drove an exit.
        assert.equal(supervisor.server.listening, true);

        await supervisor.stop();
    });

    test('POST /api/shutdown terminates cleanly and resolves shutdownRequested', async () => {
        const supervisor = createSupervisor({ port: 0, logger: { log() {}, error() {} } });
        await supervisor.start();
        const port = supervisor.server.address().port;

        const res = await request(port, 'POST', '/api/shutdown');
        assert.equal(res.status, 200);
        assert.equal(res.json.status, 'shutting-down');

        // shutdownRequested resolves once the server + seams are torn down.
        await supervisor.shutdownRequested;
        assert.equal(supervisor.server.listening, false);
    });

    test('an unhandled error inside a request never exits the process (returns 500)', async () => {
        const supervisor = createSupervisor({ port: 0, logger: { log() {}, error() {} } });
        supervisor.route('GET', '/api/boom', () => { throw new Error('kaboom'); });
        await supervisor.start();
        const port = supervisor.server.address().port;

        const res = await request(port, 'GET', '/api/boom');
        assert.equal(res.status, 500);
        assert.equal(res.json.error, 'internal supervisor error');

        // Still up and serving after the handler threw.
        const health = await request(port, 'GET', '/api/health');
        assert.equal(health.status, 200);
        assert.equal(supervisor.server.listening, true);

        await supervisor.stop();
    });

    test('unknown route returns 404 without crashing', async () => {
        const supervisor = createSupervisor({ port: 0, logger: { log() {}, error() {} } });
        await supervisor.start();
        const port = supervisor.server.address().port;

        const res = await request(port, 'GET', '/api/nope');
        assert.equal(res.status, 404);
        assert.equal(supervisor.server.listening, true);

        await supervisor.stop();
    });

    test('starts and stops all four seams via their lifecycle hooks', async () => {
        const events = [];
        const mkSeam = (name) => ({
            name,
            async start() { events.push(`start:${name}`); },
            async stop() { events.push(`stop:${name}`); },
        });
        const supervisor = createSupervisor({
            port: 0,
            logger: { log() {}, error() {} },
            ledger: mkSeam('ledger'),
            spawner: mkSeam('spawner'),
            watchdog: mkSeam('watchdog'),
            dashboard: mkSeam('dashboard'),
        });
        await supervisor.start();
        await supervisor.stop();

        assert.deepEqual(events.slice(0, 4), ['start:ledger', 'start:spawner', 'start:watchdog', 'start:dashboard']);
        // Seams torn down in reverse order.
        assert.deepEqual(events.slice(4), ['stop:dashboard', 'stop:watchdog', 'stop:spawner', 'stop:ledger']);
    });

    test('a failing seam stop does not block teardown of the others', async () => {
        const stopped = [];
        const supervisor = createSupervisor({
            port: 0,
            logger: { log() {}, error() {} },
            watchdog: { name: 'watchdog', async start() {}, async stop() { throw new Error('watchdog stop failed'); } },
            ledger: { name: 'ledger', async start() {}, async stop() { stopped.push('ledger'); } },
        });
        await supervisor.start();
        await supervisor.stop();
        // ledger (last in teardown order) still stopped despite watchdog throwing.
        assert.deepEqual(stopped, ['ledger']);
    });

    test('stop() is idempotent', async () => {
        const supervisor = createSupervisor({ port: 0, logger: { log() {}, error() {} } });
        await supervisor.start();
        const a = supervisor.stop();
        const b = supervisor.stop();
        assert.equal(a, b);
        await a;
    });

    test('default seams are inert stubs, reported by /api/health', async () => {
        const supervisor = createSupervisor({ port: 0, logger: { log() {}, error() {} } });
        await supervisor.start();
        const port = supervisor.server.address().port;
        const health = await request(port, 'GET', '/api/health');
        assert.equal(health.json.seams.ledger, 'ledger:stub');
        assert.equal(health.json.seams.spawner, 'spawner:stub');
        assert.equal(health.json.seams.watchdog, 'watchdog:stub');
        assert.equal(health.json.seams.dashboard, 'dashboard:stub');
        await supervisor.stop();
    });
});

describe('seam stubs + helpers', () => {
    test('makeSeamStub is a named no-op with start/stop', async () => {
        const s = makeSeamStub('ledger');
        assert.equal(s.name, 'ledger:stub');
        await s.start();
        await s.stop();
    });

    test('readJsonBody parses JSON and enforces a size cap', async () => {
        const parsed = await readJsonBody(mockReq('{"a":1}'));
        assert.deepEqual(parsed, { a: 1 });

        const empty = await readJsonBody(mockReq(''));
        assert.equal(empty, undefined);

        await assert.rejects(() => readJsonBody(mockReq('{bad'), { maxBytes: 100 }), /invalid JSON/);
        await assert.rejects(() => readJsonBody(mockReq('x'.repeat(50)), { maxBytes: 10 }), /byte limit/);
    });
});

describe('parseServeArgs', () => {
    test('accepts --port and --help; rejects unknown flags', () => {
        assert.equal(parseServeArgs(['--port', '9000']).values.port, '9000');
        assert.equal(parseServeArgs(['--help']).values.help, true);
        assert.throws(() => parseServeArgs(['--nope']), /Invalid command-line arguments/);
    });

    test('DEFAULT_SERVICE_PORT is a valid port', () => {
        assert.ok(Number.isInteger(DEFAULT_SERVICE_PORT) && DEFAULT_SERVICE_PORT > 0 && DEFAULT_SERVICE_PORT < 65536);
    });
});

describe('serveMain', () => {
    test('--help returns exit 0 without starting a server', async () => {
        const { exitCode } = await serveMain(['--help']);
        assert.equal(exitCode, 0);
    });

    test('invalid --port returns exit 1', async () => {
        const origErr = console.error;
        console.error = () => {};
        try {
            const { exitCode } = await serveMain(['--port', 'notaport']);
            assert.equal(exitCode, 1);
        } finally {
            console.error = origErr;
        }
    });
});

// -- minimal fake IncomingMessage for readJsonBody --------------------------
function mockReq(bodyText) {
    const listeners = {};
    const req = {
        on(event, cb) { (listeners[event] ||= []).push(cb); return req; },
        destroy() {},
    };
    // Emit on next tick so `.on()` registrations complete first.
    setImmediate(() => {
        if (bodyText.length) (listeners.data || []).forEach((cb) => cb(Buffer.from(bodyText)));
        (listeners.end || []).forEach((cb) => cb());
    });
    return req;
}

// keep sendJson referenced so linters/tree-shakers see the export is exercised
test('sendJson writes a JSON response with content-length', async () => {
    const server = http.createServer((req, res) => sendJson(res, 201, { ok: true }));
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    const res = await request(port, 'GET', '/');
    assert.equal(res.status, 201);
    assert.deepEqual(res.json, { ok: true });
    await new Promise((r) => server.close(r));
});
