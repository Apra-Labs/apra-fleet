import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// apra-fleet-qqof.2 -- end-to-end verification of full supervisor
// self-containment against a clean INSTALLED layout (no git checkout of the
// source repo on PATH or reachable via relative imports), covering the audit
// findings from apra-fleet-qqof.1 (qqof-supervisor-selfcontained-audit.test.mjs,
// a STATIC import-graph walk) with a REAL process boot.
//
// apra-fleet-n4lu.2 (n4lu2-packaged-supervisor-boot.test.mjs) already does
// this real-boot check for GET/POST /api/sprints. This test reuses the same
// "install via buildDevManifest()/extractWorkflowSubsystemAssets() into an
// isolated tmp $HOME, spawn node bin/serve.mjs from an arbitrary cwd" pattern
// and additionally asserts GET /api/members responds successfully -- the
// second endpoint apra-fleet-qqof.2's acceptance criteria calls out by name,
// and one qqof.1 specifically had to make self-contained: fleet-members.mjs
// (GET /api/members's collaborator) is reachable from serve.mjs via
// api.mjs's createSprintController(), so a reintroduced source-repo-only
// import anywhere on that path would fail this boot the same way it would
// fail the static audit.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

/** @type {Set<string>} */
const tmpDirs = new Set();
/** @type {Set<number>} */
const spawnedPids = new Set();

async function mkTmp(prefix) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpDirs.add(dir);
    // Resolve symlinks (e.g. macOS's /var -> /private/var) up front: serve.mjs's
    // own isMainModule() compares `import.meta.url` (which Node resolves through
    // realpath when loading an ES module) against
    // `pathToFileURL(process.argv[1]).href` (the raw path we spawn with) for
    // strict string equality -- a real macOS tmp dir path is NOT its own
    // realpath, so an unresolved path here would make isMainModule() return
    // false and serve.mjs silently exit 0 without ever calling serveMain(),
    // which has nothing to do with the packaging bug this suite covers.
    return fsp.realpath(dir);
}

function track(pid) {
    if (Number.isInteger(pid) && pid > 0) spawnedPids.add(pid);
    return pid;
}

function forceKill(pid) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

after(async () => {
    for (const pid of spawnedPids) forceKill(pid);
    spawnedPids.clear();
    for (const dir of tmpDirs) {
        // eslint-disable-next-line no-await-in-loop
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.clear();
});

function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Allocate a currently-free TCP port by binding to 0 and reading it back. */
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

function httpRequest(port, pathname, method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, path: pathname, method, timeout: 3000 },
            (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => resolve({ status: res.statusCode, body }));
            },
        );
        req.on('timeout', () => { req.destroy(new Error('request timeout')); });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Installs a real workflow-subsystem tree (workflowRuntime + agentSchemas +
 * the fleet-sprint builtin) into `<tmpHome>/.apra-fleet`, using the SAME
 * buildDevManifest()/extractWorkflowSubsystemAssets() code path `apra-fleet
 * install` uses -- not a hand-rolled copy -- so this test tracks the real
 * packaging pipeline (PACKAGE_TREE_EXCLUDE_DIRS etc.) rather than a stale
 * assumption about it.
 *
 * dist/cli/config.js captures os.homedir() at module-load time, so HOME/
 * USERPROFILE must be set and the module freshly imported (cache-busted)
 * before any of this runs -- see fyc3-se-package-json-shipped.test.mjs for
 * the same pattern.
 *
 * IMPORTANT: call this AT MOST ONCE per process (hence the single `before()`
 * below). dist/cli/workflow-assets.js's own (non-cache-busted) internal
 * `import ... from './config.js'` binds to whichever `dist/cli/config.js`
 * module instance the process loaded FIRST -- see
 * n4lu2-packaged-supervisor-boot.test.mjs's identical helper for the full
 * explanation.
 *
 * @returns {Promise<{ tmpHome: string, fleetSprintDir: string }>}
 */
async function installPackagedFleetSprintTree() {
    const tmpHome = await mkTmp('qqof2-home-');
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    try {
        process.env.HOME = tmpHome;
        process.env.USERPROFILE = tmpHome;

        const cacheBust = `${Date.now()}-${Math.random()}`;
        const installMod = await import(`${pathToFileURL(path.join(ROOT, 'dist/cli/install.js')).href}?qqof2=${cacheBust}`);
        const assetsMod = await import(`${pathToFileURL(path.join(ROOT, 'dist/cli/workflow-assets.js')).href}?qqof2=${cacheBust}`);
        const configMod = await import(`${pathToFileURL(path.join(ROOT, 'dist/cli/config.js')).href}?qqof2=${cacheBust}`);

        const manifest = installMod.buildDevManifest(ROOT);
        assert.ok(manifest.builtinWorkflows, 'buildDevManifest() produced no builtinWorkflows section');

        assetsMod.extractWorkflowSubsystemAssets({
            manifest,
            extractAssetBuffer: (key) => fs.readFileSync(path.join(ROOT, key)),
            version: '0.0.0-test',
            builtinNames: ['fleet-sprint'],
        });

        const fleetSprintDir = path.join(configMod.WORKFLOWS_DIR, 'fleet-sprint');
        assert.ok(fs.existsSync(fleetSprintDir), `install did not produce ${fleetSprintDir}`);
        return { tmpHome, fleetSprintDir };
    } finally {
        if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
        if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
    }
}

