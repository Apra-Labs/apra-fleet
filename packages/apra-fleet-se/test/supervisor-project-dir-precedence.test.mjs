import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    resolveProjectDir,
    discoverBeadsDir,
    PROJECT_DIR_SOURCE,
} from '../src/supervisor/beads-identity.mjs';
import { writeSupervisorConfig, supervisorConfigPath } from '../src/supervisor/project-config.mjs';
import { serveMain } from '../bin/serve.mjs';
import { resolveServiceToken } from '../src/supervisor/auth.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

// =============================================================================
// The supervisor's project-folder PRECEDENCE chain, and the deliberate
// severity asymmetry between an operator typo and a stale persisted setting.
//
// Both halves live in this ONE file on purpose: the asymmetry (a bad
// --beads-dir is fatal, a bad configured folder is not) is the non-obvious
// design decision of this lane, and a later reader wondering whether it was
// intentional must be able to see both sides asserted side by side rather
// than inferring it from two unrelated suites.
//
// PRECEDENCE: --beads-dir, then the persisted project folder, then the cwd
// walk-up. The middle step is the fix for the reported bug: a
// service-started supervisor's working directory is the INSTALLED ENGINE
// TREE, so the walk-up silently won from there and the supervisor served an
// unrelated tracker. "Config beats walk-up" is therefore asserted against a
// cwd that has its OWN .beads -- if the walk-up ever wins again, that test
// fails, which is the whole point.
//
// Two levels, deliberately:
//   - resolveProjectDir() directly, for the precedence and no-fallback
//     properties (fast, and each branch independently observable);
//   - a REAL spawned bin/serve.mjs for every "starts successfully" and health
//     payload claim, because "the supervisor still boots" is not something an
//     in-process helper call can honestly demonstrate.
//
// The spawned supervisors deliberately point at folders with NO .beads, so no
// `bd` child process is ever required to make these assertions -- the
// properties under test are about folder RESOLUTION, not tracker identity.
//
// Isolation: every fixture lives under one mkdtemp root, removed in after().
// FLEET_SE_DATA_DIR/HOME are redirected into it, and BEADS_DIR is DELETED
// from every child environment -- bd resolves BEADS_DIR before it looks at
// cwd, so a dev host running this suite from inside a real beads workspace
// would otherwise leak that workspace in. Mirrors the BD_CHILD_ENV pattern in
// tests/check-sandbox-sync-remote.test.ts and
// tests/2cc-win-bd-invocation-integ.test.ts.
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
 * One isolated fixture root with every folder shape these tests need.
 * `projB` is the TRAP: an unrelated folder that has its own `.beads`, standing
 * in for the installed engine tree the walk-up used to win from.
 */
async function makeFixture() {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-projdir-'));
    tmpRoots.add(root);
    const dirs = {
        root,
        dataDir: path.join(root, 'se-data'),
        home: path.join(root, 'home'),
        projA: path.join(root, 'projA'),
        projB: path.join(root, 'projB'),
        flagDir: path.join(root, 'flagDir'),
        noBeads: path.join(root, 'noBeads'),
        vanished: path.join(root, 'vanished-never-created'),
        // A subfolder INSIDE projB, i.e. a cwd from which the walk-up
        // genuinely has to climb before it finds a `.beads`.
        projBSub: path.join(root, 'projB', 'src', 'nested'),
    };
    await fsp.mkdir(dirs.dataDir, { recursive: true });
    await fsp.mkdir(dirs.home, { recursive: true });
    await fsp.mkdir(path.join(dirs.projA, '.beads'), { recursive: true });
    await fsp.mkdir(path.join(dirs.projB, '.beads'), { recursive: true });
    await fsp.mkdir(path.join(dirs.flagDir, '.beads'), { recursive: true });
    await fsp.mkdir(dirs.noBeads, { recursive: true });
    await fsp.mkdir(dirs.projBSub, { recursive: true });
    return dirs;
}

/** Read the config through the module that owns it, for this fixture's dataDir. */
function configFor(dirs) {
    return supervisorConfigPath({ dataDir: dirs.dataDir });
}

/** resolveProjectDir() bound to this fixture's data dir (no env mutation). */
function resolveIn(dirs, opts = {}) {
    return resolveProjectDir({
        ...opts,
        readConfig: () => import('../src/supervisor/project-config.mjs')
            .then((m) => m.readSupervisorConfig({ dataDir: dirs.dataDir })),
    });
}

