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

// apra-fleet-qe83.4: test-only escape hatch that makes killTree()/child.kill()
// no-ops, so a test can simulate "taskkill is unavailable/denied, or the
// POSIX group kill fails for both -pid and pid" without needing a real
// unkillable process (SIGKILL cannot be ignored on POSIX, so that failure
// mode can only be reproduced by disabling the kill calls themselves).
// Unset/unequal to '1' in production -- this branch is never taken there.
const simulateUnkillable = process.env.APRA_TEST_SIMULATE_KILL_FAILURE === '1';

/** Best-effort kill of the whole descendant tree rooted at `pid`. */
function killTree(pid) {
    if (!pid || simulateUnkillable) return;
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

// apra-fleet-qe83.4: grace window between the belt-and-braces child.kill()
// below and the forced process.exit() -- long enough for a real 'exit' event
// to arrive if the kill actually landed, short enough to keep the runner from
// hanging past its own bound. Overridable purely so the reproduction test
// does not need to wait out the production default.
const FORCE_EXIT_GRACE_MS = (() => {
    const raw = Number(process.env.APRA_TEST_FORCE_EXIT_GRACE_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 5_000;
})();

// apra-fleet-qe83.3.2 rework: grace window between the POSIX-only SIGTERM
// broadcast below and the unconditional hard kill that follows it --
// overridable so the reproduction test does not need to wait out the
// production default. See the timer callback in runBounded() for why this
// soft phase exists at all (a nested detached grandchild that a bare SIGKILL
// of this child's own group cannot reach).
const SOFT_KILL_GRACE_MS = (() => {
    const raw = Number(process.env.APRA_TEST_SOFT_KILL_GRACE_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 2_000;
})();

// apra-fleet-qe83.3.2 rework: the currently-running suite's child, tracked so
// a signal delivered to THIS process (not just our own timeout) can still
// reach it. On POSIX, `detached: true` below deliberately takes the child
// (and the shell it wraps) OUT of this process's own foreground process
// group -- necessary so this script's own `kill(-pid)` can reach every
// descendant, but it also means a terminal SIGINT (Ctrl-C) or a SIGTERM sent
// to just this process (e.g. by whatever dispatched `npm test`) no longer
// reaches that detached group on its own: it would kill this wrapper and
// silently orphan the still-running suite, still holding stdio open --
// exactly the pipe-hold bug this whole runner exists to prevent, one level
// up. Trap both signals here and tree-kill the live child before exiting.
let currentChild = null;
let signalHandled = false;

function handleTerminatingSignal(signal) {
    // A second Ctrl-C (or another signal) during the grace window below
    // must not re-enter this whole dance -- exit immediately instead of
    // re-arming a new soft-kill timer on top of the first one.
    if (signalHandled) {
        console.error(`\n> received a second ${signal} -- exiting immediately\n`);
        process.exit(1);
    }
    signalHandled = true;
    console.error(`\n> received ${signal} -- killing the current suite's child tree before exiting\n`);
    const pid = currentChild && currentChild.pid;
    if (!pid) {
        process.exit(1);
        return;
    }
    if (isWindows || simulateUnkillable) {
        killTree(pid);
        if (!simulateUnkillable) {
            try { currentChild.kill('SIGKILL'); } catch { /* already gone */ }
        }
        process.exit(1);
        return;
    }
    // POSIX: same two-phase cascade as the timeout path in runBounded()
    // below -- broadcast SIGTERM to the whole group first so a nested
    // runner (run-tests.mjs's own detached `node --test` child) gets a
    // chance to trap it and reap its own disjoint group, THEN escalate to
    // the hard kill. Deferring process.exit() into the timer (instead of
    // calling it synchronously here) is what gives that grace window any
    // effect -- an immediate exit would race it exactly like the bare
    // SIGKILL-the-group path this is replacing.
    try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone or no group */ }
    setTimeout(() => {
        killTree(pid);
        try { currentChild.kill('SIGKILL'); } catch { /* already gone */ }
        process.exit(1);
    }, SOFT_KILL_GRACE_MS);
}
process.on('SIGINT', () => handleTerminatingSignal('SIGINT'));
process.on('SIGTERM', () => handleTerminatingSignal('SIGTERM'));

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
        currentChild = child;

        let timedOut = false;
        let settled = false;
        let forceExitTimer = null;
        let softKillTimer = null;

        // Belt-and-braces hard kill: killTree is best-effort, and if it
        // doesn't reap the child (taskkill unavailable/denied, or the POSIX
        // group kill fails for both -pid and pid), the child's 'exit' event
        // never fires -- so also send SIGKILL directly, and start a short
        // secondary timer that force-exits this process if the child still
        // has not gone away. Without this, the runner hangs forever, which
        // is the exact failure the bound exists to remove.
        const hardKill = () => {
            killTree(child.pid);
            if (!simulateUnkillable) {
                try { child.kill('SIGKILL'); } catch { /* already gone */ }
            }
            forceExitTimer = setTimeout(() => {
                if (settled) return;
                console.error(`\n> ${suite.name} suite did not exit after being killed -- forcing process exit\n`);
                process.exit(1);
            }, FORCE_EXIT_GRACE_MS);
        };

        const timer = setTimeout(() => {
            timedOut = true;
            if (isWindows || simulateUnkillable) {
                // Windows: taskkill /T /F (inside killTree, called by
                // hardKill) walks the intact PPID tree in one shot --
                // nothing here ever detaches into its own session, so there
                // is no nested group for a soft phase to protect.
                // simulateUnkillable: the whole point of that escape hatch
                // is to prove the FORCE-EXIT backstop fires when every kill
                // is a no-op -- adding an extra soft-kill wait here would
                // only push that reproduction closer to its own outer test
                // deadline for no benefit.
                hardKill();
                return;
            }
            // POSIX only: a suite can itself be (or spawn) a nested bounded
            // runner that detaches ITS OWN child into a second, disjoint
            // process group -- packages/apra-fleet-se/scripts/run-tests.mjs
            // does exactly this for its `node --test` child, so that ITS OWN
            // killTree(-pid) can reach a grandchild tree. A bare
            // `process.kill(-child.pid, 'SIGKILL')` (inside killTree) only
            // reaches processes still inside THIS child's group -- it never
            // reaches that disjoint nested group, orphaning it still holding
            // this dispatch's stdout/stderr pipe open (the exact recorded
            // 45-minute pipe-hold bug, reintroduced on POSIX by the nested
            // npm test --workspace=... -> run-tests.mjs -> node --test path).
            // Broadcast SIGTERM to the whole group first and give any nested
            // runner inside it a grace window to trap it and reap its OWN
            // detached child before this group disappears (see run-tests.mjs's
            // own SIGTERM handler), THEN escalate to the unconditional hard
            // kill below as a backstop for suites with no such trap.
            try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone or no group */ }
            softKillTimer = setTimeout(hardKill, SOFT_KILL_GRACE_MS);
        }, timeoutMs);

        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (softKillTimer) clearTimeout(softKillTimer);
            if (forceExitTimer) clearTimeout(forceExitTimer);
            if (currentChild === child) currentChild = null;
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
