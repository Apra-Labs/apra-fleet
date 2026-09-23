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
import path from 'path';
import { fileURLToPath } from 'url';
import { TEST_CONCURRENCY } from '../test/helpers/test-concurrency.mjs';

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

function runBounded(cmd, args, opts) {
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
        }, timeoutMs);

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

const result = await runBounded(
    process.execPath,
    [
        '--test',
        '--test-reporter=./test/helpers/timestamped-reporter.mjs',
        '--test-reporter-destination=stdout',
        `--test-concurrency=${TEST_CONCURRENCY}`,
        ...(extraArgs.length > 0 ? extraArgs : ['test/*.test.mjs']),
    ],
    {
        cwd: pkgRoot,
        stdio: 'inherit',
        env: {
            ...process.env,
            APRA_FLEET_BD_MOCK: MODES[mode],
            APRA_FLEET_TEST_CONCURRENCY: String(TEST_CONCURRENCY),
        },
    },
);

if (result.timedOut) {
    console.error(`\n> test run TIMED OUT after ${timeoutMs}ms and was killed\n`);
    process.exit(1);
}
process.exit(result.status ?? 1);
