import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installExitLogging, EXIT_SIGNALS } from '../src/supervisor/exit-log.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { createBeadsFixture, envWithoutBeadsDir } from './helpers/beads-fixture.mjs';

// The supervisor writes exactly one final SYNCHRONOUS log line (cause + exit
// code) on every observable exit path. In-process tests drive a fake process
// emitter (no listener is added to the real process; exit is stubbed); the
// real-signal child tests are POSIX-only.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVE_BIN = path.join(__dirname, '../bin/serve.mjs');
const tmpDirs = [];
const cleanups = [];
after(async () => {
    for (const fn of cleanups.splice(0)) await fn();
    for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
});

function harness(extra = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-log-'));
    tmpDirs.push(dir);
    const logPath = path.join(dir, 'supervisor.log');
    const proc = new EventEmitter();
    const exits = [];
    const signals = [];
    const log = installExitLogging({
        logPath, proc,
        exit: (c) => exits.push(c),
        onSignal: (s) => signals.push(s),
        stopOnSighup: () => true,
        ...extra,
    });
    const lines = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : []);
    return { proc, log, exits, signals, lines };
}

describe('installExitLogging (in-process, stubbed exit)', () => {
    for (const sig of EXIT_SIGNALS) {
        test(`${sig}: one final line with the cause and exit code 0`, () => {
            const h = harness();
            h.proc.emit(sig);
            assert.deepEqual(h.signals, [sig]);
            h.proc.emit('exit', 0);
            assert.equal(h.lines().length, 1, h.lines().join('\n'));
            assert.match(h.lines()[0], new RegExp(`cause=signal:${sig} exit_code=0`));
            h.log.uninstall();
            assert.equal(h.proc.listenerCount('exit'), 0, 'no listeners left behind');
        });
    }

    for (const kind of ['uncaughtException', 'unhandledRejection']) {
        test(`${kind}: line has cause, exit code 1, message and a stack frame; exit(1) is called`, () => {
            const h = harness();
            const origErr = console.error;
            console.error = () => {};
            try {
                h.proc.emit(kind, new Error('kaboom-msg'));
            } finally { console.error = origErr; }
            assert.deepEqual(h.exits, [1]);
            assert.equal(h.lines().length, 1);
            const line = h.lines()[0];
            assert.match(line, new RegExp(`cause=${kind} exit_code=1`));
            assert.match(line, /kaboom-msg/);
            assert.match(line, /\bat\b.*exit-log\.test\.mjs/);
            h.proc.emit('exit', 1); // the real exit event afterwards adds nothing
            assert.equal(h.lines().length, 1);
            h.log.uninstall();
        });
    }

    test('a non-Error rejection reason is still logged', () => {
        const h = harness();
        const origErr = console.error;
        console.error = () => {};
        try { h.proc.emit('unhandledRejection', 'plain reason'); } finally { console.error = origErr; }
        assert.match(h.lines()[0], /plain reason/);
        h.log.uninstall();
    });

    test('SIGHUP on a detached launch is logged and does not stop the supervisor', () => {
        const h = harness({ stopOnSighup: () => false });
        const logged = [];
        const orig = console.log;
        console.log = (m) => logged.push(m);
        try { h.proc.emit('SIGHUP'); } finally { console.log = orig; }
        assert.deepEqual(h.signals, []);
        assert.deepEqual(h.exits, []);
        assert.equal(h.lines().length, 0);
        assert.match(logged.join('\n'), /received SIGHUP; ignored/);
        h.proc.emit('SIGTERM');
        assert.deepEqual(h.signals, ['SIGTERM'], 'a later real stop still works and keeps its own cause');
        h.log.uninstall();
    });

    test('win32 SIGHUP with non-TTY stdio writes one final line immediately and still stops', () => {
        const proc = new EventEmitter();
        proc.stdout = { isTTY: false };
        proc.stdin = { isTTY: false };
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-log-'));
        tmpDirs.push(dir);
        const logPath = path.join(dir, 'supervisor.log');
        const signals = [];
        const log = installExitLogging({ logPath, proc, platform: 'win32', exit: () => {}, onSignal: (s) => signals.push(s) });
        proc.emit('SIGHUP');
        const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
        assert.equal(lines.length, 1, lines.join('\n'));
        assert.match(lines[0], /cause=signal:SIGHUP exit_code=0/);
        assert.deepEqual(signals, ['SIGHUP']);
        proc.emit('exit', 0);
        assert.equal(fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length, 1);
        log.uninstall();
    });

    test('posix SIGHUP with non-TTY stdio (default rule) is ignored', () => {
        const proc = new EventEmitter();
        proc.stdout = { isTTY: false };
        proc.stdin = { isTTY: false };
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-log-'));
        tmpDirs.push(dir);
        const logPath = path.join(dir, 'supervisor.log');
        const signals = [];
        const log = installExitLogging({ logPath, proc, platform: 'linux', exit: () => {}, onSignal: (s) => signals.push(s) });
        const orig = console.log;
        console.log = () => {};
        try { proc.emit('SIGHUP'); } finally { console.log = orig; }
        assert.deepEqual(signals, []);
        assert.equal(fs.existsSync(logPath), false);
        log.uninstall();
    });

    test('a signal before the supervisor exists finalizes with one line and exits', () => {
        const h = harness({ canStop: () => false });
        h.proc.emit('SIGTERM');
        assert.deepEqual(h.exits, [143]);
        h.proc.emit('exit', 143);
        assert.equal(h.lines().length, 1, h.lines().join('\n'));
        assert.match(h.lines()[0], /cause=signal:SIGTERM exit_code=143/);
        h.log.uninstall();
    });

    test('exactly one line even when several exit paths fire', () => {
        const h = harness();
        h.proc.emit('SIGTERM');
        h.proc.emit('SIGHUP');
        h.proc.emit('exit', 0);
        h.proc.emit('exit', 0);
        assert.equal(h.lines().length, 1);
        h.log.uninstall();
    });
});

