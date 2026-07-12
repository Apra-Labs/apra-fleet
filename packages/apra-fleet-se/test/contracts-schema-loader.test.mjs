import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// apra-fleet-unw.22 -- tests for contracts.mjs's reframing as a thin
// adapter over vendor/apra-pm/agents/schemas/, per
// packages/apra-fleet-workflow/docs/agent-schema-layering-proposal.md
// sections 4.3 (output schemas) and 6.3 (input pre-flight validation).
//
// Two groups of tests here:
//
//   1. Pure loader-primitive tests (loadSchemaFileFrom, assertVersionPin)
//      against test/fixtures/ -- these do not depend on module-load-time
//      resolution and can run against the module however it was imported.
//
//   2. "Wired" end-to-end tests (SCHEMAS / validateRoleInput actually
//      resolving from vendored files) -- these need contracts.mjs's
//      module-load-time resolution to see fixture content, so they set
//      APRA_FLEET_SE_VENDOR_SCHEMAS_DIR_TEST_OVERRIDE *before* importing
//      contracts.mjs. This only works because `node --test` isolates each
//      test file in its own process by default (Node 20+), so this
//      env-var + dynamic-import trick cannot leak into other test files.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'vendor-apra-pm-schemas');
const VERSION_MISMATCH_FIXTURES_DIR = path.join(__dirname, 'fixtures', 'vendor-apra-pm-schemas-version-mismatch');

// -----------------------------------------------------------------------
// Group 1: loader primitives
// -----------------------------------------------------------------------

const { loadSchemaFileFrom, assertVersionPin, majorVersionFromId } = await import('../auto-sprint/contracts.mjs');

