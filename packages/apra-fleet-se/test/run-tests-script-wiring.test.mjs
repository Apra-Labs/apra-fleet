// apra-fleet-d6fq.3, criterion (a): mechanically prove the wiring
// package.json's own "test" script is supposed to provide -- that the child
// `node --test` process it ultimately spawns has APRA_FLEET_TEST_CONCURRENCY
// set in its env, and that its value equals the --test-concurrency value
// passed on the SAME command line.
//
// This test derives its child command from package.json's "test" script
// itself, rather than hardcoding a spawn of scripts/run-tests.mjs. The
// original inert-helper bug (apra-fleet-d6fq / d6fq.1) did NOT live inside
// run-tests.mjs (that script already exported the var) -- it lived in
// package.json's "test" script, which used to be a raw
// `node --test --test-concurrency=8 test/*.test.mjs` that bypassed
// run-tests.mjs entirely and so never exported anything. A test that
// hardcodes a direct spawn of run-tests.mjs would still pass at that buggy
// commit, because it never actually reads what "test" resolves to. Reading
// package.json here means a future regression of the "test" script back to
// a raw `node --test` invocation makes THIS test fail.
//
// This test actually spawns the derived command as a real child process --
// not a simulation -- and inspects what that literal child observed about
// its own execArgv/env via test/helpers/run-tests-wiring-probe.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(__dirname, '..');
const probeFile = path.join(__dirname, 'helpers', 'run-tests-wiring-probe.mjs');

// run-tests.mjs-style "test" scripts end in a bare mode keyword (mock/real/
// record) and accept extra trailing args as the file list to run (see
// scripts/run-tests.mjs's own comment header). Anything else is assumed to
// be a raw `node --test ...` invocation whose last token is the file glob
// to run. Either way we replace/extend only the trailing file-selection
// token with the probe file, so we run just the probe (not the whole
// suite) while preserving every flag the script's own command line
// actually passes -- including whether it routes through run-tests.mjs at
// all.
const RUN_TESTS_MODES = new Set(['mock', 'real', 'record']);

function deriveProbeCommand() {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
    const testScript = pkg.scripts && pkg.scripts.test;
    assert.ok(testScript, 'package.json must define a "test" script for this probe to derive its command from');

    const scriptTokens = testScript.trim().split(/\s+/);
    assert.equal(scriptTokens[0], 'node', `expected the "test" script to start with "node", got: ${testScript}`);
    const scriptArgs = scriptTokens.slice(1);

    const lastToken = scriptArgs[scriptArgs.length - 1];
    return RUN_TESTS_MODES.has(lastToken)
        ? [...scriptArgs, probeFile]
        : [...scriptArgs.slice(0, -1), probeFile];
}

test('wiring: package.json\'s "test" script exports APRA_FLEET_TEST_CONCURRENCY equal to the --test-concurrency value on the same command line', () => {
    const derivedArgs = deriveProbeCommand();
    const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-probe-')), 'result.json');
    try {
        // This test file is itself already running under `node --test`, which
        // sets NODE_TEST_CONTEXT in its own env. If that var is inherited by
        // the nested spawn below, node's test runner detects a "recursive"
        // run and silently skips executing the probe file entirely (a real
        // gotcha -- it exits 0 with no output, which looks like success
        // until you check for the probe's result file). Strip it so the
        // nested run behaves exactly like a fresh, top-level invocation of
        // package.json's "test" script, matching what a real `npm test`
        // caller does.
        const childEnv = { ...process.env, WIRING_PROBE_OUT: outPath };
        delete childEnv.NODE_TEST_CONTEXT;
        // This wiring test itself normally runs as part of `npm test`, i.e.
        // already inside a process whose own env has
        // APRA_FLEET_TEST_CONCURRENCY set by the outer run-tests.mjs. If we
        // let that leak into the nested child via inheritance, a regressed
        // "test" script (one that no longer exports the var itself) would
        // still see it -- masking exactly the bug this test exists to
        // catch. Strip it so the child only has the var if the derived
        // command actually exports it, same as a truly independent
        // top-level invocation would see.
        delete childEnv.APRA_FLEET_TEST_CONCURRENCY;

        const result = spawnSync(process.execPath, derivedArgs, {
            cwd: pkgRoot,
            encoding: 'utf8',
            env: childEnv,
        });

        assert.equal(result.status, 0, `probe run must exit 0; command: node ${derivedArgs.join(' ')}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
        assert.ok(fs.existsSync(outPath), `expected the probe to write its result to ${outPath}; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

        const { execArgv, concurrencyEnv } = JSON.parse(fs.readFileSync(outPath, 'utf8'));

        const concurrencyFlag = execArgv.find((a) => a.startsWith('--test-concurrency='));
        assert.ok(concurrencyFlag, `expected a --test-concurrency=N flag in the child's execArgv, got ${JSON.stringify(execArgv)}`);
        const flagValue = concurrencyFlag.split('=')[1];

        // This is the assertion that fails if package.json's "test" script
        // regresses back to a raw `node --test` invocation that bypasses
        // run-tests.mjs: concurrencyEnv would be null while the
        // --test-concurrency flag is still present.
        assert.notEqual(concurrencyEnv, null, 'APRA_FLEET_TEST_CONCURRENCY must be set in the child env -- this is the export the original bug removed');
        assert.equal(concurrencyEnv, flagValue, 'APRA_FLEET_TEST_CONCURRENCY must equal the --test-concurrency value passed on the same command line');
    } finally {
        fs.rmSync(path.dirname(outPath), { recursive: true, force: true });
    }
});
