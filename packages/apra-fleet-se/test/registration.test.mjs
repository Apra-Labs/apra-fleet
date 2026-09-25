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

import { buildManifest, PACKAGE_ID, APRA_FLEET_API_RANGE } from '../src/registration/manifest.mjs';
import { createRegistration, UNREGISTER_TIMEOUT_MS } from '../src/registration/register.mjs';
import { registerHoldsRoute } from '../src/registration/holds.mjs';
import { registerOwnerRefsRoute } from '../src/registration/owner-refs.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { deriveUpstreamCredential } from '@apralabs/apra-fleet-client/auth/local-token';
import { isNodeSqliteAvailable, openStore } from '../src/projects/store/db.mjs';
import { createProject } from '../src/projects/store/projects.mjs';

// =============================================================================
// apra-fleet-g6ap.2.3 -- registration module coverage:
//   1. buildManifest shape.
//   2-5. register()/unregister() against a local stub apra-fleet server.
//   6. registration skipped (no fleet.key / no server URL); supervisor still
//      starts -- driven through the REAL bin/serve.mjs subprocess.
//   7. supervisor guard accepts the raw token AND the derived 'se' credential.
//   8. GET /api/members/:id/holds.
//   9. GET /api/owner-refs (store cases skip, not fail, without node:sqlite).
//
// Cases 1-2-3-4-5-7-8-9 drive the route/registration modules directly
// in-process (createRegistration / createSupervisor.handleRequest -- no real
// HTTP listener, mirroring test/projects-routes.test.mjs's own convention).
// Case 6 is the one exception that needs the real bin/serve.mjs subprocess,
// since "registration is skipped" and "the supervisor still starts" are both
// properties of serveMain() itself, not of a module this file can unit-test
// directly.
// =============================================================================

const HAS_SQLITE = isNodeSqliteAvailable();
const sqliteSkip = HAS_SQLITE ? false : 'node:sqlite is unavailable on this Node runtime';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVE_BIN = path.join(__dirname, '../bin/serve.mjs');
const SE_PKG_ROOT = path.join(__dirname, '..');
const ROOT_VERSION_JSON = path.join(__dirname, '../../../version.json');
const PACKAGE_JSON = path.join(__dirname, '../package.json');

/** @type {string[]} */
const tmpDirs = [];
/** @type {Array<{close: () => void}>} */
const openStores = [];
/** @type {Array<import('node:http').Server>} */
const stubServers = [];
/** @type {Set<number>} */
const spawnedPids = new Set();

after(async () => {
    for (const s of openStores) {
        try { s.close(); } catch { /* best-effort */ }
    }
    for (const srv of stubServers) {
        await new Promise((resolve) => srv.close(() => resolve()));
    }
    for (const pid of spawnedPids) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    for (const dir of tmpDirs) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
});

async function mkTmp(prefix) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
}

function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
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

/**
 * A minimal stub apra-fleet server exposing exactly the two routes
 * register()/unregister() call: POST /api/workflow-packages/register and
 * DELETE /api/workflow-packages/:id. `behavior` is mutated by each test to
 * control how the NEXT register attempt answers.
 */
async function startStubServer() {
    const state = {
        registerCalls: [],
        deleteCalls: [],
        /** @type {(attempt: number) => { status: number, body?: unknown }} */
        registerBehavior: () => ({ status: 200, body: { ok: true } }),
        hangOnDelete: false,
    };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            if (req.method === 'POST' && req.url === '/api/workflow-packages/register') {
                let body = null;
                try { body = raw.length ? JSON.parse(raw) : null; } catch { body = null; }
                state.registerCalls.push({ headers: req.headers, body });
                const { status, body: respBody } = state.registerBehavior(state.registerCalls.length);
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(respBody ?? {}));
                return;
            }
            if (req.method === 'DELETE' && req.url.startsWith('/api/workflow-packages/')) {
                state.deleteCalls.push({ headers: req.headers, url: req.url });
                if (state.hangOnDelete) return; // never respond -- proves unregister() is bounded
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
    return { server, state, serverUrl: `http://127.0.0.1:${port}` };
}

/** Mock req/res driving supervisor.handleRequest directly (mirrors
 *  test/projects-routes.test.mjs's own helper of the same name). */
function mockReq(method, url, { headers = {}, body } = {}) {
    const chunks = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
    return {
        method,
        url,
        headers,
        on(event, cb) {
            if (event === 'data') { for (const c of chunks) cb(c); }
            if (event === 'end') { cb(); }
            return this;
        },
    };
}
function mockRes() {
    return {
        statusCode: undefined,
        body: undefined,
        headersSent: false,
        writeHead(status) { this.statusCode = status; this.headersSent = true; },
        end(body) { this.body = body; },
    };
}
const payloadOf = (res) => (res.body ? JSON.parse(res.body) : null);

