import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';
import { createBeadsFixture, envWithoutBeadsDir } from './helpers/beads-fixture.mjs';

// POST /api/shutdown must always end with the supervisor PROCESS exiting
// (code 0), even when one seam's stop() never settles: server.mjs bounds each
// seam stop, and bin/serve.mjs arms a forced exit. Uses child 'exit' events
// only (no POSIX-only ps / kill -0), so it runs on Windows and POSIX.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVE_BIN = path.join(__dirname, '../bin/serve.mjs');
const SE_PKG_ROOT = path.join(__dirname, '..');

const children = new Set();
const tmpDirs = new Set();
const cleanups = [];

after(async () => {
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    for (const fn of cleanups.splice(0)) await fn();
    for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
});

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    });
}

function request(port, urlPath, method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, timeout: scaledTimeout(5000, { concurrency: TEST_CONCURRENCY }) }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('timeout', () => req.destroy(new Error('request timeout')));
        req.on('error', reject);
        req.end();
    });
}

async function bootSupervisor(extraEnv = {}) {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aqkk-data-'));
    const seDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aqkk-se-'));
    tmpDirs.add(dataDir); tmpDirs.add(seDataDir);
    const port = await getFreePort();
    const fixture = await createBeadsFixture();
    cleanups.push(fixture.cleanup);
    let out = '';
    const child = spawn(process.execPath, [SERVE_BIN, '--port', String(port), '--beads-dir', fixture.dir], {
        cwd: SE_PKG_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: envWithoutBeadsDir({ APRA_FLEET_DATA_DIR: dataDir, FLEET_SE_DATA_DIR: seDataDir, ...extraEnv }),
        windowsHide: true,
    });
    children.add(child);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, at: Date.now() })));
    const deadline = Date.now() + scaledTimeout(15000, { concurrency: TEST_CONCURRENCY, multiplier: 6 });
    for (;;) {
        try { if ((await request(port, '/api/health')).status === 200) break; } catch { /* not up yet */ }
        if (Date.now() > deadline) throw new Error(`supervisor did not come up; output:\n${out}`);
        await sleep(100);
    }
    return { child, port, exited, output: () => out };
}

describe('supervisor process exit after POST /api/shutdown', () => {
    test('clean case: exits 0 within 10s of the response and frees the port', async () => {
        const sup = await bootSupervisor();
        const res = await request(sup.port, '/api/shutdown', 'POST');
        assert.equal(res.status, 200);
        const respondedAt = Date.now();
        const ex = await Promise.race([sup.exited, sleep(10_000).then(() => null)]);
        assert.ok(ex, `process did not exit within 10s; output:\n${sup.output()}`);
        assert.equal(ex.code, 0, sup.output());
        assert.ok(ex.at - respondedAt <= 10_000);
        await assert.rejects(request(sup.port, '/api/health'), 'port should be closed after exit');
        assert.match(sup.output(), /\[supervisor\] exiting \(code 0\)/);
    });

    test('hung seam: still exits within the forced-exit bound and the log names the seam', async () => {
        const sup = await bootSupervisor({
            FLEET_SE_TEST_HANG_SEAM: 'dashboard',
            FLEET_SE_SHUTDOWN_SEAM_TIMEOUT_MS: '500',
            FLEET_SE_SHUTDOWN_FORCE_EXIT_MS: '3000',
        });
        await request(sup.port, '/api/shutdown', 'POST');
        const ex = await Promise.race([sup.exited, sleep(10_000).then(() => null)]);
        assert.ok(ex, `process did not exit within 10s with a hung seam; output:\n${sup.output()}`);
        assert.equal(ex.code, 0, sup.output());
        assert.match(sup.output(), /dashboard did not stop within 500ms \(hung\)/);
    });
});
