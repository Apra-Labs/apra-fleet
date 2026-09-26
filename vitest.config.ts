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
    // apra-fleet-qe83.3.2 rework: the linked bug is a root `vitest run` on
    // Windows that never exited (LLM finished, but the dispatch waited on
    // the pipe for 45+ minutes with no process-level signal). This line is
    // NOT an effective config change and must not be read as one: verified
    // against the pinned vitest 4.0.18
    // (node_modules/vitest/dist/chunks/coverage.AVPTjMgw.js resolves
    // `resolved.pool ??= "forks"` before the dead `??= "threads"` branch
    // later in the same function, and the CLI help documents
    // "default: forks"), `forks` is already vitest 4's default pool. The
    // pre-existing config here had no `pool` key at all, so this line
    // changes nothing -- including during the recorded Windows hang, which
    // happened under that same default. It is left in place purely as an
    // explicit, self-documenting statement of intent (isolated child-process
    // test execution, not worker_threads, should a future vitest major
    // change the default) -- not as a fix, and not as evidence that a fix
    // was applied here.
    //
    // RESIDUAL RISK: a real capture of `npx vitest run --reporter=
    // hanging-process` on this Windows machine (apra-fleet-qe83.3.1, see
    // that bug's linked comment) exited cleanly with no open-handle warning
    // -- this run did NOT reproduce the specific hang, and no vitest.config.ts
    // setting is confirmed to change vitest's own exit behaviour for it. The
    // actual safety net if a root vitest run hangs again is
    // scripts/run-all-tests.mjs's wall-clock bound (apra-fleet-qe83.3.2),
    // not this file -- plus the dispatch-side stall detector and
    // completion-on-exit sibling features that bound the blast radius even
    // if the target-side bound above somehow also failed.
    pool: 'forks',
  },
});
