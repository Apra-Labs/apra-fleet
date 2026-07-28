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
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(__dirname, '..');

const MODES = { mock: '1', real: '0', record: 'record' };
const mode = process.argv[2];
if (!Object.prototype.hasOwnProperty.call(MODES, mode)) {
    console.error(`Usage: node scripts/run-tests.mjs <mock|real|record> [extra node --test args]`);
    process.exit(2);
}

// Keep in sync with the --test-concurrency value passed below. Exported into
// the test workers' env so test/helpers/scaled-timeout.mjs can derive
// contention-aware timeout budgets instead of hardcoding fixed wall-clock
// bounds that blow up under concurrent load but pass standalone.
const TEST_CONCURRENCY = 8;

const extraArgs = process.argv.slice(3);
const result = spawnSync(
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
process.exit(result.status ?? 1);
