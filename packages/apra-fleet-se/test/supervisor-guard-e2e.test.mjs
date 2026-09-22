import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { TOKEN_BYTES } from '../src/supervisor/auth.mjs';

// =============================================================================
// apra-fleet-ky2l.1.3 -- end-to-end verification of the guarded supervisor
// with the shared ~/.apra-fleet/fleet.key as its token source (DQ-20).
//
// Lane s1-supervisor, position 3 of 5. Verifies feature ky2l.1 as a WHOLE
// (the loopback-bearer merge, ky2l.1.1, plus the fleet-key token-source
// switch, ky2l.1.2) by booting the REAL bin/serve.mjs as a child process,
// not the in-process test harness -- proving the wiring an in-process
// construction could paper over (argv parsing, real env/HOME resolution,
// the real HTTP listener) actually holds together.
//
// Isolation: HOME (and USERPROFILE, for a Windows member running this same
// suite) is overridden to a fresh temp dir for the spawned child, and
// FLEET_SE_DATA_DIR/APRA_FLEET_DATA_DIR are temp dirs too -- nothing here
// ever reads or writes the real ~/.apra-fleet (asserted at the bottom).
//
// FALSIFIABILITY: this suite is only meaningful if it can fail. With the
// token-source switch reverted (auth.mjs's resolveServiceToken() reading
// only the private/token fallback, never fleet.key -- i.e. back to
// apra-fleet-ky2l.1.1's plain loadOrCreateToken() call), the "fleet.key
// bearer -> 200" assertion in case 3 below fails (the spawned supervisor
// would 401 the fleet.key value, since it never resolved that file at all).
// This was verified by hand during authoring: stashing the ky2l.1.2 change
// to auth.mjs/bin/serve.mjs and re-running this file reproduces exactly that
// failure, restored immediately after.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SE_PKG_ROOT = path.join(__dirname, '..');
const SERVE_BIN = path.join(SE_PKG_ROOT, 'bin', 'serve.mjs');
const TOKEN_HEX_LEN = TOKEN_BYTES * 2;
const VALID_FLEET_KEY = 'f'.repeat(TOKEN_HEX_LEN);
/** A well-formed but DIFFERENT token, standing in for a private/token
 *  fallback value that must NOT authorize once a fleet.key is present. */
const WRONG_FALLBACK_TOKEN = '1'.repeat(TOKEN_HEX_LEN);

const spawnedPids = new Set();
const tmpDirs = new Set();

function track(pid) {
    if (Number.isInteger(pid) && pid > 0) spawnedPids.add(pid);
    return pid;
}
function forceKill(pid) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}
after(async () => {
    for (const pid of spawnedPids) forceKill(pid);
    spawnedPids.clear();
    for (const dir of tmpDirs) {
        // eslint-disable-next-line no-await-in-loop
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.clear();
});

async function mkTmp(prefix) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpDirs.add(dir);
    return dir;
}

function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
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

/** Tiny promise-based HTTP client. */
function request(port, method, urlPath, { headers, host = '127.0.0.1' } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host, port, method, path: urlPath, headers: headers ?? {}, timeout: 5000 }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
        });
        req.on('timeout', () => { req.destroy(new Error('request timeout')); });
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

/** Snapshot of the REAL ~/.apra-fleet directory: names + mtimes. */
function snapshotRealApraFleet() {
    const dir = path.join(os.homedir(), '.apra-fleet');
    let entries;
    try {
        entries = fs.readdirSync(dir).sort();
    } catch {
        return null;
    }
    return entries.map((name) => {
        const full = path.join(dir, name);
        let mtimeMs = null;
        try { mtimeMs = fs.statSync(full).mtimeMs; } catch { /* raced away */ }
        return `${name}:${mtimeMs}`;
    });
}

