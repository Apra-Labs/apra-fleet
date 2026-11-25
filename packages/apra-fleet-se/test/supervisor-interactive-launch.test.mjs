// An interactive supervisor launch survives its launching terminal closing.
//
// serve.mjs with neither --detach nor --foreground detaches when stdin or
// stdout is a TTY. Scenarios:
//   1. POSIX, real pseudo-terminal: `script` gives the launcher a pty; the
//      launcher exits 0 printing the detached pid, the pty is gone and the
//      launcher's process group is sent SIGHUP, yet GET /api/health still
//      answers with that pid.
//   1w. Injected seam (every host, including Windows, and the stand-in for
//      scenario 1 when no pty is available): serveMain in-process with
//      platform=win32 and TTY streams injected takes the REAL detach path; the
//      detached child answers /api/health with its own pid. A Windows console
//      close cannot be simulated portably, so this is how it is covered.
//   2. Non-TTY launch (pipes) stays in the foreground: the spawned process
//      itself answers /api/health with its own pid (no respawn).
//   3. --foreground under a pty stays in the foreground: the launcher keeps
//      running and the serving pid is its own child.
// Teardown: POST /api/shutdown (application/json, {}) stops each supervisor;
// the after() hook SIGKILLs only pids this file started, and removes its temp
// dirs. A host without a usable `script` (Windows, or none installed) skips
// scenarios 1 and 3 with a diagnostic and relies on 1w.
//
// Isolation: throwaway beads fixture via --beads-dir, temp FLEET_SE_DATA_DIR +
// APRA_FLEET_DATA_DIR, ephemeral ports.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';
import { createBeadsFixture, envWithoutBeadsDir } from './helpers/beads-fixture.mjs';
import { detachSupervisor } from '../src/supervisor/detach.mjs';
import { serveMain } from '../bin/serve.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVE_BIN = path.join(__dirname, '../bin/serve.mjs');
const SE_PKG_ROOT = path.join(__dirname, '..');
const T = (ms) => scaledTimeout(ms, { concurrency: TEST_CONCURRENCY });

const startedPids = new Set();
const tmpDirs = [];
const cleanups = [];

after(async () => {
    for (const pid of startedPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    for (const c of cleanups) await c();
    for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
});

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    });
}

async function mkTmp(prefix) {
    const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
}

function request(port, method, urlPath) {
    return new Promise((resolve) => {
        const body = method === 'POST' ? '{}' : null;
        const req = http.request({
            host: '127.0.0.1', port, path: urlPath, method, timeout: 3000,
            headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
        }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        if (body) req.write(body);
        req.end();
    });
}

const health = async (port) => { const r = await request(port, 'GET', '/api/health'); return r && r.status === 200 ? r.json : null; };

/** `promise`, or a rejection after `ms`; the timer is always cleared (never holds the process open). */
function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message())), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function waitFor(fn, { timeoutMs, label }) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const v = await fn();
        if (v) return v;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        // eslint-disable-next-line no-await-in-loop
        await sleep(150);
    }
}

/** POST /api/shutdown and wait until `pid` is gone. */
async function shutdownAndWait(port, pid) {
    const r = await request(port, 'POST', '/api/shutdown');
    assert.ok(r && r.status === 200, `POST /api/shutdown answered ${r ? r.status : 'nothing'}`);
    await waitFor(() => !alive(pid), { timeoutMs: T(20000), label: `pid ${pid} to exit after /api/shutdown` });
    startedPids.delete(pid);
}

/** argv that runs `cmd args...` under a pseudo-terminal via script(1), or null. */
function ptyArgv(cmd, args) {
    if (process.platform === 'darwin' || process.platform.endsWith('bsd')) return ['script', ['-q', '/dev/null', cmd, ...args]];
    if (process.platform === 'linux') {
        const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
        return ['script', ['-q', '-e', '-c', [cmd, ...args].map(q).join(' '), '/dev/null']];
    }
    return null;
}

let ptyProbe;
/** Whether script(1) here really gives its command a TTY on stdin and stdout. */
function ptyAvailable() {
    if (ptyProbe !== undefined) return ptyProbe;
    const a = ptyArgv(process.execPath, ['-e', 'process.stdout.write(`PTY:${Boolean(process.stdin.isTTY)}:${Boolean(process.stdout.isTTY)}`)']);
    if (!a) { ptyProbe = false; return ptyProbe; }
    const r = spawnSync(a[0], a[1], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 15000 });
    ptyProbe = r.status === 0 && /PTY:true:true/.test(r.stdout || '');
    return ptyProbe;
}

async function sandbox() {
    const seData = await mkTmp('ilaunch-se-');
    const fleetData = await mkTmp('ilaunch-fleet-');
    const fx = await createBeadsFixture();
    cleanups.push(fx.cleanup);
    const port = await getFreePort();
    const env = envWithoutBeadsDir({ FLEET_SE_DATA_DIR: seData, APRA_FLEET_DATA_DIR: fleetData, FLEET_SE_DETACH_TIMEOUT_MS: String(T(60000)) });
    return { seData, fleetData, fx, port, env };
}

function collect(child) {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const closed = new Promise((resolve) => { child.on('close', (status, signal) => resolve({ status, signal })); });
    return { closed, out: () => stdout, err: () => stderr };
}