describe('loadSchemaFileFrom (loader primitive)', () => {
    test('AC2: reads real schema content from a fixture snapshot of vendor/apra-pm/agents/schemas/', () => {
        const harvester = loadSchemaFileFrom(FIXTURES_DIR, 'harvester-output');
        assert.ok(harvester, 'expected harvester-output.json to load');
        assert.strictEqual(harvester.$id, 'apra-pm/harvester-output@1');
        assert.deepStrictEqual(harvester.required, ['status', 'notes']);
        assert.deepStrictEqual(harvester.properties.status.enum, ['OK', 'FAILED']);

        const reviewer = loadSchemaFileFrom(FIXTURES_DIR, 'reviewer-output');
        assert.ok(reviewer, 'expected reviewer-output.json to load');
        assert.strictEqual(reviewer.$id, 'apra-pm/reviewer-output@1');
        assert.deepStrictEqual(reviewer.required, ['verdict', 'notes', 'reopenIds', 'newTasks']);
    });

    test('AC2: reads input schema content too', () => {
        const harvesterInput = loadSchemaFileFrom(FIXTURES_DIR, 'harvester-input');
        assert.ok(harvesterInput);
        assert.deepStrictEqual(harvesterInput.required, [
            'analysisArtifactFile',
            'analysisText',
            'costAnalysis',
            'base-branch',
            'branch',
        ]);

        const reviewerInput = loadSchemaFileFrom(FIXTURES_DIR, 'reviewer-input');
        assert.ok(reviewerInput);
        assert.deepStrictEqual(reviewerInput.required, ['base-branch', 'branch']);
    });

    test('AC3: returns null (not a throw) when the file is absent -- the fallback-shim signal', () => {
        // "planner" deliberately has no output schema file anywhere (per
        // the proposal, planner's output IS the beads DAG), so this proves
        // the absent-file path without needing a synthetic fixture.
        const result = loadSchemaFileFrom(FIXTURES_DIR, 'planner');
        assert.strictEqual(result, null);
    });

    test('throws on a malformed (non-JSON) schema file, distinct from the absent-file case', () => {
        const tmpDir = fs.mkdtempSync(path.join(__dirname, 'fixtures', 'tmp-malformed-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'broken.json'), '{ not valid json', 'utf-8');
            assert.throws(() => loadSchemaFileFrom(tmpDir, 'broken'), /not valid JSON/);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('majorVersionFromId', () => {
    test('extracts the trailing @<major> from an apra-pm $id', () => {
        assert.strictEqual(majorVersionFromId('apra-pm/harvester-output@1'), 1);
        assert.strictEqual(majorVersionFromId('apra-pm/reviewer-input@12'), 12);
    });

    test('returns null for a non-string or non-conforming id', () => {
        assert.strictEqual(majorVersionFromId(undefined), null);
        assert.strictEqual(majorVersionFromId('no-version-suffix'), null);
    });
});

describe('assertVersionPin (loader primitive)', () => {
    test('does not throw when the vendored major version matches expectations', () => {
        const harvester = loadSchemaFileFrom(FIXTURES_DIR, 'harvester-output');
        assert.doesNotThrow(() => assertVersionPin('harvester', harvester, 1));
    });

    test('AC4: throws loudly when the vendored $id major version does not match', () => {
        const mismatched = loadSchemaFileFrom(VERSION_MISMATCH_FIXTURES_DIR, 'harvester-output');
        assert.ok(mismatched, 'expected the version-mismatch fixture to load');
        assert.strictEqual(mismatched.$id, 'apra-pm/harvester-output@2');
        assert.throws(
            () => assertVersionPin('harvester', mismatched, 1),
            /Version-pin mismatch for role "harvester"/,
        );
    });
});

// -----------------------------------------------------------------------
// Group 2: end-to-end wiring, module resolved against the fixture dir
// -----------------------------------------------------------------------

describe('SCHEMAS / validateRoleInput resolved against a fixture vendor/apra-pm', () => {
    let wired;

    before(async () => {
        const previous = process.env.APRA_FLEET_SE_VENDOR_SCHEMAS_DIR_TEST_OVERRIDE;
        process.env.APRA_FLEET_SE_VENDOR_SCHEMAS_DIR_TEST_OVERRIDE = FIXTURES_DIR;
        // Cache-bust so this import re-runs contracts.mjs's module-level
        // resolution against the override, independent of the (uncached,
        // since this is a distinct URL) import above.
        wired = await import(`../auto-sprint/contracts.mjs?wired-test=${Date.now()}`);
        if (previous === undefined) {
            delete process.env.APRA_FLEET_SE_VENDOR_SCHEMAS_DIR_TEST_OVERRIDE;
        } else {
            process.env.APRA_FLEET_SE_VENDOR_SCHEMAS_DIR_TEST_OVERRIDE = previous;
        }
    });

    test('AC2: SCHEMAS.harvesterReport is loaded from the fixture file, not the fallback literal', () => {
        assert.strictEqual(wired.harvesterReport.$id, 'apra-pm/harvester-output@1');
        assert.ok('description' in wired.harvesterReport, 'vendored schema has a description field the fallback literal never had');
    });

    test('AC2: SCHEMAS.reviewerVerdict is loaded from the fixture file', () => {
        assert.strictEqual(wired.reviewerVerdict.$id, 'apra-pm/reviewer-output@1');
    });

    test('AC3: a role with no fixture file (e.g. none provided for "finalVerdict"'
        + ' -- application-owned, never loaded from vendor) keeps its literal', () => {
        assert.strictEqual(wired.finalVerdict.$id, 'finalVerdict');
    });

    test('loaded schemas still validate real fixture data end-to-end via VALIDATORS', () => {
        const result = wired.validateVerdict('harvesterReport', { status: 'OK', notes: 'ok' });
        assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
    });

    describe('validateRoleInput (AC5)', () => {
        test('harvester: rejects a context missing required input fields', () => {
            const result = wired.validateRoleInput('harvester', {
                'base-branch': 'main',
                branch: 'feat/x',
                // analysisArtifactFile, analysisText, costAnalysis all missing
            });
            assert.strictEqual(result.valid, false);
            assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
        });

        test('harvester: accepts a complete context', () => {
            const result = wired.validateRoleInput('harvester', {
                analysisArtifactFile: 'sprint-logs/feat-x.md',
                analysisText: 'Sprint analysis...',
                costAnalysis: '$1.23 total',
                'base-branch': 'main',
                branch: 'feat/x',
            });
            assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
            assert.strictEqual(result.errors, null);
        });

        test('reviewer: rejects a context missing required input fields', () => {
            const result = wired.validateRoleInput('reviewer', { branch: 'feat/x' }); // base-branch missing
            assert.strictEqual(result.valid, false);
            assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
        });

        test('reviewer: accepts a complete context', () => {
            const result = wired.validateRoleInput('reviewer', { 'base-branch': 'main', branch: 'feat/x' });
            assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
        });

        test('no-ops (passes) for a role with no input schema file at all', () => {
            // "planner" has no <role>-input.json in the fixture set (or
            // anywhere) -- proves the no-op/pass path from proposal
            // section 6.3, distinct from a validation failure.
            const result = wired.validateRoleInput('planner', {});
            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.errors, null);
        });

        test('throws on an unknown role string', () => {
            assert.throws(() => wired.validateRoleInput('not-a-role', {}), /unknown role/);
        });
    });
});

// -----------------------------------------------------------------------
// Group 3: fallback shim against THIS checkout's real (unbumped) submodule
// -----------------------------------------------------------------------

describe('fallback shim against the real (unbumped) vendor/apra-pm submodule', () => {
    test('AC3: contracts.mjs imports and exports usable schemas even though this checkout'
        + ' has not bumped the vendor/apra-pm submodule pointer to include unw.21 schemas yet', async () => {
        // Imports the module the NORMAL way (no override), i.e. exactly
        // how runner.js imports it. If vendor/apra-pm/agents/schemas/ is
        // genuinely absent in this checkout (the expected state -- see the
        // TEMPORARY STATE note in contracts.mjs), every export below comes
        // from the fallback literals; if the submodule has since been
        // bumped, it comes from the real vendored files. Either way the
        // shapes below must hold -- this is exactly what "shim" means.
        const real = await import('../auto-sprint/contracts.mjs');
        for (const name of ['planReviewerVerdict', 'reviewerVerdict', 'doerReport', 'deployerReport', 'integReport', 'ciReport', 'harvesterReport']) {
            assert.ok(real.SCHEMAS[name], `expected SCHEMAS.${name} to be defined`);
            assert.strictEqual(real.SCHEMAS[name].type, 'object');
            assert.ok(Array.isArray(real.SCHEMAS[name].required) && real.SCHEMAS[name].required.length > 0);
        }
    });
});
