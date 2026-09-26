// =============================================================================
// apra-fleet-i9ag.3.4 -- SUPERVISOR SIDE of "Sprints page reachable and live
// through the console /ext hop".
//
// The console side of the same feature lives in the root repo's
// tests/i9ag34-sprints-console-hop-e2e.test.ts (vitest), which drives the REAL
// src/console /ext proxy and the REAL workflow-package registry against a real
// supervisor subprocess. THIS file owns everything that is a property of the
// supervisor package itself, so neither side has to reach into the other's
// language/runtime:
//
//   1. self-registration goes to the apra-fleet server's ORIGIN, carries the
//      real manifest (Sprints nav entry + the /api/health probe path), and is
//      authenticated with the shared fleet.key;
//   2. a clean stop (POST /api/shutdown) unregisters the package;
//   3. the Sprints page, requested with the console's mount-path header, is the
//      REAL dashboard and emits no app-path that is still rooted at '/';
//   4. /api/health answers 200 to the derived per-package credential and 401
//      with no credential at all;
//   5. the launch form's own POST target is routed and authorised behind that
//      same guard -- asserted WITHOUT launching a sprint.
//
// Everything runs against the REAL bin/serve.mjs subprocess (the pattern
// test/registration.test.mjs case 6 established) talking to a stub apra-fleet
// server, because "what URL does the supervisor register at" and "does a clean
// stop unregister" are properties of serveMain() itself, not of a module that
// could be unit-tested in-process. No suite an impl task in this sprint owns is
// touched: this is an additive file.
//
// DETERMINISM (this runs under the bounded runner on Linux, macOS and Windows):
//  - every listener binds :0 and reads the assigned port back; no port literal,
//    and the reserved staging ports are never touched;
//  - no shell-level variable expansion anywhere: every path is resolved in
//    JavaScript and handed to spawn() as an argv element / env value;
//  - nothing is POSIX-only. The supervisor is stopped through its own in-band
//    POST /api/shutdown (not a signal), with process.kill(SIGKILL) only as the
//    after-hook backstop for a subprocess that never answered;
//  - the subprocess's cwd is a FRESH TEMP DIR, never this package root. That is
//    load-bearing, not tidiness: the dashboard renders the tracker it finds via
//    cwd, so running it in the checkout embeds this repo's live backlog (~3 MB
//    of rows that change every sprint) into the page under test. A temp cwd
//    makes the rendered document depend only on the code, not on the state of
//    whatever clone happens to be running the suite;
//  - HOME/USERPROFILE are redirected to a temp dir, so the fleet.key minted
//    here is never the developer's own.
// =============================================================================

import { test, describe, before, after } from 'node:test';
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

import { buildManifest, PACKAGE_ID, SPRINTS_UI_PATH } from '../src/registration/manifest.mjs';
import { MOUNT_PATH_HEADER } from '../src/supervisor/mount-prefix.mjs';
import { deriveUpstreamCredential } from '@apralabs/apra-fleet-client/auth/local-token';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVE_BIN = path.join(__dirname, '../bin/serve.mjs');

/** The console mount path a real `/ext/<id>` hop would stamp on every request
 *  for THIS package -- built from PACKAGE_ID, never hand-copied, so the id and
 *  the mount path can never drift apart here. */
const MOUNT_PREFIX = `/ext/${PACKAGE_ID}`;

/** Generous upper bound on booting a real supervisor subprocess. A FAILURE
 *  bound, not a sleep: a passing run never waits for it to elapse. Scaled for
 *  the concurrency the bounded runner launches with, so sibling test files
 *  contending for CPU cannot turn scheduling delay into a false failure. */
const BOOT_TIMEOUT_MS = scaledTimeout(20000, { concurrency: TEST_CONCURRENCY, multiplier: 6 });

/** @type {string[]} */
const tmpDirs = [];
/** @type {import('node:http').Server[]} */
const stubServers = [];
/** @type {Set<number>} */
const spawnedPids = new Set();