test('1. POSIX pty: a no-flag launch detaches, and the supervisor survives the launcher terminal hanging up', async (t) => {
    if (!ptyAvailable()) { t.skip('no usable pseudo-terminal (script(1)) on this host; covered by the injected-seam scenario'); return; }
    const { fx, port, env, seData } = await sandbox();
    const [cmd, args] = ptyArgv(process.execPath, [SERVE_BIN, '--port', String(port), '--beads-dir', fx.dir]);
    // Own process group so the whole launcher group can be hung up afterwards.
    const launcher = spawn(cmd, args, { cwd: SE_PKG_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    startedPids.add(launcher.pid);
    const io = collect(launcher);
    const { status } = await withTimeout(io.closed, T(90000), () => `launcher did not exit; output: ${io.out()}`);
    const m = /pid (\d+), port (\d+)/.exec(io.out());
    startedPids.delete(launcher.pid);
    if (m) startedPids.add(Number(m[1]));
    assert.equal(status, 0, `launcher exit 0: ${io.out()}\n${io.err()}`);
    assert.match(io.out(), /interactive console detected/, 'the default (no flag) took the detach path');
    assert.ok(m, `launcher printed the detached pid: ${io.out()}`);
    const childPid = Number(m[1]);
    assert.equal(Number(m[2]), port);
    assert.notEqual(childPid, launcher.pid);

    // The terminal is gone with the launcher; hang up its whole process group too.
    try { process.kill(-launcher.pid, 'SIGHUP'); } catch (e) { assert.equal(e.code, 'ESRCH'); }
    await sleep(800);

    assert.ok(alive(childPid), 'detached supervisor is alive after its terminal hung up');
    const h = await health(port);
    assert.ok(h, '/api/health still answers');
    assert.equal(h.pid, childPid, '/api/health answers with the detached pid');
    assert.ok(fs.existsSync(path.join(seData, 'logs', 'supervisor-launch.log')), 'launch log in the sandbox data dir');

    await shutdownAndWait(port, childPid);
});

test('1w. injected seam: platform=win32 with TTY streams takes the real detach path (any host)', async () => {
    const { fx, port, env } = await sandbox();
    // serveMain runs in this process and its detached child inherits
    // process.env: point both at the sandbox for the duration of the call.
    const keys = ['FLEET_SE_DATA_DIR', 'APRA_FLEET_DATA_DIR', 'FLEET_SE_DETACH_TIMEOUT_MS', 'BEADS_DIR'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
    let result = null;
    let r;
    try {
        r = await serveMain(['--port', String(port), '--beads-dir', fx.dir], {
            installExitLog: false,
            platform: 'win32',
            stdio: { stdin: { isTTY: true }, stdout: { isTTY: true } },
            detachSupervisor: async (opts) => {
                result = await detachSupervisor({ ...opts, out: () => {} });
                if (result.pid) startedPids.add(result.pid);
                return result;
            },
        });
    } finally {
        for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
    assert.equal(r.exitCode, 0);
    assert.ok(result && Number.isInteger(result.pid), 'the real detachSupervisor ran and reported a child pid');
    assert.notEqual(result.pid, process.pid);
    const h = await health(port);
    assert.ok(h, '/api/health answers');
    assert.equal(h.pid, result.pid, 'the detached child serves');

    await shutdownAndWait(port, result.pid);
});

test('2. a non-TTY launch (pipes) stays in the foreground: the spawned process itself serves', async () => {
    const { fx, port, env } = await sandbox();
    const serve = spawn(process.execPath, [SERVE_BIN, '--port', String(port), '--beads-dir', fx.dir], {
        cwd: SE_PKG_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    startedPids.add(serve.pid);
    const io = collect(serve);
    const h = await waitFor(() => health(port), { timeoutMs: T(30000), label: 'foreground supervisor /api/health' });
    assert.equal(h.pid, serve.pid, 'no respawn: the launched process answers with its own pid');
    assert.doesNotMatch(io.out(), /interactive console detected|supervisor started: pid/);

    await shutdownAndWait(port, serve.pid);
    const { status } = await io.closed;
    assert.equal(status, 0);
});

test('3. --foreground under a pty stays in the foreground', async (t) => {
    if (!ptyAvailable()) { t.skip('no usable pseudo-terminal (script(1)) on this host; --foreground on a TTY is covered by the launch-mode unit tests'); return; }
    const { fx, port, env } = await sandbox();
    const [cmd, args] = ptyArgv(process.execPath, [SERVE_BIN, '--foreground', '--port', String(port), '--beads-dir', fx.dir]);
    const launcher = spawn(cmd, args, { cwd: SE_PKG_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    startedPids.add(launcher.pid);
    const io = collect(launcher);
    const h = await waitFor(() => health(port), { timeoutMs: T(30000), label: '--foreground supervisor /api/health' });
    startedPids.add(h.pid);
    assert.ok(alive(launcher.pid), 'the launcher keeps running: it did not hand off to a detached child');
    const ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(h.pid)], { encoding: 'utf8' }).trim());
    assert.equal(ppid, launcher.pid, 'the serving process is the pty launcher\'s own child');
    assert.doesNotMatch(io.out(), /interactive console detected|supervisor started: pid/);

    await shutdownAndWait(port, h.pid);
    await withTimeout(io.closed, T(15000), () => 'pty launcher did not exit after shutdown');
    startedPids.delete(launcher.pid);
});
