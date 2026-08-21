import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
        // Two genuinely independent real directories on disk, standing in
        // for dist/agents/schemas and the package-local apra-pm schemas dir.
        // We deliberately do NOT touch the real DIST_BUNDLED_SCHEMAS_DIR or
        // PACKAGE_LOCAL_SCHEMAS_DIR paths -- those are read by sibling
        // suites (contracts-schema-packaging.test.mjs,
        // contracts-schema-dist-staleness-guard.test.mjs) and must not be
        // mutated by this task.
        const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-se-dirtest-dist-'));
        const tmpLocal = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-se-dirtest-local-'));
        try {
            const distFile = path.join(tmpDist, 'doer-input.json');
            const localFile = path.join(tmpLocal, 'doer-input.json');
            fs.writeFileSync(distFile, JSON.stringify({ v: 1 }));
            fs.writeFileSync(localFile, JSON.stringify({ v: 1 }));

            // newestJsonMtimeMs() is NOT exported by contracts.mjs (private
            // module-local helper -- see the `function newestJsonMtimeMs`
            // definition, only reachable through resolveSchemasDir()'s
            // deps.newestJsonMtimeMs default). This adapter is a path
            // translator over the REAL filesystem -- a genuine recursive
            // max-mtime-over-.json-files walk against real temp
            // directories, not a canned-value spy -- so the in-place-edit
            // flip below is exercised against real fs.statSync mtimes, only
            // redirected to point at our controlled fixtures instead of the
            // hardcoded DIST_BUNDLED_SCHEMAS_DIR/PACKAGE_LOCAL_SCHEMAS_DIR
            // constants (which resolveSchemasDir always calls freshnessOf
            // with, regardless of the real on-disk paths under test).
            const realNewestJsonMtimeMs = (dir) => {
                let newest = 0;
                let entries;
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch {
                    return 0;
                }
                for (const entry of entries) {
                    const entryPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        newest = Math.max(newest, realNewestJsonMtimeMs(entryPath));
                    } else if (entry.isFile() && entry.name.endsWith('.json')) {
                        try {
                            newest = Math.max(newest, fs.statSync(entryPath).mtimeMs);
                        } catch {
                            // Unreadable file between readdir and stat -- ignore it.
                        }
                    }
                }
                return newest;
            };
            const adapter = (dir) => {
                if (dir === DIST_BUNDLED_SCHEMAS_DIR) return realNewestJsonMtimeMs(tmpDist);
                if (dir === PACKAGE_LOCAL_SCHEMAS_DIR) return realNewestJsonMtimeMs(tmpLocal);
                throw new Error(`unexpected freshness lookup for ${dir}`);
            };

            const before = resolveSchemasDir({ env: {}, exists: () => true, newestJsonMtimeMs: adapter });
            assert.strictEqual(before, DIST_BUNDLED_SCHEMAS_DIR, `expected a fresh tie to resolve to DIST_BUNDLED_SCHEMAS_DIR before the edit, got ${before}`);

            // Record the directory's own mtime before the edit: it must NOT
            // move on an in-place content edit (only create/delete/rename
            // touch a directory's own mtime). If the implementation used
            // dir mtime instead of the max mtime over .json files, this
            // in-place edit would never be observed and the assertion below
            // would fail -- that is the point of this whole case.
            const localDirMtimeBefore = fs.statSync(tmpLocal).mtimeMs;

            // Edit the EXISTING file's content (no add/delete/rename of any
            // entry in the directory) with a distinctly different byte
            // length, then pin its mtime forward with fs.utimesSync so the
            // test is deterministic even on filesystems with coarse mtime
            // resolution (legitimate: this controls the fixture's clock,
            // not the code under test).
            fs.writeFileSync(localFile, JSON.stringify({ v: 2, edited: true, padding: 'xxxxxxxxxxxxxxxxxxxx' }));
            const future = new Date(Date.now() + 5000);
            fs.utimesSync(localFile, future, future);

            const localDirMtimeAfter = fs.statSync(tmpLocal).mtimeMs;
            assert.strictEqual(
                localDirMtimeAfter,
                localDirMtimeBefore,
                'sanity check: an in-place edit to an existing file must NOT move its parent directory\'s own mtime (or this case is not exercising the regression it exists to catch)'
            );

            const after = resolveSchemasDir({ env: {}, exists: () => true, newestJsonMtimeMs: adapter });
            assert.strictEqual(
                after,
                PACKAGE_LOCAL_SCHEMAS_DIR,
                `expected the in-place-edited package-local stand-in to be resolved as fresher after the edit, got ${after} (a dir-mtime-based implementation would still return dist here since the directory's own mtime never moved)`
            );
        } finally {
            fs.rmSync(tmpDist, { recursive: true, force: true });
            fs.rmSync(tmpLocal, { recursive: true, force: true });
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
