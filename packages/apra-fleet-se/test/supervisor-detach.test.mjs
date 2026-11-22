// serve.mjs --detach: returns only after /api/health answers with the CHILD's
// pid, the child outlives the launcher, and a port taken by someone else is a
// loud non-zero failure.
//
// Isolation: throwaway beads dir, temp FLEET_SE_DATA_DIR + APRA_FLEET_DATA_DIR,
// ephemeral port. Teardown stops only pids this test started (the detached
// child pid is parsed from the launcher's own output).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';
import { createBeadsFixture, envWithoutBeadsDir } from './helpers/beads-fixture.mjs';
import { stripDetachArgs } from '../src/supervisor/detach.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVE_BIN = path.join(__dirname, '../bin/serve.mjs');
const SE_PKG_ROOT = path.join(__dirname, '..');

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

function health(port) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2000 }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

test('stripDetachArgs removes only the --detach flag', () => {
    assert.deepEqual(stripDetachArgs(['--port', '1', '--detach', '--beads-dir', 'x']), ['--port', '1', '--beads-dir', 'x']);
});

test('--detach returns after /api/health answers with the child pid, and the child outlives the launcher', async () => {
    const seData = await mkTmp('detach-se-');
    const fleetData = await mkTmp('detach-fleet-');
    const port = await getFreePort();
    const fx = await createBeadsFixture();
    cleanups.push(fx.cleanup);

    const r = spawnSync(process.execPath, [SERVE_BIN, '--detach', '--port', String(port), '--beads-dir', fx.dir], {
        cwd: SE_PKG_ROOT,
        env: envWithoutBeadsDir({ FLEET_SE_DATA_DIR: seData, APRA_FLEET_DATA_DIR: fleetData, FLEET_SE_DETACH_TIMEOUT_MS: String(scaledTimeout(60000, { concurrency: TEST_CONCURRENCY })) }),
        encoding: 'utf8',
        windowsHide: true,
        timeout: scaledTimeout(90000, { concurrency: TEST_CONCURRENCY }),
    });
    const m = /pid (\d+), port (\d+)/.exec(r.stdout || '');
    if (m) startedPids.add(Number(m[1]));
    assert.equal(r.status, 0, `launcher exit: ${r.stdout}\n${r.stderr}`);
    assert.ok(m, `launcher must print pid/port: ${r.stdout}`);
    const childPid = Number(m[1]);
    assert.equal(Number(m[2]), port);

    // The launcher has exited (spawnSync returned); the child must still serve and be alive.
    assert.ok(alive(childPid), 'child is alive after the launcher exited');
    await sleep(500);
    const h = await health(port);
    assert.ok(h, 'health answers after the launcher exited');
    assert.equal(h.pid, childPid, 'health reports the child pid');
    assert.ok(fs.existsSync(path.join(seData, 'logs', 'supervisor-launch.log')), 'launch log is in the data dir');

    // Teardown: stop only the child we started.
    process.kill(childPid, 'SIGKILL');
    startedPids.delete(childPid);
});

test('--detach with the port taken by another process exits non-zero naming the reason and leaves no child', async () => {
    const seData = await mkTmp('detach-se-');
    const fleetData = await mkTmp('detach-fleet-');
    const fx = await createBeadsFixture();
    cleanups.push(fx.cleanup);

    // A stand-in "other supervisor" answering /api/health with a different pid.
    const other = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', pid: process.pid + 1000000, seams: {} }));
    });
    await new Promise((resolve) => { other.listen(0, '127.0.0.1', resolve); });
    const port = other.address().port;
    try {
        // Async spawn: the stand-in server lives in THIS process, whose event
        // loop a spawnSync would block.
        const launcher = spawn(process.execPath, [SERVE_BIN, '--detach', '--port', String(port), '--beads-dir', fx.dir], {
            cwd: SE_PKG_ROOT,
            env: envWithoutBeadsDir({ FLEET_SE_DATA_DIR: seData, APRA_FLEET_DATA_DIR: fleetData, FLEET_SE_DETACH_TIMEOUT_MS: String(scaledTimeout(30000, { concurrency: TEST_CONCURRENCY })) }),
            windowsHide: true,
        });
        const r = await new Promise((resolve) => {
            let stdout = '';
            let stderr = '';
            launcher.stdout.on('data', (c) => { stdout += c; });
            launcher.stderr.on('data', (c) => { stderr += c; });
            launcher.on('close', (status) => resolve({ status, stdout, stderr }));
        });
        assert.notEqual(r.status, 0, 'non-zero exit');
        assert.match(r.stderr, /already served by a different process/);
        assert.match(r.stderr, /supervisor-launch\.log/);
        assert.doesNotMatch(r.stdout || '', /supervisor started/);
    } finally {
        await new Promise((resolve) => { other.close(resolve); });
    }
});
