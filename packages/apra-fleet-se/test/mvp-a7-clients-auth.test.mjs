import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { EventEmitter } from 'node:events';

import { createSupervisor, readJsonBody, sendJson } from '../src/supervisor/server.mjs';
import { loadOrCreateToken } from '../src/supervisor/auth.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createWatchdog } from '../src/supervisor/watchdog.mjs';
import { createBacklog } from '../src/supervisor/backlog.mjs';
import { createDashboard, registerDashboardRoutes } from '../src/supervisor/dashboard.mjs';
import { createDoltMutex, registerDoltMutexRoutes } from '../src/supervisor/dolt-mutex.mjs';
import { createIdAllocator, registerIdAllocatorRoutes } from '../src/supervisor/id-allocator.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';

import {
    createHttpDoltPushMutexClient,
    createHttpChildIdAllocatorClient,
} from '../fleet-sprint/coordination.mjs';

// =============================================================================
// apra-fleet-50j6.2.5 -- end-to-end verification of feature 50j6.2: with
// loopback bind + the bearer/cookie auth guard live (50j6.1), every
// pre-existing caller keeps working from the user's point of view:
//   (a) dashboard cookie      -- GET / sets se_token; a subsequent POST to a
//                                 live-mutating sub-route carrying ONLY that
//                                 cookie succeeds (no dashboard script change
//                                 needed).
//   (b) runner coordination   -- the dolt-push-mutex and child-id-allocator
//                                 HTTP clients (fleet-sprint/coordination.mjs)
//                                 drive a full acquire/renew/release and
//                                 allocate/confirm/release round trip.
//   (c) spawner                -- the spawned child's env carries
//                                 FLEET_SE_SERVICE_TOKEN; argv never does.
//   (d) read routes            -- GET /state and GET /events stay open with
//                                 no credential.
//
// This file changes ONLY itself -- every assertion exercises production code
// shipped by 50j6.1.*/50j6.2.1-.4 verbatim; no src/ or fleet-sprint/ edit was
// needed to make any of it pass.
//
// Criterion 5 ("no assertion is satisfied merely by a 200 from an open
// route") is met by pairing every AUTHED case with a stripped-credential
// negative; the read-only routes in (d) are genuinely open (never guarded --
// see auth.mjs's requiresAuth), so there is no credential to strip for them.
// =============================================================================

const silentLogger = { log() {}, error() {} };

/** mkdtemp helper; every dir created here is removed in the module-level after() below. */
const tmpDirs = new Set();
async function mkTmp(prefix) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpDirs.add(dir);
    return dir;
}
after(async () => {
    for (const dir of tmpDirs) {
        // eslint-disable-next-line no-await-in-loop
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.clear();
});

/** Tiny promise-based HTTP client so this test doesn't pull in a dep. */
function request(port, method, urlPath, { headers } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, method, path: urlPath, headers: headers ?? {} },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf-8');
                    let json;
                    try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
                    resolve({ status: res.statusCode, headers: res.headers, json, text });
                });
            },
        );
        req.on('error', reject);
        req.end();
    });
}

/**
 * Parses the `se_token=<value>` cookie out of a Set-Cookie header value.
 * Node's http client ALWAYS returns `set-cookie` as an array (even for a
 * single header) -- unlike every other response header, which is folded
 * into a plain string -- so this accepts either shape.
 */
function extractSeTokenCookie(setCookieHeader) {
    const raw = Array.isArray(setCookieHeader) ? setCookieHeader.join('; ') : setCookieHeader;
    if (typeof raw !== 'string') return null;
    const match = /se_token=([^;]+)/.exec(raw);
    return match ? match[1] : null;
}

/**
 * Builds one real, auth-enforcing supervisor with the full production route
 * table this task needs to exercise: dashboard (GET /, /state, /events),
 * dolt-push-mutex, and child-id-allocator -- plus one stand-in live-mutating
 * route (POST /sprints/:id/live/stop), the same stand-in-for-proxy pattern
 * mvp-a7-bind-auth.test.mjs already uses for the identical reason: the guard
 * fires on method+path SHAPE alone (auth.mjs's requiresAuth), before any
 * route lookup, so a stand-in handler proves the exact same guard behavior a
 * real proxy.mjs handler would, without pulling in a live child sprint.
 * @returns {Promise<{ port: number, token: string, stop: () => Promise<void>, liveStopCalls: () => number }>}
 */
