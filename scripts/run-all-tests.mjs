#!/usr/bin/env node
// Runs vitest and the apra-fleet-se workspace's own test suite unconditionally
// -- unlike `vitest run && npm test --workspace=...`, a failure (including a
// flaky, unrelated one) in the first suite no longer silently skips the
// second suite entirely. Exits non-zero if either suite failed.
//
// apra-fleet-qe83.3.1: the suite list is overridable via APRA_TEST_SUITES_JSON
// (a JSON array of {name, cmd, args}) purely so
// tests/run-all-tests-timeout.test.ts can drive this exact runner against a
// deterministic, fast stub suite instead of the real (multi-minute) suites
// below -- default behaviour is unchanged when it is unset. This task adds
// only that injection point; the suite invocation below is still a bare,
// unbounded spawnSync (no timeout) -- apra-fleet-qe83.3.2 is what actually
// bounds it, which is exactly what the new test's reproduction pins down.

import { spawnSync } from 'node:child_process';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const defaultSuites = [
    { name: 'vitest', cmd: npmCmd, args: ['exec', '--', 'vitest', 'run'] },
    { name: 'apra-fleet-se', cmd: npmCmd, args: ['test', '--workspace=@apralabs/apra-fleet-se'] },
    // packages/apra-fleet-se/apra-pm is NOT an npm workspace (see ci.yml's
    // "Run apra-pm test suite (node:test; not an npm workspace)" step), so
    // it is otherwise reached only by CI's explicit --prefix invocation.
    // Mirror that here so local runs get the same signal as CI.
    { name: 'apra-pm', cmd: npmCmd, args: ['test', '--prefix', 'packages/apra-fleet-se/apra-pm'] },
];

const suites = process.env.APRA_TEST_SUITES_JSON
    ? JSON.parse(process.env.APRA_TEST_SUITES_JSON)
    : defaultSuites;

let failed = false;
for (const suite of suites) {
    console.log(`\n> running ${suite.name} suite...\n`);
    // shell: true is required on Windows: Node refuses to spawnSync a
    // .cmd/.bat file directly (EINVAL) since the CVE-2024-27980 fix -- npm
    // ships as npm.cmd there. Harmless on POSIX where cmd is plain 'npm'.
    const result = spawnSync(suite.cmd, suite.args, { stdio: 'inherit', shell: true });
    if (result.status !== 0) {
        failed = true;
        console.error(`\n> ${suite.name} suite FAILED (exit ${result.status})\n`);
    }
}

process.exit(failed ? 1 : 0);