// -----------------------------------------------------------------------------
// 1. buildManifest shape
// -----------------------------------------------------------------------------

describe('buildManifest', () => {
    test('manifest shape: id, health, nav (incl. scope "project"), panels, ownerRefs, holds, version, apraFleetApi', async () => {
        const manifest = buildManifest({ baseUrl: 'http://127.0.0.1:8787' });
        assert.equal(manifest.id, 'se');
        assert.equal(manifest.id, PACKAGE_ID);
        assert.equal(manifest.baseUrl, 'http://127.0.0.1:8787');
        assert.equal(manifest.health, '/api/health');
        assert.equal(manifest.ownerRefs, '/api/owner-refs');
        assert.equal(manifest.holds, '/api/members/:id/holds');
        assert.ok(manifest.holds.includes(':id'), 'holds path must carry the :id placeholder');

        assert.ok(Array.isArray(manifest.nav) && manifest.nav.length > 0);
        for (const entry of manifest.nav) {
            assert.equal(typeof entry.label, 'string');
            assert.ok(entry.label.length > 0);
            assert.ok(entry.path.startsWith('/'));
        }
        assert.ok(manifest.nav.some((e) => e.scope === 'project'), 'expected at least one scope:"project" nav entry');
        assert.ok(manifest.nav.some((e) => e.scope === undefined), 'expected at least one global (no scope) nav entry');

        assert.ok(Array.isArray(manifest.panels) && manifest.panels.length > 0);
        for (const entry of manifest.panels) {
            assert.equal(typeof entry.slot, 'string');
            assert.ok(entry.path.startsWith('/'));
        }

        const pkg = JSON.parse(await fsp.readFile(PACKAGE_JSON, 'utf-8'));
        assert.equal(manifest.version, pkg.version);

        assert.equal(manifest.apraFleetApi, APRA_FLEET_API_RANGE);
    });

    // Minimal reimplementation of src/services/workflow-packages.ts's
    // satisfiesVersionRange() comparator semantics (deliberately NOT importing
    // that TS module cross-package): tokens are space-separated and AND-ed,
    // each token is an optional comparator (^, ~, >=, <=, >, <, =; no
    // comparator means exact equality) followed by MAJOR.MINOR.PATCH. Caret
    // and tilde compute the same upper-bound rules as the real matcher. This
    // mirrors the general syntax (not just caret), so it stays correct across
    // any AND-ed comparator range the declared APRA_FLEET_API_RANGE takes,
    // not only a caret shape.
    function localSatisfiesVersionRange(version, range) {
        const parse = (raw) => {
            const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
            assert.ok(m, `expected MAJOR.MINOR.PATCH, got "${raw}"`);
            return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
        };
        const cmp = (a, b) => (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
        const caretUpper = (v) => v.major > 0 ? { major: v.major + 1, minor: 0, patch: 0 }
            : v.minor > 0 ? { major: 0, minor: v.minor + 1, patch: 0 }
            : { major: 0, minor: 0, patch: v.patch + 1 };
        const tildeUpper = (v) => ({ major: v.major, minor: v.minor + 1, patch: 0 });
        const v = parse(version);
        const tokens = range.trim().split(/\s+/).filter(Boolean);
        assert.ok(tokens.length > 0, `expected a non-empty range, got "${range}"`);
        for (const token of tokens) {
            const m = /^(\^|~|>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(token);
            assert.ok(m, `expected a supported comparator token, got "${token}" (in "${range}")`);
            const bound = parse(m[2]);
            const op = m[1];
            let ok;
            switch (op) {
                case '^': ok = cmp(v, bound) >= 0 && cmp(v, caretUpper(bound)) < 0; break;
                case '~': ok = cmp(v, bound) >= 0 && cmp(v, tildeUpper(bound)) < 0; break;
                case '>=': ok = cmp(v, bound) >= 0; break;
                case '<=': ok = cmp(v, bound) <= 0; break;
                case '>': ok = cmp(v, bound) > 0; break;
                case '<': ok = cmp(v, bound) < 0; break;
                case '=':
                case undefined:
                    ok = cmp(v, bound) === 0;
                    break;
                default:
                    ok = false;
            }
            if (!ok) return false;
        }
        return true;
    }

    test('APRA_FLEET_API_RANGE is satisfied by the repo version.json version', async () => {
        const rootVersion = JSON.parse(await fsp.readFile(ROOT_VERSION_JSON, 'utf-8'));
        const version = rootVersion.version;
        assert.match(version, /^\d+\.\d+\.\d+$/, `expected bare semver in version.json, got "${version}"`);

        assert.ok(localSatisfiesVersionRange(version, APRA_FLEET_API_RANGE),
            `expected repo version ${version} to satisfy ${APRA_FLEET_API_RANGE}`);
    });

    test('APRA_FLEET_API_RANGE also admits 0.5.0 ahead of the server version bump', () => {
        // apra-fleet-g6ap.10: the moment version.json goes to 0.5.0, the
        // supervisor's registration POST must not start getting 409 from
        // POST /api/workflow-packages/register. Falsifiable: reverting
        // APRA_FLEET_API_RANGE to '^0.4.0' makes this fail, since a caret
        // range on 0.4.0 only covers [0.4.0, 0.5.0).
        assert.ok(localSatisfiesVersionRange('0.5.0', APRA_FLEET_API_RANGE),
            `expected APRA_FLEET_API_RANGE "${APRA_FLEET_API_RANGE}" to admit the upcoming server version 0.5.0`);
    });

    test('buildManifest requires a non-empty baseUrl', () => {
        assert.throws(() => buildManifest({}), TypeError);
        assert.throws(() => buildManifest({ baseUrl: '' }), TypeError);
    });
});

// -----------------------------------------------------------------------------
// 2-5. register() / unregister() against a local stub server
// -----------------------------------------------------------------------------

describe('createRegistration', () => {
    test('register() POSTs the manifest with Authorization Bearer <token>', async () => {
        const { state, serverUrl } = await startStubServer();
        const token = 'a'.repeat(64);
        const manifest = buildManifest({ baseUrl: 'http://127.0.0.1:9' });
        const reg = createRegistration({
            serverUrl, token, manifest, logger: { log() {}, warn() {}, error() {} },
        });
        await reg.register();
        assert.equal(state.registerCalls.length, 1);
        assert.equal(state.registerCalls[0].headers.authorization, `Bearer ${token}`);
        assert.deepEqual(state.registerCalls[0].body, manifest);
    });

    test('stub down for the first N attempts -> register retries with backoff then succeeds', async () => {
        const { state, serverUrl } = await startStubServer();
        state.registerBehavior = (attempt) => (attempt < 3 ? { status: 503, body: { error: 'unavailable' } } : { status: 200, body: { ok: true } });
        const sleeps = [];
        const reg = createRegistration({
            serverUrl,
            token: 'b'.repeat(64),
            manifest: buildManifest({ baseUrl: 'http://127.0.0.1:9' }),
            sleepImpl: async (ms) => { sleeps.push(ms); }, // injected -- no real waiting
            logger: { log() {}, warn() {}, error() {} },
        });
        await reg.register();
        assert.equal(state.registerCalls.length, 3, 'expected exactly 2 failures then a success');
        assert.equal(sleeps.length, 2, 'expected one sleep per failed attempt');
        assert.ok(sleeps[1] >= sleeps[0], 'expected the backoff delay to grow (or stay capped), not shrink');
    });

    test('stub answers 409 -> no retry, error text logged', async () => {
        const { state, serverUrl } = await startStubServer();
        state.registerBehavior = () => ({ status: 409, body: { error: 'apraFleetApi range not satisfied by this server' } });
        const errors = [];
        const reg = createRegistration({
            serverUrl,
            token: 'c'.repeat(64),
            manifest: buildManifest({ baseUrl: 'http://127.0.0.1:9' }),
            sleepImpl: async () => { throw new Error('must not sleep/retry on a 409'); },
            logger: { log() {}, warn() {}, error: (...a) => errors.push(a.join(' ')) },
        });
        await reg.register();
        assert.equal(state.registerCalls.length, 1, 'a 409 must not be retried');
        assert.ok(errors.some((line) => line.includes('409') && line.includes('apraFleetApi range not satisfied')),
            `expected the server's error text to be logged, got: ${JSON.stringify(errors)}`);
    });

    test('unregister() sends DELETE /api/workflow-packages/se and is bounded when the stub hangs', async () => {
        const { state, serverUrl } = await startStubServer();
        state.hangOnDelete = true;
        const reg = createRegistration({
            serverUrl,
            token: 'd'.repeat(64),
            manifest: { id: 'se' },
            logger: { log() {}, warn() {}, error() {} },
        });
        const started = Date.now();
        await reg.unregister();
        const elapsed = Date.now() - started;
        assert.ok(elapsed < UNREGISTER_TIMEOUT_MS + 2000,
            `unregister() must be bounded by ~UNREGISTER_TIMEOUT_MS (${UNREGISTER_TIMEOUT_MS}ms), took ${elapsed}ms`);
        assert.equal(state.deleteCalls.length, 1);
        assert.equal(state.deleteCalls[0].url, '/api/workflow-packages/se');
    });

    test('unregister() also stops an in-flight register() retry loop', async () => {
        const { state, serverUrl } = await startStubServer();
        state.registerBehavior = () => ({ status: 503, body: { error: 'unavailable' } });
        let sleepCount = 0;
        const reg = createRegistration({
            serverUrl,
            token: 'e'.repeat(64),
            manifest: buildManifest({ baseUrl: 'http://127.0.0.1:9' }),
            backoff: { initialMs: 5, maxMs: 20, factor: 2 },
            sleepImpl: async (ms) => { sleepCount += 1; await sleep(ms); },
            logger: { log() {}, warn() {}, error() {} },
        });
        const registerPromise = reg.register();
        await sleep(20); // let a couple of retries happen
        await reg.unregister();
        await registerPromise;
        const callsAtStop = state.registerCalls.length;
        await sleep(50);
        assert.equal(state.registerCalls.length, callsAtStop, 'register() must stop retrying once unregister() is called');
        void sleepCount;
    });
});

// -----------------------------------------------------------------------------
// 7. supervisor guard: raw token AND the derived 'se' credential
// -----------------------------------------------------------------------------

describe('supervisor guard accepts the derived credential', () => {
    test('GET /api/health: raw token -> 200; derived("se") -> 200; derived("other") -> 401', async () => {
        const token = 'f'.repeat(64);
        const supervisor = createSupervisor({ token });

        const rawRes = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/health', { headers: { authorization: `Bearer ${token}` } }), rawRes);
        assert.equal(rawRes.statusCode, 200);

        const derivedSe = deriveUpstreamCredential(token, PACKAGE_ID);
        const seRes = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/health', { headers: { authorization: `Bearer ${derivedSe}` } }), seRes);
        assert.equal(seRes.statusCode, 200);

        const derivedOther = deriveUpstreamCredential(token, 'not-se');
        const otherRes = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/health', { headers: { authorization: `Bearer ${derivedOther}` } }), otherRes);
        assert.equal(otherRes.statusCode, 401);

        const noAuthRes = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/health', {}), noAuthRes);
        assert.equal(noAuthRes.statusCode, 401);
    });
});

// -----------------------------------------------------------------------------
// 8. GET /api/members/:id/holds
// -----------------------------------------------------------------------------

describe('registerHoldsRoute', () => {
    test('held with a reservation reason when the ledger holds the member; not held otherwise', async () => {
        const supervisor = createSupervisor({});
        const ledger = { list: () => [{ sprintId: 'sprint-1', members: ['alice', 'bob'] }] };
        registerHoldsRoute(supervisor, { ledger });

        const heldRes = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/members/alice/holds', {}), heldRes);
        assert.equal(heldRes.statusCode, 200);
        assert.deepEqual(payloadOf(heldRes), { held: true, reasons: [{ kind: 'reservation', sprintId: 'sprint-1' }] });

        const notHeldRes = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/members/carol/holds', {}), notHeldRes);
        assert.equal(notHeldRes.statusCode, 200);
        assert.deepEqual(payloadOf(notHeldRes), { held: false, reasons: [] });
    });
});

// -----------------------------------------------------------------------------
// 9. GET /api/owner-refs
// -----------------------------------------------------------------------------

describe('registerOwnerRefsRoute', () => {
    test('lists created projects', { skip: sqliteSkip }, async () => {
        const dir = await mkTmp('se-ownerrefs-');
        const store = openStore({ dataDir: dir });
        openStores.push(store);
        createProject(store.db, {
            id: 'proj1', name: 'Project One', backlogMember: 'akhil', beads: { dir: '/tmp/proj1' },
        });
        createProject(store.db, {
            id: 'proj2', name: 'Project Two', backlogMember: 'akhil', beads: { dir: '/tmp/proj2' },
        });

        const supervisor = createSupervisor({});
        registerOwnerRefsRoute(supervisor, { store });
        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/owner-refs', {}), res);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(payloadOf(res), { refs: [{ id: 'proj1', name: 'Project One' }, { id: 'proj2', name: 'Project Two' }] });
    });

    test('503 store-unavailable when no store is passed', async () => {
        const supervisor = createSupervisor({});
        registerOwnerRefsRoute(supervisor, {});
        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/owner-refs', {}), res);
        assert.equal(res.statusCode, 503);
        assert.deepEqual(payloadOf(res), { error: 'store-unavailable' });
    });
});

// -----------------------------------------------------------------------------
// 6. registration skipped (no fleet.key / no server URL); supervisor still
// starts -- driven through the real bin/serve.mjs subprocess (the one case
// that genuinely needs it: both properties belong to serveMain() itself).
// -----------------------------------------------------------------------------

/** Allocate a freshly free port and boot `bin/serve.mjs` as a real
 *  subprocess with a given env, capturing its stdout. */
async function bootServe(extraEnv) {
    const dataDir = await mkTmp('g6ap23-serve-data-');
    const seDataDir = await mkTmp('g6ap23-serve-se-');
    const homeDir = await mkTmp('g6ap23-home-');
    const port = await getFreePort();

    // console.warn/error write to stderr (installSelfLogTee only tees them
    // into a log FILE, not stdout -- see self-log.mjs), so both streams must
    // be captured to see the registration skip warning, which is logged via
    // console.warn.
    let stdout = '';
    const child = spawn(process.execPath, [SERVE_BIN, '--port', String(port)], {
        cwd: SE_PKG_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            APRA_FLEET_DATA_DIR: dataDir,
            FLEET_SE_DATA_DIR: seDataDir,
            HOME: homeDir,
            USERPROFILE: homeDir,
            ...extraEnv,
        },
    });
    if (Number.isInteger(child.pid) && child.pid > 0) spawnedPids.add(child.pid);
    child.stdout.on('data', (c) => { stdout += c.toString('utf-8'); });
    child.stderr.on('data', (c) => { stdout += c.toString('utf-8'); });
    let exited = false;
    child.on('exit', () => { exited = true; });

    const deadline = Date.now() + scaledTimeout(15000, { concurrency: TEST_CONCURRENCY, multiplier: 6 });
    for (;;) {
        if (exited) throw new Error(`serve subprocess exited before starting; stdout so far:\n${stdout}`);
        const healthy = await new Promise((resolve) => {
            const req = http.request({ host: '127.0.0.1', port, path: '/api/health', method: 'GET', timeout: 2000 }, (res) => {
                res.resume();
                resolve(res.statusCode === 200 || res.statusCode === 401);
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.end();
        });
        if (healthy) break;
        if (Date.now() > deadline) throw new Error(`timed out waiting for serve subprocess to answer /api/health; stdout so far:\n${stdout}`);
        // eslint-disable-next-line no-await-in-loop
        await sleep(100);
    }

    return {
        port,
        homeDir,
        getStdout: () => stdout,
        stop: async () => {
            try {
                await new Promise((resolve) => {
                    const req = http.request({ host: '127.0.0.1', port, path: '/api/shutdown', method: 'POST', timeout: 2000 }, (res) => { res.resume(); resolve(); });
                    req.on('error', () => resolve());
                    req.on('timeout', () => { req.destroy(); resolve(); });
                    req.end();
                });
            } finally {
                if (Number.isInteger(child.pid)) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ } }
            }
        },
    };
}

describe('registration skip paths (real bin/serve.mjs subprocess)', () => {
    test('no fleet.key (private-token source) -> registration skipped with a log line, supervisor still starts', async () => {
        const serve = await bootServe({});
        try {
            const stdout = serve.getStdout();
            assert.ok(stdout.includes('[registration] WARNING'), `expected a loud registration skip warning, got:\n${stdout}`);
            assert.ok(stdout.toLowerCase().includes('fleet.key'), `expected the warning to name the missing fleet.key, got:\n${stdout}`);
        } finally {
            await serve.stop();
        }
    });

    test('no apra-fleet HTTP server URL configured -> registration skipped with a log line, supervisor still starts', async () => {
        const homeDir = await mkTmp('g6ap23-home-fleetkey-');
        await fsp.mkdir(path.join(homeDir, '.apra-fleet'), { recursive: true });
        await fsp.writeFile(path.join(homeDir, '.apra-fleet', 'fleet.key'), crypto.randomBytes(32).toString('hex'), 'utf-8');

        const serve = await bootServe({ HOME: homeDir, USERPROFILE: homeDir, APRA_FLEET_TRANSPORT: 'stdio' });
        try {
            const stdout = serve.getStdout();
            assert.ok(stdout.includes('[registration] WARNING'), `expected a loud registration skip warning, got:\n${stdout}`);
            assert.ok(stdout.toLowerCase().includes('http server url'), `expected the warning to name the missing HTTP server URL, got:\n${stdout}`);
        } finally {
            await serve.stop();
        }
    });
});
