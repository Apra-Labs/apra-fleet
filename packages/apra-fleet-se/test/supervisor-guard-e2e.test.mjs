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
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';

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
//
// CONTENTION HARDENING (apra-fleet-ky2l.18.1): the windows-latest CI leg
// failed this file with a bare 'request timeout' after the child HAD logged
// its listening line -- one HTTP request against 127.0.0.1 got no response
// inside a FIXED 5 s budget while ubuntu/macos passed the same file. That is
// the documented contention class serve-wiring-integration.test.mjs already
// handles (apra-fleet-ryk / apra-fleet-33c.1): under --test-concurrency the
// first accept on a slow hosted runner can exceed a fixed budget. So every
// per-request / TCP-connect timeout here is scaledTimeout()-derived, the boot
// deadline is concurrency-scaled, the FIRST loopback probe (which only needs
// ANY HTTP status back) retries until a scaled deadline, and every timeout
// names its request (method, path, elapsed ms) with the child's stdout/stderr
// so far attached to any request-phase failure. No assertion is loosened and
// nothing is skipped on win32 -- the guarded supervisor is not POSIX-only.
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

// Per-request budget. Plain `npm test` invokes `node --test` without
// exporting APRA_FLEET_TEST_CONCURRENCY (only scripts/run-tests.mjs does),
// so pass the package's concurrency constant explicitly -- otherwise
// scaledTimeout() silently falls back to its unscaled baseMs while the file
// genuinely runs TEST_CONCURRENCY-wide (the apra-fleet-ryk lesson).
const REQUEST_TIMEOUT_MS = scaledTimeout(5000, { concurrency: TEST_CONCURRENCY });
const CONNECT_TIMEOUT_MS = scaledTimeout(5000, { concurrency: TEST_CONCURRENCY });
const BOOT_DEADLINE_MS = scaledTimeout(20000, { concurrency: TEST_CONCURRENCY, multiplier: 6 });
const FIRST_PROBE_DEADLINE_MS = scaledTimeout(15000, { concurrency: TEST_CONCURRENCY, multiplier: 6 });

// apra-fleet-v6t7.7: GET / renders the full dashboard -- unlike the
// /api/* JSON endpoints exercised above, which only touch in-memory
// state, this route can read/parse the local beads database, so on a
// cold cache it can plausibly take longer than the generic
// REQUEST_TIMEOUT_MS. Named and independently env-overridable (rather
// than folded into REQUEST_TIMEOUT_MS) so a slow machine or CI leg can
// raise just this budget without loosening the timing on every other
// assertion in this file. Default equals REQUEST_TIMEOUT_MS itself
// (5000ms base x 3x contention headroom = 15000ms @ TEST_CONCURRENCY=4)
// -- that value has not actually been shown insufficient: a standalone
// re-run of this exact lane under identical contention passed clean
// (pass=4224, fail=0), and the one observed timeout coincided with a
// concurrent `npm run build` and server probes loading the same machine.
// 15s is kept as the documented default rather than raised blind; the
// env override exists for a genuinely slower environment to prove its
// own number instead of everyone inheriting a bigger guess.
const GET_ROOT_TIMEOUT_MS = (() => {
    const override = Number(process.env.APRA_TEST_GUARD_BUDGET_MS);
    return Number.isFinite(override) && override > 0 ? override : REQUEST_TIMEOUT_MS;
})();

const LISTENING_LOG_RE = /listening on http:\/\/localhost:\d+/;

/**
 * Wrap a request-phase error with a diagnostic that distinguishes "the
 * supervisor process never logged its listening line" (server never bound)
 * from "the process bound and logged it, but this particular request never
 * answered" (server bound but the route did not answer) -- using the
 * already-captured serve.mjs stdout -- and appends the captured
 * stdout/stderr tail so a CI log is actionable without a re-run. Exercised
 * directly (see the "timeout diagnostic" test below) against a deliberately
 * unbound port so the message text is proven, not assumed.
 */
function describeRequestFailure(err, { stdoutBuf, stderrBuf }) {
    const bindState = LISTENING_LOG_RE.test(stdoutBuf)
        ? 'server bound but the route did not answer'
        : 'server never bound';
    const context = `${bindState}\n--- serve.mjs stdout so far ---\n${stdoutBuf}\n--- serve.mjs stderr so far ---\n${stderrBuf}`;
    if (err instanceof Error) {
        err.message = `${err.message}\n${context}`;
        return err;
    }
    return new Error(`${String(err)}\n${context}`);
}

/** Tiny promise-based HTTP client. A timeout rejects with an error that
 *  names the request (method, path, elapsed ms) so a CI log is actionable. */
function request(port, method, urlPath, { headers, host = '127.0.0.1', timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const req = http.request({ host, port, method, path: urlPath, headers: headers ?? {}, timeout: timeoutMs }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
        });
        req.on('timeout', () => {
            req.destroy(new Error(`request timeout after ${Date.now() - startedAt} ms (budget ${timeoutMs} ms): ${method} ${urlPath}`));
        });
        req.on('error', (err) => {
            reject(new Error(`${method} ${urlPath} failed after ${Date.now() - startedAt} ms: ${err?.message ?? err}`, { cause: err }));
        });
        req.end();
    });
}