describe('project-dir precedence -- flag, then config, then walk-up', () => {
    test('flag beats config: both present and pointing at DIFFERENT folders, the flag wins', async () => {
        const dirs = await makeFixture();
        await writeSupervisorConfig({ dataDir: dirs.dataDir, projectDir: dirs.projA });

        const r = await resolveIn(dirs, { flag: dirs.flagDir, cwd: dirs.projB });

        assert.equal(r.source, PROJECT_DIR_SOURCE.FLAG);
        assert.equal(r.projectDir, dirs.flagDir);
        assert.notEqual(r.projectDir, dirs.projA, 'the config must not win over an explicit flag');
        assert.equal(r.chdir, dirs.flagDir, 'the flag folder is the one chdir\'d into');
        assert.equal(r.usable, true);
    });

    test('config beats walk-up: cwd is an unrelated folder WITH its own .beads, config still wins', async () => {
        const dirs = await makeFixture();
        await writeSupervisorConfig({ dataDir: dirs.dataDir, projectDir: dirs.projA });

        // Precondition: the cwd really is a walk-up trap -- if this ever stops
        // holding, the test below would pass for the wrong reason.
        const trap = discoverBeadsDir({ cwd: dirs.projB });
        assert.ok(trap, 'fixture precondition: projB must have its own .beads');
        assert.equal(trap.repoRoot, dirs.projB);

        const r = await resolveIn(dirs, { cwd: dirs.projB });

        assert.equal(r.source, PROJECT_DIR_SOURCE.CONFIG);
        assert.equal(r.projectDir, dirs.projA, 'the configured folder must win');
        assert.notEqual(
            r.projectDir, dirs.projB,
            'REGRESSION: the cwd walk-up won over the persisted setting -- this is the reported bug',
        );
        assert.equal(r.chdir, dirs.projA);
    });

    test('walk-up still works: no flag and no config file resolves exactly as it did before', async () => {
        const dirs = await makeFixture();
        // No config written at all.
        assert.equal(
            await fsp.access(configFor(dirs)).then(() => true, () => false),
            false,
            'fixture precondition: no config file exists',
        );

        const r = await resolveIn(dirs, { cwd: dirs.projB });

        assert.equal(r.source, PROJECT_DIR_SOURCE.WALK_UP);
        assert.equal(r.projectDir, dirs.projB, 'resolution is the cwd, as it always was');
        assert.equal(r.chdir, null, 'the legacy path requests NO chdir -- byte-identical to before');
        assert.equal(r.usable, true);
        assert.equal(r.warning, null);
        // And the legacy discovery from that cwd is untouched.
        assert.equal(discoverBeadsDir({ cwd: dirs.projB }).repoRoot, dirs.projB);
    });

    test('a malformed config file falls through to the walk-up rather than failing', async () => {
        const dirs = await makeFixture();
        await fsp.writeFile(configFor(dirs), 'not json', 'utf-8');

        const r = await resolveIn(dirs, { cwd: dirs.projB });

        assert.equal(r.source, PROJECT_DIR_SOURCE.WALK_UP);
        assert.equal(r.projectDir, dirs.projB);
        assert.match(r.configReason, /not valid JSON/, 'the reason is carried for the startup log');
    });

    test('a config naming a .beads dir normalizes to its project folder, exactly as the flag does', async () => {
        const dirs = await makeFixture();
        await writeSupervisorConfig({ dataDir: dirs.dataDir, projectDir: path.join(dirs.projA, '.beads') });

        const r = await resolveIn(dirs, { cwd: dirs.projB });

        assert.equal(r.source, PROJECT_DIR_SOURCE.CONFIG);
        assert.equal(r.projectDir, dirs.projA, 'the .beads suffix is stripped, as resolveBeadsDirArg does');
    });
});

