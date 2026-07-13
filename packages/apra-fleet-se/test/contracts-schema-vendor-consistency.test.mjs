import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// apra-fleet-unw2.5 -- consistency test between contracts.mjs's hand-written
// fallback literals (section 3) and the vendored schema files they mirror.
//
// Purpose: a future vendor/apra-pm submodule bump can change a role's
// output schema (add/remove a required field, change an enum, etc.)
// without anyone remembering to update the corresponding FALLBACK_* literal
// in contracts.mjs in the same commit. Until that literal is updated, it is
// silently WRONG for the (currently rare, but real) window between "the
// bump landed" and "the vendored file is unexpectedly missing again" (e.g.
// a later partial revert) -- or simply stale documentation that misleads a
// future reader of contracts.mjs section 3. This test catches that drift
// mechanically: whenever the vendored directory is available (here,
// simulated via the fixture snapshot), every fallback literal must be
// structurally identical to its vendored counterpart.
//
// "Structurally identical" deliberately excludes $id/$schema/version/title/
// description: the vendored files carry provenance metadata the
// hand-written literals never had and never need (see normalizeShape
// below) -- the property this test protects is "would ajv validate the
// same data the same way", not "is the file byte-identical".

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'vendor-apra-pm-schemas');

const { FALLBACK_SCHEMAS, ROLE_FOR_SCHEMA_NAME } = await import('../auto-sprint/contracts.mjs');

/**
 * Dynamically (re)imports contracts.mjs with
 * APRA_FLEET_SE_SCHEMAS_DIR pointed at `overrideDir`,
 * restoring the previous env var afterward. Cache-busted per call. Mirrors
 * the helper in test/contracts-schema-loader.test.mjs /
 * test/contracts-schema-observability.test.mjs.
 * @param {string} overrideDir
 */
async function importWired(overrideDir) {
    const previous = process.env.APRA_FLEET_SE_SCHEMAS_DIR;
    process.env.APRA_FLEET_SE_SCHEMAS_DIR = overrideDir;
    try {
        return await import(`../auto-sprint/contracts.mjs?consistency-test=${Date.now()}-${Math.random()}`);
    } finally {
        if (previous === undefined) {
            delete process.env.APRA_FLEET_SE_SCHEMAS_DIR;
        } else {
            process.env.APRA_FLEET_SE_SCHEMAS_DIR = previous;
        }
    }
}

/**
 * Reduces a JSON schema to only the parts that determine ajv validation
 * behavior (type/properties/required), stripping provenance-only metadata
 * ($id, $schema, version, title, description) that is expected to differ
 * between a vendored file and its hand-written fallback literal.
 * @param {object} schema
 */
function normalizeShape(schema) {
    return JSON.parse(JSON.stringify({
        type: schema.type,
        properties: schema.properties,
        required: schema.required,
    }));
}

/**
 * Asserts that `fallback` and `vendored` are structurally identical
 * (per normalizeShape), with a failure message that tells a future reader
 * exactly what to do.
 * @param {string} schemaName
 * @param {string} role
 * @param {object} fallback
 * @param {object} vendored
 */
function assertFallbackMatchesVendored(schemaName, role, fallback, vendored) {
    assert.deepStrictEqual(
        normalizeShape(fallback),
        normalizeShape(vendored),
        `contracts.mjs's FALLBACK_ literal for "${schemaName}" (role "${role}") has drifted from ` +
            `vendor/apra-pm/agents/schemas/${role}-output.json. Update the literal in the same commit ` +
            `as the submodule bump that changed it.`,
    );
}

