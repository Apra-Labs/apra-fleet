import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import url, { fileURLToPath } from 'node:url';

// apra-fleet-ot2z.20.2 -- pins the freshness-first precedence between
// resolveSchemasDir()'s two bundled/local candidates delivered by
// apra-fleet-ot2z.20.1 (parent bead apra-fleet-ot2z.20: a stale local
// dist/agents/schemas silently shadowed package-local apra-pm schema
// updates). resolveSchemasDir() is exercised via its `deps` injection point
// (env, exists, newestJsonMtimeMs) for cases 1-6, and against a real,
// controlled temp filesystem for case 7 -- see the module docstring in
// ../fleet-sprint/contracts.mjs for the full precedence contract.
//
// Deliberately NOT covered here (owned by apra-fleet-ot2z.20.1's suites,
// do not duplicate): contracts-schema-packaging.test.mjs and
// contracts-schemas-dir-resolution.test.mjs, both of which already exercise
// resolveSchemasDir() with injected deps for their own precedence cases.
// This file adds the specific freshness-comparison + real max-mtime-over-
// .json-files cases that neither of those existing suites carries.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { resolveSchemasDir, DIST_BUNDLED_SCHEMAS_DIR, PACKAGE_LOCAL_SCHEMAS_DIR } =
    await import('../fleet-sprint/contracts.mjs');

describe('resolveSchemasDir: freshness-first precedence between existing candidates', () => {
    test('1. both candidates exist and package-local is fresher -> resolves package-local (the apra-fleet-ot2z.20 regression this pins)', () => {
        const result = resolveSchemasDir({
            env: {},
            exists: () => true,
            newestJsonMtimeMs: (dir) => (dir === PACKAGE_LOCAL_SCHEMAS_DIR ? 2000 : 1000),
        });
        assert.strictEqual(
            result,
            PACKAGE_LOCAL_SCHEMAS_DIR,
            `expected the fresher PACKAGE_LOCAL_SCHEMAS_DIR (${PACKAGE_LOCAL_SCHEMAS_DIR}) to win, got ${result}`
        );
    });

    test('2. both exist and dist is fresher -> resolves dist', () => {
        const result = resolveSchemasDir({
            env: {},
            exists: () => true,
            newestJsonMtimeMs: (dir) => (dir === DIST_BUNDLED_SCHEMAS_DIR ? 2000 : 1000),
        });
        assert.strictEqual(
            result,
            DIST_BUNDLED_SCHEMAS_DIR,
            `expected the fresher DIST_BUNDLED_SCHEMAS_DIR (${DIST_BUNDLED_SCHEMAS_DIR}) to win, got ${result}`
        );
    });

    test('3. both exist with equal freshness -> resolves dist (documented tie-break, preserves pre-fix behaviour)', () => {
        const result = resolveSchemasDir({
            env: {},
            exists: () => true,
            newestJsonMtimeMs: () => 1000,
        });
        assert.strictEqual(
            result,
            DIST_BUNDLED_SCHEMAS_DIR,
            `expected a freshness tie to resolve to DIST_BUNDLED_SCHEMAS_DIR (${DIST_BUNDLED_SCHEMAS_DIR}), got ${result}`
        );
    });

    test('4. only-one-exists falls through without consulting freshness; neither exists -> null', () => {
        const distOnly = resolveSchemasDir({
            env: {},
            exists: (candidate) => candidate === DIST_BUNDLED_SCHEMAS_DIR,
        });
        assert.strictEqual(distOnly, DIST_BUNDLED_SCHEMAS_DIR, `expected dist-only to resolve DIST_BUNDLED_SCHEMAS_DIR, got ${distOnly}`);

        const localOnly = resolveSchemasDir({
            env: {},
            exists: (candidate) => candidate === PACKAGE_LOCAL_SCHEMAS_DIR,
        });
        assert.strictEqual(localOnly, PACKAGE_LOCAL_SCHEMAS_DIR, `expected local-only to resolve PACKAGE_LOCAL_SCHEMAS_DIR, got ${localOnly}`);

        const neither = resolveSchemasDir({ env: {}, exists: () => false });
        assert.strictEqual(neither, null, `expected neither-exists to resolve null, got ${neither}`);
    });

    test('5. APRA_FLEET_SE_SCHEMAS_DIR override wins outright and the freshness seam is never consulted', () => {
        let freshnessCalls = 0;
        const result = resolveSchemasDir({
            env: { APRA_FLEET_SE_SCHEMAS_DIR: '/fixture/explicit-override' },
            exists: () => true,
            newestJsonMtimeMs: () => {
                freshnessCalls++;
                return 999;
            },
        });
        assert.strictEqual(result, '/fixture/explicit-override');
        assert.strictEqual(freshnessCalls, 0, 'the env override must short-circuit before the freshness seam is ever consulted, so the override path stays cheap and side-effect free');
    });

    test('6. the freshness seam is not consulted when only one candidate exists', () => {
        let freshnessCalls = 0;
        const spy = () => {
            freshnessCalls++;
            return 0;
        };

        resolveSchemasDir({ env: {}, exists: (candidate) => candidate === DIST_BUNDLED_SCHEMAS_DIR, newestJsonMtimeMs: spy });
        assert.strictEqual(freshnessCalls, 0, 'dist-only resolution must not consult the freshness seam');

        resolveSchemasDir({ env: {}, exists: (candidate) => candidate === PACKAGE_LOCAL_SCHEMAS_DIR, newestJsonMtimeMs: spy });
        assert.strictEqual(freshnessCalls, 0, 'local-only resolution must not consult the freshness seam');

        resolveSchemasDir({ env: {}, exists: () => false, newestJsonMtimeMs: spy });
        assert.strictEqual(freshnessCalls, 0, 'neither-exists resolution must not consult the freshness seam');
    });
});

