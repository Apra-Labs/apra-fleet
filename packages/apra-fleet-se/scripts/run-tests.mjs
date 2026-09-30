// Cross-platform test launcher: runs the exact same `node --test` invocation
// as the plain `test` script, with APRA_FLEET_BD_MOCK set for the requested
// bd mode (see test/helpers/bd-replay.mjs for the mode contract). A node
// launcher (instead of `VAR=x` prefixes in package.json) because inline env
// assignment does not work in Windows cmd/PowerShell npm scripts.
//
//   node scripts/run-tests.mjs mock     -> replay recorded bd fixtures (fast)
//   node scripts/run-tests.mjs real     -> real bd CLI (pre-shim behavior)
//   node scripts/run-tests.mjs record   -> real bd CLI + refresh recordings
//
// Extra args after the mode are passed through to `node --test` (e.g. a
// specific test file path).
//
// apra-fleet-qe83.3: bounded by a wall-clock timeout (default 15 minutes,
// override with APRA_TEST_TIMEOUT_MS) so a hung test (e.g. a test file that
// never resolves and keeps the event loop alive) cannot hold this process --
// and therefore whatever invoked it, e.g. scripts/run-all-tests.mjs's own
// suite loop -- open indefinitely. See that script's header comment for why
// this uses async spawn() plus a manual timer/tree-kill instead of
// spawnSync's own `timeout` option: reaching descendant processes (should
// `node --test` itself ever spawn any) needs a live pid to act on while the
// child is still running, which a fully synchronous spawnSync cannot give
// us.
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { TEST_CONCURRENCY } from '../test/helpers/test-concurrency.mjs';
import { SERIAL_PROCESS_TEST_FILES } from '../test/helpers/serial-process-suites.mjs';
import { sweepStaleTempHomes } from './stale-temp-home-sweep.mjs';
import { ISOLATED_HOME_IMPORT_FLAG } from './isolated-home-import.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(__dirname, '..');
const isWindows = process.platform === 'win32';

const MODES = { mock: '1', real: '0', record: 'record' };
const mode = process.argv[2];
if (!Object.prototype.hasOwnProperty.call(MODES, mode)) {
    console.error(`Usage: node scripts/run-tests.mjs <mock|real|record> [extra node --test args]`);
    process.exit(2);
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const timeoutMs = (() => {
    const raw = Number(process.env.APRA_TEST_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
})();

// apra-fleet-v6t7.16: test/isolated-home-setup.mjs's per-test-file-process
// exit handler cleans up its own apra-fleet-se-test-run-* temp home, but
// that handler is registered via process.on('exit'), which never fires when
// a hung test file is force-killed (taskkill /F on Windows, SIGKILL on
// POSIX -- see killTree()/runBounded() above), leaking the temp dir under
// os.tmpdir() indefinitely. Sweep those stale dirs from THIS parent process
// -- which outlives every individual test-file child -- BEFORE spawning the
// node --test run below, rather than from inside isolated-home-setup.mjs
// itself: that module is imported by every test-file process via --import,
// so a sweep there would race with and delete a SIBLING file's still-live
// temp home in the same concurrent run. See scripts/stale-temp-home-sweep.mjs
// (extracted so it is independently unit-testable) for the liveness-marker
// rework this does: the sweep never deletes a dir whose owning pid is still
// alive, regardless of age, and only falls back to age-gating by this run's
// own timeoutMs for dirs with no live-owner marker.
sweepStaleTempHomes(timeoutMs);

// TEST_CONCURRENCY (test/helpers/test-concurrency.mjs) is exported into the
// test workers' env below so test/helpers/scaled-timeout.mjs can derive
// contention-aware timeout budgets instead of hardcoding fixed wall-clock
// bounds that blow up under concurrent load but pass standalone.

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
            process.kill(-pid, 'SIGKILL');
        } catch {
            try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
    }
}

