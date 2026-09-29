import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSupervisor, readJsonBody, sendJson } from '../src/supervisor/server.mjs';
import { registerProjectFolderRoutes } from '../src/supervisor/project-route.mjs';
import {
    probeBeadsIdentity, createBeadsIdentityState, formatStaleConfiguredProjectWarning, LAUNCH_MODE,
} from '../src/supervisor/beads-identity.mjs';

// apra-fleet-i9ag.17.14 -- a git that cannot be SPAWNED (not on the
// supervisor's PATH) is reported as that, not as a missing origin remote; and
// restart guidance names 'apra-fleet restart' only for the installed service.
// execBd/execGit are injected: no real bd or git runs.

const tmpDirs = [];
after(async () => {
    for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
});
async function mkTmp(prefix) {
    const d = fs.realpathSync.native(await fsp.mkdtemp(path.join(os.tmpdir(), prefix)));
    tmpDirs.push(d);
    return d;
}

const execBd = async (args) => {
    if (args[0] === 'where') {
        return { stdout: JSON.stringify({ path: '/w/.beads', prefix: 'demo', database_path: '/w/.beads/db' }) };
    }
    return { stdout: JSON.stringify({ key: 'sync.remote', value: 'https://example.invalid/a/b.git' }) };
};
const gitEnoent = async () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }); };
const gitNoOrigin = async () => {
    throw Object.assign(new Error("fatal: No such remote 'origin'"), { code: 128 });
};

function mockReq(method, url, { headers = {}, body } = {}) {
    const chunks = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
    return {
        method, url, headers,
        on(event, cb) {
            if (event === 'data') for (const c of chunks) cb(c);
            if (event === 'end') cb();
            return this;
        },
    };
}
function mockRes() {
    return {
        statusCode: undefined, body: undefined, headersSent: false,
        writeHead(s) { this.statusCode = s; this.headersSent = true; },
        end(b) { this.body = b; },
    };
}

async function post(execGit, launchMode) {
    const token = 't'.repeat(64);
    const projectDir = await mkTmp('git-path-cur-');
    const dataDir = await mkTmp('git-path-data-');
    const target = await mkTmp('git-path-target-');
    const supervisor = createSupervisor({ token });
    registerProjectFolderRoutes(supervisor, {
        projectDir, source: 'walk-up', flagActive: false, dataDir, readJsonBody, sendJson,
        execBd, execGit, launchMode,
    });
    const res = mockRes();
    await supervisor.handleRequest(
        mockReq('POST', '/api/project', { headers: { authorization: `Bearer ${token}` }, body: { projectDir: target } }),
        res,
    );
    return { status: res.statusCode, body: JSON.parse(res.body) };
}

describe('git not on the supervisor PATH (apra-fleet-i9ag.17.14)', () => {
    test('POST with execGit ENOENT -> 400 naming the PATH cause and restart-after-install, not "git remote add origin"', async () => {
        const r = await post(gitEnoent, LAUNCH_MODE.INSTALLED_SERVICE);
        assert.equal(r.status, 400);
        assert.match(r.body.error, /git/);
        assert.match(r.body.error, /PATH/);
        assert.match(r.body.error, /just installed/);
        assert.match(r.body.error, /apra-fleet restart/);
        assert.doesNotMatch(r.body.error, /git remote add origin/);
        assert.ok(r.body.missing.includes('repoRemote'));
    });

    test('POST with execGit non-zero exit (no origin) keeps the "git remote add origin" guidance', async () => {
        const r = await post(gitNoOrigin, LAUNCH_MODE.STANDALONE);
        assert.equal(r.status, 400);
        assert.match(r.body.error, /git remote add origin/);
        assert.doesNotMatch(r.body.error, /PATH/);
        assert.ok(r.body.missing.includes('repoRemote'));
    });

    test('the startup/Health incomplete-identity warning carries the PATH cause only when git could not be spawned', async () => {
        const enoent = createBeadsIdentityState({
            cwd: '/w', launchMode: LAUNCH_MODE.STANDALONE,
            initial: await probeBeadsIdentity({ cwd: '/w', execBd, execGit: gitEnoent }),
        });
        assert.match(enoent.getWarning(), /PATH/);
        assert.doesNotMatch(enoent.getWarning(), /git remote add origin/);

        const noOrigin = createBeadsIdentityState({
            cwd: '/w', initial: await probeBeadsIdentity({ cwd: '/w', execBd, execGit: gitNoOrigin }),
        });
        assert.match(noOrigin.getWarning(), /git remote add origin/);
        assert.doesNotMatch(noOrigin.getWarning(), /PATH/);
    });
});

describe('restart guidance by launch mode (apra-fleet-i9ag.17.14)', () => {
    const completeGit = async () => ({ stdout: 'https://example.invalid/a/b.git\n' });

    test('save note names apra-fleet restart only in installed-service mode', async () => {
        const service = await post(completeGit, LAUNCH_MODE.INSTALLED_SERVICE);
        const standalone = await post(completeGit, LAUNCH_MODE.STANDALONE);
        const unspecified = await post(completeGit, undefined);
        assert.equal(service.status, 200);
        assert.match(service.body.note, /apra-fleet restart/);
        assert.equal(standalone.status, 200);
        assert.doesNotMatch(standalone.body.note, /run 'apra-fleet restart'/);
        assert.match(standalone.body.note, /restart the supervisor/);
        assert.doesNotMatch(unspecified.body.note, /run 'apra-fleet restart'/);
    });

    test('stale-config warning names apra-fleet restart only in installed-service mode', () => {
        const svc = formatStaleConfiguredProjectWarning('/gone', '/cfg.json', { launchMode: LAUNCH_MODE.INSTALLED_SERVICE });
        const solo = formatStaleConfiguredProjectWarning('/gone', '/cfg.json', { launchMode: LAUNCH_MODE.STANDALONE });
        assert.match(svc, /run 'apra-fleet restart'/);
        assert.doesNotMatch(solo, /run 'apra-fleet restart'/);
        assert.match(solo, /does not manage a standalone launch/);
    });
});