after(async () => {
    for (const pid of spawnedPids) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    spawnedPids.clear();
    for (const srv of stubServers.splice(0)) {
        await new Promise((resolve) => srv.close(() => resolve()));
    }
    for (const dir of tmpDirs.splice(0)) {
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

/** Allocate a currently-free TCP port by binding to 0 and reading it back. */
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

/** One HTTP round trip against 127.0.0.1:<port>, resolving
 *  `{ status, headers, body }`. JSON-encodes `body` when given. */
function request(port, method, urlPath, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf-8');
        const outHeaders = { ...headers };
        if (payload) {
            outHeaders['content-type'] = 'application/json';
            outHeaders['content-length'] = payload.length;
        }
        const req = http.request({
            host: '127.0.0.1', port, path: urlPath, method,
            headers: outHeaders, timeout: scaledTimeout(10000, { concurrency: TEST_CONCURRENCY }),
        }, (res) => {
            let raw = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { raw += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw }));
        });
        req.on('timeout', () => { req.destroy(new Error(`request timeout: ${method} ${urlPath}`)); });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

const jsonOf = (res) => (res.body ? JSON.parse(res.body) : null);

/**
 * Poll `pred()` until truthy or the deadline passes. `isAlive`, when given, is
 * checked first on every iteration so a dead subprocess fails FAST with a
 * readable message instead of burning the whole (deliberately generous)
 * timeout.
 */
async function waitFor(pred, { timeoutMs = BOOT_TIMEOUT_MS, label = 'condition', isAlive, describe: describeState } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (isAlive && !isAlive()) {
            throw new Error(`${label}: the supervisor subprocess exited before the condition was met.${describeState ? `\n${describeState()}` : ''}`);
        }
        // eslint-disable-next-line no-await-in-loop
        const value = await pred();
        if (value) return value;
        if (Date.now() > deadline) {
            throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}.${describeState ? `\n${describeState()}` : ''}`);
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(100);
    }
}

/**
 * A stub apra-fleet server exposing ONLY what this flow legitimately needs:
 *
 *  - `GET /health` -- the HTTP-singleton liveness probe
 *    (@apralabs/apra-fleet-client's checkRunningInstance), which is what makes
 *    the supervisor resolve an `http` connection at all;
 *  - `POST /api/workflow-packages/register` and
 *    `DELETE /api/workflow-packages/:id` -- the registry surface.
 *
 * EVERY request is recorded (`calls`), including ones that fall through to 404.
 * That is the point: the registration regression this file pins is the
 * supervisor POSTing to the WRONG path, which a stub that only recorded the
 * right path could never see.
 */
async function startStubFleetServer() {
    const state = { calls: [], registerBodies: [], deleteCalls: [] };
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
                state.registerBodies.push({ body, headers: req.headers });
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

/**
 * Boot the REAL bin/serve.mjs against a stub apra-fleet server, wired so the
 * supervisor resolves a real `http` fleet connection and self-registers.
 *
 * The `server.json` written below is deliberately REALISTIC: its `url` carries
 * the `/mcp` suffix, because that is exactly what the real server writes
 * (src/index.ts persists createHttpTransport()'s `handle.url`, and the client's
 * checkRunningInstance() hands that value straight back to the supervisor). A
 * fixture that dropped the suffix would quietly hide the registration-URL
 * regression this file exists to pin.
 */
async function bootSupervisor() {
    const stub = await startStubFleetServer();
    const homeDir = await mkTmp('i9ag34-home-');
    const dataDir = await mkTmp('i9ag34-fleet-data-');
    const seDataDir = await mkTmp('i9ag34-se-data-');
    // A cwd with no tracker in it -- see this file's header for why the
    // subprocess must NOT run in the checkout.
    const workDir = await mkTmp('i9ag34-cwd-');

    const fleetKey = crypto.randomBytes(32).toString('hex');
    await fsp.mkdir(path.join(homeDir, '.apra-fleet'), { recursive: true });
    await fsp.writeFile(path.join(homeDir, '.apra-fleet', 'fleet.key'), fleetKey, 'utf-8');
    await fsp.writeFile(
        path.join(dataDir, 'server.json'),
        JSON.stringify({ pid: process.pid, port: stub.port, url: `${stub.origin}/mcp` }),
        'utf-8',
    );

    const port = await getFreePort();
    let output = '';
    // console.warn/error go to stderr (installSelfLogTee only tees them into a
    // log FILE), so both streams are captured -- a boot failure must surface as
    // the subprocess's own diagnostics, not as a bare timeout.
    const child = spawn(process.execPath, [SERVE_BIN, '--port', String(port)], {
        cwd: workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            APRA_FLEET_DATA_DIR: dataDir,
            FLEET_SE_DATA_DIR: seDataDir,
            HOME: homeDir,
            USERPROFILE: homeDir,
        },
    });
    if (Number.isInteger(child.pid) && child.pid > 0) spawnedPids.add(child.pid);
    child.stdout.on('data', (c) => { output += c.toString('utf-8'); });
    child.stderr.on('data', (c) => { output += c.toString('utf-8'); });
    let exited = false;
    let exitCode = null;
    child.on('exit', (code) => { exited = true; exitCode = code; });

    const isAlive = () => !exited;
    const describeState = () => `subprocess output so far:\n${output}`;

    await waitFor(async () => {
        try {
            // /api/health is behind the supervisor's own guard, so an
            // unauthenticated 401 is just as good a liveness signal as a 200.
            const res = await request(port, 'GET', '/api/health');
            return res.status === 200 || res.status === 401;
        } catch {
            return false;
        }
    }, { label: 'the supervisor subprocess to answer /api/health', isAlive, describe: describeState });

    return {
        port,
        fleetKey,
        stub,
        output: () => output,
        isAlive,
        exitCode: () => exitCode,
        /** The derived per-package credential the console's /ext hop attaches
         *  -- computed the same way src/console/proxy.ts computes it. */
        derivedCredential: () => deriveUpstreamCredential(fleetKey, PACKAGE_ID),
        /** Clean, in-band stop -- the documented shutdown path, and the one
         *  whose completion triggers unregister(). Resolves once the process
         *  has actually exited. */
        stopCleanly: async () => {
            const res = await request(port, 'POST', '/api/shutdown', {
                headers: { authorization: `Bearer ${fleetKey}` },
            });
            assert.equal(res.status, 200, `POST /api/shutdown was refused: ${res.status} ${res.body}`);
            await waitFor(() => exited, {
                label: 'the supervisor subprocess to exit after POST /api/shutdown',
                describe: describeState,
            });
        },
        kill: () => { try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } },
    };
}

/**
 * Every absolute app-path the rendered dashboard EMITS: the target of an
 * `href="..."`/`action="..."`/`src="..."` attribute, a `fetch('...')` call, a
 * `new EventSource('...')` construction, or a `link.href = '...'` assignment.
 *
 * Only literals rooted at '/' are collected. Deliberately the same sweep shape
 * the supervisor's own dashboard suite uses, reimplemented here rather than
 * imported, so this file stays additive and does not couple to a suite an impl
 * task in this sprint owns.
 */
function emittedAppPaths(html) {
    const sweep = /(?:href="|action="|src="|fetch\('|new EventSource\('|link\.href = ')(\/[A-Za-z0-9._~/%-]*)/g;
    return Array.from(html.matchAll(sweep)).map((m) => m[1]);
}

// -----------------------------------------------------------------------------
// One shared supervisor for every read-only assertion. The stop/unregister case
// gets its OWN boot, since stopping the process is the thing it asserts.
// -----------------------------------------------------------------------------

describe('apra-fleet-i9ag.3.4 (supervisor side): Sprints reachable and live through the console /ext hop', () => {
    /** @type {Awaited<ReturnType<typeof bootSupervisor>>} */
    let sv;
    /** The Sprints page as the console would fetch it: mount-path header set. */
    let mountedHtml;

    before(async () => {
        sv = await bootSupervisor();
        const res = await request(sv.port, 'GET', SPRINTS_UI_PATH, {
            headers: { [MOUNT_PATH_HEADER]: MOUNT_PREFIX },
        });
        assert.equal(res.status, 200, `GET ${SPRINTS_UI_PATH} answered ${res.status}: ${res.body.slice(0, 400)}`);
        mountedHtml = res.body;
    });

    // ---------------------------------------------------------------------
    // (1) Registration: the right URL, the right credential, the real manifest.
    // ---------------------------------------------------------------------

    test('self-registers at the fleet server ORIGIN -- never under its /mcp endpoint path', async () => {
        await waitFor(() => sv.stub.state.registerBodies.length > 0, {
            label: 'the supervisor to POST its registration to the stub fleet server',
            isAlive: sv.isAlive,
            describe: () => `subprocess output so far:\n${sv.output()}\nstub saw: ${JSON.stringify(sv.stub.state.calls.map((c) => `${c.method} ${c.url}`))}`,
        });

        const seen = sv.stub.state.calls.map((c) => `${c.method} ${c.url}`);
        // The regression this pins: `server.json`'s url is the MCP endpoint
        // ('<origin>/mcp'), so passing it through to createRegistration()
        // verbatim made the supervisor POST '<origin>/mcp/api/workflow-packages/
        // register' -- a 404 on the real server, and a RETRYABLE one, so the
        // supervisor retried forever and never registered. Asserted as an
        // absence over EVERY recorded request, not just the successful one.
        assert.deepEqual(
            seen.filter((line) => line.includes('/mcp/api/')),
            [],
            `registration must target the server origin, not its MCP endpoint path; stub saw: ${JSON.stringify(seen)}`,
        );
        assert.ok(
            seen.includes('POST /api/workflow-packages/register'),
            `expected a register POST at the origin; stub saw: ${JSON.stringify(seen)}`,
        );
        // One successful attempt is enough -- a retry loop would mean the POST
        // was refused, which is exactly the broken state above.
        assert.equal(sv.stub.state.registerBodies.length, 1,
            `expected exactly one registration attempt, got ${sv.stub.state.registerBodies.length} (a repeat means the server refused it)`);

        const { body, headers } = sv.stub.state.registerBodies[0];
        // The apra-fleet server's /api guard checks the bearer path against the
        // RAW fleet key (not a derived value) -- see src/console/server.ts.
        assert.equal(headers.authorization, `Bearer ${sv.fleetKey}`);
        // The manifest is the real one, byte-for-byte: this is what makes the
        // console list a Sprints nav entry and probe the guarded health path.
        assert.deepEqual(body, buildManifest({ baseUrl: `http://127.0.0.1:${sv.port}` }));
        assert.equal(body.id, PACKAGE_ID);
        assert.equal(body.health, '/api/health');
        assert.deepEqual(
            body.nav.find((e) => e.label === 'Sprints'),
            { label: 'Sprints', path: SPRINTS_UI_PATH },
            'the manifest must carry an unscoped Sprints nav entry at SPRINTS_UI_PATH',
        );
    });

    // ---------------------------------------------------------------------
    // (2) The Sprints page IS the real dashboard, and nothing stays rooted at '/'.
    // ---------------------------------------------------------------------

    test(`GET ${SPRINTS_UI_PATH} serves the REAL dashboard (not the /ui placeholder)`, () => {
        for (const marker of [
            'Fleet-Sprint Supervisor',   // page title/header
            'Sprint Stack',              // the live sprint stack panel
            'id="sprint-stack"',
            'Launch Sprint',             // the launch form section
            'id="launch-sprint-form"',
        ]) {
            assert.ok(mountedHtml.includes(marker), `real dashboard marker missing: ${marker}`);
        }
    });

    test('every app-path the mounted Sprints page emits is rooted under the console mount path, exactly once', () => {
        const paths = emittedAppPaths(mountedHtml);
        assert.ok(paths.length > 0, 'the sweep found no app-paths at all -- it has stopped matching the rendered page');
        for (const p of paths) {
            assert.ok(p.startsWith(`${MOUNT_PREFIX}/`), `left rooted at '/': ${p}`);
            assert.equal(p.indexOf(MOUNT_PREFIX, 1), -1, `prefixed more than once: ${p}`);
        }
        // The client-side live-refresh re-renders rows in the browser, so the
        // prefix and the helper that applies it must both reach the page --
        // otherwise the first SSE tick would rewrite every link back to '/'.
        assert.ok(mountedHtml.includes(`var MOUNT_PREFIX = '${MOUNT_PREFIX}';`),
            'the resolved mount prefix must be shipped to the client script');
        assert.ok(mountedHtml.includes('function mountHref(mountPrefix, appPath)'),
            'mountHref() must be shipped to the client script');
    });

    test('the SAME page requested without the mount header stays rooted at \'/\' -- the prefix comes from the header, not a hardcode', async () => {
        const res = await request(sv.port, 'GET', SPRINTS_UI_PATH);
        assert.equal(res.status, 200);
        assert.ok(!res.body.includes(MOUNT_PREFIX),
            'a direct (header-less) hit must never carry a mount prefix');
        const direct = emittedAppPaths(res.body);
        // Same app-paths, same order, just unprefixed: proves the mounted render
        // differs from the direct one ONLY by the prefix.
        assert.deepEqual(
            emittedAppPaths(mountedHtml),
            direct.map((p) => MOUNT_PREFIX + p),
        );
    });

    // ---------------------------------------------------------------------
    // (3) The guard: derived per-package credential in, no credential out.
    // ---------------------------------------------------------------------

    test('GET /api/health answers 200 to the derived per-package credential and 401 with no credential', async () => {
        const authorized = await request(sv.port, 'GET', '/api/health', {
            headers: { authorization: `Bearer ${sv.derivedCredential()}`, [MOUNT_PATH_HEADER]: MOUNT_PREFIX },
        });
        assert.equal(authorized.status, 200, `derived credential was refused: ${authorized.body}`);

        const anonymous = await request(sv.port, 'GET', '/api/health');
        assert.equal(anonymous.status, 401, 'an uncredentialed health probe must be refused');

        // A credential derived for a DIFFERENT package id must not work here --
        // otherwise any registered package could read this one's health.
        const foreign = await request(sv.port, 'GET', '/api/health', {
            headers: { authorization: `Bearer ${deriveUpstreamCredential(sv.fleetKey, `not-${PACKAGE_ID}`)}` },
        });
        assert.equal(foreign.status, 401, "a credential derived for another package id must not authenticate here");
    });

    // ---------------------------------------------------------------------
    // (4) The launch form's POST target: routed and authorised, nothing launched.
    // ---------------------------------------------------------------------

    test("the launch form's own POST target is routed and authorised behind the same guard, without launching a sprint", async () => {
        // Read the target OUT OF THE RENDERED PAGE rather than hardcoding it, so
        // this asserts the path the form actually submits to. The mounted page
        // emits it under the console mount prefix; strip that to get the path on
        // the supervisor's own origin (which is what the /ext hop forwards).
        const mountedTarget = emittedAppPaths(mountedHtml).find((p) => p.endsWith('/api/sprints'));
        assert.ok(mountedTarget, 'the rendered launch form emits no /api/sprints target');
        const submitPath = mountedTarget.slice(MOUNT_PREFIX.length);
        assert.equal(submitPath, '/api/sprints');

        const before = jsonOf(await request(sv.port, 'GET', '/api/sprints', {
            headers: { authorization: `Bearer ${sv.derivedCredential()}` },
        }));

        // Authorised, and it REACHES the handler: an empty body is rejected by
        // the launch request validator (400, naming the offending field), which
        // only runs after routing and auth have both succeeded. A 401 would mean
        // the credential was refused; a 404 would mean the route is not there.
        const routed = await request(sv.port, 'POST', submitPath, {
            headers: { authorization: `Bearer ${sv.derivedCredential()}`, [MOUNT_PATH_HEADER]: MOUNT_PREFIX },
            body: {},
        });
        assert.equal(routed.status, 400, `expected the launch validator's 400, got ${routed.status}: ${routed.body}`);
        assert.equal(jsonOf(routed).field, 'issue',
            'the 400 must come from the launch request validator (field "issue"), proving the handler was reached');

        const anonymous = await request(sv.port, 'POST', submitPath, { body: {} });
        assert.equal(anonymous.status, 401, 'an uncredentialed launch POST must be refused');

        // Nothing was launched: the live sprint list is unchanged.
        const after_ = jsonOf(await request(sv.port, 'GET', '/api/sprints', {
            headers: { authorization: `Bearer ${sv.derivedCredential()}` },
        }));
        assert.deepEqual(after_, before, 'a rejected launch must leave the live sprint list untouched');
    });
});