async function buildAuthedSupervisor() {
    const dataDir = await mkTmp('a7-clients-');
    const { token } = loadOrCreateToken(dataDir);

    const ledger = createLedger({ filePath: path.join(dataDir, LEDGER_FILENAME) });
    await ledger.start();
    const watchdog = createWatchdog({
        ledger,
        env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir },
        resolvePort: () => undefined,
        logger: silentLogger,
    });
    const backlog = createBacklog({
        ledger,
        listAllBeads: () => [],
        expandScope: async (roots) => new Set(roots),
        watchdog,
        logger: silentLogger,
    });
    const dashboard = createDashboard({
        ledger, watchdog, expandScope: async (roots) => new Set(roots), backlog, logger: silentLogger,
    });
    const mutex = createDoltMutex({ leaseMs: 100_000 });
    const allocator = createIdAllocator({ filePath: path.join(dataDir, 'id-allocator.json'), logger: silentLogger });
    await allocator.start();

    const supervisor = createSupervisor({ port: 0, token, dashboard, logger: silentLogger });
    registerDashboardRoutes(supervisor, dashboard);
    registerDoltMutexRoutes(supervisor, mutex, { readJsonBody, sendJson });
    registerIdAllocatorRoutes(supervisor, allocator, { readJsonBody, sendJson });

    let liveStopCalls = 0;
    supervisor.route('POST', '/sprints/:id/live/stop', async (req, res) => {
        liveStopCalls += 1;
        sendJson(res, 200, { stopped: true });
    });

    await supervisor.start();
    const { port } = supervisor.server.address();

    return {
        port,
        token,
        liveStopCalls: () => liveStopCalls,
        async stop() {
            await supervisor.stop();
            await allocator.stop();
        },
    };
}

// =============================================================================
// (a) dashboard cookie -- GET / sets se_token; a POST to a live-mutating
// sub-route carrying ONLY that cookie succeeds; stripping the cookie 401s the
// same request against the same route handler.
// =============================================================================
describe('mvp-a7 clients -- dashboard cookie keeps the page working', () => {
    test('GET / sets se_token; POST .../live/stop with ONLY the cookie succeeds; stripped -> 401', async () => {
        const { port, token, liveStopCalls, stop } = await buildAuthedSupervisor();
        try {
            const root = await request(port, 'GET', '/');
            assert.notEqual(root.status, 401, 'GET / must stay open with no credential');
            const cookieValue = extractSeTokenCookie(root.headers['set-cookie']);
            assert.equal(cookieValue, token, 'GET / must set the se_token cookie to the real service token');

            // The dashboard page needs no script change: only the cookie the
            // browser automatically attaches, no Authorization header.
            const authed = await request(port, 'POST', '/sprints/x/live/stop', {
                headers: { cookie: `se_token=${cookieValue}` },
            });
            assert.equal(authed.status, 200, 'cookie-only POST to a live-mutating sub-route must succeed');
            assert.deepEqual(authed.json, { stopped: true });
            assert.equal(liveStopCalls(), 1);

            // Criterion 5: the SAME route, credential stripped, must fail --
            // proving the 200 above was not just an open route.
            const stripped = await request(port, 'POST', '/sprints/x/live/stop');
            assert.equal(stripped.status, 401, 'the same route with no credential at all must be rejected');
            assert.equal(liveStopCalls(), 1, 'the unauthorized request must never reach the route handler');

            // A wrong cookie value must fail exactly like no cookie.
            const wrongCookie = await request(port, 'POST', '/sprints/x/live/stop', {
                headers: { cookie: `se_token=${'0'.repeat(cookieValue.length)}` },
            });
            assert.equal(wrongCookie.status, 401);
            assert.equal(liveStopCalls(), 1);
        } finally {
            await stop();
        }
    });
});

