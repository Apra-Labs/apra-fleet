import path from 'node:path';
import os from 'node:os';
import { inject, vi } from 'vitest';

// Global mock: preflightCheck always passes in tests.
// The real preflightCheck hits strategy.testConnection + execCommand on every
// non-local dispatch, which breaks existing mocks' call-count expectations.
// preflight-check.test.ts uses vi.unmock to test the real implementation.
vi.mock('../src/services/preflight-check.js', () => ({
  preflightCheck: vi.fn().mockResolvedValue({ ok: true, connectivity: true, authValid: true, latencyMs: 1 }),
  invalidatePreflightCache: vi.fn(),
  clearPreflightCache: vi.fn(),
}));

process.env.NODE_ENV = 'test';
// apra-fleet-2xs.9: unique-per-run directory computed once in tests/global-setup.ts
// and handed to every worker via provide/inject, so concurrent `vitest run`
// invocations never share (and corrupt) the same registry.json. Falls back to the
// old fixed path only if globalSetup somehow did not run (e.g. a future ad hoc
// vitest invocation that omits globalSetup).
process.env.APRA_FLEET_DATA_DIR =
  inject('APRA_FLEET_TEST_DATA_DIR') ?? path.join(os.tmpdir(), 'apra-fleet-test-data');

// apra-fleet-iywi.8: src/paths.ts's FLEET_DIR is an EAGER module-load constant
// (computed once, at first import, from process.env.APRA_FLEET_DATA_DIR). Several
// suites (e.g. tests/console-workflow-packages.test.ts) delete and restore files
// under FLEET_DIR directly, trusting that it resolved to the isolated per-run temp
// dir set above rather than the real ~/.apra-fleet/data. That trust used to be
// implicit and unverified: nothing stopped a future import-order break (some other
// module importing src/paths.ts before this setup file runs, an ad hoc vitest
// invocation bypassing this config, a different test runner entirely) from silently
// falling through to the real data dir, where a beforeEach/afterEach delete-restore
// cycle could wipe a developer's real workflow-packages.json/config.json for good if
// the process died between the delete and the restore.
//
// Make the isolation explicit and fail loudly instead of assuming it: import
// src/paths.ts's FLEET_DIR via a DYNAMIC import (not a static one -- static imports
// are hoisted and would execute before the process.env assignment above runs,
// defeating this exact check) so it is evaluated strictly after
// APRA_FLEET_DATA_DIR is set, then assert the two values are identical. A mismatch
// means FLEET_DIR did NOT pick up the isolated dir and may point at the real
// ~/.apra-fleet/data -- refuse to run any test in that case.
const { FLEET_DIR: isolatedFleetDir } = await import('../src/paths.js');
if (isolatedFleetDir !== process.env.APRA_FLEET_DATA_DIR) {
  throw new Error(
    'FATAL test-isolation guard (apra-fleet-iywi.8): src/paths.ts FLEET_DIR ' +
      `("${isolatedFleetDir}") does not match the isolated APRA_FLEET_DATA_DIR ` +
      `("${process.env.APRA_FLEET_DATA_DIR}") set moments earlier in this same file. ` +
      'This means src/paths.ts computed FLEET_DIR before APRA_FLEET_DATA_DIR was set ' +
      '(or something reset the env var afterward), so it may resolve under the real ' +
      'home directory instead of the per-run isolated temp dir. Refusing to run tests ' +
      'that read, write or delete files under FLEET_DIR against a non-isolated path.',
  );
}
