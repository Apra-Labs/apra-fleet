#!/usr/bin/env node
// Runs vitest and the apra-fleet-se workspace's own test suite unconditionally
// -- unlike `vitest run && npm test --workspace=...`, a failure (including a
// flaky, unrelated one) in the first suite no longer silently skips the
// second suite entirely. Exits non-zero if either suite failed.
//
// apra-fleet-qe83.3: bounded by a wall-clock timeout per suite (default 15
// minutes, override with APRA_TEST_TIMEOUT_MS) so a hung suite (e.g. a
// vitest run that never exits -- the linked bug, observed on Windows) cannot
// hold a dispatch open indefinitely. The suite list itself is overridable
// via APRA_TEST_SUITES_JSON (a JSON array of {name, cmd, args}) purely so
// tests/run-all-tests-timeout.test.ts can drive this exact runner against a
// deterministic stub suite instead of the real (multi-minute) suites.
// Default behaviour for both is unchanged when the env vars are unset.
//
// Why this uses async spawn() instead of spawnSync's own `timeout` option:
// spawnSync's built-in timeout only ever signals the IMMEDIATE child -- on
// Windows that is cmd.exe (required for shell:true below) or npm.cmd,
// neither of which forwards a kill signal to what THEY spawn in turn (npm ->
// node -> vitest -> worker processes). Killing just that top process leaves
// the rest of the tree running, which is exactly the bug this exists to fix.
// Reaching the whole tree needs a *live* pid to hand to `taskkill /T` (or a
// POSIX process group to signal) WHILE the child is still running -- and a
// fully synchronous spawnSync blocks this script until the child has
// already exited, so it can never intervene mid-wait. Async spawn() plus a
// manual timer (below) is watched concurrently instead.

import { spawn, spawnSync } from 'node:child_process';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const isWindows = process.platform === 'win32';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const timeoutMs = (() => {
    const raw = Number(process.env.APRA_TEST_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
})();

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

/** Best-effort kill of the whole descendant tree rooted at `pid`. */
function killTree(pid) {
    if (!pid) return;
    if (isWindows) {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
    } else {
        try {
            // Negative pid signals the whole process group -- see the
            // `detached: true` note below for why that reaches every
            // descendant, not just the immediate child.
            process.kill(-pid, 'SIGKILL');
        } catch {
            // Already gone, or (unexpectedly) never got its own group --
            // fall back to a direct kill of just the pid we have.
            try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
    }
}

/**
 * Runs one suite with a wall-clock bound, killing the whole child tree if it
 * is exceeded. Resolves with a spawnSync-shaped result ({ status, timedOut })
 * so the calling loop below barely differs from a plain spawnSync call.
 */
function runBounded(suite) {
    return new Promise(resolve => {
        // shell: true is required on Windows: Node refuses to spawn a
        // .cmd/.bat file directly (EINVAL) since the CVE-2024-27980 fix --
        // npm ships as npm.cmd there. Harmless on POSIX where cmd is plain
        // 'npm'. detached: true on POSIX makes the child (there, the shell
        // wrapper shell:true spawns) its own process-group leader, so
        // `kill(-pid)` reaches every descendant it launches; Windows has no
        // equivalent spawn-time option, hence taskkill /T above instead.
        const child = spawn(suite.cmd, suite.args, {
            stdio: 'inherit',
            shell: true,
            detached: !isWindows,
        });

        let timedOut = false;
        let settled = false;
        const timer = setTimeout(() => {
            timedOut = true;
            killTree(child.pid);
        }, timeoutMs);

        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };

        child.on('exit', (code) => {
            finish({ status: timedOut ? null : code, timedOut });
        });
        child.on('error', (err) => {
            console.error(`\n> ${suite.name} suite errored: ${err.message}\n`);
            finish({ status: 1, timedOut });
        });
    });
}

let failed = false;
for (const suite of suites) {
    console.log(`\n> running ${suite.name} suite...\n`);
    const result = await runBounded(suite);
    if (result.timedOut) {
        failed = true;
        console.error(`\n> ${suite.name} suite TIMED OUT after ${timeoutMs}ms and was killed\n`);
    } else if (result.status !== 0) {
        failed = true;
        console.error(`\n> ${suite.name} suite FAILED (exit ${result.status})\n`);
    }
}

process.exit(failed ? 1 : 0);
