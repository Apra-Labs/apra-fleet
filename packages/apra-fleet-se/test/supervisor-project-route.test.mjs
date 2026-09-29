import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSupervisor, readJsonBody, sendJson } from '../src/supervisor/server.mjs';
import { registerProjectFolderRoutes } from '../src/supervisor/project-route.mjs';
import { readSupervisorConfig, supervisorConfigPath } from '../src/supervisor/project-config.mjs';
import { BEADS_DIR_NAME } from '../src/supervisor/beads-identity.mjs';

// =============================================================================
// apra-fleet-i9ag.17.2.1 -- GET/POST /api/project: read/write the
// supervisor's persisted project folder.
//
// Driven by constructing "a supervisor built the way serve.mjs builds it"
// in-process (createSupervisor() + registerProjectFolderRoutes(), the exact
// exports bin/serve.mjs itself calls), mirroring test/serve-mount.test.mjs's
// established convention rather than spawning a real subprocess -- the
// full-process round trip (including restart) is covered separately by
// apra-fleet-i9ag.17.2.3's suite.
//
// Every test works inside its own mkdtemp dataDir and mkdtemp candidate
// project folders under os.tmpdir(); nothing here writes to a real home
// directory.
//
// The POST usability check (does this folder carry a beads identity a sprint
// could actually run against?) is driven entirely through the route's
// injectable `execBd`/`execGit` deps -- see fakeExecs() below. No test in
// this file needs a real `bd` or `git` on PATH, which is what lets the
// failure cases (bd missing, sync.remote unset, no git origin) be asserted
// deterministically on every host instead of only where the environment
// happens to reproduce them.
// =============================================================================

/** @type {string[]} */
const tmpDirs = [];

