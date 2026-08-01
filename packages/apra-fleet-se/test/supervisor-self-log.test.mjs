import { test, describe } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';

import {
    formatLocalTimestamp,
    resolveSelfLogPath,
    installSelfLogTee,
    createSelfLogView,
    registerSelfLogRoutes,
} from '../src/supervisor/self-log.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';

// Supervisor's own stdout/stderr, timestamped (local time) and served at
// GET /supervisor/log -- the companion to log-view.mjs's per-sprint-child
// raw log, but for the supervisor process itself.

/** GET a supervisor path, resolving the full body once the response ends. */
function getText(port, urlPath) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

/** A fake fs implementation collecting writes in memory, no real disk I/O. */
function fakeFs() {
    const files = new Map();
    return {
        files,
        mkdirSync() {},
        createWriteStream(p) {
            files.set(p, '');
            return {
                write(chunk) { files.set(p, files.get(p) + chunk); return true; },
                end() {},
            };
        },
    };
}

describe('self-log -- formatLocalTimestamp', () => {
    test('formats in LOCAL time, not UTC', () => {
        // A date with a non-zero-minute local offset baked in via explicit
        // constructor args is still read back via the local getters below,
        // so this only asserts internal consistency (would fail if the
        // implementation switched to any UTC-based getter by mistake).
        const d = new Date(2026, 0, 5, 9, 7, 3, 42); // Jan 5 2026, 09:07:03.042 local
        assert.strictEqual(formatLocalTimestamp(d), '2026-01-05 09:07:03.042');
    });

    test('zero-pads month/day/hour/minute/second/ms', () => {
        const d = new Date(2026, 8, 2, 1, 2, 3, 4); // Sep 2 2026, 01:02:03.004 local
        assert.strictEqual(formatLocalTimestamp(d), '2026-09-02 01:02:03.004');
    });
});

describe('self-log -- resolveSelfLogPath', () => {
    test('lives under <dataDir>/logs/supervisor.log', () => {
        const p = resolveSelfLogPath('/data');
        assert.match(p, /[/\\]data[/\\]logs[/\\]supervisor\.log$/);
    });
});

describe('self-log -- installSelfLogTee', () => {
    test('tees console.log to the file, timestamped, without suppressing the original console call', () => {
        const fs = fakeFs();
        const seenByOriginal = [];
        const fakeConsole = { log: (...a) => seenByOriginal.push(a.join(' ')), warn: () => {}, error: () => {} };
        const fixedNow = new Date(2026, 0, 1, 12, 0, 0, 0);

        const tee = installSelfLogTee({ dataDir: '/data', consoleObj: fakeConsole, now: () => fixedNow, fsImpl: fs });
        fakeConsole.log('hello world');
        tee.stop();

        assert.deepStrictEqual(seenByOriginal, ['hello world']);
        const written = fs.files.get(tee.logPath);
        assert.match(written, /^\[2026-01-01 12:00:00\.000\] \[info\] hello world\n$/);
    });

    test('stop() restores the original console methods', () => {
        const fs = fakeFs();
        const originalLog = () => {};
        const fakeConsole = { log: originalLog, warn: () => {}, error: () => {} };
        const tee = installSelfLogTee({ dataDir: '/data', consoleObj: fakeConsole, fsImpl: fs });
        assert.notStrictEqual(fakeConsole.log, originalLog);
        tee.stop();
        assert.strictEqual(fakeConsole.log, originalLog);
    });
});

describe('self-log -- GET /supervisor/log', () => {
    test('serves the full file content', async () => {
        const view = createSelfLogView({ logPath: '/data/logs/supervisor.log', readFile: async () => '[2026-01-01 00:00:00.000] [info] line one\n[2026-01-01 00:00:01.000] [info] line two\n' });
        const supervisor = createSupervisor({ port: 0 });
        registerSelfLogRoutes(supervisor, view);
        await supervisor.start();
        try {
            const { status, body } = await getText(supervisor.port, '/supervisor/log');
            assert.strictEqual(status, 200);
            assert.match(body, /line one/);
            assert.match(body, /line two/);
        } finally {
            await supervisor.stop('test-done');
        }
    });

    test('respects ?tail=N', async () => {
        const view = createSelfLogView({ logPath: '/data/logs/supervisor.log', readFile: async () => 'a\nb\nc\n' });
        const supervisor = createSupervisor({ port: 0 });
        registerSelfLogRoutes(supervisor, view);
        await supervisor.start();
        try {
            const { body } = await getText(supervisor.port, '/supervisor/log?tail=2');
            assert.strictEqual(body, 'b\nc\n');
        } finally {
            await supervisor.stop('test-done');
        }
    });

    test('404s with a clear message when the file does not exist yet', async () => {
        const err = new Error('not found');
        err.code = 'ENOENT';
        const view = createSelfLogView({ logPath: '/data/logs/supervisor.log', readFile: async () => { throw err; } });
        const supervisor = createSupervisor({ port: 0 });
        registerSelfLogRoutes(supervisor, view);
        await supervisor.start();
        try {
            const { status, body } = await getText(supervisor.port, '/supervisor/log');
            assert.strictEqual(status, 404);
            assert.match(body, /nothing has been logged/);
        } finally {
            await supervisor.stop('test-done');
        }
    });
});