describe('project-dir severity -- a typo is FATAL, staleness is NOT', () => {
    test('a --beads-dir that does not exist exits non-zero (operator typo on THIS launch)', async () => {
        const dirs = await makeFixture();
        const errors = [];
        const originalError = console.error;
        const originalDataDir = process.env.FLEET_SE_DATA_DIR;
        process.env.FLEET_SE_DATA_DIR = dirs.dataDir;
        console.error = (...a) => { errors.push(a.join(' ')); };
        let result;
        try {
            result = await serveMain(['--beads-dir', dirs.vanished]);
        } finally {
            console.error = originalError;
            if (originalDataDir === undefined) delete process.env.FLEET_SE_DATA_DIR;
            else process.env.FLEET_SE_DATA_DIR = originalDataDir;
        }

        assert.equal(result.exitCode, 1, 'a nonexistent --beads-dir must NOT be silently ignored');
        const text = errors.join('\n');
        assert.match(text, /--beads-dir/);
        assert.ok(text.includes(dirs.vanished), `the message must name the bad path, got: ${text}`);
        assert.match(text, /does not exist or is not a directory/);
    });

    test('a CONFIG that does not exist is not fatal, warns naming the path, and does NOT fall back to the walk-up', async () => {
        const dirs = await makeFixture();
        await writeSupervisorConfig({ dataDir: dirs.dataDir, projectDir: dirs.vanished });

        // Does not throw -- the staleness-tolerant half of the asymmetry.
        const r = await resolveIn(dirs, { cwd: dirs.projB });

        assert.equal(r.source, PROJECT_DIR_SOURCE.CONFIG);
        assert.equal(r.usable, false, 'the folder is reported unusable rather than raising');
        assert.equal(r.chdir, null, 'nothing to chdir into');
        assert.ok(r.warning, 'a warning must be produced');
        assert.ok(r.warning.includes(dirs.vanished), `the warning must name the offending path: ${r.warning}`);
        assert.match(r.warning, /To fix:/, 'the warning must carry the fix');
        // The setting is read only at startup: a fix that is not followed by a
        // restart leaves the supervisor on the stale value, so the warning has
        // to say so -- otherwise the operator edits the setting and waits.
        assert.match(
            r.warning, /RESTART/i,
            `the warning must say a restart is required after fixing the setting: ${r.warning}`,
        );
        // The no-fallback property: projB has its own .beads and must NOT win.
        assert.notEqual(
            r.projectDir, dirs.projB,
            'REGRESSION: a stale setting fell back to the walk-up and adopted an unrelated tracker',
        );
        assert.equal(r.projectDir, dirs.vanished, 'the configured path is still what is reported');
    });
});

// -----------------------------------------------------------------------------
// Real spawned bin/serve.mjs -- the only honest way to assert "starts
// successfully", and the health payload for each of the three winning sources.
// -----------------------------------------------------------------------------

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

function getJson(port, urlPath, token) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, method: 'GET', path: urlPath, headers: { authorization: `Bearer ${token}` } },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf-8');
                    let json;
                    try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
                    resolve({ status: res.statusCode, json });
                });
            },
        );
        req.on('error', reject);
        req.end();
    });
}

/**
 * Boot the REAL bin/serve.mjs against `dirs`, wait for /api/health, return it.
 *
 * `cwd` is the child's working directory (the walk-up input). `flag` adds
 * --beads-dir. The child's HOME and FLEET_SE_DATA_DIR are redirected into the
 * fixture, BEADS_DIR is stripped, and the dolt orphan sweep is scoped to the
 * fixture so this never touches another supervisor's sql-server.
 */
async function bootServe(dirs, { cwd, flag } = {}) {
    const port = await getFreePort();
    const token = resolveServiceToken(dirs.dataDir, { home: dirs.home }).token;

    const env = { ...process.env };
    // bd resolves BEADS_DIR before cwd: a dev host running this suite from
    // inside a real beads workspace must not leak that workspace into the
    // child's resolution. See this file's header.
    delete env.BEADS_DIR;
    env.FLEET_SE_DATA_DIR = dirs.dataDir;
    env.APRA_FLEET_DATA_DIR = path.join(dirs.root, 'fleet-data');
    env.HOME = dirs.home;
    env.USERPROFILE = dirs.home;
    // Never sweep another instance's ephemeral dolt sql-servers.
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
            const res = await getJson(port, '/api/health', token);
            if (res.status === 200 && res.json && res.json.status === 'ok') { health = res.json; break; }
        } catch { /* not listening yet */ }
        await new Promise((r) => { setTimeout(r, 100); });
    }

    const log = stdout.join('');
    async function stop() {
        try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
        spawnedPids.delete(child.pid);
    }
    return { health, log, exited, stop, port };
}

