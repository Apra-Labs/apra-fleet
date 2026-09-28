import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
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
// =============================================================================

/** @type {string[]} */
const tmpDirs = [];

after(async () => {
    for (const dir of tmpDirs) {
        // eslint-disable-next-line no-await-in-loop
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
});

async function mkTmp(prefix = 'apra-fleet-project-route-') {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
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

/** Builds a supervisor with the project-folder routes mounted exactly the
 *  way bin/serve.mjs does. */
function mountProjectRoute({ token, projectDir, source = 'walk-up', flagActive = false, dataDir }) {
    const supervisor = createSupervisor({ token });
    registerProjectFolderRoutes(supervisor, {
        projectDir, source, flagActive, dataDir, readJsonBody, sendJson,
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

        const config = await readSupervisorConfig({ dataDir });
        assert.equal(config.configured, false, 'a rejected write must never persist');
    });

    test('POST an existing path with no .beads -> 200, ACCEPTED and persisted, hasBeadsDb:false (staleness-tolerant)', async () => {
        const token = 'g'.repeat(64);
        const projectDir = await mkTmp('proj-accept-nobeads-');
        const dataDir = await mkTmp('data-');
        const supervisor = mountProjectRoute({ token, projectDir, dataDir });
        const target = await mkTmp('proj-accept-nobeads-target-');

        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/project', { headers: AUTH(token), body: { projectDir: target } }), res);
        assert.equal(res.statusCode, 200);
        assert.equal(payloadOf(res).projectDir, target);
        assert.equal(payloadOf(res).hasBeadsDb, false);

        const config = await readSupervisorConfig({ dataDir });
        assert.equal(config.configured, true);
        assert.equal(config.projectDir, target);
    });

    test('POST an existing path WITH .beads -> 200, persisted, hasBeadsDb:true', async () => {
        const token = 'h'.repeat(64);
        const projectDir = await mkTmp('proj-accept-beads-');
        const dataDir = await mkTmp('data-');
        const supervisor = mountProjectRoute({ token, projectDir, dataDir });
        const target = await mkTmp('proj-accept-beads-target-');
        await fsp.mkdir(path.join(target, BEADS_DIR_NAME));

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