// -----------------------------------------------------------------------------
// (5) Clean stop unregisters. Its own boot -- stopping the process IS the
// assertion, so it must not share a supervisor with the cases above.
// -----------------------------------------------------------------------------

describe('apra-fleet-i9ag.3.4 (supervisor side): a clean stop removes the registry entry', () => {
    test('POST /api/shutdown unregisters the package from the fleet server', async () => {
        const sv = await bootSupervisor();
        await waitFor(() => sv.stub.state.registerBodies.length > 0, {
            label: 'the supervisor to register before being stopped',
            isAlive: sv.isAlive,
            describe: () => `subprocess output so far:\n${sv.output()}`,
        });
        assert.deepEqual(sv.stub.state.deleteCalls, [], 'nothing may be unregistered while the supervisor is up');

        await sv.stopCleanly();

        // unregister() runs AFTER supervisor teardown resolves, and is bounded,
        // so the DELETE may land a moment after the process exits.
        await waitFor(() => sv.stub.state.deleteCalls.length > 0, {
            label: 'the supervisor to DELETE its registry entry on clean shutdown',
            describe: () => `subprocess output so far:\n${sv.output()}`,
        });
        assert.equal(sv.stub.state.deleteCalls.length, 1);
        assert.equal(sv.stub.state.deleteCalls[0].url, `/api/workflow-packages/${PACKAGE_ID}`);
        assert.equal(sv.stub.state.deleteCalls[0].headers.authorization, `Bearer ${sv.fleetKey}`);
    });
});