describe('supervisor stop paths feed the final line', () => {
    test('POST /api/shutdown: cause is the http shutdown route, exit code 0', async () => {
        const sup = createSupervisor({ port: 0, logger: { log() {}, error() {} } });
        const h = harness({ causeProvider: () => sup.exitCause });
        const { port } = await sup.start();
        await new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, path: '/api/shutdown', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', resolve); });
            req.on('error', reject);
            req.end();
        });
        await sup.shutdownRequested;
        h.proc.emit('exit', 0);
        assert.equal(h.lines().length, 1);
        assert.match(h.lines()[0], /cause=http:\/api\/shutdown exit_code=0/);
        h.log.uninstall();
    });

    test('forced-exit timeout: the line names forced-exit-timeout and the exit code', async () => {
        const holder = {};
        const sup = createSupervisor({
            port: 0, logger: { log() {}, error() {} },
            seamStopTimeoutMs: 50, forcedExitMs: 200,
            dashboard: { name: 'dashboard', start() {}, stop: () => new Promise(() => {}) },
            ledger: { name: 'ledger', start() {}, stop: () => new Promise(() => {}) },
            exit: (c) => holder.h.log.exitFn(c),
        });
        holder.h = harness({ causeProvider: () => sup.exitCause });
        await sup.start();
        void sup.stop('test');
        const deadline = Date.now() + scaledTimeout(5000, { concurrency: TEST_CONCURRENCY, multiplier: 2 });
        while (holder.h.exits.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
        assert.deepEqual(holder.h.exits, [0]);
        assert.equal(holder.h.lines().length, 1);
        assert.match(holder.h.lines()[0], /cause=forced-exit-timeout exit_code=0/);
        holder.h.log.uninstall();
    });
});

const posixOnly = process.platform === 'win32' ? { skip: 'real POSIX signals (SIGTERM/SIGHUP) are not delivered to a child on Windows; the in-process tests above cover every path' } : {};

