// =============================================================================
// apra-fleet-i9ag.12.3 -- fresh install converges on workflow-package
// registration in EITHER start order (end-to-end, real bin/serve.mjs subprocess)
// =============================================================================
//
// The bug (apra-fleet-i9ag.12): on a fresh machine the supervisor checked its
// registration preconditions exactly ONCE at startup and, when any of them was
// not yet satisfied, logged "skipping workflow-package registration" and never
// came back to it. So Sprints never appeared in the console until somebody
// restarted the supervisor by hand.
//
// What this file proves, through the REAL subprocess against a stub apra-fleet
// server, is convergence with NO supervisor restart, from each of the three
// former one-shot skip branches:
//
//   (b) supervisor-first, NO fleet.key at all  -> former branch (a)
//   (e) supervisor-first, fleet.key PRESENT but no reachable server, with
//       APRA_FLEET_TRANSPORT UNSET               -> former branch (c); since
//       main #629 the client auto-starts a gone server instead of a private
//       stdio one, which the test sandbox refuses -> connection-error branch
//   (c) server-first, everything already present -> registers immediately
//
// WHY (b) AND (e) ARE BOTH NEEDED, AND WHY EACH ASSERTS ITS OWN BRANCH TEXT.
// The two cases are easy to collapse by accident. serve.mjs only resolves the
// server connection at all when the token source is ALREADY 'fleet-key', so with
// no fleet.key on disk the connection is never resolved and the no-fleet.key
// branch short-circuits first. Case (e) therefore MUST start with a valid
// fleet.key already written, or it silently re-tests case (b) and yields a false
// green. Each case asserts the distinct log text of the branch it means to
// exercise, and case (e) additionally asserts the branch-(b) text is ABSENT, so
// the two can never quietly become the same test.
//
// WHY APRA_FLEET_TRANSPORT IS LEFT UNSET. That is the real fresh-machine
// default, and it is the case a naive fix misses: with the var unset and no
// healthy HTTP singleton, resolveFleetServerConnection()
// (packages/apra-fleet-client/src/client/server-resolution.mjs) does NOT throw
// -- it falls through to its stdio self-spawn tier and RETURNS { mode: 'stdio' }.
// That leaves consoleOrigin null and lands in the third former skip branch, not
// the connection-error one. Forcing APRA_FLEET_TRANSPORT=http would route around
// exactly the path this bug is about, so no test here sets it.
// UPDATE (main #629): with the var unset a verifiably GONE server is now
// auto-started (`apra-fleet start`) rather than resolved to stdio. Inside the
// test sandbox (APRA_TEST_SANDBOX_ROOT) that auto-start refuses with
// AUTOSTART_TEST_UNINJECTED, so case (e) now asserts the connection-error
// retry, the auto-start refusal, and the ABSENCE of the stdio branch text.
//
// NOTHING IS SELF-SPAWNED: the sandbox refusal happens before any binary is
// resolved, so this path starts no real server.
//
// ISOLATION. HOME/USERPROFILE, APRA_FLEET_DATA_DIR and FLEET_SE_DATA_DIR are all
// redirected to temp dirs, and the subprocess runs in a temp cwd, so the
// developer's real ~/.apra-fleet is never read or written and no tracker in the
// checkout is touched.
//
// Whether the apra-fleet server is "up" is controlled purely by whether
// <APRA_FLEET_DATA_DIR>/server.json exists: that file is what
// checkRunningInstance() reads to decide there is an HTTP singleton to attach
// to. Writing it mid-test is how "the server comes up" is simulated, without
// starting and stopping a listener underneath the supervisor.
// =============================================================================

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';
import { buildIsolatedHomeEnv } from '../../../tests/helpers/isolated-home.mjs';
import { deriveUpstreamCredential } from '@apralabs/apra-fleet-client/auth/local-token';
import { PACKAGE_ID } from '../src/registration/manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVE_BIN = path.join(__dirname, '../bin/serve.mjs');

/** Generous FAILURE bound on booting the subprocess -- a passing run never
 *  waits for it. Scaled for the concurrency the bounded runner uses. */
const BOOT_TIMEOUT_MS = scaledTimeout(20000, { concurrency: TEST_CONCURRENCY, multiplier: 6 });

/** Bound on CONVERGENCE after the preconditions are satisfied. The outer
 *  convergence backoff is capped at 15s (DEFAULT_CONVERGE_BACKOFF), and the
 *  acceptance budget for this bug is 60s, so this is deliberately well under
 *  that budget while comfortably above one capped interval. */
