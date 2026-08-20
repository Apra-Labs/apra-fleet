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

// apra-fleet-n4lu.2 -- end-to-end regression coverage for apra-fleet-n4lu.1
// (which vendored packages/apra-fleet-se/src/supervisor/lib/exec-bd.mjs so
// backlog.mjs/scope-overlap.mjs stop importing the repo-root-relative
// '../../../../scripts/lib/exec-bd.mjs' -- a path that only resolves inside a
// git checkout, NOT inside a packaged/installed apra-fleet-se tree, because
// scripts/ sits entirely outside packages/apra-fleet-se/ and is additionally
// one of PACKAGE_TREE_EXCLUDE_DIRS, apra-fleet-n4lu).
//
// Both tests below build a REAL installed tree the same way `apra-fleet
// install` does -- buildDevManifest() + extractWorkflowSubsystemAssets()
// (src/cli/install.ts / src/cli/workflow-assets.ts), into an isolated tmp
// $HOME -- rather than hand-simulating "a packaged layout", so a regression
// in either the vendoring fix OR the packaging pipeline itself would be
// caught here.
//
//   1. "packaged tree self-containment" -- a fast, no-process-spawn check:
//      the installed backlog.mjs/scope-overlap.mjs import cleanly (static
//      ESM imports resolve at dynamic-import time, so a reintroduced
//      escaping import would throw ERR_MODULE_NOT_FOUND right here) and the
//      old escaping path is asserted absent on disk.
//   2. "deployed supervisor boots" -- a real `node bin/serve.mjs --port
//      8788`-equivalent subprocess, spawned FROM the installed tree with cwd
//      set to an arbitrary, unrelated project directory (never the repo,
//      never the installed tree itself), asserting it boots (GET
//      /api/health) and serves GET/POST /api/sprints.

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
 * below, shared by both describe blocks). dist/cli/workflow-assets.js's own
 * (non-cache-busted) internal `import ... from './config.js'` binds to
 * whichever `dist/cli/config.js` module instance the process loaded FIRST --
 * a second cache-busted re-import of workflow-assets.js in the SAME process
 * still extracts against that first-bound WORKFLOWS_DIR/NODE_MODULES_DIR
 * (the first tmp $HOME), even though the caller's OWN direct, cache-busted
 * `dist/cli/config.js` import correctly reflects the NEW $HOME -- so the
 * extraction silently lands under the wrong (first) tmp $HOME and this
 * function's own existsSync() assertion fails against the (correct, but
 * never populated) second tmp $HOME. A real `apra-fleet install` invocation
 * never hits this: it is always a brand-new process, so there is only ever
 * one `config.js` load. This is purely a same-process, call-it-twice test
 * artifact.
 *
 * @returns {Promise<{ tmpHome: string, fleetSprintDir: string }>}
 */
