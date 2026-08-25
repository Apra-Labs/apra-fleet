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

// apra-fleet-7h6n.4 -- merged from n4lu2-packaged-supervisor-boot.test.mjs,
// qqof-supervisor-selfcontained-audit.test.mjs, and
// qqof2-installed-supervisor-endpoints.test.mjs, each of which independently
// built a REAL installed tree (buildDevManifest() + extractWorkflowSubsystem-
// Assets(), src/cli/install.ts / src/cli/workflow-assets.ts, into an isolated
// tmp $HOME -- the same code path `apra-fleet install` uses) via a
// copy-pasted helper differing only in its tmp-dir prefix, and n4lu2 and
// qqof2 each additionally spawned their OWN real `node bin/serve.mjs`
// subprocess to check overlapping endpoints (qqof2's own header comment
// conceded n4lu.2 already does the real-boot check for GET/POST
// /api/sprints). Consolidated here into ONE install + ONE supervisor boot,
// shared by every describe block below, while preserving every distinct
// assertion the three originals made:
//
//   1. "packaged tree self-containment" (n4lu.2) -- a fast, no-process-spawn
//      check: the installed backlog.mjs/scope-overlap.mjs import cleanly
//      (static ESM imports resolve at dynamic-import time, so a
//      reintroduced escaping import would throw ERR_MODULE_NOT_FOUND right
//      here) and the old escaping path is asserted absent on disk.
//   2. "full supervisor-reachable import-graph audit" (qqof.1) -- a static
//      walk of EVERY module reachable from the installed bin/serve.mjs,
//      asserting each resolves inside the installed tree (broader than (1):
//      catches an out-of-tree import from ANY supervisor-reachable module,
//      not just backlog.mjs/scope-overlap.mjs), plus two narrower pins
//      (the n4lu.1 vendored exec-bd.mjs is reachable and ships; contracts.
//      mjs's package-local vendored-schema dir ships).
//   3. "deployed supervisor boots and serves its endpoints" (n4lu.2 + qqof.2
//      merged into ONE spawn+boot+shutdown cycle instead of two) -- a real
//      `node bin/serve.mjs --port <port>` subprocess, spawned FROM the
//      installed tree with cwd set to an arbitrary, unrelated project
//      directory (never the repo, never the installed tree itself,
//      confirming nothing resolves relative to cwd either), asserting it
//      boots (GET /api/health) and serves GET/POST /api/sprints (n4lu.2)
//      and GET /api/members (qqof.2, reachable via api.mjs's
//      createSprintController() -> fleet-members.mjs -- the second endpoint
//      qqof.2's acceptance criteria called out by name).
//
// test/fyc3-se-package-json-shipped.test.mjs is DELIBERATELY NOT merged
// here -- its checks are static package.json assertions needing no install
// at all (see that file for its own cache-busted os.homedir() pattern).

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
 * Waits for `child` to exit, or rejects after `timeoutMs`. Unlike a plain
 * `Promise.race([exitPromise, sleep(timeoutMs).then(() => throw ...)])` (the
 * shape all three original files used), the losing timer here is explicitly
 * `clearTimeout()`'d the instant the process actually exits (apra-fleet-
 * 7h6n.4 timing fix) -- a bare, un-cleared `setTimeout(..., 10000)` keeps
 * the event loop alive for the FULL 10s regardless of which race arm wins,
 * which is what made each original boot test (and this merged one, before
 * this fix) pad ~10s onto the process's wall time even though the actual
 * shutdown completes in milliseconds. Confirmed via instrumented timing
 * markers that removing this dangling timer is what the bead's targeted
 * wall-time reduction actually comes from -- the boot/install/teardown work
 * itself was already only a few hundred ms.
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function waitForExit(child, timeoutMs) {
    return new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            reject(new Error(`process did not exit within ${timeoutMs}ms`));
        }, timeoutMs);
        function onExit() {
            clearTimeout(timer);
            resolve();
        }
        child.once('exit', onExit);
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
 * IMPORTANT (apra-fleet-7h6n.4): called from a SINGLE `before()` below,
 * shared by every describe block in this file -- MUST run at most once per
 * process. dist/cli/workflow-assets.js's own (non-cache-busted) internal
 * `import ... from './config.js'` binds to whichever `dist/cli/config.js`
 * module instance the process loaded FIRST -- a second cache-busted
 * re-import of workflow-assets.js in the SAME process still extracts
 * against that first-bound WORKFLOWS_DIR/NODE_MODULES_DIR (the first tmp
 * $HOME), even though the caller's OWN direct, cache-busted `dist/cli/
 * config.js` import correctly reflects the NEW $HOME -- so the extraction
 * silently lands under the wrong (first) tmp $HOME and this function's own
 * existsSync() assertion fails against the (correct, but never populated)
 * second tmp $HOME. A real `apra-fleet install` invocation never hits this:
 * it is always a brand-new process, so there is only ever one `config.js`
 * load. This is purely a same-process, call-it-twice test artifact -- the
 * exact reason the three original files (each calling this once, in their
 * OWN process) never collided, and the exact reason this merged file must
 * keep calling it only once.
 *
 * @returns {Promise<{ tmpHome: string, fleetSprintDir: string }>}
 */
async function installPackagedFleetSprintTree() {
    const tmpHome = await mkTmp('installed-supervisor-home-');
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    try {
        process.env.HOME = tmpHome;
        process.env.USERPROFILE = tmpHome;

        const cacheBust = `${Date.now()}-${Math.random()}`;
        const installMod = await import(`${pathToFileURL(path.join(ROOT, 'dist/cli/install.js')).href}?installed-supervisor=${cacheBust}`);
        const assetsMod = await import(`${pathToFileURL(path.join(ROOT, 'dist/cli/workflow-assets.js')).href}?installed-supervisor=${cacheBust}`);
        const configMod = await import(`${pathToFileURL(path.join(ROOT, 'dist/cli/config.js')).href}?installed-supervisor=${cacheBust}`);

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

// -----------------------------------------------------------------------------
// Static import-graph walker (qqof.1)
// -----------------------------------------------------------------------------

// `import ... from '...'`, side-effect `import '...'`, and `export ... from
// '...'` -- the static ESM specifiers Node resolves at (dynamic-)import time.
const STATIC_SPEC_RE = /(?:^|\n)\s*(?:import\b[^'"]*?from\s*|import\s*|export\b[^'"]*?from\s*)['"]([^'"]+)['"]/g;
// `import('...')` with a string literal (a variable/template dynamic import
// cannot be resolved statically; there are none on this graph -- see the audit
// doc -- and any newly introduced one would be caught by the fs-read/spawn scan
// rather than here).
const DYN_SPEC_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractSpecifiers(src) {
    const specs = [];
    let m;
    while ((m = STATIC_SPEC_RE.exec(src))) specs.push(m[1]);
    while ((m = DYN_SPEC_RE.exec(src))) specs.push(m[1]);
    return specs;
}

/**
 * Resolves a relative/absolute specifier to an on-disk file, trying the exact
 * path first, then the `.mjs`/`.js` and `index.*` completions Node's ESM
 * resolver would apply. Returns null if none exist on disk.
 */
function resolveOnDisk(fromFile, spec) {
    const target = path.resolve(path.dirname(fromFile), spec);
    for (const cand of [target, `${target}.mjs`, `${target}.js`, path.join(target, 'index.mjs'), path.join(target, 'index.js')]) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
    }
    return null;
}

/**
 * Walks the static import graph from `entry`, returning { visited, outOfTree,
 * unresolved }. A specifier that is a bare module (node builtin or npm dep) is
 * skipped -- only relative/absolute specifiers can escape the packaged tree.
 */
function walkImportGraph(entry, treeRoot) {
    const visited = new Set();
    const outOfTree = [];
    const unresolved = [];
    const treePrefix = treeRoot.endsWith(path.sep) ? treeRoot : treeRoot + path.sep;

    function walk(file, importer) {
        if (visited.has(file)) return;
        visited.add(file);
        if (file !== treeRoot && !file.startsWith(treePrefix)) {
            outOfTree.push({ file, importer });
            return; // do not recurse outside the tree
        }
        let src;
        try {
            src = fs.readFileSync(file, 'utf-8');
        } catch {
            return;
        }
        for (const spec of extractSpecifiers(src)) {
            if (!spec.startsWith('.') && !spec.startsWith('/')) continue; // bare module
            const resolved = resolveOnDisk(file, spec);
            if (resolved) walk(resolved, file);
            else unresolved.push({ spec, from: file });
        }
    }

    walk(entry, null);
    return { visited, outOfTree, unresolved };
}

// One real install, shared by EVERY describe block below -- see
// installPackagedFleetSprintTree()'s doc comment for why this must not be
// called more than once per process.
/** @type {{ tmpHome: string, fleetSprintDir: string }} */
let installed;
before(async () => {
    installed = await installPackagedFleetSprintTree();
});

// -----------------------------------------------------------------------------
// (1) packaged tree self-containment (n4lu.2): no ERR_MODULE_NOT_FOUND at
// import time for the two files apra-fleet-n4lu.1 vendored.
// -----------------------------------------------------------------------------
describe('installed-supervisor: packaged apra-fleet-se tree is self-contained (n4lu.2, no repo-root scripts/lib/ escape)', () => {
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
        const backlogUrl = `${pathToFileURL(path.join(supervisorDir, 'backlog.mjs')).href}?installed-supervisor=${cacheBust}`;
        const scopeOverlapUrl = `${pathToFileURL(path.join(supervisorDir, 'scope-overlap.mjs')).href}?installed-supervisor=${cacheBust}`;

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
// (2) full supervisor-reachable import-graph self-containment audit (qqof.1)
// -----------------------------------------------------------------------------
describe('installed-supervisor: the entire supervisor-reachable import graph is self-contained in the installed tree (qqof.1)', () => {
    test('every module reachable from the installed bin/serve.mjs resolves inside the installed tree', async () => {
        const { fleetSprintDir } = installed;
        const entry = path.join(fleetSprintDir, 'bin', 'serve.mjs');
        assert.ok(fs.existsSync(entry), `installed tree is missing ${entry}`);

        const { visited, outOfTree, unresolved } = walkImportGraph(entry, fleetSprintDir);

        // The graph must be non-trivial -- a walker that silently resolved
        // nothing would vacuously "pass".
        assert.ok(visited.size >= 30, `expected the supervisor import graph to reach >=30 modules, got ${visited.size}`);

        const rel = (f) => path.relative(fleetSprintDir, f);
        assert.deepEqual(
            outOfTree.map((o) => `${rel(o.file)} <- ${o.importer ? rel(o.importer) : 'ENTRY'}`),
            [],
            'supervisor-reachable module(s) resolve OUTSIDE the installed tree (source-only / repo-root escape)'
        );
        assert.deepEqual(
            unresolved.map((u) => `${u.spec} (from ${rel(u.from)})`),
            [],
            'supervisor-reachable relative/absolute import(s) do not resolve to a file inside the installed tree'
        );
    });

    test('the n4lu.1 vendored exec-bd.mjs is part of the reachable graph and ships in-tree', async () => {
        const { fleetSprintDir } = installed;
        const entry = path.join(fleetSprintDir, 'bin', 'serve.mjs');
        const { visited } = walkImportGraph(entry, fleetSprintDir);
        const vendored = path.join(fleetSprintDir, 'src', 'supervisor', 'lib', 'exec-bd.mjs');
        assert.ok(fs.existsSync(vendored), `installed tree is missing the n4lu.1 vendored ${vendored}`);
        assert.ok(visited.has(vendored), 'the vendored exec-bd.mjs is not reachable from serve.mjs (n4lu.1 coverage regressed)');
    });

    test('contracts.mjs package-local vendored-schema dir ships in the installed tree', async () => {
        // The one runtime fs-read of a source-tree file on a reachable path is
        // contracts.mjs's resolveSchemasDir(). Its package-local candidate must
        // ship so the loader never has to fall all the way back to literals in
        // a normal install (its dist/ candidate is a build-only artifact).
        const { fleetSprintDir } = installed;
        const schemasDir = path.join(fleetSprintDir, 'apra-pm', 'agents', 'schemas');
        assert.ok(fs.existsSync(schemasDir), `installed tree is missing the package-local schema dir ${schemasDir}`);
        const jsonFiles = fs.readdirSync(schemasDir).filter((f) => f.endsWith('.json'));
        assert.ok(jsonFiles.length > 0, `package-local schema dir ${schemasDir} shipped no *.json schema files`);
    });
});

// -----------------------------------------------------------------------------
// (3) deployed supervisor boots and serves its endpoints -- n4lu.2's
// GET/POST /api/sprints coverage MERGED with qqof.2's GET /api/members
// coverage into ONE spawn+boot+shutdown cycle (apra-fleet-7h6n.4) instead of
// the two originals ran independently.
// -----------------------------------------------------------------------------
describe('installed-supervisor: deployed supervisor boots without ERR_MODULE_NOT_FOUND and serves /api/sprints + /api/members (n4lu.2 + qqof.2)', () => {
    test('node <installed>/bin/serve.mjs --port <port> (cwd = arbitrary project dir, no source repo on the resolution path) boots and answers GET/POST /api/sprints and GET /api/members', async () => {
        const { fleetSprintDir } = installed;
        const serveBin = path.join(fleetSprintDir, 'bin', 'serve.mjs');
        assert.ok(fs.existsSync(serveBin), `installed tree is missing ${serveBin}`);

        // (qqof.2) Sanity: the source repo's scripts/ dir (excluded by
        // PACKAGE_TREE_EXCLUDE_DIRS) must genuinely be absent from this
        // installed tree, so a clean boot below proves nothing supervisor-
        // reachable depends on it -- rather than accidentally succeeding
        // because scripts/ happened to still be present somewhere nearby.
        const scriptsDir = path.join(fleetSprintDir, 'scripts');
        assert.ok(!fs.existsSync(scriptsDir), `installed tree unexpectedly ships ${scriptsDir} -- test setup is not exercising a source-repo-free layout`);

        // An arbitrary project directory -- deliberately NOT the repo root,
        // NOT the installed tree, and unrelated to either -- mirrors how a
        // real operator's shell cwd has nothing to do with where
        // ~/.apra-fleet/workflows/fleet-sprint lives, and confirms nothing
        // resolves relative to cwd either.
        const arbitraryCwd = await mkTmp('installed-supervisor-arbitrary-cwd-');
        const dataDir = await mkTmp('installed-supervisor-data-');
        const seDataDir = await mkTmp('installed-supervisor-se-data-');
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

        // (n4lu.2 + qqof.2) GET /api/sprints: a fresh ledger, so an empty
        // (but well-formed) list.
        const getSprints = await httpRequest(port, '/api/sprints');
        assert.equal(getSprints.status, 200, `GET /api/sprints did not respond 200: ${getSprints.body}`);
        const sprintsBody = JSON.parse(getSprints.body);
        assert.deepEqual(sprintsBody.sprints, []);
        assert.ok('scopeFreshness' in sprintsBody);

        // (n4lu.2) POST /api/sprints: an empty body deterministically fails
        // request validation (missing 'issue') -- what matters here is that
        // the installed supervisor actually ROUTES and RESPONDS to the
        // request (never a connection failure / silent crash), not that it
        // launches.
        const postSprints = await httpRequest(port, '/api/sprints', 'POST');
        assert.equal(postSprints.status, 400, `POST /api/sprints (empty body) did not respond 400: ${postSprints.body}`);
        const postBody = JSON.parse(postSprints.body);
        assert.ok(postBody.error, 'POST /api/sprints error response is missing an "error" field');

        // (qqof.2) GET /api/members: fleet-members.mjs degrades to an empty
        // member list (never throws) when no fleet HTTP singleton is
        // reachable -- exactly the case in this isolated sandbox -- so what
        // matters here is that the route is reachable and well-formed at
        // all, proving the whole GET /api/members import path (api.mjs ->
        // fleet-members.mjs -> @apralabs/apra-fleet-client) resolved
        // cleanly inside the installed tree.
        const getMembers = await httpRequest(port, '/api/members');
        assert.equal(getMembers.status, 200, `GET /api/members did not respond 200: ${getMembers.body}`);
        const membersBody = JSON.parse(getMembers.body);
        assert.ok(Array.isArray(membersBody.members), `GET /api/members response is missing a "members" array: ${getMembers.body}`);

        assert.doesNotMatch(stderrBuf, /ERR_MODULE_NOT_FOUND/, `installed supervisor logged ERR_MODULE_NOT_FOUND after serving /api/sprints and /api/members:\n${stderrBuf}`);

        // Clean shutdown -- the in-band way to stop; confirms the process is
        // still fully alive and responsive after every request above.
        const shutdown = await httpRequest(port, '/api/shutdown', 'POST');
        assert.equal(shutdown.status, 200);

        await waitForExit(serve, 10000);
        assert.equal(serve.exitCode, 0, 'installed serve.mjs should exit 0 on /api/shutdown');
        assert.doesNotMatch(stderrBuf, /ERR_MODULE_NOT_FOUND/, `installed supervisor logged ERR_MODULE_NOT_FOUND after boot:\n${stderrBuf}`);
    });
});
