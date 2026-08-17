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