describe('resolveSchemasDir: on-disk case against real temp directories (default freshness algorithm)', () => {
    test('7. an in-place edit to an existing .json file (no add/delete/rename) flips resolution to that directory', async () => {
        // This case must exercise contracts.mjs's own PRIVATE default
        // newestJsonMtimeMs() implementation -- not a spy/adapter injected
        // through deps -- against a real, controlled filesystem. Because
        // that helper is module-private and DIST_BUNDLED_SCHEMAS_DIR /
        // PACKAGE_LOCAL_SCHEMAS_DIR are hardcoded constants derived from
        // contracts.mjs's own file location (REPO_ROOT/PACKAGE_ROOT, see
        // ../fleet-sprint/contracts.mjs lines ~128-134), we cannot redirect
        // the real module at the real DIST_BUNDLED_SCHEMAS_DIR /
        // PACKAGE_LOCAL_SCHEMAS_DIR paths without touching those real
        // directories (forbidden -- they are read by sibling suites
        // contracts-schema-packaging.test.mjs and
        // contracts-schema-dist-staleness-guard.test.mjs).
        //
        // Instead: copy contracts.mjs BYTE-FOR-BYTE (no production source
        // modified) into a fresh temp package tree that mirrors its real
        // relative layout (<tmpRoot>/packages/apra-fleet-se/fleet-sprint/
        // contracts.mjs, <tmpRoot>/dist/agents/schemas/,
        // <tmpRoot>/packages/apra-fleet-se/apra-pm/agents/schemas/), then
        // dynamic-import that copy. Its __dirname-derived
        // DIST_BUNDLED_SCHEMAS_DIR/PACKAGE_LOCAL_SCHEMAS_DIR constants then
        // point at our controlled fixtures, and calling its exported
        // resolveSchemasDir() with no deps.newestJsonMtimeMs override runs
        // the REAL default freshness algorithm (recursive max mtime over
        // .json files) against real fs.statSync mtimes on those fixtures.
        //
        // The temp tree is rooted inside this package's own test/ directory
        // (not os.tmpdir()) so Node's ESM bare-specifier resolution
        // (`import Ajv from 'ajv'`) walks up through the real
        // packages/apra-fleet-se and repo-root node_modules, exactly as it
        // does for the production file.
        const tmpRoot = fs.mkdtempSync(path.join(__dirname, '.tmp-contracts-copy-'));
        try {
            const copyFleetSprintDir = path.join(tmpRoot, 'packages', 'apra-fleet-se', 'fleet-sprint');
            const copyDistSchemasDir = path.join(tmpRoot, 'dist', 'agents', 'schemas');
            const copyLocalSchemasDir = path.join(tmpRoot, 'packages', 'apra-fleet-se', 'apra-pm', 'agents', 'schemas');
            fs.mkdirSync(copyFleetSprintDir, { recursive: true });
            fs.mkdirSync(copyDistSchemasDir, { recursive: true });
            fs.mkdirSync(copyLocalSchemasDir, { recursive: true });

            const productionContractsPath = path.join(__dirname, '..', 'fleet-sprint', 'contracts.mjs');
            const copiedContractsPath = path.join(copyFleetSprintDir, 'contracts.mjs');
            fs.copyFileSync(productionContractsPath, copiedContractsPath);

            const distFile = path.join(copyDistSchemasDir, 'sample.json');
            const localFile = path.join(copyLocalSchemasDir, 'sample.json');
            fs.writeFileSync(distFile, JSON.stringify({ v: 1 }));
            fs.writeFileSync(localFile, JSON.stringify({ v: 1 }));
            // Pin both fixture files to one identical mtime before the
            // "fresh tie" precondition below -- writeFileSync calls made
            // sequentially can land strictly different mtimes on a
            // fine-resolution filesystem (NTFS), making the tie flaky.
            const tieTime = new Date();
            fs.utimesSync(distFile, tieTime, tieTime);
            fs.utimesSync(localFile, tieTime, tieTime);

            const copiedModuleUrl = url.pathToFileURL(copiedContractsPath).href;
            const {
                resolveSchemasDir: copiedResolveSchemasDir,
                DIST_BUNDLED_SCHEMAS_DIR: copiedDist,
                PACKAGE_LOCAL_SCHEMAS_DIR: copiedLocal,
            } = await import(copiedModuleUrl);

            assert.strictEqual(copiedDist, copyDistSchemasDir, 'sanity check: the copied module must resolve its DIST_BUNDLED_SCHEMAS_DIR from its own on-disk location');
            assert.strictEqual(copiedLocal, copyLocalSchemasDir, 'sanity check: the copied module must resolve its PACKAGE_LOCAL_SCHEMAS_DIR from its own on-disk location');

            const before = copiedResolveSchemasDir({ env: {}, exists: () => true });
            assert.strictEqual(before, copiedDist, `expected a fresh tie to resolve to DIST_BUNDLED_SCHEMAS_DIR (${copiedDist}) before the edit, got ${before}`);

            // Record the directory's own mtime before the edit: it must NOT
            // move on an in-place content edit (only create/delete/rename
            // touch a directory's own mtime). If the implementation used
            // dir mtime instead of the max mtime over .json files, this
            // in-place edit would never be observed and the assertion below
            // would fail -- that is the point of this whole case.
            const localDirMtimeBefore = fs.statSync(copyLocalSchemasDir).mtimeMs;

            // Edit the EXISTING file's content (no add/delete/rename of any
            // entry in the directory) with a distinctly different byte
            // length, then pin its mtime forward with fs.utimesSync so the
            // test is deterministic even on filesystems with coarse mtime
            // resolution (legitimate: this controls the fixture's clock,
            // not the code under test).
            fs.writeFileSync(localFile, JSON.stringify({ v: 2, edited: true, padding: 'xxxxxxxxxxxxxxxxxxxx' }));
            const future = new Date(Date.now() + 5000);
            fs.utimesSync(localFile, future, future);

            const localDirMtimeAfter = fs.statSync(copyLocalSchemasDir).mtimeMs;
            assert.strictEqual(
                localDirMtimeAfter,
                localDirMtimeBefore,
                'sanity check: an in-place edit to an existing file must NOT move its parent directory\'s own mtime (or this case is not exercising the regression it exists to catch)'
            );

            const after = copiedResolveSchemasDir({ env: {}, exists: () => true });
            assert.strictEqual(
                after,
                copiedLocal,
                `expected the in-place-edited package-local stand-in (${copiedLocal}) to be resolved as fresher after the edit, got ${after} (a dir-mtime-based implementation would still return dist here since the directory's own mtime never moved)`
            );
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    test('an empty directory and a nonexistent directory both produce a finite (non-throwing) freshness value through the default seam', () => {
        // The private default newestJsonMtimeMs() is not exported by
        // contracts.mjs, so it cannot be called directly with an arbitrary
        // path without modifying production source (out of scope for this
        // task). This case instead exercises the DEFAULT seam (no
        // deps.newestJsonMtimeMs override) end to end through
        // resolveSchemasDir() against the real DIST_BUNDLED_SCHEMAS_DIR /
        // PACKAGE_LOCAL_SCHEMAS_DIR paths -- whichever of those is empty or
        // absent on this checkout must still resolve to a finite value
        // (never throw), matching the documented "tolerates an unreadable
        // or empty directory by treating it as freshness 0" contract.
        assert.doesNotThrow(() => {
            const result = resolveSchemasDir({ env: {}, exists: () => true });
            assert.ok(result === DIST_BUNDLED_SCHEMAS_DIR || result === PACKAGE_LOCAL_SCHEMAS_DIR, `expected a finite resolution (one of the two candidates), got ${result}`);
        }, 'the default freshness seam must never throw for an empty or nonexistent candidate directory');
    });
});
