import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// apra-fleet-qqof.1 -- full supervisor-reachable import-graph self-containment
// audit, enforced against a REAL installed tree.
//
// apra-fleet-n4lu.2 (n4lu2-packaged-supervisor-boot.test.mjs) pins the TWO
// files n4lu.1 fixed (backlog.mjs/scope-overlap.mjs) and boots serve.mjs. This
// guard is broader: it walks the ENTIRE static import graph from the installed
// bin/serve.mjs and asserts EVERY resolved module lives inside the installed
// tree -- so a future out-of-tree import (repo-root-relative, source-only, or
// an escape into an excluded dir) from ANY supervisor-reachable module, not
// just the two n4lu files, fails here.
//
// The tree is built the SAME way `apra-fleet install` builds it
// (buildDevManifest() + extractWorkflowSubsystemAssets(), src/cli/install.ts /
// src/cli/workflow-assets.ts) into an isolated tmp $HOME, so this tracks the
// real packaging pipeline (PACKAGE_TREE_EXCLUDE_DIRS = {test,docs,scripts,
// examples}) rather than a hand-simulated layout.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

/** @type {Set<string>} */
const tmpDirs = new Set();

async function mkTmp(prefix) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpDirs.add(dir);
    return fsp.realpath(dir);
}

after(async () => {
    for (const dir of tmpDirs) {
        // eslint-disable-next-line no-await-in-loop
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.clear();
});

/**
 * Installs a real workflow-subsystem tree into `<tmpHome>/.apra-fleet` via the
 * SAME buildDevManifest()/extractWorkflowSubsystemAssets() code path
 * `apra-fleet install` uses. Call AT MOST ONCE per process -- see
 * n4lu2-packaged-supervisor-boot.test.mjs's installPackagedFleetSprintTree()
 * doc comment for why (dist/cli/config.js caches os.homedir() at load time and
 * workflow-assets.js's internal config.js import binds to the first load).
 *
 * @returns {Promise<{ tmpHome: string, fleetSprintDir: string }>}
 */
async function installPackagedFleetSprintTree() {
    const tmpHome = await mkTmp('qqof-home-');
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    try {
        process.env.HOME = tmpHome;
        process.env.USERPROFILE = tmpHome;

        const cacheBust = `${Date.now()}-${Math.random()}`;
        const installMod = await import(`${pathToFileURL(path.join(ROOT, 'dist/cli/install.js')).href}?qqof=${cacheBust}`);
        const assetsMod = await import(`${pathToFileURL(path.join(ROOT, 'dist/cli/workflow-assets.js')).href}?qqof=${cacheBust}`);
        const configMod = await import(`${pathToFileURL(path.join(ROOT, 'dist/cli/config.js')).href}?qqof=${cacheBust}`);

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
// Static import-graph walker
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

/** @type {{ tmpHome: string, fleetSprintDir: string }} */
let installed;
before(async () => {
    installed = await installPackagedFleetSprintTree();
});

describe('qqof.1: the entire supervisor-reachable import graph is self-contained in the installed tree', () => {
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