const CONVERGE_TIMEOUT_MS = scaledTimeout(45000, { concurrency: TEST_CONCURRENCY, multiplier: 2 });

/** Distinct log fragments of the three former one-shot skip branches, so each
 *  case can assert WHICH one it actually exercised. */
const BRANCH_NO_FLEET_KEY = 'fleet.key is not available yet';
const BRANCH_NO_HTTP_URL = 'no apra-fleet HTTP server URL yet';
/** Since main #629 a gone server is auto-started by the client instead of
 *  falling back to a private stdio server; inside the test sandbox that
 *  auto-start refuses (it must never start a real installed binary), so the
 *  unset-transport, server-down case lands in the connection-error branch. */
const BRANCH_RESOLVE_ERROR = 'could not resolve the apra-fleet server connection';

/** @type {string[]} */
const tmpDirs = [];
/** @type {Array<import('node:http').Server>} */
const stubServers = [];
/** @type {Set<number>} */
const spawnedPids = new Set();

after(async () => {
    for (const pid of spawnedPids) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    for (const srv of stubServers) {
        await new Promise((resolve) => srv.close(() => resolve()));
    }
    for (const dir of tmpDirs) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
});

function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function mkTmp(prefix) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

/**
 * Stub apra-fleet server: GET /health (the singleton liveness probe) plus the
 * registry surface. EVERY request is recorded, including 404 fall-throughs --
 * a stub that only recorded the correct path could not see the supervisor
 * POSTing to the wrong one.
 */
async function startStubFleetServer() {
    const state = { calls: [], registerCalls: [], deleteCalls: [] };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            state.calls.push({ method: req.method, url: req.url, headers: req.headers });
            if (req.method === 'GET' && req.url === '/health') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok' }));
                return;
            }
            if (req.method === 'POST' && req.url === '/api/workflow-packages/register') {
                let body = null;
                try { body = raw.length ? JSON.parse(raw) : null; } catch { body = null; }
                state.registerCalls.push({ url: req.url, body, headers: req.headers });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                return;
            }
            if (req.method === 'DELETE' && req.url.startsWith('/api/workflow-packages/')) {
                state.deleteCalls.push({ url: req.url, headers: req.headers });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                return;
            }
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not found' }));
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    stubServers.push(server);
    const { port } = server.address();
    return { state, port, origin: `http://127.0.0.1:${port}` };
}