// apra-fleet-qe83.4: grace window between the belt-and-braces child.kill()
// below and the forced process.exit() -- see scripts/run-all-tests.mjs's
// identical constant for the full rationale.
const FORCE_EXIT_GRACE_MS = (() => {
    const raw = Number(process.env.APRA_TEST_FORCE_EXIT_GRACE_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 5_000;
})();

const extraArgs = process.argv.slice(3);

// apra-fleet-qe83.3.2 rework: this process's own `node --test` child below is
// spawned with detached:true on POSIX (so THIS process's own killTree(-pid)
// can reach a grandchild tree), which makes it the leader of its own,
// separate process group/session. If this process is itself invoked inside
// an OUTER bounded runner (scripts/run-all-tests.mjs, via
// `npm test --workspace=...`) that outer runner's own group-wide kill on
// timeout cannot reach that disjoint group -- only THIS process (which is
// still a member of the outer group) can. Track the live child pid so a
// trapped SIGTERM (see below) can reap it before this process exits.
let activeChildPid = null;

// See the comment above: an outer bounded runner facing its own timeout
// broadcasts SIGTERM to its whole process group before escalating to
// SIGKILL, specifically to give a nested runner like this one a chance to
// reap its OWN detached child first. Without this handler, that outer
// SIGKILL only reaps this process and anything still inside ITS group --
// never the disjoint `node --test` group -- orphaning it still holding the
// outer dispatch's stdout/stderr pipe open (the recorded 45-minute
// pipe-hold bug, reintroduced on POSIX by the npm test --workspace=... ->
// run-tests.mjs -> node --test nesting).
process.on('SIGTERM', () => {
    if (activeChildPid) killTree(activeChildPid);
    process.exit(1);
});

function runBounded(cmd, args, opts, boundMs) {
    return new Promise(resolve => {
        const child = spawn(cmd, args, { ...opts, detached: !isWindows });
        activeChildPid = child.pid;

        let timedOut = false;
        let settled = false;
        let forceExitTimer = null;
        const timer = setTimeout(() => {
            timedOut = true;
            killTree(child.pid);
            // Belt-and-braces: see scripts/run-all-tests.mjs's identical
            // block for the full rationale -- killTree is best-effort, so
            // also SIGKILL directly and force-exit if the child still has
            // not gone away after a short grace window.
            if (!simulateUnkillable) {
                try { child.kill('SIGKILL'); } catch { /* already gone */ }
            }
            forceExitTimer = setTimeout(() => {
                if (settled) return;
                console.error(`\n> test run did not exit after being killed -- forcing process exit\n`);
                process.exit(1);
            }, FORCE_EXIT_GRACE_MS);
        }, boundMs);

        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (forceExitTimer) clearTimeout(forceExitTimer);
            // apra-fleet-qe83.3.2 rework (round 3 fix): mirror
            // scripts/run-all-tests.mjs's `if (currentChild === child)
            // currentChild = null` -- without this, a SIGTERM arriving after
            // this child has already exited still finds a stale
            // activeChildPid in the trap above and calls killTree() on a
            // pid that may have been recycled by the OS, i.e.
            // process.kill(-pid, 'SIGKILL') against an unrelated process
            // group.
            if (activeChildPid === child.pid) activeChildPid = null;
            resolve(result);
        };

        child.on('exit', (code) => finish({ status: timedOut ? null : code, timedOut }));
        child.on('error', (err) => {
            console.error(`\n> test run errored: ${err.message}\n`);
            finish({ status: 1, timedOut });
        });
    });
}

function envFor(concurrency) {
    return {
        ...process.env,
        APRA_FLEET_BD_MOCK: MODES[mode],
        APRA_FLEET_TEST_CONCURRENCY: String(concurrency),
    };
}

let finalResult;

