import { defineConfig, defaultExclude } from 'vitest/config';
import { hasNodeSqlite } from './tests/helpers/node-sqlite-capability.js';

// apra-fleet-ytfy.6: the KB subsystem (PR #305) is built on node:sqlite, a
// Node builtin whose FTS5 support (which the KB schema/queries depend on)
// only exists from Node >=22.16.0 (see tests/helpers/node-sqlite-capability.ts
// for the full version history -- there are two separate gates: the module
// itself unflags at 22.13.0, but FTS5 isn't compiled in until 22.16.0).
// package.json's engines.node now requires >=22.16.0, and CI's setup-node
// `node-version: 22.x` always resolves to a current (>=22.16.0) release, so
// this exclusion is a no-op there. But npm does not enforce engines.node by
// default (no engine-strict), so a dev running an older Node (or even Node
// 20) would otherwise see ~54 tests/knowledge/*.test.ts files plus a handful
// of root tests that transitively import KB-wired modules (check-status.js
// et al) fail -- an environmental gap, not a real regression. Detect
// capability once at config-load time (same process vitest itself runs in)
// and skip exactly those files when unavailable, so `npm test` stays green
// locally and the KB suite still runs for real on every runtime that
// actually has it (CI, and any local Node >=22.16.0).
// tests/regression-command-surface.test.ts is NOT listed here --
// only one of its two tests needs node:sqlite (it spawns the built server,
// which now wires in the KB), so that file gates itself internally via
// hasNodeSqlite() + it.skipIf instead of losing its other, unrelated test.
const NODE_SQLITE_DEPENDENT_TESTS = [
  'tests/knowledge/**/*.test.ts',
  'tests/code-intelligence-registry-wiring.test.ts',
  'tests/fleet-status-code-intelligence.test.ts',
  'tests/fleet-status-branch.test.ts',
  'tests/stall-detector-integration.test.ts',
  'tests/category.test.ts',
];

const sqliteAvailable = hasNodeSqlite();
if (!sqliteAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    '[vitest.config] node:sqlite (with FTS5) is unavailable on this Node runtime ' +
    `(${process.version}; requires >=22.16.0) -- skipping ${NODE_SQLITE_DEPENDENT_TESTS.length} ` +
    'KB/code-intelligence test path(s). Run under Node >=22.16.0 (matching engines.node) to exercise them.'
  );
}

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    exclude: sqliteAvailable ? defaultExclude : [...defaultExclude, ...NODE_SQLITE_DEPENDENT_TESTS],
    setupFiles: ['tests/setup.ts'],
    globalSetup: ['tests/global-setup.ts'],
    fileParallelism: false,  // Tests share registry.json in temp dir (unique per run, see global-setup.ts)
    teardownTimeout: 1000,
    // apra-fleet-qe83.3.2: the linked bug is a root `vitest run` on Windows
    // that never exited (LLM finished, but the dispatch waited on the pipe
    // for 45+ minutes with no process-level signal). `pool: 'forks'` runs
    // each test file in an isolated child PROCESS rather than a
    // worker_thread -- forked child processes are reaped by the OS on the
    // parent's own exit/kill in a way a lingering worker_thread (which can
    // keep the whole Node process alive on an unclosed handle inside it)
    // is not, so this is the more exit-deterministic choice between
    // Vitest's two pools.
    //
    // RESIDUAL RISK: a real capture of `npx vitest run --reporter=
    // hanging-process` on this Windows machine (apra-fleet-qe83.3.1, see
    // that bug's linked comment) exited cleanly with no open-handle warning
    // -- this run did NOT reproduce the specific hang, so `pool: 'forks'`
    // plus the existing `teardownTimeout` are a deterministic-exit
    // improvement made without a confirmed root cause, not a verified fix
    // for the exact handle that caused the recorded bug. The two other
    // fixes in this bug's parent feature (bounded npm test runners here,
    // plus the dispatch-side stall detector and completion-on-exit sibling
    // features) are what actually bound the blast radius if this
    // particular hang recurs.
    pool: 'forks',
  },
});
