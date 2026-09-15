import { test, describe } from 'node:test';
import assert from 'node:assert';

// apra-fleet-bun.1 -- unit tests for contracts.mjs's resolveSchemasDir(),
// the bundled-location-first, layout-aware schema directory resolver. Each
// branch is exercised in isolation via the `deps` injection point (env,
// exists) rather than real directories on disk, so this file does not need
// to touch process.env or the filesystem at all -- see
// test/contracts-schema-loader.test.mjs for the separate end-to-end
// (real-fixture, real env var) wiring tests.
//
// apra-fleet-j918.7.4: this file used to duplicate the whole precedence
// algorithm (env-override-wins, freshness-tie-to-dist, dist-absent
// fallthrough, neither-exists-null) against test/contracts-schemas-
// dir.test.mjs and test/contracts-schema-packaging.test.mjs. Those branches
// were removed here; contracts-schemas-dir.test.mjs is now the single
// source of truth for the precedence algorithm (its cases 1-6 cover exactly
// what branches 1-4 here used to, including the two assertions unique to
// this file's version -- exists() never called on the override path, and
// the tie always resolving to dist with dist probed FIRST -- both moved
// into that file's cases 5 and 3 respectively, verified non-regressed
// before deletion here). The one case below has no equivalent anywhere
// else: it is this file's own distinct concern.

const { resolveSchemasDir } = await import('../fleet-sprint/contracts.mjs');

describe('resolveSchemasDir', () => {
    test('empty-string env override is treated as unset (falls through to directory probing)', () => {
        const result = resolveSchemasDir({
            env: { APRA_FLEET_SE_SCHEMAS_DIR: '' },
            exists: () => false,
        });
        assert.strictEqual(result, null);
    });
});