if (extraArgs.length > 0) {
    // Caller already chose exactly which file(s)/pattern to run (a developer
    // re-running one file, or test/run-tests-script-wiring.test.mjs's derived
    // probe command) -- nothing to isolate it from, so run it exactly as
    // before, at the full TEST_CONCURRENCY.
    finalResult = await runBounded(
        process.execPath,
        [
            '--test',
            // apra-fleet-v6t7.16: run-level home isolation, applied via --import
            // before any test file's own top-level code runs. The flag itself is
            // resolved once in ./isolated-home-import.mjs and shared with the other
            // entry point into this suite (scripts/run-integ-suites.mjs's real-bd
            // lanes) -- see that module's header.
            ISOLATED_HOME_IMPORT_FLAG,
            '--test-reporter=./test/helpers/timestamped-reporter.mjs',
            '--test-reporter-destination=stdout',
            `--test-concurrency=${TEST_CONCURRENCY}`,
            ...extraArgs,
        ],
        {
            cwd: pkgRoot,
            stdio: 'inherit',
            env: envFor(TEST_CONCURRENCY),
        },
        timeoutMs,
    );
} else {
    // apra-fleet-i9ag.19.46: the default (no explicit file argument) run
    // splits into two SEQUENTIAL phases so the heavy real-process suites
    // registered in test/helpers/serial-process-suites.mjs never run
    // concurrently with each other, or with the rest of the suite -- see
    // that module's header for why an incidental/scaled-timeout-only fix
    // (just widening the budget) is not the right fix. This is what makes
    // those suites' pass/fail outcome independent of how many *other*
    // se-lane suites the scheduler happens to be running at the same time.
    const allTestFiles = fs
        .readdirSync(path.join(pkgRoot, 'test'))
        .filter((name) => name.endsWith('.test.mjs'))
        .sort();

    // Loud, fail-fast check that the registry itself has not gone stale
    // (a renamed/deleted file left behind in the list): a silent no-op here
    // would quietly stop isolating that file from the concurrent lane again.
    const missing = SERIAL_PROCESS_TEST_FILES.filter((name) => !allTestFiles.includes(name));
    if (missing.length > 0) {
        console.error(
            `\n> test/helpers/serial-process-suites.mjs lists file(s) that no longer exist under test/: ${missing.join(', ')}\n` +
            `> fix the registry (rename or remove the stale entry) before running tests.\n`
        );
        process.exit(1);
    }

    const serialSet = new Set(SERIAL_PROCESS_TEST_FILES);
    const concurrentFiles = allTestFiles.filter((name) => !serialSet.has(name)).map((name) => `test/${name}`);
    const serialFiles = SERIAL_PROCESS_TEST_FILES.map((name) => `test/${name}`);

    // apra-fleet-i9ag.19.46 rework: the two phases below share ONE deadline
    // (`sharedDeadline`, timeoutMs from the moment this branch starts) rather
    // than each getting its own fresh timeoutMs. Giving each runBounded() call
    // its own full budget silently doubled this entry point's worst-case
    // wall-clock hold to 2x timeoutMs (verified: `APRA_TEST_TIMEOUT_MS=5000
    // node scripts/run-tests.mjs mock` took ~11s, not ~5s) -- exactly the
    // "hung suite can never hold a dispatch open indefinitely" guarantee
    // CLAUDE.md documents this entry point for. The serial lane only gets
    // whatever remains of the shared budget after the concurrent lane
    // finishes, and is skipped entirely (loudly, not silently) once that
    // budget is already spent -- a hung concurrent lane must not also buy the
    // serial lane a second full timeoutMs.
    const sharedDeadline = Date.now() + timeoutMs;
    const remainingBudgetMs = () => Math.max(0, sharedDeadline - Date.now());

    console.log(`\n> concurrent lane: ${concurrentFiles.length} test file(s) at --test-concurrency=${TEST_CONCURRENCY}\n`);
    const concurrentResult = await runBounded(
        process.execPath,
        [
            '--test',
            // apra-fleet-v6t7.16: run-level home isolation -- see the identical
            // comment on the extraArgs branch above for the full rationale.
            ISOLATED_HOME_IMPORT_FLAG,
            '--test-reporter=./test/helpers/timestamped-reporter.mjs',
            '--test-reporter-destination=stdout',
            `--test-concurrency=${TEST_CONCURRENCY}`,
            ...concurrentFiles,
        ],
        {
            cwd: pkgRoot,
            stdio: 'inherit',
            env: envFor(TEST_CONCURRENCY),
        },
        timeoutMs,
    );

    if (concurrentResult.timedOut) {
        console.error(`\n> concurrent lane TIMED OUT after ${timeoutMs}ms and was killed\n`);
    }

    const serialBudgetMs = remainingBudgetMs();
    let serialResult;
    if (concurrentResult.timedOut || serialBudgetMs <= 0) {
        console.error(
            `\n> skipping serial lane: the shared ${timeoutMs}ms test budget is already exhausted ` +
            `(concurrent lane ${concurrentResult.timedOut ? 'timed out' : `used all of it, ${serialBudgetMs}ms remaining`}) -- ` +
            `running it against a fresh budget would let a hung concurrent lane buy a second full timeoutMs\n`
        );
        serialResult = { status: 1, timedOut: true };
    } else {
        console.log(
            `\n> serial lane: ${serialFiles.length} heavy real-process test file(s) at --test-concurrency=1, ` +
            `${serialBudgetMs}ms remaining of the shared ${timeoutMs}ms budget ` +
            `(registered in test/helpers/serial-process-suites.mjs, run only after the concurrent lane finishes so ` +
            `neither lane contends with the other)\n`
        );
        serialResult = await runBounded(
            process.execPath,
            [
                '--test',
                // apra-fleet-v6t7.16: run-level home isolation -- see the identical
                // comment on the extraArgs branch above for the full rationale.
                ISOLATED_HOME_IMPORT_FLAG,
                '--test-reporter=./test/helpers/timestamped-reporter.mjs',
                '--test-reporter-destination=stdout',
                '--test-concurrency=1',
                ...serialFiles,
            ],
            {
                cwd: pkgRoot,
                stdio: 'inherit',
                env: envFor(1),
            },
            serialBudgetMs,
        );
        if (serialResult.timedOut) {
            console.error(`\n> serial lane TIMED OUT after ${serialBudgetMs}ms (remaining shared budget) and was killed\n`);
        }
    }

    finalResult = {
        timedOut: concurrentResult.timedOut || serialResult.timedOut,
        status: concurrentResult.status !== 0 ? concurrentResult.status : serialResult.status,
    };
}

if (finalResult.timedOut) {
    console.error(`\n> test run TIMED OUT and was killed\n`);
    process.exit(1);
}
process.exit(finalResult.status ?? 1);
