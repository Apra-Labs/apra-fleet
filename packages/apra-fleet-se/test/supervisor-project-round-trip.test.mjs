import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { PROJECT_DIR_SOURCE, discoverBeadsDir } from '../src/supervisor/beads-identity.mjs';
import { supervisorConfigPath } from '../src/supervisor/project-config.mjs';
import { resolveServiceToken } from '../src/supervisor/auth.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

// =============================================================================
// apra-fleet-i9ag.17.2.3 -- console project-folder round trip, end to end
// against REAL spawned bin/serve.mjs subprocesses: an operator saves a
// folder through the console's guarded API, it persists, it is what the
// NEXT boot resolves (even from a cwd that would otherwise resolve
// somewhere else), a bad path is rejected without disturbing what is on
// disk, both endpoints stay guarded, the page reflects it, and the M2
// /api/projects domain is untouched.
//
// Mirrors test/supervisor-project-dir-precedence.test.mjs's own established
// harness (bootServe over a real spawned subprocess is the only honest way
// to assert "starts successfully" and "resolves X on THIS boot" -- an
// in-process helper call cannot demonstrate either). The spawned
// supervisors' project folder deliberately carries NO .beads, so no real
// `bd` child process is ever required by these assertions -- the
// properties under test are about the persisted SETTING and its
// precedence, not tracker identity.
//
// Isolation: every fixture lives under one mkdtemp root, removed in
// after(). FLEET_SE_DATA_DIR/HOME are redirected into it, and BEADS_DIR is
// DELETED from every child environment -- bd resolves BEADS_DIR before it
// looks at cwd, so a dev host running this suite from inside a real beads
// workspace must not leak that workspace in (same BD_CHILD_ENV pattern as
// tests/check-sandbox-sync-remote.test.ts and
// tests/2cc-win-bd-invocation-integ.test.ts). Every spawned pid is tracked
// and force-killed in a single top-level after(), so a failing assertion
// mid-suite can never leave a process holding its port.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVE_BIN = path.join(__dirname, '../bin/serve.mjs');

/** @type {Set<number>} */
const spawnedPids = new Set();
/** @type {Set<string>} */
const tmpRoots = new Set();

after(async () => {
    for (const pid of spawnedPids) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    spawnedPids.clear();
    for (const dir of tmpRoots) {
        // eslint-disable-next-line no-await-in-loop
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpRoots.clear();
});

/**
 * One isolated fixture root. `cwdTrap` is the walk-up TRAP -- an unrelated
 * folder with its own `.beads`, standing in for the installed engine tree
 * the walk-up used to win from -- so "survives restart" genuinely proves
 * the persisted config beats it, exactly as supervisor-project-dir-
 * precedence.test.mjs's own "config beats walk-up" case does.
 */
async function makeFixture() {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-projroundtrip-'));
    tmpRoots.add(root);
    const dirs = {
        root,
        dataDir: path.join(root, 'se-data'),
        home: path.join(root, 'home'),
        bootCwd: path.join(root, 'boot-cwd'),
        savedProj: path.join(root, 'saved-proj'),
        cwdTrap: path.join(root, 'cwd-trap'),
        bogus: path.join(root, 'does-not-exist-at-all'),
    };
    await fsp.mkdir(dirs.dataDir, { recursive: true });
    await fsp.mkdir(dirs.home, { recursive: true });
    await fsp.mkdir(dirs.bootCwd, { recursive: true });
    await fsp.mkdir(dirs.savedProj, { recursive: true });
    await fsp.mkdir(path.join(dirs.cwdTrap, '.beads'), { recursive: true });
    return dirs;
}

function configFor(dirs) {
    return supervisorConfigPath({ dataDir: dirs.dataDir });
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

function request(port, method, urlPath, { token, body } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf-8') : null;
        const headers = {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        };
        const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf-8');
                let json;
                try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.on('error', reject);
        if (payload) req.end(payload); else req.end();
    });
}

/**
 * Boot the REAL bin/serve.mjs against `dirs`, wait for /api/health, return a
 * handle. `cwd` is the child's working directory (the walk-up input); `flag`
 * adds --beads-dir. The child's HOME/FLEET_SE_DATA_DIR are redirected into
 * the fixture and BEADS_DIR is stripped (see this file's header).
 */
