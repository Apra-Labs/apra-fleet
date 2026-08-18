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
    // apra-pm is a nested package under apra-fleet-se, not an npm workspace of
    // its own, so it is invisible to `--workspace=@apralabs/apra-fleet-se`'s
    // `test/*.test.mjs` glob and was never reached by the two suites above.
    { name: 'apra-pm', cmd: npmCmd, args: ['test'], cwd: 'packages/apra-fleet-se/apra-pm' },
];

let failed = false;
for (const suite of suites) {
    console.log(`\n> running ${suite.name} suite...\n`);
    // shell: true is required on Windows: Node refuses to spawnSync a
    // .cmd/.bat file directly (EINVAL) since the CVE-2024-27980 fix -- npm
    // ships as npm.cmd there. Harmless on POSIX where cmd is plain 'npm'.
    const result = spawnSync(suite.cmd, suite.args, { stdio: 'inherit', shell: true, cwd: suite.cwd });
    if (result.status !== 0) {
        failed = true;
        console.error(`\n> ${suite.name} suite FAILED (exit ${result.status})\n`);
    }
}

process.exit(failed ? 1 : 0);
