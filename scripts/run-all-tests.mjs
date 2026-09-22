#!/usr/bin/env node
// Runs vitest and the apra-fleet-se workspace's own test suite unconditionally
// -- unlike `vitest run && npm test --workspace=...`, a failure (including a
// flaky, unrelated one) in the first suite no longer silently skips the
// second suite entirely. Exits non-zero if either suite failed.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// How much of each suite's output to echo. The full log stays on disk.
const TAIL_LINES = 200;

// Upper bound on a single suite. Generous enough that a slow-but-working run
// is never cut short, short enough that a hung one fails inside a dispatch
// rather than outliving it. Override with APRA_FLEET_TEST_TIMEOUT_MS.
const SUITE_TIMEOUT_MS = Number(process.env.APRA_FLEET_TEST_TIMEOUT_MS) || 20 * 60 * 1000;

const suites = [
    { name: 'vitest', cmd: npmCmd, args: ['exec', '--', 'vitest', 'run'] },
    { name: 'apra-fleet-se', cmd: npmCmd, args: ['test', '--workspace=@apralabs/apra-fleet-se'] },
];

// my-beads-db-0cd.16: the old spawnSync({ timeout, killSignal: 'SIGKILL' })
// sent SIGKILL to the cmd.exe shell (shell:true is required below -- see the
// comment at the spawn call), never to npm or the vitest workers underneath
// it, so a Windows timeout orphaned exactly the workers this comment used to
// claim it prevented, and those orphans went on to contend with the next
// suite in the same run. Fixed by spawning async, owning the timer ourselves,
// and killing the whole tree rooted at the pid THIS runner spawned:
//   - win32: `taskkill /PID <pid> /T /F` walks Windows' own parent-pid chain
//     for that one process, so it cannot reach an unrelated process that
//     merely shares an image name.
//   - POSIX: spawn with detached:true so the child becomes its own process
//     group leader, then `process.kill(-pid, 'SIGKILL')` signals that group.
// Both forms are scoped to descendants of our own child pid -- no kill-by-
// name, no broad pgid/image-name sweep. That scoping matters beyond
// correctness: my-beads-db-cc8 is an open P1 where the test suite kills the
// live fleet server and supervisor (and any in-flight sprint with them), and
// a wider kill here would make that worse, not just fail to fix this bug.
function killProcessTree(pid) {
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
        try {
            process.kill(-pid, 'SIGKILL');
        } catch {
            // Already dead, or never got its own group (spawn failed before we
            // could detach it) -- nothing left to kill.
        }
    }
}

// Runs one suite to completion or until SUITE_TIMEOUT_MS elapses, whichever
// comes first. Resolves (never rejects) with a shape compatible with the old
// spawnSync result plus an explicit timedOut flag driven by our own timer,
// not inferred from the child's exit signal -- taskkill on win32 does not
// reliably surface as `signal: 'SIGKILL'` the way a POSIX kill does.
function runSuite(cmd, args, spawnOpts, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, {
            ...spawnOpts,
            shell: true,
            // POSIX only: makes this child the leader of a new process group so
            // killProcessTree can target that group in isolation. Meaningless on
            // win32 (no pgid concept), where taskkill's /T does the equivalent
            // job by walking parent-pid chains instead.
            detached: process.platform !== 'win32',
        });

        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child.pid);
        }, timeoutMs);

        child.on('error', (error) => {
            clearTimeout(timer);
            resolve({ status: null, signal: null, error, timedOut });
        });
        child.on('exit', (status, signal) => {
            clearTimeout(timer);
            resolve({ status, signal, error: null, timedOut });
        });
    });
}

let failed = false;
for (const suite of suites) {
    console.log(`\n> running ${suite.name} suite...\n`);
    // shell: true is required on Windows: Node refuses to spawnSync a
    // .cmd/.bat file directly (EINVAL) since the CVE-2024-27980 fix -- npm
    // ships as npm.cmd there. Harmless on POSIX where cmd is plain 'npm'.
    // Suite output goes to a real FILE DESCRIPTOR, not an inherited or piped
    // stdio. Under fleet-sprint the process tree runs with no terminal and a
    // consumer that may not drain, and a child writing more than the OS pipe
    // buffer then blocks on write forever: spawnSync never returns, the
    // suite sits at ~0% CPU until the dispatch timeout kills it, and the
    // children are orphaned. Measured against a deliberately non-draining
    // consumer: stdio:'inherit' deadlocks, and stdio:'pipe' ALSO deadlocks
    // (it only moves the block to this process writing the captured buffer
    // back out). Writing to a file descriptor never blocks on a reader, so
    // it is the only variant that completes.
    // The timeout is a second, independent guard. Fixing the stdio deadlock
    // above does not stop a suite hanging for its OWN reasons: vitest will
    // sit forever after the last test if a test leaves a handle open (these
    // suites spawn git and open SQLite), producing no summary and no exit.
    // Observed 2026-09-16: a run reached kb-bible-v2.test.ts, logged 470 KB,
    // then never exited -- two workers alive 40+ minutes at ~0% CPU. Without
    // a bound, that stalls the whole dispatch until fleet's stall detector
    // kills it. A timeout turns an invisible stall into a fast, reported
    // failure with the log intact.
    const logPath = path.join(os.tmpdir(), `apra-fleet-tests-${suite.name}-${process.pid}.log`);
    const fd = fs.openSync(logPath, 'w');
    let result;
    try {
        result = await runSuite(suite.cmd, suite.args, { stdio: ['ignore', fd, fd] }, SUITE_TIMEOUT_MS);
    } finally {
        fs.closeSync(fd);
    }

    const timedOut = result.timedOut;

    // Echo a BOUNDED tail rather than the whole log: the full output is on
    // disk either way, and an unbounded write here would re-introduce the
    // very blocking this function exists to avoid.
    const output = fs.readFileSync(logPath, 'utf8');
    const tail = output.split('\n').slice(-TAIL_LINES).join('\n');
    console.log(tail);
    console.log(`> ${suite.name}: full output at ${logPath}`);

    if (timedOut) {
        failed = true;
        console.error(
            `\n> ${suite.name} suite TIMED OUT after ${SUITE_TIMEOUT_MS / 1000}s and was killed.\n` +
            `> The suite produced output but never exited -- usually a test leaving a\n` +
            `> handle open (a spawned process, an open database). The tail above shows\n` +
            `> the last file it reached; full log: ${logPath}\n`
        );
        continue;
    }
    if (result.error) {
        failed = true;
        console.error(`\n> ${suite.name} suite could not be spawned: ${result.error.message}\n`);
        continue;
    }
    if (result.status !== 0) {
        failed = true;
        console.error(`\n> ${suite.name} suite FAILED (exit ${result.status})\n`);
    }
}

process.exit(failed ? 1 : 0);