/**
 * Retry `request()` until ANY HTTP status arrives or the deadline passes.
 * Only used for the very first loopback probe, which asserts nothing about
 * the status -- it exists to prove the listener is reachable at all, so a
 * slow first accept on a contended runner must not fail the suite. Every
 * later request keeps its single-shot budget and exact assertion.
 */
async function requestWithRetry(port, method, urlPath, { deadlineMs, isAlive, label }) {
    const deadline = Date.now() + deadlineMs;
    const errors = [];
    for (;;) {
        if (isAlive && !isAlive()) {
            throw new Error(`${label}: serve.mjs exited before answering.\nattempts:\n${errors.join('\n')}`);
        }
        try {
            // eslint-disable-next-line no-await-in-loop
            return await request(port, method, urlPath);
        } catch (err) {
            errors.push(String(err?.message ?? err));
        }
        if (Date.now() > deadline) {
            throw new Error(`${label}: no HTTP status within ${deadlineMs} ms (${errors.length} attempt(s)).\nattempts:\n${errors.join('\n')}`);
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(100);
    }
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
        const socket = net.createConnection({ host, port, timeout: CONNECT_TIMEOUT_MS });
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
            const deadline = Date.now() + BOOT_DEADLINE_MS;
            for (;;) {
                if (exited) {
                    assert.fail(`serve.mjs exited (code=${serve.exitCode}, signal=${serve.signalCode}) before listening.\nstdout:\n${stdoutBuf}\nstderr:\n${stderrBuf}`);
                }
                if (/listening on http:\/\/localhost:\d+/.test(stdoutBuf)) break;
                if (Date.now() > deadline) {
                    assert.fail(`timed out after ${BOOT_DEADLINE_MS} ms waiting for the supervisor to log its listening line.\nstdout so far:\n${stdoutBuf}\nstderr so far:\n${stderrBuf}`);
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
            // First loopback probe: retried until ANY status arrives (see
            // requestWithRetry) -- the listening line proves bind, not that a
            // contended runner has accepted its first connection yet.
            const loopbackOk = await requestWithRetry(port, 'GET', '/api/health', {
                deadlineMs: FIRST_PROBE_DEADLINE_MS,
                isAlive: () => !exited,
                label: 'first loopback GET /api/health',
            });
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
            const root = await request(port, 'GET', '/', { timeoutMs: GET_ROOT_TIMEOUT_MS });
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
        } catch (err) {
            // Any request-phase failure carries the child's output so far,
            // plus the "server never bound" vs "server bound but the route
            // did not answer" bind-state diagnostic, so a CI log names the
            // request AND shows what the supervisor was doing (the
            // boot-deadline branch above already does this for the pre-boot
            // case).
            throw describeRequestFailure(err, { stdoutBuf, stderrBuf });
        } finally {
            // 6. Kill the child.
            forceKill(serve.pid);
        }

        // 6 (cont'd). The temp dirs are the only artifacts -- real
        // ~/.apra-fleet listing/mtimes are unchanged.
        const afterSnap = snapshotRealApraFleet();
        assert.deepEqual(afterSnap, before, 'the real ~/.apra-fleet directory must be untouched by this suite');
    });

    // apra-fleet-v6t7.7: proves describeRequestFailure()'s two messages
    // against a REAL failed request (a deliberately unbound port -- nothing
    // ever listens on it), rather than only asserting against hand-built
    // strings, so the diagnostic text is demonstrated on an actual
    // connection failure instead of merely assumed correct.
    test('timeout diagnostic distinguishes "server never bound" from "server bound but the route did not answer"', async () => {
        const port = await getFreePort(); // closed immediately after allocation; nothing listens on it
        // apra-fleet-v6t7.9: the unexpected-success assertion MUST live
        // outside this try/catch. An assert.fail() thrown inside the try
        // produces an AssertionError, which the catch below would accept
        // (it IS an Error) and stash into `caught` -- silently passing the
        // very case (the "unbound" port actually answering) this subtest
        // exists to catch. `succeeded` is asserted after the try/catch so
        // an unexpected success genuinely reds the test.
        let caught;
        let succeeded = false;
        try {
            await request(port, 'GET', '/', { timeoutMs: 1000 });
            succeeded = true;
        } catch (err) {
            caught = err;
        }
        assert.equal(succeeded, false, 'expected the request against an unbound port to fail');
        assert.ok(caught instanceof Error, 'the request against an unbound port must reject with an Error');

        // describeRequestFailure() mutates err.message in place (matching
        // how it is actually used against the single shared serve.mjs
        // error in the main test above), so each invocation below gets its
        // own fresh Error built from the same real failure -- otherwise the
        // second call's diagnostic would stack onto the first's message.
        const neverBound = describeRequestFailure(new Error(caught.message), { stdoutBuf: '', stderrBuf: '' });
        assert.match(
            neverBound.message,
            /server never bound/,
            'stdout with no listening line must be diagnosed as "server never bound"',
        );
        assert.doesNotMatch(neverBound.message, /server bound but the route did not answer/);

        const boundButSilent = describeRequestFailure(new Error(caught.message), {
            stdoutBuf: `[supervisor] listening on http://localhost:${port}\n`,
            stderrBuf: '',
        });
        assert.match(
            boundButSilent.message,
            /server bound but the route did not answer/,
            'stdout containing the listening line must be diagnosed as "server bound but the route did not answer"',
        );
        assert.doesNotMatch(boundButSilent.message, /server never bound/);
    });
});
