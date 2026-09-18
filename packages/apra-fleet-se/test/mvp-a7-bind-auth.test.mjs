import { test, describe } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';

import { createSupervisor, sendJson } from '../src/supervisor/server.mjs';

// apra-fleet-50j6.1.2 -- server.mjs: loopback-only bind + the 401 bearer-token
// guard in handleRequest.
//
// Acceptance criteria proved here:
//   1. Connecting via the machine's own non-loopback IPv4 address refuses the
//      connection (the server only ever binds 127.0.0.1) -- skipped with a
//      named reason when the host has no non-internal IPv4 interface.
//   2. GET /api/sprints: no token -> 401, Authorization: Bearer header -> 200,
//      se_token cookie -> 200.
//   3. POST /sprints/x/live/stop with no token -> 401 BEFORE the route's own
//      handler (a stand-in proxy call) ever runs.

const TOKEN = 'a'.repeat(64);

/** Tiny promise-based HTTP client so tests don't pull in a dep. */
function request(port, method, path, { headers } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, method, path, headers: headers ?? {} },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf-8');
                    let json;
                    try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
                    resolve({ status: res.statusCode, headers: res.headers, json });
                });
            },
        );
        req.on('error', reject);
        req.end();
    });
}

/** First non-internal IPv4 address on this host, or null if there is none. */
function firstNonInternalIPv4() {
    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
        for (const entry of entries ?? []) {
            if (entry.family === 'IPv4' && !entry.internal) return entry.address;
        }
    }
    return null;
}

/** Attempt a raw TCP connect; resolves with the connect error's `code`, or null if it connected. */
function tryConnect(host, port) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host, port, timeout: 2000 });
        socket.once('connect', () => { socket.destroy(); resolve(null); });
        socket.once('timeout', () => { socket.destroy(); resolve('TIMEOUT'); });
        socket.once('error', (err) => { resolve(err.code); });
    });
}

describe('server.mjs -- loopback-only bind', () => {
    test('connecting via a non-loopback IPv4 address is refused', async (t) => {
        const nonLoopback = firstNonInternalIPv4();
        if (!nonLoopback) {
            t.skip('host has no non-internal IPv4 interface to test against');
            return;
        }

        const supervisor = createSupervisor({ port: 0, logger: { log() {}, error() {} } });
        await supervisor.start();
        const { port } = supervisor.server.address();
        try {
            const code = await tryConnect(nonLoopback, port);
            // ECONNREFUSED is the expected signal (nothing is listening on
            // this interface). On some hosts a local firewall silently drops
            // the self-directed SYN to a non-loopback interface instead of
            // answering with RST, which surfaces here as our own TIMEOUT
            // sentinel rather than ECONNREFUSED -- accept either, since both
            // mean the connection was NOT accepted. Only `code === null`
            // (the socket actually connected) would indicate the regression
            // this test guards against: the server bound wider than 127.0.0.1.
            assert.notEqual(code, null, 'connecting via the non-loopback interface must not succeed');
            assert.ok(
                code === 'ECONNREFUSED' || code === 'TIMEOUT',
                `expected ECONNREFUSED (or a firewall TIMEOUT), got: ${code}`,
            );
        } finally {
            await supervisor.stop();
        }
    });
});

describe('server.mjs -- 401 bearer-token guard', () => {
    test('GET /api/sprints: no token -> 401, header -> 200, cookie -> 200', async () => {
        const supervisor = createSupervisor({ port: 0, token: TOKEN, logger: { log() {}, error() {} } });
        supervisor.route('GET', '/api/sprints', async (req, res) => {
            sendJson(res, 200, { sprints: [] });
        });
        await supervisor.start();
        const { port } = supervisor.server.address();
        try {
            const noToken = await request(port, 'GET', '/api/sprints');
            assert.equal(noToken.status, 401);
            assert.equal(noToken.json.error, 'unauthorized');
            assert.match(noToken.headers['www-authenticate'] ?? '', /Bearer/i);

            const withHeader = await request(port, 'GET', '/api/sprints', {
                headers: { authorization: `Bearer ${TOKEN}` },
            });
            assert.equal(withHeader.status, 200);
            assert.deepEqual(withHeader.json, { sprints: [] });

            const withCookie = await request(port, 'GET', '/api/sprints', {
                headers: { cookie: `se_token=${TOKEN}` },
            });
            assert.equal(withCookie.status, 200);
            assert.deepEqual(withCookie.json, { sprints: [] });
        } finally {
            await supervisor.stop();
        }
    });

    test('POST /sprints/x/live/stop: no token -> 401 before the proxy handler runs', async () => {
        let proxyCalls = 0;
        const supervisor = createSupervisor({ port: 0, token: TOKEN, logger: { log() {}, error() {} } });
        supervisor.route('POST', '/sprints/:id/live/stop', async (req, res) => {
            proxyCalls += 1;
            sendJson(res, 200, { stopped: true });
        });
        await supervisor.start();
        const { port } = supervisor.server.address();
        try {
            const res = await request(port, 'POST', '/sprints/x/live/stop');
            assert.equal(res.status, 401);
            assert.equal(res.json.error, 'unauthorized');
            assert.equal(proxyCalls, 0, 'the route handler (proxy) must not run on an unauthorized request');

            const authed = await request(port, 'POST', '/sprints/x/live/stop', {
                headers: { authorization: `Bearer ${TOKEN}` },
            });
            assert.equal(authed.status, 200);
            assert.equal(proxyCalls, 1);
        } finally {
            await supervisor.stop();
        }
    });

    test('no token configured (deps.token/deps.dataDir both absent) -> guard is skipped entirely (back-compat)', async () => {
        const supervisor = createSupervisor({ port: 0, logger: { log() {}, error() {} } });
        supervisor.route('GET', '/api/sprints', async (req, res) => {
            sendJson(res, 200, { sprints: [] });
        });
        await supervisor.start();
        const { port } = supervisor.server.address();
        try {
            const res = await request(port, 'GET', '/api/sprints');
            assert.equal(res.status, 200);
        } finally {
            await supervisor.stop();
        }
    });
});