async function installPackagedFleetSprintTree() {
    const tmpHome = await mkTmp('n4lu2-home-');
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    try {
        process.env.HOME = tmpHome;
        process.env.USERPROFILE = tmpHome;

        const cacheBust = `${Date.now()}-${Math.random()}`;
        const installMod = await import(`${pathToFileURL(path.join(ROOT, 'dist/cli/install.js')).href}?n4lu2=${cacheBust}`);
        const assetsMod = await import(`${pathToFileURL(path.join(ROOT, 'dist/cli/workflow-assets.js')).href}?n4lu2=${cacheBust}`);
        const configMod = await import(`${pathToFileURL(path.join(ROOT, 'dist/cli/config.js')).href}?n4lu2=${cacheBust}`);

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

// One real install, shared by both describe blocks below -- see
// installPackagedFleetSprintTree()'s doc comment for why this must not be
// called more than once per process.
/** @type {{ tmpHome: string, fleetSprintDir: string }} */
let installed;
before(async () => {
    installed = await installPackagedFleetSprintTree();
});

// -----------------------------------------------------------------------------
// (1) packaged tree self-containment: no ERR_MODULE_NOT_FOUND at import time
// -----------------------------------------------------------------------------
describe('n4lu.2: packaged apra-fleet-se tree is self-contained (no repo-root scripts/lib/ escape)', () => {
    test('installed backlog.mjs/scope-overlap.mjs import cleanly and resolve execBdAsync from the in-tree lib/exec-bd.mjs', async () => {
        const { fleetSprintDir } = installed;
        const supervisorDir = path.join(fleetSprintDir, 'src', 'supervisor');

        // The vendored copy this task pins must actually ship inside the
        // installed tree.
        const vendoredExecBd = path.join(supervisorDir, 'lib', 'exec-bd.mjs');
        assert.ok(fs.existsSync(vendoredExecBd), `installed tree is missing ${vendoredExecBd}`);

        // Regression pin: the OLD escaping import ('../../../../scripts/lib/
        // exec-bd.mjs', resolved from src/supervisor/{backlog,scope-overlap}.mjs)
        // must not exist anywhere in this tmp install -- proving that IF the
        // vendored copy were removed and the old import reintroduced, the
        // dynamic imports below would genuinely throw ERR_MODULE_NOT_FOUND
        // rather than accidentally succeeding against some other tree.
        const oldEscapingPath = path.resolve(supervisorDir, '..', '..', '..', 'scripts', 'lib', 'exec-bd.mjs');
        assert.ok(
            !fs.existsSync(oldEscapingPath),
            `sanity check failed: the pre-fix escaping import path (${oldEscapingPath}) unexpectedly exists in this tmp install`
        );

        // Static imports are resolved at dynamic-import time -- if either
        // module still imported the escaping path, this would throw
        // ERR_MODULE_NOT_FOUND right here (the exact failure apra-fleet-n4lu
        // filed against the deployed supervisor).
        const cacheBust = `${Date.now()}-${Math.random()}`;
        const backlogUrl = `${pathToFileURL(path.join(supervisorDir, 'backlog.mjs')).href}?n4lu2=${cacheBust}`;
        const scopeOverlapUrl = `${pathToFileURL(path.join(supervisorDir, 'scope-overlap.mjs')).href}?n4lu2=${cacheBust}`;

        let backlogMod;
        try {
            backlogMod = await import(backlogUrl);
        } catch (err) {
            assert.fail(`importing installed backlog.mjs threw (expected clean import): ${err?.stack ?? err}`);
        }
        let scopeOverlapMod;
        try {
            scopeOverlapMod = await import(scopeOverlapUrl);
        } catch (err) {
            assert.fail(`importing installed scope-overlap.mjs threw (expected clean import): ${err?.stack ?? err}`);
        }

        assert.equal(typeof backlogMod.registerBacklogRoutes, 'function');
        assert.equal(typeof backlogMod.bdListAllBeadsRaw, 'function');
        assert.equal(typeof scopeOverlapMod.createScopeGuard, 'function');
        assert.equal(typeof scopeOverlapMod.bdListChildren, 'function');

        // Both importers must point at the in-tree copy, not the escaping path.
        for (const [label, file] of [['backlog.mjs', path.join(supervisorDir, 'backlog.mjs')], ['scope-overlap.mjs', path.join(supervisorDir, 'scope-overlap.mjs')]]) {
            const src = fs.readFileSync(file, 'utf-8');
            assert.match(src, /from ['"]\.\/lib\/exec-bd\.mjs['"]/, `${label} no longer imports execBdAsync from the in-tree './lib/exec-bd.mjs'`);
            assert.doesNotMatch(src, /scripts\/lib\/exec-bd\.mjs/, `${label} still references the repo-root-relative scripts/lib/exec-bd.mjs path`);
        }
    });
});

// -----------------------------------------------------------------------------
// (2) real supervisor boot from the packaged tree, arbitrary cwd
// -----------------------------------------------------------------------------
describe('n4lu.2: deployed supervisor boots without ERR_MODULE_NOT_FOUND and serves /api/sprints', () => {
    test('node <installed>/bin/serve.mjs --port 8788 (cwd = arbitrary project dir) boots and answers GET/POST /api/sprints', async () => {
        const { fleetSprintDir } = installed;
        const serveBin = path.join(fleetSprintDir, 'bin', 'serve.mjs');
        assert.ok(fs.existsSync(serveBin), `installed tree is missing ${serveBin}`);

        // An arbitrary project directory -- deliberately NOT the repo root,
        // NOT the installed tree, and unrelated to either -- mirrors how a
        // real operator's shell cwd has nothing to do with where
        // ~/.apra-fleet/workflows/fleet-sprint lives.
        const arbitraryCwd = await mkTmp('n4lu2-arbitrary-cwd-');
        const dataDir = await mkTmp('n4lu2-data-');
        const seDataDir = await mkTmp('n4lu2-se-data-');
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
        // the process exits first -- e.g. on a reintroduced ERR_MODULE_NOT_FOUND.
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
                assert.fail(`timed out waiting for /api/health from the packaged supervisor.\nstderr so far:\n${stderrBuf}`);
            }
            // eslint-disable-next-line no-await-in-loop
            await sleep(100);
        }

        assert.doesNotMatch(stderrBuf, /ERR_MODULE_NOT_FOUND/, `packaged supervisor logged ERR_MODULE_NOT_FOUND:\n${stderrBuf}`);

        // GET /api/sprints: a fresh ledger, so an empty (but well-formed) list.
        const getSprints = await httpRequest(port, '/api/sprints');
        assert.equal(getSprints.status, 200, `GET /api/sprints did not respond 200: ${getSprints.body}`);
        const getBody = JSON.parse(getSprints.body);
        assert.deepEqual(getBody.sprints, []);
        assert.ok('scopeFreshness' in getBody);

        // POST /api/sprints: an empty body deterministically fails request
        // validation (missing 'issue') -- what matters here is that the
        // packaged supervisor actually ROUTES and RESPONDS to the request
        // (never a connection failure / silent crash), not that it launches.
        const postSprints = await httpRequest(port, '/api/sprints', 'POST');
        assert.equal(postSprints.status, 400, `POST /api/sprints (empty body) did not respond 400: ${postSprints.body}`);
        const postBody = JSON.parse(postSprints.body);
        assert.ok(postBody.error, 'POST /api/sprints error response is missing an "error" field');

        // Clean shutdown -- the in-band way to stop; confirms the process is
        // still fully alive and responsive after both requests above.
        const shutdown = await httpRequest(port, '/api/shutdown', 'POST');
        assert.equal(shutdown.status, 200);

        await Promise.race([
            new Promise((resolve) => { serve.once('exit', resolve); if (exited) resolve(); }),
            sleep(10000).then(() => { throw new Error('serve.mjs did not exit after /api/shutdown'); }),
        ]);
        assert.equal(serve.exitCode, 0, 'packaged serve.mjs should exit 0 on /api/shutdown');
        assert.doesNotMatch(stderrBuf, /ERR_MODULE_NOT_FOUND/, `packaged supervisor logged ERR_MODULE_NOT_FOUND after boot:\n${stderrBuf}`);
    });
});
