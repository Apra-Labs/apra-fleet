// apra-fleet-d6fq.3, criterion (a): mechanically prove the wiring
// scripts/run-tests.mjs is supposed to provide -- that the child `node
// --test` process it spawns has APRA_FLEET_TEST_CONCURRENCY set in its env,
// and that its value equals the --test-concurrency value passed on the
// SAME command line. This is the assertion that would have caught the
// original inert-helper bug (apra-fleet-d6fq / d6fq.1): before d6fq.1,
// package.json ran a raw `node --test --test-concurrency=8 ...` without
// exporting APRA_FLEET_TEST_CONCURRENCY at all, so test/helpers/
// scaled-timeout.mjs silently ran every budget unscaled under the suite
// that actually has 8-way contention.
//
// This test actually spawns `node scripts/run-tests.mjs mock <probe file>`
// (test/helpers/run-tests-wiring-probe.mjs) as a real child process -- not
// a simulation -- and inspects what that literal child observed about its
// own execArgv/env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(__dirname, '..');
const runTestsScript = path.join(pkgRoot, 'scripts', 'run-tests.mjs');
const probeFile = path.join(__dirname, 'helpers', 'run-tests-wiring-probe.mjs');

test('wiring: `node scripts/run-tests.mjs mock <file>` exports APRA_FLEET_TEST_CONCURRENCY equal to the --test-concurrency value on the same command line', () => {
    const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-probe-')), 'result.json');
    try {
        // This test file is itself already running under `node --test`, which
        // sets NODE_TEST_CONTEXT in its own env. If that var is inherited by
        // the nested `node scripts/run-tests.mjs mock <probe>` spawn below,
        // node's test runner detects a "recursive" run and silently skips
        // executing the probe file entirely (a real gotcha -- it exits 0 with
        // no output, which looks like success until you check for the
        // probe's result file). Strip it so the nested run behaves exactly
        // like a fresh, top-level `node scripts/run-tests.mjs mock <file>`
        // invocation, matching what run-tests.mjs's real callers do.
        const childEnv = { ...process.env, WIRING_PROBE_OUT: outPath };
        delete childEnv.NODE_TEST_CONTEXT;

        const result = spawnSync(process.execPath, [runTestsScript, 'mock', probeFile], {
            cwd: pkgRoot,
            encoding: 'utf8',
            env: childEnv,
        });

        assert.equal(result.status, 0, `probe run must exit 0; stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
        assert.ok(fs.existsSync(outPath), `expected the probe to write its result to ${outPath}; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

        const { execArgv, concurrencyEnv } = JSON.parse(fs.readFileSync(outPath, 'utf8'));

        const concurrencyFlag = execArgv.find((a) => a.startsWith('--test-concurrency='));
        assert.ok(concurrencyFlag, `expected a --test-concurrency=N flag in the child's execArgv, got ${JSON.stringify(execArgv)}`);
        const flagValue = concurrencyFlag.split('=')[1];

        // This is the assertion that fails if the APRA_FLEET_TEST_CONCURRENCY
        // export is removed from scripts/run-tests.mjs: concurrencyEnv would be
        // null while the --test-concurrency flag is still present.
        assert.notEqual(concurrencyEnv, null, 'APRA_FLEET_TEST_CONCURRENCY must be set in the child env -- this is the export the original bug removed');
        assert.equal(concurrencyEnv, flagValue, 'APRA_FLEET_TEST_CONCURRENCY must equal the --test-concurrency value passed on the same command line');
    } finally {
        fs.rmSync(path.dirname(outPath), { recursive: true, force: true });
    }
});