// =============================================================================
// (b) runner coordination -- both HTTP coordination clients drive a full
// round trip against the authed supervisor with no 401; with the token
// removed, the same calls are rejected.
// =============================================================================
describe('mvp-a7 clients -- runner coordination clients (dolt-push-mutex + child-id-allocator)', () => {
    test('dolt-push-mutex client: authed acquire/renew/release round trip succeeds; unauthed acquire is rejected', async () => {
        const { port, token, stop } = await buildAuthedSupervisor();
        const serviceUrl = `http://127.0.0.1:${port}`;
        try {
            const client = createHttpDoltPushMutexClient({ serviceUrl, sprintId: 'a7-sprint', token });
            const grant = await client.acquire('a7-sprint', { pid: process.pid });
            assert.ok(typeof grant.token === 'string' && grant.token.length > 0, 'acquire must be granted a lease token');

            const renewed = await client.renew(grant.token);
            assert.equal(renewed, true, 'renew must succeed while the header carries a valid token');

            const released = await client.release(grant.token);
            assert.equal(released, true, 'release must succeed while the header carries a valid token');

            // Unauthed: the same acquire, no token at all -- the guard, not
            // some unauthenticated fallback, must be what carried the authed
            // calls above.
            const unauthedClient = createHttpDoltPushMutexClient({ serviceUrl, sprintId: 'a7-sprint-2' });
            await assert.rejects(
                () => unauthedClient.acquire('a7-sprint-2', { pid: process.pid }),
                /401|HTTP/,
                'acquire with no service token must be rejected',
            );
        } finally {
            await stop();
        }
    });

    test('child-id-allocator client: authed allocate/confirm and allocate/release round trips succeed; unauthed allocate is rejected', async () => {
        const { port, token, stop } = await buildAuthedSupervisor();
        const serviceUrl = `http://127.0.0.1:${port}`;
        try {
            const client = createHttpChildIdAllocatorClient({ serviceUrl, sprintId: 'a7-sprint', token });

            const confirmGrant = await client.allocate('parent-1', { pid: process.pid });
            assert.ok(typeof confirmGrant.childId === 'string' && confirmGrant.childId.length > 0);
            const confirmed = await client.confirm(confirmGrant.token);
            assert.equal(confirmed, true, 'confirm must succeed while the header carries a valid token');

            const releaseGrant = await client.allocate('parent-1', { pid: process.pid });
            const released = await client.release(releaseGrant.token);
            assert.equal(released, true, 'release must succeed while the header carries a valid token');

            // Unauthed: the same allocate, no token at all.
            const unauthedClient = createHttpChildIdAllocatorClient({ serviceUrl, sprintId: 'a7-sprint-2' });
            await assert.rejects(
                () => unauthedClient.allocate('parent-1', { pid: process.pid }),
                /401|HTTP/,
                'allocate with no service token must be rejected',
            );
        } finally {
            await stop();
        }
    });
});

// =============================================================================
// (c) spawner -- the spawned child's env carries FLEET_SE_SERVICE_TOKEN, and
// the spawn argv never does (argv is world-readable via a process listing;
// asserting the negative explicitly is the acceptance criterion).
// =============================================================================
describe('mvp-a7 clients -- spawner passes the service token via env, never argv', () => {
    test('child env carries FLEET_SE_SERVICE_TOKEN; spawn argv does not contain the token anywhere', async () => {
        const dataDir = await mkTmp('a7-clients-spawner-');
        const calls = [];
        const fakeSpawn = (command, args, opts) => {
            const child = new EventEmitter();
            child.pid = 4242;
            child.unref = () => {};
            calls.push({ command, args, opts });
            return child;
        };
        const fakeFs = {
            mkdirSync() {},
            openSync() { return 999; },
            closeSync() {},
        };
        const token = 'a7-clients-secret-token-value';

        const spawner = createSpawner({
            spawn: fakeSpawn,
            basePort: 9411,
            isPortAvailable: async () => true,
            serviceToken: token,
            dataDir,
            fs: fakeFs,
            logger: silentLogger,
        });

        await spawner.spawnSprint({ issue: 'i1', members: 'm1', branch: 'b1', base: 'main' });

        assert.equal(calls.length, 1);
        const call = calls[0];
        assert.ok(call.opts.env, 'spawn must be called with an explicit env when a serviceToken is configured');
        assert.equal(call.opts.env.FLEET_SE_SERVICE_TOKEN, token, 'the child env must carry the service token');

        // Negative, asserted explicitly (acceptance criterion): the token must
        // appear nowhere in argv -- neither as a standalone element nor as a
        // substring of any element (e.g. embedded in a combined flag value).
        assert.ok(!call.args.includes(token), 'argv must not contain the token as a standalone element');
        for (const arg of call.args) {
            assert.ok(!String(arg).includes(token), `argv element leaked the token: ${arg}`);
        }
        assert.ok(!call.command.includes(token), 'the spawned command itself must not embed the token');
    });
});

// =============================================================================
// (d) read routes -- GET /state and GET /events stay open with no
// credential, exactly as before the auth guard landed.
// =============================================================================
describe('mvp-a7 clients -- read routes stay open with no credential', () => {
    test('GET /state and GET /events succeed with zero credential presented', async () => {
        const { port, stop } = await buildAuthedSupervisor();
        try {
            const state = await request(port, 'GET', '/state');
            assert.notEqual(state.status, 401, 'GET /state must stay open with no credential');
            assert.deepEqual(state.json.sprints, [], 'a real (empty) state payload, not a guard short-circuit');

            const eventsRes = await new Promise((resolve, reject) => {
                const req = http.request({ host: '127.0.0.1', port, path: '/events', method: 'GET' }, (res) => {
                    resolve(res);
                    req.destroy();
                });
                req.on('error', reject);
                req.end();
            });
            assert.notEqual(eventsRes.statusCode, 401, 'GET /events must stay open with no credential');
        } finally {
            await stop();
        }
    });
});