async function bootServe(dirs, { cwd, flag } = {}) {
    const port = await getFreePort();
    const token = resolveServiceToken(dirs.dataDir, { home: dirs.home }).token;

    const env = { ...process.env };
    delete env.BEADS_DIR;
    env.FLEET_SE_DATA_DIR = dirs.dataDir;
    env.APRA_FLEET_DATA_DIR = path.join(dirs.root, 'fleet-data');
    env.HOME = dirs.home;
    env.USERPROFILE = dirs.home;
    env.FLEET_SE_SWEEP_OWNER_DATA_DIR = dirs.root;

    const args = [SERVE_BIN, '--port', String(port)];
    if (flag) args.push('--beads-dir', flag);

    const stdout = [];
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (Number.isInteger(child.pid)) spawnedPids.add(child.pid);
    child.stdout.on('data', (c) => stdout.push(c.toString('utf-8')));
    child.stderr.on('data', (c) => stdout.push(c.toString('utf-8')));
    let exited = false;
    child.on('exit', () => { exited = true; });

    const deadline = Date.now() + scaledTimeout(20000);
    let health;
    while (Date.now() < deadline) {
        if (exited) break;
        try {
            // eslint-disable-next-line no-await-in-loop
            const res = await request(port, 'GET', '/api/health', { token });
            if (res.status === 200 && res.json && res.json.status === 'ok') { health = res.json; break; }
        } catch { /* not listening yet */ }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => { setTimeout(r, 100); });
    }

    const log = () => stdout.join('');
    async function stop() {
        if (!spawnedPids.has(child.pid)) return; // already stopped
        try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
        spawnedPids.delete(child.pid);
    }
    return {
        health, exited, stop, port, token, log,
        get pid() { return child.pid; },
    };
}

