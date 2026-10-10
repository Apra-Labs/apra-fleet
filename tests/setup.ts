import path from 'node:path';
import os from 'node:os';
import { inject, vi } from 'vitest';
// @ts-expect-error -- plain .mjs helper shared with the node --test runners
import { assertNotRealProfile } from '../scripts/test-sandbox.mjs';

// Fail fast if this worker would resolve the real user profile (fleet.key,
// ~/.apra-fleet/bin, ~/.apra-fleet/data): see scripts/test-sandbox.mjs.
assertNotRealProfile();

// Global mock: preflightCheck always passes in tests.
// The real preflightCheck hits strategy.testConnection + execCommand on every
// non-local dispatch, which breaks existing mocks' call-count expectations.
// preflight-check.test.ts uses vi.unmock to test the real implementation.
vi.mock('../src/services/preflight-check.js', () => ({
  preflightCheck: vi.fn().mockResolvedValue({ ok: true, connectivity: true, authValid: true, latencyMs: 1 }),
  invalidatePreflightCache: vi.fn(),
  clearPreflightCache: vi.fn(),
}));

// Global mock: the code_* pre-flight's self-heal never spawns a real
// `npx gitnexus analyze` in tests -- every not-ready index reads as "build
// started". code-reindex-tools.test.ts uses vi.unmock to drive the real
// scheduler against a fake npx.
vi.mock('../src/tools/code-index-heal.js', () => ({
  scheduleIndexBuild: vi.fn(() => ({ started: true })),
}));

// Global mock: LLM CLI resolution (src/services/llm-cli-resolver.ts) never
// issues probe execs in tests -- the real resolver runs several member-side
// probes per member, which would shift every existing exec-call sequence
// mock. The mock reuses a path already stored on the member (so builder
// tests that seed agent.llmCli still see the absolute path) and otherwise
// reports "no stored path", which callers treat as the bare-command
// fallback. tests/llm-cli-resolver*.test.ts use vi.unmock for the real thing.
vi.mock('../src/services/llm-cli-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/llm-cli-resolver.js')>();
  return {
    ...actual,
    ensureMemberLlmCli: vi.fn(async (agent: { llmCli?: { provider: string; path: string } ; llmProvider?: string }, provider: { name: string }) => {
      const stored = agent.llmCli;
      return { ok: true, path: stored && stored.provider === provider.name ? stored.path : undefined, source: stored ? 'stored' : undefined, reprobed: false };
    }),
    invalidateLlmCliPath: vi.fn(),
  };
});

process.env.NODE_ENV = 'test';
// install's post-start /health wait: off unless a test opts in
// (_setServiceHealthWaitOverride) -- no test may wait on a real server.
process.env.APRA_FLEET_INSTALL_HEALTH_TIMEOUT_MS ??= '0';
// apra-fleet-2xs.9: unique-per-run directory computed once in tests/global-setup.ts
// and handed to every worker via provide/inject, so concurrent `vitest run`
// invocations never share (and corrupt) the same registry.json. Falls back to the
// old fixed path only if globalSetup somehow did not run (e.g. a future ad hoc
// vitest invocation that omits globalSetup).
process.env.APRA_FLEET_DATA_DIR =
  inject('APRA_FLEET_TEST_DATA_DIR') ?? path.join(os.tmpdir(), 'apra-fleet-test-data');
