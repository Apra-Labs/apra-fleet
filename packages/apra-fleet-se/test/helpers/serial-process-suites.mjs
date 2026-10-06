// Explicit registry of "heavy real-process" test files -- the contention-
// sensitive lane apra-fleet-i9ag.19.46 carves out of the default concurrent
// run.
//
// WHY THIS EXISTS: scripts/run-tests.mjs normally runs every test/*.test.mjs
// file concurrently (up to TEST_CONCURRENCY files at once, see
// test-concurrency.mjs). A handful of files do something much heavier than
// the rest of the suite -- they spawn a REAL OS child process that itself
// does real work (a real `bd init` Dolt bootstrap, or a real
// `bin/serve.mjs`/nested `node --test` child) rather than exercising
// in-process mocks. Every one of those child spawns competes for CPU/IO with
// whatever else the host is doing at that moment, including OTHER files in
// the same concurrent batch. That makes a contention-derived timeout budget
// (test/helpers/scaled-timeout.mjs) a function of how many such heavy files
// the scheduler happens to run at once -- exactly the "implicit environment
// decides behaviour" pattern CLAUDE.md forbids: apra-fleet-i9ag.19's four new
// se-lane suites (i9ag19-7/-9/-11/-14) pushed bd-init-templating.test.mjs's
// real `bd init` bootstrap past its already-3x-scaled budget purely because
// more heavy files than before were now resident at once.
//
// THE FIX: scripts/run-tests.mjs's default (no explicit file argument) run
// splits into two sequential phases -- files listed here run in their OWN
// phase at `--test-concurrency=1` (serial, and never overlapping with the
// concurrent-lane phase), so their outcome no longer depends on how many
// *other* se-lane suites happen to be running. That is an explicit,
// enumerated grouping rather than an incidental one: adding a new heavy
// real-process test file without registering it here is a silent regression
// back to the original bug, so test/serial-process-suites-registry.test.mjs
// scans every test file's source for the same real-process signatures this
// list was built from and FAILS LOUDLY if one is found unregistered (or if an
// entry here no longer matches an existing file).
//
// Passing an explicit file/pattern to `node scripts/run-tests.mjs <mode>
// <file>` (as e.g. test/run-tests-script-wiring.test.mjs's derived probe
// command, or a developer re-running one file directly) bypasses this split
// entirely -- the caller already chose exactly what runs, so there is nothing
// to isolate it from.
export const SERIAL_PROCESS_TEST_FILES = [
    // Real `bd init`/`bd list`/`bd show` etc. against the actual `bd` binary
    // (a real embedded-Dolt bootstrap), gated on `bd` being on PATH.
    'bd-init-templating.test.mjs',
    'bd-replay-read-cache.test.mjs',

    // Spawn `bin/serve.mjs` (or another real supervisor entry point) as a
    // real, long-lived child process that boots an actual HTTP server.
    'f34-concurrent-launch-engagement-integration.test.mjs',
    'i9ag19-11-serve-startup-toolchain.test.mjs',
    'i9ag19-14-pathless-service-launch.test.mjs',
    'i9ag34-sprints-console-hop-e2e.test.mjs',
    'installed-supervisor.test.mjs',
    'registration-convergence.test.mjs',
    'registration.test.mjs',
    'serve-wiring-integration.test.mjs',
    'supervisor-guard-e2e.test.mjs',
    'supervisor-lifecycle.test.mjs',
    'supervisor-project-dir-precedence.test.mjs',
    'supervisor-project-round-trip.test.mjs',

    // Spawn a nested `node --test` child process running real target files.
    'supervisor-dashboard-backlog-no-live-spawn.test.mjs',
    'supervisor-dashboard-no-live-spawn-guard-integrity.test.mjs',
    // apra-fleet-i9ag.19.46 rework: found by widening
    // test/serial-process-suites-registry.test.mjs's signatures to also catch
    // execFileSync (not just the bare `spawn(` form) -- both of these run
    // real target suite files as a nested `node --test` child via
    // execFileSync(process.execPath, [...]): phase1-leaf-facade-
    // completeness.test.mjs's golden-transcript gate (~2.7s), and phase3-
    // dispatch-engine-completeness.test.mjs's three nested runs (behaviour-
    // pins, golden-transcript, and a 63-file/164-test mock-sprint pass
    // measured at 14.8s-43.3s depending on concurrency -- see that file's own
    // COST comment above its mock-sprint test).
    'phase1-leaf-facade-completeness.test.mjs',
    'phase3-dispatch-engine-completeness.test.mjs',
    // Same nested golden-transcript execFileSync(process.execPath, ['--test',
    // 'test/golden-transcript.test.mjs', 'test/golden-transcript-3bead.test.mjs'])
    // call as phase1-leaf-facade-completeness.test.mjs above -- these are its
    // pre-existing sibling facade tests. Registered for the same reason
    // regardless of the separately-tracked NODE_TEST_CONTEXT no-op bug noted
    // in phase1-leaf-facade-completeness.test.mjs's header (these two do not
    // strip that var, so they currently no-op rather than really running the
    // nested suite) -- this guard classifies by what the code spawns, not by
    // whether a separate bug currently keeps it from doing real work.
    'phase0-seams-facade.test.mjs',
    'vcs-auth-extraction-facade.test.mjs',

    // Windows-only real-process cases: a stub bd.cmd shim run through the
    // real execBdAsync()/startup toolchain probe, i.e. real node children
    // launched via a resolved node path rather than a literal
    // process.execPath call (skipped off Windows).
    'aolt-win32-recorded-node-bd.test.mjs',
];