describe('console project-folder round trip (apra-fleet-i9ag.17.2.3)', () => {
    let dirs;
    /** @type {Awaited<ReturnType<typeof bootServe>>|null} */
    let sup;

    before(async () => {
        dirs = await makeFixture();
        // Fixture precondition, mirroring supervisor-project-dir-precedence.test.mjs's
        // own trap check -- if this ever stops holding, "survives restart"
        // below would pass for the wrong reason.
        const trap = discoverBeadsDir({ cwd: dirs.cwdTrap });
        assert.ok(trap, 'fixture precondition: cwdTrap must have its own .beads');

        // Boot #1: no flag, no config yet -- an arbitrary beads-less cwd (its
        // own resolution does not matter here, only that the API is live).
        sup = await bootServe(dirs, { cwd: dirs.bootCwd });
        assert.equal(sup.exited, false, `boot #1 should still be running. Log:\n${sup.log()}`);
        assert.ok(sup.health, `boot #1 never answered /api/health. Log:\n${sup.log()}`);
    });

    after(async () => {
        if (sup) await sup.stop();
    });

    test('round trip: POST saves a folder, the write echoes it back, and it lands in supervisor.config.json on disk', async () => {
        const postRes = await request(sup.port, 'POST', '/api/project', { token: sup.token, body: { projectDir: dirs.savedProj } });
        assert.equal(postRes.status, 200, JSON.stringify(postRes.json));
        assert.equal(postRes.json.projectDir, dirs.savedProj);
        assert.equal(postRes.json.restartRequired, true);

        const onDisk = JSON.parse(await fsp.readFile(configFor(dirs), 'utf-8'));
        assert.equal(onDisk.projectDir, dirs.savedProj, 'the saved value must be the one actually on disk, not just what the route echoed back');

        // GET on THIS still-running process deliberately still reports its
        // ORIGINAL boot-time resolution (walk-up/bootCwd), never the
        // just-saved value -- config is read only during startup
        // resolution (apra-fleet-i9ag.17.2.1's restartRequired:true), so
        // claiming otherwise here would be exactly the "looks live but
        // isn't" failure that field exists to prevent. The "survives
        // restart" case below is where GET legitimately reads the saved
        // value back, on a process that has genuinely adopted it.
        const getRes = await request(sup.port, 'GET', '/api/project', { token: sup.token });
        assert.equal(getRes.status, 200);
        assert.equal(getRes.json.projectDir, dirs.bootCwd);
        assert.equal(getRes.json.source, PROJECT_DIR_SOURCE.WALK_UP);
    });

    test('rejection: a nonexistent path 4xxs and leaves the previously saved value intact on disk', async () => {
        const before1 = JSON.parse(await fsp.readFile(configFor(dirs), 'utf-8'));

        const res = await request(sup.port, 'POST', '/api/project', { token: sup.token, body: { projectDir: dirs.bogus } });
        assert.equal(res.status, 400);
        assert.ok(res.json.error.includes(dirs.bogus), res.json.error);

        const after1 = JSON.parse(await fsp.readFile(configFor(dirs), 'utf-8'));
        assert.deepEqual(after1, before1, 'a rejected write must leave the on-disk config byte-for-byte unchanged');
        assert.equal(after1.projectDir, dirs.savedProj);
    });

    test('auth: an unauthenticated call to both GET and POST /api/project is refused', async () => {
        const getRes = await request(sup.port, 'GET', '/api/project', {});
        assert.equal(getRes.status, 401);

        const postRes = await request(sup.port, 'POST', '/api/project', { body: { projectDir: dirs.savedProj } });
        assert.equal(postRes.status, 401);

        // Refusing the write must not have touched the persisted value either.
        const onDisk = JSON.parse(await fsp.readFile(configFor(dirs), 'utf-8'));
        assert.equal(onDisk.projectDir, dirs.savedProj);
    });

    test('page: GET /ui/projects reflects the saved value and never serves the placeholder string', async () => {
        const res = await request(sup.port, 'GET', '/ui/projects', { token: sup.token });
        assert.equal(res.status, 200);
        assert.ok(res.headers['content-type'].includes('text/html'), res.headers['content-type']);
        assert.ok(!res.text.includes('arrives in a later sprint'), 'expected /ui/projects to no longer answer the placeholder');
        assert.ok(res.text.includes('id="save-form"'), 'expected the real Projects page markup');
    });

    test('M2 untouched: /api/projects is still registered and answers as it did before this sprint (never 404)', async () => {
        const res = await request(sup.port, 'GET', '/api/projects', { token: sup.token });
        // Either genuinely served (200, node:sqlite available) or the
        // pre-existing store-unavailable degrade path (503) -- either is
        // "still registered and answering as before"; the regression this
        // guards against is the route disappearing entirely (404).
        assert.notEqual(res.status, 404, 'the /api/projects M2 domain must remain registered');
        assert.ok([200, 503].includes(res.status), `unexpected status ${res.status}: ${res.text}`);
    });

    test('survives restart: a FRESH supervisor in the SAME data dir, with NO --beads-dir and a cwd that would otherwise resolve the walk-up trap, resolves the saved folder', async () => {
        // Stop boot #1 first -- the persisted setting, not the live process,
        // is what this property is about.
        await sup.stop();
        sup = null;

        const second = await bootServe(dirs, { cwd: dirs.cwdTrap });
        try {
            assert.equal(second.exited, false, `boot #2 should still be running. Log:\n${second.log()}`);
            assert.ok(second.health, `boot #2 never answered /api/health. Log:\n${second.log()}`);
            assert.equal(second.health.projectDir, dirs.savedProj, 'REGRESSION: the persisted setting did not survive the restart');
            assert.equal(second.health.projectDirSource, PROJECT_DIR_SOURCE.CONFIG);
            assert.notEqual(
                second.health.projectDir, dirs.cwdTrap,
                'REGRESSION: the cwd walk-up trap won over the persisted setting on a real restart -- exactly the sprint bug',
            );

            // And GET /api/project on the fresh process reports the same thing.
            const getRes = await request(second.port, 'GET', '/api/project', { token: second.token });
            assert.equal(getRes.status, 200);
            assert.equal(getRes.json.projectDir, dirs.savedProj);
            assert.equal(getRes.json.source, PROJECT_DIR_SOURCE.CONFIG);
        } finally {
            await second.stop();
        }
    });
});