describe('real signals against a spawned supervisor (POSIX only)', posixOnly, () => {
    function freePort() {
        return new Promise((resolve, reject) => {
            const srv = net.createServer();
            srv.once('error', reject);
            srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
        });
    }
    function health(port) {
        return new Promise((resolve) => {
            const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        });
    }
    for (const sig of ['SIGTERM']) {
        test(`${sig} leaves one final line with cause and exit code in supervisor.log`, async () => {
            const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'exitlog-data-'));
            const seDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'exitlog-se-'));
            tmpDirs.push(dataDir, seDataDir);
            const fixture = await createBeadsFixture();
            cleanups.push(fixture.cleanup);
            const port = await freePort();
            const child = spawn(process.execPath, [SERVE_BIN, '--port', String(port), '--beads-dir', fixture.dir], {
                cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
                env: envWithoutBeadsDir({ APRA_FLEET_DATA_DIR: dataDir, FLEET_SE_DATA_DIR: seDataDir }),
            });
            let out = '';
            child.stdout.on('data', (c) => { out += c; });
            child.stderr.on('data', (c) => { out += c; });
            const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
            try {
                const deadline = Date.now() + scaledTimeout(15000, { concurrency: TEST_CONCURRENCY, multiplier: 6 });
                while (!(await health(port))) {
                    if (Date.now() > deadline) throw new Error(`supervisor did not come up; output:\n${out}`);
                    await new Promise((r) => setTimeout(r, 100));
                }
                child.kill(sig);
                const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), scaledTimeout(15000, { concurrency: TEST_CONCURRENCY, multiplier: 4 })))]);
                assert.equal(code, 0);
            } finally { try { child.kill('SIGKILL'); } catch { /* gone */ } }
            const logFile = path.join(seDataDir, 'logs', 'supervisor.log');
            const finals = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.includes('final:'));
            assert.equal(finals.length, 1, finals.join('\n'));
            assert.match(finals[0], new RegExp(`cause=signal:${sig} exit_code=0`));
        });
    }

    for (const sig of ['SIGHUP']) {
        test(`${sig} on a detached launch keeps the supervisor alive and logs it`, async () => {
            const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'exitlog-data-'));
            const seDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'exitlog-se-'));
            tmpDirs.push(dataDir, seDataDir);
            const fixture = await createBeadsFixture();
            cleanups.push(fixture.cleanup);
            const port = await freePort();
            const child = spawn(process.execPath, [SERVE_BIN, '--port', String(port), '--beads-dir', fixture.dir], {
                cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
                env: envWithoutBeadsDir({ APRA_FLEET_DATA_DIR: dataDir, FLEET_SE_DATA_DIR: seDataDir }),
            });
            let out = '';
            child.stdout.on('data', (c) => { out += c; });
            child.stderr.on('data', (c) => { out += c; });
            const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
            try {
                const deadline = Date.now() + scaledTimeout(15000, { concurrency: TEST_CONCURRENCY, multiplier: 6 });
                while (!(await health(port))) {
                    if (Date.now() > deadline) throw new Error(`supervisor did not come up; output:\n${out}`);
                    await new Promise((r) => setTimeout(r, 100));
                }
                child.kill(sig);
                await new Promise((r) => setTimeout(r, 500));
                assert.equal(await health(port), true, 'still serving after SIGHUP');
                child.kill('SIGTERM');
                const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), scaledTimeout(15000, { concurrency: TEST_CONCURRENCY, multiplier: 4 })))]);
                assert.equal(code, 0);
            } finally { try { child.kill('SIGKILL'); } catch { /* gone */ } }
            const logFile = path.join(seDataDir, 'logs', 'supervisor.log');
            const finals = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.includes('final:'));
            assert.equal(finals.length, 1, finals.join('\n'));
            assert.match(finals[0], /cause=signal:SIGTERM exit_code=0/);
            assert.match(fs.readFileSync(logFile, 'utf8'), /received SIGHUP; ignored/);
        });
    }
});
