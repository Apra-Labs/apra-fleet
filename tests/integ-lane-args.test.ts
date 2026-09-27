import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  buildLaneArgs, INTEG_PKG_DIR, INTEG_TEST_DIR, INTEG_REPORTER_PATH,
} from '../scripts/integ-lane-args.mjs';
import {
  ISOLATED_HOME_SETUP_PATH, ISOLATED_HOME_IMPORT_FLAG,
} from '../packages/apra-fleet-se/scripts/isolated-home-import.mjs';

// apra-fleet-y3xp (bug v9p2): scripts/run-integ-suites.mjs's real-bd lanes
// spawned `node --test` WITHOUT the run-level home-isolation `--import`
// preload that packages/apra-fleet-se/scripts/run-tests.mjs passes, so that
// lane ran the whole suite against the operator's real HOME / APPDATA /
// LOCALAPPDATA and the real ~/.apra-fleet-se. The lane argv is now built by
// scripts/integ-lane-args.mjs's buildLaneArgs(), which is what these tests
// pin: an assertion on the actual built args, not a grep of the source.
//
// Deliberately NOT a source-text check: a grep for "--import" in
// run-integ-suites.mjs would still pass if the flag were misspelled, pointed
// at a path that does not exist, or were placed after the positional test
// files (where node treats it as an argument to the test run, not a node
// option). The cases below cover each of those instead, and the last one
// spawns the flag for real to prove it isolates rather than merely parses.

const MAIN_LANE_CONCURRENCY = 8;
const ISOLATED_LANE_CONCURRENCY = 1;
const FILES = ['alpha.test.mjs', 'beta.test.mjs'];

describe('buildLaneArgs (scripts/run-integ-suites.mjs real-bd lane argv)', () => {
  it('carries the isolated-home preload for BOTH lanes cmdSupervise runs', () => {
    // Two sequential lanes run per pass (the main concurrency-8 lane and the
    // dolt-heavy isolated lane) -- neither may lose the isolation.
    for (const concurrency of [MAIN_LANE_CONCURRENCY, ISOLATED_LANE_CONCURRENCY]) {
      expect(
        buildLaneArgs(FILES, concurrency),
        `lane at concurrency=${concurrency} is missing the isolated-home preload`,
      ).toContain(ISOLATED_HOME_IMPORT_FLAG);
    }
  });

  it('passes the preload as a node option -- before every positional test file', () => {
    const args = buildLaneArgs(FILES, MAIN_LANE_CONCURRENCY);
    const importIndex = args.indexOf(ISOLATED_HOME_IMPORT_FLAG);
    const firstFileIndex = args.findIndex((a) => !a.startsWith('--'));

    expect(importIndex).toBeGreaterThanOrEqual(0);
    expect(firstFileIndex).toBeGreaterThanOrEqual(0);
    // After the first positional argument, node stops reading node options --
    // the flag would be handed to the test run instead of preloading anything.
    expect(importIndex).toBeLessThan(firstFileIndex);
  });

  it('points the preload at a file that really exists, as a file:// URL', () => {
    const args = buildLaneArgs(FILES, MAIN_LANE_CONCURRENCY);
    const flag = args.find((a) => a.startsWith('--import='))!;
    const url = flag.slice('--import='.length);

    // A bare relative path would resolve against the SPAWNING process's cwd,
    // not this repo -- the reason run-tests.mjs uses a URL too.
    expect(url.startsWith('file://')).toBe(true);
    expect(url).toBe(pathToFileURL(ISOLATED_HOME_SETUP_PATH).href);
    expect(fs.existsSync(ISOLATED_HOME_SETUP_PATH)).toBe(true);
    expect(ISOLATED_HOME_SETUP_PATH).toBe(
      path.join(INTEG_TEST_DIR, 'isolated-home-setup.mjs'),
    );
  });

  it('otherwise still builds the lane the checkpoint reporter needs', () => {
    const args = buildLaneArgs(FILES, MAIN_LANE_CONCURRENCY);

    expect(args[0]).toBe('--test');
    expect(args).toContain(`--test-concurrency=${MAIN_LANE_CONCURRENCY}`);
    // The checkpoint reporter matches file-level events by absolute path
    // (scripts/integ-file-results-reporter.mjs header), so the test files must
    // stay absolute and rooted in the se package's test dir.
    expect(args.slice(-FILES.length)).toEqual(
      FILES.map((f) => path.join(INTEG_TEST_DIR, f)),
    );
    expect(args).toContain(`--test-reporter=${pathToFileURL(INTEG_REPORTER_PATH).href}`);
    expect(INTEG_TEST_DIR).toBe(path.join(INTEG_PKG_DIR, 'test'));
  });

  it('an empty lane still produces a preloaded argv (a resume can leave one lane empty)', () => {
    // runLane() short-circuits an empty lane before spawning, but the builder
    // must not silently drop the isolation for the "no files" shape either --
    // that is the shape a crash-resume hits.
    expect(buildLaneArgs([], ISOLATED_LANE_CONCURRENCY)).toContain(ISOLATED_HOME_IMPORT_FLAG);
  });

  it('the preload actually isolates the home of a process spawned with it', () => {
    // The end the flag exists for: not that the string is well-formed, but
    // that a child carrying it resolves a temp home instead of the real one.
    const printHome = 'console.log(require("os").homedir())';
    const isolated = execFileSync(
      process.execPath,
      [ISOLATED_HOME_IMPORT_FLAG, '-e', printHome],
      { encoding: 'utf8' },
    ).trim();

    expect(isolated).not.toBe(os.homedir());
    // realpath: the helper resolves its temp dir (macOS /var -> /private/var),
    // so compare against the resolved tmpdir rather than os.tmpdir() raw.
    expect(isolated.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
  }, 30_000);
});