describe('project-dir on a REAL supervisor -- boots, logs one source line, reports health', () => {
    test('source=flag: health reports the flag folder and the flag as its source', async () => {
        const dirs = await makeFixture();
        // Config points somewhere else entirely; the flag must still win, and
        // the cwd is the .beads-bearing trap.
        await writeSupervisorConfig({ dataDir: dirs.dataDir, projectDir: dirs.projA });

        const { health, log, exited, stop } = await bootServe(dirs, { cwd: dirs.projB, flag: dirs.noBeads });
        try {
            assert.equal(exited, false, `the supervisor should still be running. Log:\n${log}`);
            assert.ok(health, `no /api/health answer. Log:\n${log}`);
            assert.equal(health.projectDir, dirs.noBeads);
            assert.equal(health.projectDirSource, PROJECT_DIR_SOURCE.FLAG);
            // Exactly one startup line names the resolved folder and source.
            const lines = log.split('\n').filter((l) => l.includes('project folder:'));
            assert.equal(lines.length, 1, `expected exactly one project-folder line, got ${lines.length}:\n${log}`);
            assert.ok(lines[0].includes(dirs.noBeads));
            assert.ok(lines[0].includes(`source: ${PROJECT_DIR_SOURCE.FLAG}`));
        } finally {
            await stop();
        }
    });

    test('source=config on a folder with no .beads: starts, beads unknown, carries a beadsWarning', async () => {
        const dirs = await makeFixture();
        await writeSupervisorConfig({ dataDir: dirs.dataDir, projectDir: dirs.noBeads });

        const { health, log, exited, stop } = await bootServe(dirs, { cwd: dirs.projB });
        try {
            assert.equal(exited, false, `a beads-less configured folder must NOT stop startup. Log:\n${log}`);
            assert.ok(health, `no /api/health answer. Log:\n${log}`);
            assert.equal(health.projectDir, dirs.noBeads);
            assert.equal(health.projectDirSource, PROJECT_DIR_SOURCE.CONFIG);
            assert.notEqual(
                health.projectDir, dirs.projB,
                'REGRESSION: the walk-up trap won over the persisted setting on a real boot',
            );
            assert.equal(health.beads, null, 'beads identity is unknown');
            assert.ok(health.beadsWarning, 'a beadsWarning must be carried');
            const lines = log.split('\n').filter((l) => l.includes('project folder:'));
            assert.equal(lines.length, 1, `expected exactly one project-folder line:\n${log}`);
            assert.ok(lines[0].includes(`source: ${PROJECT_DIR_SOURCE.CONFIG}`));
        } finally {
            await stop();
        }
    });

    test('source=config on a VANISHED folder: still starts, warning names the path, beads unknown', async () => {
        const dirs = await makeFixture();
        await writeSupervisorConfig({ dataDir: dirs.dataDir, projectDir: dirs.vanished });

        const { health, log, exited, stop } = await bootServe(dirs, { cwd: dirs.projB });
        try {
            assert.equal(exited, false, `a stale configured folder must NOT be a startup error. Log:\n${log}`);
            assert.ok(health, `no /api/health answer. Log:\n${log}`);
            assert.equal(health.projectDir, dirs.vanished);
            assert.equal(health.projectDirSource, PROJECT_DIR_SOURCE.CONFIG);
            assert.equal(health.beads, null);
            assert.ok(health.beadsWarning, 'a beadsWarning must be carried');
            assert.ok(
                health.beadsWarning.includes(dirs.vanished),
                `the warning must name the offending path, got: ${health.beadsWarning}`,
            );
            assert.notEqual(
                health.projectDir, dirs.projB,
                'REGRESSION: a stale setting fell back to the walk-up on a real boot',
            );
        } finally {
            await stop();
        }
    });

    test('source=walk-up from a SUBFOLDER: health reports the discovered project root, not the cwd it started from', async () => {
        const dirs = await makeFixture();
        // No config, no flag -- the walk-up has to climb out of projB/src/
        // nested to reach projB, which is the folder that holds `.beads` and
        // the cwd every sprint child would be given.
        const { health, log, exited, stop } = await bootServe(dirs, { cwd: dirs.projBSub });
        try {
            assert.equal(exited, false, `the walk-up path must still start. Log:\n${log}`);
            assert.ok(health, `no /api/health answer. Log:\n${log}`);
            assert.equal(health.projectDirSource, PROJECT_DIR_SOURCE.WALK_UP);
            assert.equal(
                health.projectDir, dirs.projB,
                'the walk-up must report the folder it FOUND, not the subfolder it started from',
            );
            assert.notEqual(health.projectDir, dirs.projBSub);
            const lines = log.split('\n').filter((l) => l.includes('project folder:'));
            assert.equal(lines.length, 1, `expected exactly one project-folder line:\n${log}`);
            assert.ok(lines[0].includes(dirs.projB), lines[0]);
        } finally {
            await stop();
        }
    });

    test('source=walk-up: no flag and no config, health reports the cwd and walk-up as its source', async () => {
        const dirs = await makeFixture();
        // No config file at all -- the legacy path.

        const { health, log, exited, stop } = await bootServe(dirs, { cwd: dirs.noBeads });
        try {
            assert.equal(exited, false, `the legacy no-beads path must still start. Log:\n${log}`);
            assert.ok(health, `no /api/health answer. Log:\n${log}`);
            assert.equal(health.projectDir, dirs.noBeads);
            assert.equal(health.projectDirSource, PROJECT_DIR_SOURCE.WALK_UP);
            assert.equal(health.beads, null);
            assert.ok(health.beadsWarning, 'the pre-existing no-beads warning still fires');
            const lines = log.split('\n').filter((l) => l.includes('project folder:'));
            assert.equal(lines.length, 1, `expected exactly one project-folder line:\n${log}`);
            assert.ok(lines[0].includes(`source: ${PROJECT_DIR_SOURCE.WALK_UP}`));
        } finally {
            await stop();
        }
    });
});
