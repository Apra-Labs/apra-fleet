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

/** Best-effort kill of the whole descendant tree rooted at `pid`. */
function killTree(pid) {
    if (!pid) return;
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

const extraArgs = process.argv.slice(3);

function runBounded(cmd, args, opts) {
    return new Promise(resolve => {
        const child = spawn(cmd, args, { ...opts, detached: !isWindows });

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
