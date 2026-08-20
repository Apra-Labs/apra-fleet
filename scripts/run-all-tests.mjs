#!/usr/bin/env node
// Runs vitest and the apra-fleet-se workspace's own test suite unconditionally
// -- unlike `vitest run && npm test --workspace=...`, a failure (including a
// flaky, unrelated one) in the first suite no longer silently skips the
// second suite entirely. Exits non-zero if either suite failed.

import { spawnSync } from 'node:child_process';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const suites = [
    { name: 'vitest', cmd: npmCmd, args: ['exec', '--', 'vitest', 'run'] },
    { name: 'apra-fleet-se', cmd: npmCmd, args: ['test', '--workspace=@apralabs/apra-fleet-se'] },
    // packages/apra-fleet-se/apra-pm is NOT an npm workspace (see ci.yml's
    // "Run apra-pm test suite (node:test; not an npm workspace)" step), so
    // it is otherwise reached only by CI's explicit --prefix invocation.
    // Mirror that here so local runs get the same signal as CI.
    { name: 'apra-pm', cmd: npmCmd, args: ['test', '--prefix', 'packages/apra-fleet-se/apra-pm'] },
];

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