describe('vendored-schema / fallback-literal consistency (apra-fleet-unw2.5)', () => {
    let wired;

    before(async () => {
        wired = await importWired(FIXTURES_DIR);
    });

    test('every FALLBACK_SCHEMAS entry has a corresponding SCHEMAS entry and role mapping', () => {
        assert.deepStrictEqual(Object.keys(FALLBACK_SCHEMAS).sort(), Object.keys(ROLE_FOR_SCHEMA_NAME).sort());
        for (const schemaName of Object.keys(FALLBACK_SCHEMAS)) {
            assert.ok(schemaName in wired.SCHEMAS, `expected SCHEMAS.${schemaName} to exist`);
        }
    });

    describe('AC: every resolved SCHEMAS entry actually came from the vendored file, not silently the fallback', () => {
        for (const [schemaName, role] of Object.entries(ROLE_FOR_SCHEMA_NAME)) {
            test(`${schemaName} (role "${role}")`, () => {
                const resolved = wired.SCHEMAS[schemaName];
                const fallback = FALLBACK_SCHEMAS[schemaName];
                assert.ok(
                    typeof resolved.$id === 'string' && resolved.$id.startsWith('apra-pm/'),
                    `expected SCHEMAS.${schemaName}.$id to look vendored (apra-pm/...), got ${JSON.stringify(resolved.$id)} -- ` +
                        'this means it silently resolved to the fallback literal even though the fixture directory exists.',
                );
                assert.notStrictEqual(
                    resolved.$id,
                    fallback.$id,
                    `SCHEMAS.${schemaName}.$id equals the fallback literal's $id -- looks like it did not resolve from the vendored file`,
                );
            });
        }
    });

    describe('AC: each fallback literal deep-equals (structurally) its vendored counterpart', () => {
        for (const [schemaName, role] of Object.entries(ROLE_FOR_SCHEMA_NAME)) {
            test(`${schemaName} (role "${role}")`, () => {
                assertFallbackMatchesVendored(schemaName, role, FALLBACK_SCHEMAS[schemaName], wired.SCHEMAS[schemaName]);
            });
        }
    });
});

describe('AC: fixture drift is actually caught (mutate one byte in a test-local copy)', () => {
    let tmpDir;

    before(() => {
        tmpDir = fs.mkdtempSync(path.join(__dirname, 'fixtures', 'tmp-mutated-fixture-'));
        for (const file of fs.readdirSync(FIXTURES_DIR)) {
            fs.copyFileSync(path.join(FIXTURES_DIR, file), path.join(tmpDir, file));
        }
    });

    after(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('mutating one character of doer-output.json\'s enum makes the consistency check fail', async () => {
        const target = path.join(tmpDir, 'doer-output.json');
        const original = fs.readFileSync(target, 'utf-8');
        // Target the enum literal specifically -- "VERIFY" also appears
        // earlier in this file's free-text "description" field (which
        // normalizeShape() deliberately ignores), so a non-anchored
        // replace() would silently mutate the wrong occurrence and this
        // test would pass for the wrong reason.
        assert.ok(original.includes('["VERIFY", "BLOCKED"]'), 'test setup: fixture no longer contains the literal this test mutates -- update this test');

        // One-character mutation (Y -> B), same length, still valid JSON,
        // changes properties.status.enum -- this is exactly the class of
        // drift (a vendored enum changing without the fallback literal
        // being updated) this consistency check exists to catch.
        const mutated = original.replace('["VERIFY", "BLOCKED"]', '["VERIFB", "BLOCKED"]');
        assert.notStrictEqual(mutated, original);
        fs.writeFileSync(target, mutated, 'utf-8');

        const mutatedWired = await importWired(tmpDir);

        assert.throws(
            () => assertFallbackMatchesVendored('doerReport', 'doer', FALLBACK_SCHEMAS.doerReport, mutatedWired.SCHEMAS.doerReport),
            (err) => err instanceof assert.AssertionError,
            'expected the consistency check to throw against a fixture mutated by even one byte',
        );
    });

    test('the real (unmutated) committed fixture does NOT trip that same check (control)', async () => {
        // Sanity: prove the previous test's failure is due to the mutation,
        // not the checking logic itself always throwing.
        const cleanWired = await importWired(FIXTURES_DIR);
        assert.doesNotThrow(() => assertFallbackMatchesVendored('doerReport', 'doer', FALLBACK_SCHEMAS.doerReport, cleanWired.SCHEMAS.doerReport));
    });
});