describe('supervisor-guard-e2e (apra-fleet-ky2l.1.3): real bin/serve.mjs, fleet-key token source', () => {
    test('loopback-only bind, 401 guard everywhere without the fleet.key bearer, 200 with it, GET / hides the token', async () => {
        const before = snapshotRealApraFleet();

        const home = await mkTmp('supervisor-guard-e2e-home-');
        const dataDir = await mkTmp('supervisor-guard-e2e-data-');
        const seDataDir = await mkTmp('supervisor-guard-e2e-se-');
        const port = await getFreePort();

        // 1. write a 64-hex fleet.key under <tempHome>/.apra-fleet/.
        const fleetKeyDir = path.join(home, '.apra-fleet');
        await fsp.mkdir(fleetKeyDir, { recursive: true });
        await fsp.writeFile(path.join(fleetKeyDir, 'fleet.key'), VALID_FLEET_KEY, 'utf8');

        // A pre-existing private/token fallback with a DIFFERENT value, so
        // case 3 below can prove fleet.key wins over it (not just over an
        // absent fallback) -- exactly the "private/token fallback value (if
        // one was minted)" scenario the acceptance criteria names.
        const privateDir = path.join(seDataDir, 'private');
        await fsp.mkdir(privateDir, { recursive: true });
        await fsp.writeFile(path.join(privateDir, 'token'), WRONG_FALLBACK_TOKEN, { encoding: 'utf8', mode: 0o600 });

        let stdoutBuf = '';
        let stderrBuf = '';
        const serve = spawn(process.execPath, [SERVE_BIN, '--port', String(port)], {
            cwd: SE_PKG_ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                HOME: home,
                USERPROFILE: home, // Windows member running this same suite
                APRA_FLEET_DATA_DIR: dataDir,
                FLEET_SE_DATA_DIR: seDataDir,
            },
        });
        track(serve.pid);
        serve.stdout.on('data', (c) => { stdoutBuf += c.toString('utf-8'); });
        serve.stderr.on('data', (c) => { stderrBuf += c.toString('utf-8'); });
        let exited = false;
        serve.once('exit', () => { exited = true; });

        try {
            // Wait for the listening log line (server.mjs's own startup log).
            const deadline = Date.now() + 20000;
            for (;;) {
                if (exited) {
                    assert.fail(`serve.mjs exited (code=${serve.exitCode}, signal=${serve.signalCode}) before listening.\nstdout:\n${stdoutBuf}\nstderr:\n${stderrBuf}`);
                }
                if (/listening on http:\/\/localhost:\d+/.test(stdoutBuf)) break;
                if (Date.now() > deadline) {
                    assert.fail(`timed out waiting for the supervisor to log its listening line.\nstdout so far:\n${stdoutBuf}\nstderr so far:\n${stderrBuf}`);
                }
                // eslint-disable-next-line no-await-in-loop
                await sleep(100);
            }

            // 2. Bind: 127.0.0.1 only.
            const nonLoopback = firstNonInternalIPv4();
            if (nonLoopback) {
                const code = await tryConnect(nonLoopback, port);
                assert.notEqual(code, null, 'connecting via the non-loopback interface must not succeed');
                assert.ok(
                    code === 'ECONNREFUSED' || code === 'TIMEOUT',
                    `expected ECONNREFUSED (or a firewall TIMEOUT), got: ${code}`,
                );
            }
            const loopbackOk = await request(port, 'GET', '/api/health');
            assert.notEqual(loopbackOk.status, undefined, 'loopback must be reachable at all');

            // 3. Guard: every /api/* route and POST .../live/... 401s without
            // a credential, with WWW-Authenticate: Bearer; the fleet.key
            // bearer authorizes; the pre-existing private/token fallback
            // value does NOT (fleet.key is THE token when present).
            for (const p of ['/api/health', '/api/members', '/api/sprints']) {
                // eslint-disable-next-line no-await-in-loop
                const res = await request(port, 'GET', p);
                assert.equal(res.status, 401, `GET ${p} without a header must be 401`);
                assert.match(res.headers['www-authenticate'] ?? '', /Bearer/i, `GET ${p} 401 must carry WWW-Authenticate: Bearer`);
            }
            const liveStop = await request(port, 'POST', '/sprints/x/live/stop');
            assert.equal(liveStop.status, 401, 'POST /sprints/x/live/stop without header or cookie must be 401');

            const withFleetKey = await request(port, 'GET', '/api/health', { headers: { authorization: `Bearer ${VALID_FLEET_KEY}` } });
            assert.equal(withFleetKey.status, 200, 'GET /api/health with the fleet.key bearer must be 200');

            const withWrongFallback = await request(port, 'GET', '/api/health', { headers: { authorization: `Bearer ${WRONG_FALLBACK_TOKEN}` } });
            assert.equal(withWrongFallback.status, 401, 'the private/token fallback value must NOT authorize once a fleet.key is present');

            // 4. GET / -> 200, body free of the token; any Set-Cookie is HttpOnly.
            const root = await request(port, 'GET', '/');
            assert.equal(root.status, 200);
            assert.ok(!root.body.includes(VALID_FLEET_KEY), 'GET / body must never contain the fleet.key token');
            const setCookie = root.headers['set-cookie'];
            if (setCookie) {
                const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
                for (const c of cookies) assert.match(c, /HttpOnly/i, `Set-Cookie must be HttpOnly: ${c}`);
            }

            // 5. Startup log names the source, never the token value.
            assert.match(stdoutBuf, /\[supervisor\] service token source: fleet-key/, 'startup log must name the fleet-key source');
            assert.ok(!stdoutBuf.includes(VALID_FLEET_KEY), 'the token value must never appear in stdout');
            assert.ok(!stderrBuf.includes(VALID_FLEET_KEY), 'the token value must never appear in stderr');
        } finally {
            // 6. Kill the child.
            forceKill(serve.pid);
        }

        // 6 (cont'd). The temp dirs are the only artifacts -- real
        // ~/.apra-fleet listing/mtimes are unchanged.
        const afterSnap = snapshotRealApraFleet();
        assert.deepEqual(afterSnap, before, 'the real ~/.apra-fleet directory must be untouched by this suite');
    });
});
