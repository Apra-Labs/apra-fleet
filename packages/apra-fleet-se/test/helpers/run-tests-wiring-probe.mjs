// Probe file for test/run-tests-script-wiring.test.mjs (apra-fleet-d6fq.3).
//
// This is NOT auto-discovered by run-tests.mjs's default `test/*.test.mjs`
// glob (it lives under test/helpers/ and does not end in .test.mjs) --
// it is only ever run explicitly, as the extra-args file passed to
// `node scripts/run-tests.mjs <mode> <this file>`. When node --test runs it
// as that explicit argument, this process IS the literal child run-tests.mjs
// spawns, so what it observes on process.execArgv/process.env is exactly
// what run-tests.mjs actually wired up -- not a simulation of it.
//
// It reports its own execArgv (which carries the --test-concurrency=N flag
// node's own --test harness parsed) and the APRA_FLEET_TEST_CONCURRENCY env
// var run-tests.mjs is supposed to export from the SAME TEST_CONCURRENCY
// constant, so the outer wiring test can assert the two agree.
//
// Reports via a file (path given by WIRING_PROBE_OUT), not console.log:
// run-tests.mjs pipes the child's output through timestamped-reporter.mjs,
// which only forwards test:pass/fail/diagnostic/stderr events -- plain
// console.log ("test:stdout" events) is silently dropped by that reporter,
// so a stdout-based handoff would never reach the outer test.
import { test } from 'node:test';
import fs from 'node:fs';

test('probe: report execArgv and APRA_FLEET_TEST_CONCURRENCY for the wiring test to inspect', () => {
    const outPath = process.env.WIRING_PROBE_OUT;
    if (!outPath) {
        throw new Error('WIRING_PROBE_OUT env var not set -- this probe must be launched by test/run-tests-script-wiring.test.mjs');
    }
    fs.writeFileSync(
        outPath,
        JSON.stringify({
            execArgv: process.execArgv,
            concurrencyEnv: process.env.APRA_FLEET_TEST_CONCURRENCY ?? null,
        })
    );
});