after(async () => {
    for (const dir of tmpDirs) {
        // eslint-disable-next-line no-await-in-loop
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
});

/**
 * mkdtemp under a REALPATH'd root. os.tmpdir() is itself a symlink on some
 * hosts (macOS: /var/folders/... -> /private/var/folders/...), and a spawned
 * supervisor reports its cwd already resolved, so an un-resolved fixture path
 * would not compare equal to what the process reports. Resolving once at
 * creation keeps both sides of every path assertion in the same spelling.
 * The `.native` variant also expands a Windows 8.3 short name.
 */
async function mkRealTmp(prefix) {
    return fs.realpathSync.native(await fsp.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function mkTmp(prefix = 'apra-fleet-project-route-') {
    const dir = await mkRealTmp(prefix);
    tmpDirs.push(dir);
    return dir;
}

/** Mock req/res driving supervisor.handleRequest directly (mirrors
 *  test/serve-mount.test.mjs's own helper of the same name). */
function mockReq(method, url, { headers = {}, body } = {}) {
    const chunks = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
    return {
        method,
        url,
        headers,
        on(event, cb) {
            if (event === 'data') { for (const c of chunks) cb(c); }
            if (event === 'end') { cb(); }
            return this;
        },
    };
}
function mockRes() {
    return {
        statusCode: undefined,
        body: undefined,
        headersSent: false,
        writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
        end(body) { this.body = body; },
    };
}
const payloadOf = (res) => (res.body ? JSON.parse(res.body) : null);

/**
 * Fake `bd`/`git` child processes for the POST usability probe, in the exact
 * shapes probeBeadsIdentity() calls them with (execBdAsync / promisified
 * execFile). Defaults describe a COMPLETE, usable project folder; each field
 * can be knocked out to drive one specific missing requirement, and
 * `bdMissing` models bd not being installed at all (the probe then throws).
 */
function fakeExecs({ prefix = 'demo', syncRemote = 'https://example.invalid/acme/demo.git', repoRemote = 'https://example.invalid/acme/demo.git', bdMissing = false } = {}) {
    const execBd = async (args) => {
        if (bdMissing) throw new Error('spawn bd ENOENT');
        if (args[0] === 'where') {
            return { stdout: JSON.stringify({ path: '/wherever/.beads', prefix, database_path: '/wherever/.beads/db' }) };
        }
        if (args[0] === 'config') {
            return { stdout: JSON.stringify({ key: 'sync.remote', value: syncRemote }) };
        }
        return { stdout: '' };
    };
    const execGit = async () => {
        if (!repoRemote) throw new Error("fatal: No such remote 'origin'");
        return { stdout: `${repoRemote}\n` };
    };
    return { execBd, execGit };
}

/** Builds a supervisor with the project-folder routes mounted exactly the
 *  way bin/serve.mjs does. `execs` overrides the usability probe's two
 *  child-process seams (defaulting to a complete, usable folder). */
function mountProjectRoute({ token, projectDir, source = 'walk-up', flagActive = false, dataDir, execs = fakeExecs() }) {
    const supervisor = createSupervisor({ token });
    registerProjectFolderRoutes(supervisor, {
        projectDir, source, flagActive, dataDir, readJsonBody, sendJson,
        execBd: execs.execBd, execGit: execs.execGit,
    });
    return supervisor;
}

const AUTH = (token) => ({ authorization: `Bearer ${token}` });

describe('GET/POST /api/project (apra-fleet-i9ag.17.2.1)', () => {
    test('GET reports the resolved projectDir, source, hasBeadsDb:false for a folder with no .beads, and flagActive', async () => {
        const token = 'a'.repeat(64);
        const projectDir = await mkTmp('proj-no-beads-');
        const dataDir = await mkTmp('data-');
        const supervisor = mountProjectRoute({ token, projectDir, source: 'walk-up', flagActive: false, dataDir });

        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/project', { headers: AUTH(token) }), res);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(payloadOf(res), {
            projectDir, source: 'walk-up', hasBeadsDb: false, flagActive: false,
        });
    });

    test('GET reports hasBeadsDb:true when the resolved folder actually contains .beads', async () => {
        const token = 'b'.repeat(64);
        const projectDir = await mkTmp('proj-with-beads-');
        await fsp.mkdir(path.join(projectDir, BEADS_DIR_NAME));
        await fsp.writeFile(path.join(path.join(projectDir, BEADS_DIR_NAME), 'metadata.json'), '{}');
        const dataDir = await mkTmp('data-');
        const supervisor = mountProjectRoute({ token, projectDir, source: 'config', flagActive: false, dataDir });

        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/project', { headers: AUTH(token) }), res);
        assert.equal(res.statusCode, 200);
        assert.equal(payloadOf(res).hasBeadsDb, true);
        assert.equal(payloadOf(res).source, 'config');
    });

    test('GET reports flagActive:true and source "flag" when the flag is in force', async () => {
        const token = 'c'.repeat(64);
        const projectDir = await mkTmp('proj-flag-');
        const dataDir = await mkTmp('data-');
        const supervisor = mountProjectRoute({ token, projectDir, source: 'flag', flagActive: true, dataDir });

        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/project', { headers: AUTH(token) }), res);
        assert.equal(payloadOf(res).source, 'flag');
        assert.equal(payloadOf(res).flagActive, true);
    });

    test('GET without a credential -> 401 (guard applies to /api/project like every /api/ route)', async () => {
        const token = 'd'.repeat(64);
        const projectDir = await mkTmp('proj-noauth-get-');
        const dataDir = await mkTmp('data-');
        const supervisor = mountProjectRoute({ token, projectDir, dataDir });

        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/project', {}), res);
        assert.equal(res.statusCode, 401);
    });

    test('POST without a credential -> 401, and nothing is persisted', async () => {
        const token = 'e'.repeat(64);
        const projectDir = await mkTmp('proj-noauth-post-');
        const target = await mkTmp('proj-noauth-post-target-');
        const dataDir = await mkTmp('data-');
        const supervisor = mountProjectRoute({ token, projectDir, dataDir });

        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/project', { body: { projectDir: target } }), res);
        assert.equal(res.statusCode, 401);

        const config = await readSupervisorConfig({ dataDir });
        assert.equal(config.configured, false, 'an unauthenticated write must never persist');
    });

    test('POST a path that does not exist -> 400 naming the path; nothing is persisted', async () => {
        const token = 'f'.repeat(64);
        const projectDir = await mkTmp('proj-reject-');
        const dataDir = await mkTmp('data-');
        const supervisor = mountProjectRoute({ token, projectDir, dataDir });
        const bogus = path.join(projectDir, 'does-not-exist-at-all');

        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/project', { headers: AUTH(token), body: { projectDir: bogus } }), res);
        assert.equal(res.statusCode, 400);
        assert.ok(payloadOf(res).error.includes(bogus), `expected the rejection message to name the path, got: ${payloadOf(res).error}`);
        // The console operator never typed a flag; the shared validator's
        // `--beads-dir` phrasing must not leak into the page.
        assert.ok(
            !payloadOf(res).error.includes('--beads-dir'),
            `the console rejection must not name a CLI flag, got: ${payloadOf(res).error}`,
        );
        assert.match(payloadOf(res).error, /project folder/);

        const config = await readSupervisorConfig({ dataDir });
        assert.equal(config.configured, false, 'a rejected write must never persist');
    });

    // -------------------------------------------------------------------
    // SET-TIME USABILITY: the engine's beads identity precondition is fatal
    // to a sprint, so a folder that cannot satisfy it is refused HERE --
    // while the operator is present -- instead of at the next launch.
    // -------------------------------------------------------------------

    test('POST a folder whose beads identity cannot be probed at all (no bd) -> 400 naming every missing requirement and its fix; nothing is persisted', async () => {
        const token = 'g'.repeat(64);
        const projectDir = await mkTmp('proj-reject-nobd-');
        const dataDir = await mkTmp('data-');
        const supervisor = mountProjectRoute({ token, projectDir, dataDir, execs: fakeExecs({ bdMissing: true }) });
        const target = await mkTmp('proj-reject-nobd-target-');

        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/project', { headers: AUTH(token), body: { projectDir: target } }), res);
        assert.equal(res.statusCode, 400);
        assert.deepEqual(payloadOf(res).missing, ['beadsDir', 'prefix', 'syncRemote', 'repoRemote']);
        const { error } = payloadOf(res);
        assert.ok(error.includes(target), `expected the message to name the folder, got: ${error}`);
        assert.match(error, /run 'bd init' in that folder/);
        assert.match(error, /bd config set sync\.remote <url>/);
        assert.match(error, /git remote add origin <url>/);
        assert.ok(error.includes('spawn bd ENOENT'), `expected the raw probe failure to survive into the message, got: ${error}`);

        const config = await readSupervisorConfig({ dataDir });
        assert.equal(config.configured, false, 'an unusable folder must never persist');
    });

    test("POST a folder with no bd 'sync.remote' -> 400 naming ONLY that requirement; nothing is persisted", async () => {
        const token = 'm'.repeat(64);
        const projectDir = await mkTmp('proj-reject-nosync-');
        const dataDir = await mkTmp('data-');
        const supervisor = mountProjectRoute({ token, projectDir, dataDir, execs: fakeExecs({ syncRemote: '' }) });
        const target = await mkTmp('proj-reject-nosync-target-');

        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/project', { headers: AUTH(token), body: { projectDir: target } }), res);
        assert.equal(res.statusCode, 400);
        assert.deepEqual(payloadOf(res).missing, ['syncRemote']);
        assert.match(payloadOf(res).error, /bd config set sync\.remote <url>/);
        assert.ok(!payloadOf(res).error.includes('bd init'), 'a requirement that IS satisfied must not be named');

        const config = await readSupervisorConfig({ dataDir });
        assert.equal(config.configured, false);
    });

    test("POST a folder with no git 'origin' remote -> 400 naming ONLY that requirement; nothing is persisted", async () => {
        const token = 'n'.repeat(64);
        const projectDir = await mkTmp('proj-reject-noorigin-');
        const dataDir = await mkTmp('data-');
        const supervisor = mountProjectRoute({ token, projectDir, dataDir, execs: fakeExecs({ repoRemote: '' }) });
        const target = await mkTmp('proj-reject-noorigin-target-');

        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/project', { headers: AUTH(token), body: { projectDir: target } }), res);
        assert.equal(res.statusCode, 400);
        assert.deepEqual(payloadOf(res).missing, ['repoRemote']);
        assert.match(payloadOf(res).error, /git remote add origin <url>/);

        const config = await readSupervisorConfig({ dataDir });
        assert.equal(config.configured, false);
    });

    test('POST an existing path WITH .beads -> 200, persisted, hasBeadsDb:true', async () => {
        const token = 'h'.repeat(64);
        const projectDir = await mkTmp('proj-accept-beads-');
        const dataDir = await mkTmp('data-');
        const supervisor = mountProjectRoute({ token, projectDir, dataDir });
        const target = await mkTmp('proj-accept-beads-target-');
        await fsp.mkdir(path.join(target, BEADS_DIR_NAME));
        await fsp.writeFile(path.join(path.join(target, BEADS_DIR_NAME), 'metadata.json'), '{}');

        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/project', { headers: AUTH(token), body: { projectDir: target } }), res);
        assert.equal(res.statusCode, 200);
        assert.equal(payloadOf(res).hasBeadsDb, true);

        const config = await readSupervisorConfig({ dataDir });
        assert.equal(config.projectDir, target);
    });

    test('POST the .beads subdirectory itself resolves to (and persists) its PARENT -- same convenience --beads-dir has', async () => {
        const token = 'i'.repeat(64);
        const projectDir = await mkTmp('proj-accept-dotbeads-');
        const dataDir = await mkTmp('data-');
        const supervisor = mountProjectRoute({ token, projectDir, dataDir });
        const target = await mkTmp('proj-accept-dotbeads-target-');
        const beadsSubdir = path.join(target, BEADS_DIR_NAME);
        await fsp.mkdir(beadsSubdir);

        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/project', { headers: AUTH(token), body: { projectDir: beadsSubdir } }), res);
        assert.equal(res.statusCode, 200);
        assert.equal(payloadOf(res).projectDir, target, 'expected the .beads path to resolve to its parent project folder');

        const config = await readSupervisorConfig({ dataDir });
        assert.equal(config.projectDir, target);
    });

    test('POST while the flag is in force -> saved, but the response says the flag overrides it (never silently inert)', async () => {
        const token = 'j'.repeat(64);
        const projectDir = await mkTmp('proj-flagged-');
        const dataDir = await mkTmp('data-');
        const supervisor = mountProjectRoute({ token, projectDir, source: 'flag', flagActive: true, dataDir });
        const target = await mkTmp('proj-flagged-target-');

        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/project', { headers: AUTH(token), body: { projectDir: target } }), res);
        assert.equal(res.statusCode, 200);
        assert.equal(payloadOf(res).flagActive, true);
        assert.ok(payloadOf(res).note.includes('--beads-dir'), `expected the response note to name the overriding flag, got: ${payloadOf(res).note}`);
        assert.equal(
            payloadOf(res).source, 'flag',
            'the flag keeps winning the precedence after a restart, so the save must not claim source "config"',
        );

        // Still genuinely persisted -- inert only until the flag is dropped.
        const config = await readSupervisorConfig({ dataDir });
        assert.equal(config.configured, true);
        assert.equal(config.projectDir, target);
    });

    test('POST with no flag in force -> the response note asks for a restart, with no flag-override caveat', async () => {
        const token = 'k'.repeat(64);
        const projectDir = await mkTmp('proj-unflagged-');
        const dataDir = await mkTmp('data-');
        const supervisor = mountProjectRoute({ token, projectDir, source: 'walk-up', flagActive: false, dataDir });
        const target = await mkTmp('proj-unflagged-target-');

        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/project', { headers: AUTH(token), body: { projectDir: target } }), res);
        assert.equal(res.statusCode, 200);
        assert.equal(payloadOf(res).flagActive, false);
        assert.ok(!payloadOf(res).note.includes('--beads-dir'), `expected no flag-override caveat, got: ${payloadOf(res).note}`);
        assert.equal(payloadOf(res).restartRequired, true);
        // The console re-renders its Current block straight from this
        // response; without `source` the Source row reads "unknown" the
        // instant a save succeeds. 'config' is what the saved value resolves
        // to at the next startup, not the pre-save 'walk-up' this route was
        // mounted with.
        assert.equal(payloadOf(res).source, 'config');
    });

    test('the route only opens supervisor.config.json through project-config.mjs -- writing via the route and reading via readSupervisorConfig agree on the same file', async () => {
        const token = 'l'.repeat(64);
        const projectDir = await mkTmp('proj-samefile-');
        const dataDir = await mkTmp('data-');
        const supervisor = mountProjectRoute({ token, projectDir, dataDir });
        const target = await mkTmp('proj-samefile-target-');

        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/project', { headers: AUTH(token), body: { projectDir: target } }), res);
        assert.equal(res.statusCode, 200);

        const onDisk = JSON.parse(await fsp.readFile(supervisorConfigPath({ dataDir }), 'utf-8'));
        assert.equal(onDisk.projectDir, target);
    });
});
