// The `node --test` argv for one real-bd lane of scripts/run-integ-suites.mjs,
// built as a pure function so the flags a lane actually runs with are
// assertable without spawning anything (tests/integ-lane-args.test.ts).
//
// Extracted for apra-fleet-y3xp (bug v9p2): runLane() used to build this argv
// inline and had silently drifted from the OTHER entry point into the same
// suite, packages/apra-fleet-se/scripts/run-tests.mjs -- it omitted the
// run-level home-isolation `--import` preload, so the real-bd lane ran against
// the operator's REAL HOME/APPDATA/LOCALAPPDATA (and the real
// ~/.apra-fleet-se) while the bounded npm test lane did not. An inline argv
// inside a spawn() call could only be checked by reading the source or by
// running the whole suite for real; a pure builder can be pinned by a test.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ISOLATED_HOME_IMPORT_FLAG } from '../packages/apra-fleet-se/scripts/isolated-home-import.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');

/** packages/apra-fleet-se -- the lane's cwd, and the root of its test dir. */
export const INTEG_PKG_DIR = path.join(repoRoot, 'packages', 'apra-fleet-se');

/** Where the lane's *.test.mjs files live; lane file names are relative to it. */
export const INTEG_TEST_DIR = path.join(INTEG_PKG_DIR, 'test');

/** The checkpoint reporter that streams per-file results into the status file. */
export const INTEG_REPORTER_PATH = path.join(scriptsDir, 'integ-file-results-reporter.mjs');

/**
 * Build the full argv (after process.execPath) for one lane.
 *
 * @param {string[]} files - test file names relative to INTEG_TEST_DIR. Passed
 *   as ABSOLUTE paths on purpose: the checkpoint reporter identifies file-level
 *   events by name === data.file (see its header comment).
 * @param {number} concurrency - the lane's --test-concurrency.
 * @returns {string[]}
 */
export function buildLaneArgs(files, concurrency) {
  return [
    '--test',
    // Run-level home isolation, shared with scripts/run-tests.mjs rather than
    // spelled out again here -- the drift between the two is the bug this
    // builder exists to make untestable-by-inspection no longer possible.
    ISOLATED_HOME_IMPORT_FLAG,
    `--test-concurrency=${concurrency}`,
    '--test-reporter=./test/helpers/timestamped-reporter.mjs',
    '--test-reporter-destination=stdout',
    `--test-reporter=${pathToFileURL(INTEG_REPORTER_PATH).href}`,
    '--test-reporter-destination=stdout',
    ...files.map((f) => path.join(INTEG_TEST_DIR, f)),
  ];
}