async function waitFor(pred, { timeoutMs = BOOT_TIMEOUT_MS, label = 'condition', isAlive, describe: describeState } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (isAlive && !isAlive()) {
            throw new Error(`${label}: the supervisor subprocess exited before the condition was met.${describeState ? `\n${describeState()}` : ''}`);
        }
        // eslint-disable-next-line no-await-in-loop
        if (await pred()) return;
        if (Date.now() > deadline) {
            throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}.${describeState ? `\n${describeState()}` : ''}`);
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(150);
    }
}

function request(port, method, urlPath, { headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, path: urlPath, method, headers,
            timeout: scaledTimeout(10000, { concurrency: TEST_CONCURRENCY }),
        }, (res) => {
            let raw = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { raw += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: raw }));
        });
        req.on('timeout', () => { req.destroy(new Error(`request timeout: ${method} ${urlPath}`)); });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Boot the real bin/serve.mjs in a fully isolated environment.
 *
 * @param {{ withFleetKey?: boolean, withServer?: boolean, env?: object }} opts
 *   withFleetKey -- write a valid 64-hex fleet.key before starting.
 *   withServer   -- write server.json before starting, so the supervisor
 *                   resolves a real http connection to the stub.
 * APRA_FLEET_TRANSPORT is deliberately never set (and is scrubbed from the
 * inherited env, so an exported value in the developer's shell or CI cannot
 * silently turn these cases into the forced-http path the bug hides behind).
 */
async function bootSupervisor({ withFleetKey = false, withServer = false, env = {} } = {}) {
    const stub = await startStubFleetServer();
    const homeDir = await mkTmp('i9ag12-home-');
    const dataDir = await mkTmp('i9ag12-fleet-data-');
    const seDataDir = await mkTmp('i9ag12-se-data-');
    const workDir = await mkTmp('i9ag12-cwd-');

    const fleetKey = crypto.randomBytes(32).toString('hex');
    // apra-fleet-q1ku: the child runs with its own APRA_FLEET_DATA_DIR, so its
    // fleet.key is <APRA_FLEET_DATA_DIR>/fleet.key (shared fleet-path resolver),
    // not <home>/.apra-fleet/fleet.key.
    const fleetKeyPath = path.join(dataDir, 'fleet.key');
    const serverJsonPath = path.join(dataDir, 'server.json');
    // Realistic on purpose: the url carries the /mcp suffix, exactly what the
    // real server writes. The registry hangs off the ORIGIN, so a fixture
    // without the suffix would hide a whole class of URL bug.
    const serverJson = JSON.stringify({ pid: process.pid, port: stub.port, url: `${stub.origin}/mcp` });

    await fsp.mkdir(path.join(homeDir, '.apra-fleet'), { recursive: true });
    if (withFleetKey) await fsp.writeFile(fleetKeyPath, fleetKey, 'utf-8');
    if (withServer) await fsp.writeFile(serverJsonPath, serverJson, 'utf-8');

    const childEnv = { ...process.env };
    delete childEnv.APRA_FLEET_TRANSPORT;
    delete childEnv.APRA_FLEET_SERVER_CMD;
    delete childEnv.APRA_FLEET_SERVER_BIN;

    const port = await getFreePort();
    let output = '';
    const child = spawn(process.execPath, [SERVE_BIN, '--port', String(port)], {
        cwd: workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...buildIsolatedHomeEnv(homeDir, childEnv),
            APRA_FLEET_DATA_DIR: dataDir,
            FLEET_SE_DATA_DIR: seDataDir,
            ...env,
        },
    });
    if (Number.isInteger(child.pid) && child.pid > 0) spawnedPids.add(child.pid);
    child.stdout.on('data', (c) => { output += c.toString('utf-8'); });
    child.stderr.on('data', (c) => { output += c.toString('utf-8'); });
    let exited = false;
    child.on('exit', () => { exited = true; });

    const isAlive = () => !exited;
    const describeState = () => `subprocess output so far:\n${output}`;

    await waitFor(async () => {
        try {
            const res = await request(port, 'GET', '/api/health');
            return res.status === 200 || res.status === 401;
        } catch {
            return false;
        }
    }, { label: 'the supervisor subprocess to answer /api/health', isAlive, describe: describeState });

    return {
        port,
        stub,
        fleetKey,
        homeDir,
        /** The private/token fallback the supervisor minted under its own data
         *  root (FLEET_SE_DATA_DIR) because no fleet.key existed at boot. */
        readPrivateToken: async () => (await fsp.readFile(path.join(seDataDir, 'private', 'token'), 'utf-8')).trim(),
        output: () => output,
        isAlive,
        describeState,
        /** Simulate "the operator installed apra-fleet" -- the key appears. */
        mintFleetKey: () => fsp.writeFile(fleetKeyPath, fleetKey, 'utf-8'),
        /** Simulate "the apra-fleet server came up" -- the singleton is now
         *  discoverable, so the next resolution pass sees mode 'http'. */
        bringServerUp: () => fsp.writeFile(serverJsonPath, serverJson, 'utf-8'),
        /** Wait until the stub has actually been asked to register. */
        waitForRegistration: () => waitFor(
            async () => stub.state.registerCalls.length > 0,
            {
                timeoutMs: CONVERGE_TIMEOUT_MS,
                label: 'the supervisor to converge on workflow-package registration',
                isAlive,
                describe: () => `${describeState()}\nstub saw: ${JSON.stringify(stub.state.calls.map((c) => `${c.method} ${c.url}`))}`,
            },
        ),
        /**
         * Clean, in-band stop -- the path whose completion triggers
         * unregister(): an authenticated POST /api/shutdown bearing the raw
         * fleet key. Works whether or not fleet.key existed at boot: the
         * supervisor's own api guard re-resolves its token (apra-fleet-hwxd),
         * so a supervisor booted on the private/token fallback accepts the
         * fleet-key credential once the key appears.
         */
        stopCleanly: async () => {
            try {
                const res = await request(port, 'POST', '/api/shutdown', { headers: { authorization: `Bearer ${fleetKey}` } });
                assert.equal(res.status, 200, `POST /api/shutdown was refused: ${res.status} ${res.body}`);
                await waitFor(() => exited, { label: 'the supervisor subprocess to exit', describe: describeState });
            } finally {
                try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
            }
        },
    };
}

/** Assert the register POST is well-formed: right path, right bearer. Shared by
 *  every case so no case can pass on a weaker check than the others. */
function assertRegisteredWith(sv) {
    const calls = sv.stub.state.registerCalls;
    assert.equal(calls.length >= 1, true, 'expected at least one register POST');
    const call = calls[0];
    assert.equal(call.url, '/api/workflow-packages/register',
        'the register POST must target consoleOrigin + /api/workflow-packages/register, not the /mcp endpoint path');
    assert.equal(call.headers.authorization, `Bearer ${sv.fleetKey}`,
        'the bearer must be the RAW fleet.key contents');
    assert.equal(call.body && call.body.id, 'se', 'expected workflow package se to be the one registered');
}

/** No request the stub EVER saw may carry anything other than the raw fleet
 *  key -- in particular never the private/token fallback credential, which the
 *  apra-fleet server's console guard cannot accept anyway. */
function assertNoForeignCredential(sv) {
    for (const call of sv.stub.state.calls) {
        const auth = call.headers.authorization;
        if (auth === undefined) continue;
        assert.equal(auth, `Bearer ${sv.fleetKey}`,
            `a request carried a credential that is not the raw fleet key: ${call.method} ${call.url} (${auth})`);
    }
}

// -----------------------------------------------------------------------------
// Case (b): supervisor-first, NO fleet.key -- former skip branch (a)
// -----------------------------------------------------------------------------

describe('apra-fleet-i9ag.12: supervisor started BEFORE fleet.key exists converges', () => {
    test('no fleet.key -> retries (former branch a), then registers once the key and server appear, with no restart', async () => {
        const sv = await bootSupervisor({ withFleetKey: false, withServer: false });
        let passed = false;
        try {
            // apra-fleet-hwxd.2 (1): before fleet.key exists the supervisor's own
            // guard is keyed to the private/token fallback -- a guarded /api
            // route answers 200 to that bearer (and 401 to none).
            const privateToken = await sv.readPrivateToken();
            const preKey = await request(sv.port, 'GET', '/api/health', { headers: { authorization: `Bearer ${privateToken}` } });
            assert.equal(preKey.status, 200, `private/token bearer before fleet.key: ${preKey.status} ${preKey.body}`);
            assert.equal((await request(sv.port, 'GET', '/api/health')).status, 401,
                'GET /api/health is a guarded route: no credential must be 401');

            // It must be WAITING on the key, and must say so as a retry.
            await waitFor(
                async () => sv.output().includes(BRANCH_NO_FLEET_KEY),
                { label: `the no-fleet.key retry log (${BRANCH_NO_FLEET_KEY})`, isAlive: sv.isAlive, describe: sv.describeState },
            );
            const early = sv.output();
            assert.match(early, /RETRYING/, 'the state must be reported as being retried');
            assert.ok(
                !/skipping workflow-package registration/i.test(early),
                `registration must no longer be described as skipped:\n${early}`,
            );
            // This case must exercise branch (a), NOT the stdio branch -- with no
            // fleet.key the connection is never resolved at all.
            assert.ok(
                !early.includes(BRANCH_NO_HTTP_URL),
                `case (b) must land in the no-fleet.key branch, not the stdio branch:\n${early}`,
            );
            // And nothing may have been sent to the server yet.
            assert.equal(sv.stub.state.registerCalls.length, 0,
                'no register attempt may happen before a fleet-key-sourced token exists');

            // Now the machine converges: the key is minted and the server comes up.
            await sv.mintFleetKey();

            // apra-fleet-hwxd.2 (2): the console's /ext/se hop credential --
            // deriveUpstreamCredential(fleetKey, PACKAGE_ID), exactly what
            // src/console/proxy.ts attaches -- now reaches the SAME process
            // (no restart) on a guarded /api route.
            const hop = await request(sv.port, 'GET', '/api/health', {
                headers: { authorization: `Bearer ${deriveUpstreamCredential(sv.fleetKey, PACKAGE_ID)}` },
            });
            assert.equal(hop.status, 200,
                `fleet-key-derived /ext/se bearer after fleet.key appeared, no restart: ${hop.status} ${hop.body}`);
            await sv.bringServerUp();
            await sv.waitForRegistration();

            assertRegisteredWith(sv);
            assertNoForeignCredential(sv);
            // The token value must never be logged.
            assert.ok(!sv.output().includes(sv.fleetKey), 'the fleet key value must never appear in a log line');
            assert.ok(!sv.output().includes(privateToken), 'the private/token value must never appear in a log line');
            passed = true;
        } finally {
            // apra-fleet-hwxd.2 (3): the authenticated in-band shutdown with
            // the fleet-key credential, now that the guard follows fleet.key.
            // stopCleanly() always kills the child; when an assertion above
            // already failed, its own refusal must not mask that first error.
            await sv.stopCleanly().catch((err) => { if (passed) throw err; });
        }
        // (4) checked again after shutdown so the shutdown/unregister log
        // lines are covered too.
        assert.ok(!sv.output().includes(sv.fleetKey), 'the fleet key value must never appear in supervisor output');
        assert.ok(!sv.output().includes(await sv.readPrivateToken()), 'the private/token value must never appear in supervisor output');
    });
});

// -----------------------------------------------------------------------------
// Case (e): supervisor-first, fleet.key PRESENT, no reachable server, transport
// UNSET -- former skip branch (c), the branch a naive fix leaves broken.
// -----------------------------------------------------------------------------

describe('apra-fleet-i9ag.12: supervisor started with fleet.key but BEFORE the server converges', () => {
    test('server down, APRA_FLEET_TRANSPORT unset: client auto-start (main #629) cannot resolve a connection -> retries, then registers once the server comes up', async () => {
        const sv = await bootSupervisor({ withFleetKey: true, withServer: false });
        try {
            await waitFor(
                async () => sv.output().includes(BRANCH_RESOLVE_ERROR),
                { label: `the connection-error retry log (${BRANCH_RESOLVE_ERROR})`, isAlive: sv.isAlive, describe: sv.describeState },
            );
            const early = sv.output();
            assert.match(early, /RETRYING/, 'the state must be reported as being retried');
            assert.ok(
                !/skipping workflow-package registration/i.test(early),
                `registration must no longer be described as skipped:\n${early}`,
            );
            // THE load-bearing assertion of this file: this case must NOT have
            // collapsed into case (b). With the key already present the
            // no-fleet.key branch is unreachable, so its text must be absent.
            assert.ok(
                !early.includes(BRANCH_NO_FLEET_KEY),
                `case (e) must land in the connection branch, not the no-fleet.key branch -- a valid `
                + `fleet.key was written before boot:\n${early}`,
            );
            // Proof it really took #629's auto-start path (the unset-transport
            // default no longer falls back to a private stdio server).
            assert.match(early, /auto-start/i, `expected the client auto-start refusal in the log:\n${early}`);
            assert.ok(!early.includes(BRANCH_NO_HTTP_URL), `no stdio fallback any more (main #629):\n${early}`);
            assert.equal(sv.stub.state.registerCalls.length, 0, 'no register attempt before an http url exists');

            await sv.bringServerUp();
            await sv.waitForRegistration();

            assertRegisteredWith(sv);
            assertNoForeignCredential(sv);
            assert.ok(!sv.output().includes(sv.fleetKey), 'the fleet key value must never appear in a log line');
        } finally {
            await sv.stopCleanly();
        }
    });
});

