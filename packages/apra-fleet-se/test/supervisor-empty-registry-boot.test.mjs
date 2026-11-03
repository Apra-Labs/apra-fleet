import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';
import { createBeadsFixture, envWithoutBeadsDir } from './helpers/beads-fixture.mjs';

// Carry-over regression guard (recurrence of an earlier closed fix): the
// supervisor booted against a fleet whose registry is EMPTY must serve
// /api/health and /api/members (valid empty JSON), log no "failed to list
// fleet members", and bring its backlog member up ready on the first attempt,
// so an immediate POST /api/sprints is not refused with 503 "fleet member
// list unavailable" / "backlog member is not ready".
//
// Nothing here is stubbed: a REAL fleet server (dist/index.js, http transport,
// sandboxed data dir => empty registry) answers list_members through the REAL
// tool-registry wrapper, and a REAL bin/serve.mjs supervisor attaches to it
// via the server.json in the shared sandbox data dir. Reverting either half of
// the fix (src/tools/list-members.ts json early return, or the
// fleet-members.mjs content-item parse) makes the parse path fail here.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVE_BIN = path.join(__dirname, '../bin/serve.mjs');
const SE_PKG_ROOT = path.join(__dirname, '..');
const FLEET_DIST_INDEX = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js');

const children = new Set();
const tmpDirs = new Set();
const cleanups = [];

after(async () => {
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    for (const fn of cleanups.splice(0)) await fn();
    for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
});

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const T = (ms, multiplier) => scaledTimeout(ms, { concurrency: TEST_CONCURRENCY, multiplier });

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    });
}

function request(port, urlPath, method = 'GET', body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port, path: urlPath, method, timeout: T(8000),
            headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
        }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: text }));
        });
        req.on('timeout', () => req.destroy(new Error('request timeout')));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function waitFor(fn, what, ms) {
    const deadline = Date.now() + ms;
    for (;;) {
        try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
    }
}

function spawnLogged(args, opts) {
    let out = '';
    const child = spawn(process.execPath, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.add(child);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    return { child, output: () => out };
}

describe(
    'supervisor boot against an empty fleet registry (real fleet server, real supervisor)',
    { skip: !fs.existsSync(FLEET_DIST_INDEX) && 'dist/index.js missing -- run npm run build first' },
    () => {
        test('health + members answer 200 with an empty list, backlog member ready, launch not refused for fleet reasons', async () => {
            const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wk8e-'));
            tmpDirs.add(root);
            const home = path.join(root, 'home');
            const fleetData = path.join(root, 'fleet-data');
            const seData = path.join(root, 'se-data');
            await fsp.mkdir(home, { recursive: true });
            await fsp.mkdir(fleetData, { recursive: true });
            await fsp.mkdir(seData, { recursive: true });
            const fleetPort = await getFreePort();
            const supPort = await getFreePort();
            const fixture = await createBeadsFixture();
            cleanups.push(fixture.cleanup);

            const sharedEnv = {
                HOME: home,
                USERPROFILE: home,
                APRA_FLEET_DATA_DIR: fleetData,
                APRA_FLEET_PORT: String(fleetPort),
                APRA_FLEET_TRANSPORT: 'http',
            };

            // Real fleet server, empty registry (fresh sandbox data dir).
            const fleet = spawnLogged([FLEET_DIST_INDEX, 'run', '--transport', 'http'], {
                cwd: root,
                env: envWithoutBeadsDir(sharedEnv),
            });
            await waitFor(
                async () => fs.existsSync(path.join(fleetData, 'server.json')) && (await request(fleetPort, '/health')).status === 200,
                `fleet server up; output:\n${fleet.output()}`,
                T(30000, 6),
            );

            // Real supervisor, attaching to that fleet via the shared data dir.
            const sup = spawnLogged([SERVE_BIN, '--port', String(supPort), '--beads-dir', fixture.dir], {
                cwd: SE_PKG_ROOT,
                env: envWithoutBeadsDir({ ...sharedEnv, FLEET_SE_DATA_DIR: seData }),
            });
            await waitFor(async () => (await request(supPort, '/api/health')).status === 200,
                `supervisor up; output:\n${sup.output()}`, T(30000, 6));

            // Criterion 1: GET /api/members is 200 with an empty list as valid JSON.
            const membersRes = await request(supPort, '/api/members');
            assert.equal(membersRes.status, 200, membersRes.body);
            const members = JSON.parse(membersRes.body);
            const list = Array.isArray(members) ? members : members.members;
            assert.ok(Array.isArray(list), `members payload: ${membersRes.body}`);
            assert.ok(!list.some((m) => m && m.name && !String(m.name).includes('backlog')),
                `no non-backlog members expected in an empty registry: ${membersRes.body}`);
            assert.equal((await request(supPort, '/api/health')).status, 200);

            // Criterion 2: the backlog member came up ready on the first attempt (no 30s retry).
            await waitFor(() => /\[backlog-member\] (registered|adopted)/.test(sup.output()),
                `backlog member registered; output:\n${sup.output()}`, T(30000, 6));
            const launch = await request(supPort, '/api/sprints', 'POST', {
                issue: fixture.issues[0].id,
                branch: 'sprint/wk8e-empty-registry',
                base: 'main',
                members: ['dev-a'],
            });
            // Positive signal: the request passed BOTH hard-pin gates (backlog member
            // ready, fleet list readable) and spawned a sprint child -- 201, not 503.
            // A merely-absent refusal text would also pass if an earlier 4xx fired.
            let launched = null;
            try { launched = JSON.parse(launch.body); } catch { /* asserted below */ }
            if (launched && launched.pid) {
                cleanups.push(async () => { try { process.kill(launched.pid, 'SIGKILL'); } catch { /* gone */ } });
            }
            assert.equal(launch.status, 201, `launch must be accepted (gates passed): ${launch.body}`);
            assert.doesNotMatch(launch.body, /fleet member list unavailable|backlog member is not ready|not yet ensured/);

            const out = sup.output();
            assert.doesNotMatch(out, /failed to list fleet members/, out);
            assert.doesNotMatch(out, /\[backlog-member\] WARNING: degraded/, out);
        });
    },
);
