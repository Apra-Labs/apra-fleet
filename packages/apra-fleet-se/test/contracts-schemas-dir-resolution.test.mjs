import { test, describe } from 'node:test';
import assert from 'node:assert';

// apra-fleet-bun.1 -- unit tests for contracts.mjs's resolveSchemasDir(),
// the bundled-location-first, layout-aware schema directory resolver. Each
// branch is exercised in isolation via the `deps` injection point (env,
// exists) rather than real directories on disk, so this file does not need
// to touch process.env or the filesystem at all -- see
// test/contracts-schema-loader.test.mjs for the separate end-to-end
// (real-fixture, real env var) wiring tests.

const { resolveSchemasDir } = await import('../auto-sprint/contracts.mjs');

describe('resolveSchemasDir', () => {
    test('branch 1: APRA_FLEET_SE_SCHEMAS_DIR env override wins outright, no exists() check needed', () => {
        const result = resolveSchemasDir({
            env: { APRA_FLEET_SE_SCHEMAS_DIR: '/fixture/override' },
            exists: () => {
                throw new Error('exists() must not be called when the env override is set');
            },
        });
        assert.strictEqual(result, '/fixture/override');
    });

    test('branch 2: dist/agents/schemas wins when it exists, even if the package-local and monorepo dirs also exist', () => {
        const result = resolveSchemasDir({
            env: {},
            exists: (candidate) => true,
        });
        assert.ok(candidate_matches(result, 'dist', 'agents', 'schemas'), result);
    });

    test('branch 3: falls through to packages/apra-fleet-se/apra-pm/agents/schemas when dist/agents/schemas is absent', () => {
        const result = resolveSchemasDir({
            env: {},
            exists: (candidate) => !candidate_matches(candidate, 'dist', 'agents', 'schemas'),
        });
        assert.ok(candidate_matches(result, 'apra-fleet-se', 'apra-pm', 'agents', 'schemas'), result);
    });

    test('branch 4: returns null when none of the candidates exist -- the quiet fallback-literal signal', () => {
        const result = resolveSchemasDir({ env: {}, exists: () => false });
        assert.strictEqual(result, null);
    });

    test('empty-string env override is treated as unset (falls through to directory probing)', () => {
        const result = resolveSchemasDir({
            env: { APRA_FLEET_SE_SCHEMAS_DIR: '' },
            exists: () => false,
        });
        assert.strictEqual(result, null);
    });
});

/**
 * True if every one of `parts` appears, in order, in `candidatePath`'s
 * path segments -- a loose, OS-path-separator-agnostic way to assert
 * "this resolved to roughly the directory I expect" without hardcoding
 * '/' vs '\\'.
 * @param {string} candidatePath
 * @param {...string} parts
 * @returns {boolean}
 */
function candidate_matches(candidatePath, ...parts) {
    const normalized = candidatePath.replace(/\\/g, '/');
    let cursor = 0;
    for (const part of parts) {
        const idx = normalized.indexOf(part, cursor);
        if (idx === -1) return false;
        cursor = idx + part.length;
    }
    return true;
}