// -----------------------------------------------------------------------------
// Case (c): server-first -- the already-working path must not regress.
// -----------------------------------------------------------------------------

describe('apra-fleet-i9ag.12: supervisor started AFTER fleet.key and the server (no regression)', () => {
    test('registers on the first attempt, with no waiting log at all', async () => {
        const sv = await bootSupervisor({ withFleetKey: true, withServer: true });
        try {
            await sv.waitForRegistration();
            assertRegisteredWith(sv);
            assertNoForeignCredential(sv);

            assert.equal(sv.stub.state.registerCalls.length, 1, 'expected exactly one register POST on the happy path');
            const out = sv.output();
            assert.ok(
                !out.includes(BRANCH_NO_FLEET_KEY) && !out.includes(BRANCH_NO_HTTP_URL),
                `the happy path must not log any waiting reason:\n${out}`,
            );
            assert.ok(!out.includes(sv.fleetKey), 'the fleet key value must never appear in a log line');
        } finally {
            await sv.stopCleanly();
        }
    });

    test('a clean shutdown unregisters the instance the convergence loop built', async () => {
        const sv = await bootSupervisor({ withFleetKey: true, withServer: true });
        await sv.waitForRegistration();
        await sv.stopCleanly();

        assert.equal(sv.stub.state.deleteCalls.length, 1,
            `expected exactly one unregister DELETE, stub saw: ${JSON.stringify(sv.stub.state.calls.map((c) => `${c.method} ${c.url}`))}`);
        assert.equal(sv.stub.state.deleteCalls[0].url, '/api/workflow-packages/se');
        assertNoForeignCredential(sv);
    });
});
