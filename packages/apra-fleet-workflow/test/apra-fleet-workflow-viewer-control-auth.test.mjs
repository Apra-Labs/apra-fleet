import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { FleetWorkflow } from '../src/workflow/index.mjs';
import { createDashboardViewer } from '../src/viewer/index.mjs';

// (apra-fleet-4v8r.2) The per-sprint viewer's control POSTs (/stop, /pause,
// /resume, /save_logs) must reject callers without the service token when one
// is configured, before any side effect; GET routes stay open; the bind stays
// loopback-only.

// The control handlers flush state under process.cwd(); isolate in a temp cwd.
let cwdOriginal;
let cwdTemp;
beforeEach(() => {
    cwdTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-viewer-auth-test-cwd-'));
    cwdOriginal = process.cwd();
    process.chdir(cwdTemp);
});
afterEach(() => {
    process.chdir(cwdOriginal);
    fs.rmSync(cwdTemp, { recursive: true, force: true });
});

const TOKEN = 'test-service-token-0123456789';

function request(port, method, urlPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

function makeWorkflow() {
    const wf = new FleetWorkflow({});
    const calls = { stop: 0, pause: 0, resume: 0 };
    wf.requestStop = () => { calls.stop++; };
    wf.requestPause = () => { calls.pause++; };
    wf.requestResume = () => { calls.resume++; return Promise.resolve(); };
    return { wf, calls };
}

async function withViewer(opts, fn) {
    const { wf, calls } = makeWorkflow();
    const origLog = console.log;
    const origWarn = console.warn;
    const logs = [];
    const warns = [];
    console.log = (...a) => { logs.push(a.join(' ')); };
    console.warn = (...a) => { warns.push(a.join(' ')); };
    let server;
    try {
        server = createDashboardViewer(wf, { port: 0, ...opts });
        await new Promise((resolve, reject) => {
            server.once('listening', resolve);
            server.once('error', reject);
        });
    } finally {
        console.log = origLog;
        console.warn = origWarn;
    }
    try {
        return await fn({ port: server.address().port, server, calls, logs, warns });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

describe('viewer control POSTs with serviceToken set', () => {
    test('POST /stop /pause /resume /save_logs without a bearer -> 401 and no side effect', async () => {
        await withViewer({ serviceToken: TOKEN }, async ({ port, calls }) => {
            for (const p of ['/stop', '/pause', '/resume', '/save_logs']) {
                const r = await request(port, 'POST', p);
                assert.strictEqual(r.status, 401, p);
            }
            const wrong = await request(port, 'POST', '/stop', { authorization: 'Bearer nope' });
            assert.strictEqual(wrong.status, 401);
            // A cookie is not accepted (cookies are not port-scoped).
            const cookie = await request(port, 'POST', '/stop', { cookie: `se_token=${TOKEN}` });
            assert.strictEqual(cookie.status, 401);
            assert.deepStrictEqual(calls, { stop: 0, pause: 0, resume: 0 });
        });
    });

    test('POST with the right bearer behaves as before', async () => {
        await withViewer({ serviceToken: TOKEN }, async ({ port, calls }) => {
            const auth = { authorization: `Bearer ${TOKEN}` };
            assert.strictEqual((await request(port, 'POST', '/pause', auth)).status, 200);
            assert.strictEqual((await request(port, 'POST', '/resume', auth)).status, 200);
            assert.strictEqual((await request(port, 'POST', '/save_logs', auth)).status, 200);
            assert.strictEqual((await request(port, 'POST', '/stop', auth)).status, 200);
            assert.strictEqual(calls.pause, 1);
            assert.strictEqual(calls.resume, 1);
            assert.strictEqual(calls.stop, 1);
        });
    });

    test('GET / and /state need no credential', async () => {
        await withViewer({ serviceToken: TOKEN }, async ({ port }) => {
            assert.strictEqual((await request(port, 'GET', '/')).status, 200);
            assert.strictEqual((await request(port, 'GET', '/state')).status, 200);
        });
    });

    test('binds 127.0.0.1 only', async () => {
        await withViewer({ serviceToken: TOKEN }, async ({ server }) => {
            assert.strictEqual(server.address().address, '127.0.0.1');
        });
    });
});

describe('viewer control POSTs with no serviceToken (standalone)', () => {
    test('POST /pause works unauthenticated and exactly one warning is logged', async () => {
        await withViewer({}, async ({ port, calls, warns }) => {
            assert.strictEqual((await request(port, 'POST', '/pause')).status, 200);
            assert.strictEqual(calls.pause, 1);
            const unauth = warns.filter((w) => /unauthenticated/i.test(w));
            assert.strictEqual(unauth.length, 1, JSON.stringify(warns));
        });
    });
});
