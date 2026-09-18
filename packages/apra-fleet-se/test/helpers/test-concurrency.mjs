// Single source of truth for this package's --test-concurrency value.
//
// scripts/run-tests.mjs passes this to `node --test --test-concurrency=N`
// and exports it as APRA_FLEET_TEST_CONCURRENCY for scaled-timeout.mjs to
// read at runtime. A caller that can't rely on that env var being set (e.g.
// serve-wiring-integration.test.mjs, invoked by the plain `npm test` script
// which bypasses run-tests.mjs) imports this constant directly instead of
// re-hardcoding the number -- there is exactly one literal value in the
// whole package, here.
export const TEST_CONCURRENCY = 4;