/** @type {{ tmpHome: string, fleetSprintDir: string }} */
let installed;
before(async () => {
    installed = await installPackagedFleetSprintTree();
});

describe('qqof.2: installed supervisor boots from a source-repo-free tree and serves /api/sprints and /api/members', () => {
    test('node <installed>/bin/serve.mjs --port <port> (cwd = arbitrary project dir, no source repo on the resolution path) boots clean and GET /api/sprints + GET /api/members both respond', async () => {
        const { fleetSprintDir } = installed;
        const serveBin = path.join(fleetSprintDir, 'bin', 'serve.mjs');
        assert.ok(fs.existsSync(serveBin), `installed tree is missing ${serveBin}`);

        // Sanity: the source repo's scripts/ dir (excluded by
        // PACKAGE_TREE_EXCLUDE_DIRS) must genuinely be absent from this
        // installed tree, so a clean boot here proves nothing supervisor-
        // reachable depends on it -- rather than accidentally succeeding
        // because scripts/ happened to still be present somewhere nearby.
        const scriptsDir = path.join(fleetSprintDir, 'scripts');
        assert.ok(!fs.existsSync(scriptsDir), `installed tree unexpectedly ships ${scriptsDir} -- test setup is not exercising a source-repo-free layout`);

        // An arbitrary project directory -- deliberately NOT the repo root,
        // NOT the installed tree, and unrelated to either -- mirrors how a
        // real operator's shell cwd has nothing to do with where
        // ~/.apra-fleet/workflows/fleet-sprint lives, and confirms nothing
        // resolves relative to cwd either.
        const arbitraryCwd = await mkTmp('qqof2-arbitrary-cwd-');
        const dataDir = await mkTmp('qqof2-data-');
        const seDataDir = await mkTmp('qqof2-se-data-');
        const port = await getFreePort();

        let stderrBuf = '';
        const serve = spawn(process.execPath, [serveBin, '--port', String(port)], {
            cwd: arbitraryCwd,
            stdio: ['ignore', 'ignore', 'pipe'],
            env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir, FLEET_SE_DATA_DIR: seDataDir },
        });
        track(serve.pid);
        serve.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf-8'); });
        let exited = false;
        serve.once('exit', () => { exited = true; });

        // Poll for /api/health, but fail fast (with the captured stderr) if
        // the process exits first -- e.g. on a reintroduced ERR_MODULE_NOT_FOUND
        // or other source-repo-relative resolution failure.
        const deadline = Date.now() + 20000;
        for (;;) {
            if (exited) {
                assert.fail(
                    `serve.mjs exited (code=${serve.exitCode}, signal=${serve.signalCode}) before ` +
                    `/api/health responded -- likely a packaging/module-resolution failure.\nstderr:\n${stderrBuf}`
                );
            }
            // eslint-disable-next-line no-await-in-loop
            const health = await httpRequest(port, '/api/health').catch(() => null);
            if (health && health.status === 200) break;
            if (Date.now() > deadline) {
                assert.fail(`timed out waiting for /api/health from the installed supervisor.\nstderr so far:\n${stderrBuf}`);
            }
            // eslint-disable-next-line no-await-in-loop
            await sleep(100);
        }

        assert.doesNotMatch(stderrBuf, /ERR_MODULE_NOT_FOUND/, `installed supervisor logged ERR_MODULE_NOT_FOUND:\n${stderrBuf}`);

        // GET /api/sprints: a fresh ledger, so an empty (but well-formed) list.
        const getSprints = await httpRequest(port, '/api/sprints');
        assert.equal(getSprints.status, 200, `GET /api/sprints did not respond 200: ${getSprints.body}`);
        const sprintsBody = JSON.parse(getSprints.body);
        assert.deepEqual(sprintsBody.sprints, []);
        assert.ok('scopeFreshness' in sprintsBody);

        // GET /api/members: fleet-members.mjs degrades to an empty member
        // list (never throws) when no fleet HTTP singleton is reachable --
        // exactly the case in this isolated sandbox -- so what matters here
        // is that the route is reachable and well-formed at all, proving the
        // whole GET /api/members import path (api.mjs -> fleet-members.mjs
        // -> @apralabs/apra-fleet-client) resolved cleanly inside the
        // installed tree.
        const getMembers = await httpRequest(port, '/api/members');
        assert.equal(getMembers.status, 200, `GET /api/members did not respond 200: ${getMembers.body}`);
        const membersBody = JSON.parse(getMembers.body);
        assert.ok(Array.isArray(membersBody.members), `GET /api/members response is missing a "members" array: ${getMembers.body}`);

        assert.doesNotMatch(stderrBuf, /ERR_MODULE_NOT_FOUND/, `installed supervisor logged ERR_MODULE_NOT_FOUND after serving /api/sprints and /api/members:\n${stderrBuf}`);

        // Clean shutdown -- the in-band way to stop; confirms the process is
        // still fully alive and responsive after both requests above.
        const shutdown = await httpRequest(port, '/api/shutdown', 'POST');
        assert.equal(shutdown.status, 200);

        await Promise.race([
            new Promise((resolve) => { serve.once('exit', resolve); if (exited) resolve(); }),
            sleep(10000).then(() => { throw new Error('serve.mjs did not exit after /api/shutdown'); }),
        ]);
        assert.equal(serve.exitCode, 0, 'installed serve.mjs should exit 0 on /api/shutdown');
    });
});
