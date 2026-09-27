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

/**
 * Resolves a path into the one spelling both sides of a comparison can agree
 * on, across every platform in the CI matrix.
 *
 * fs.realpathSync.native rather than fs.realpathSync: the JS implementation
 * only walks symlinks, so on win32 it leaves an 8.3 short name intact --
 * os.tmpdir() reads TEMP, which on a GitHub Windows runner is
 * C:\Users\RUNNER~1\AppData\Local\Temp, while the child below reports the
 * long C:\Users\runneradmin\... form. Only the native binding expands the
 * short name, and it also handles macOS's /var -> /private/var symlink.
 * Lowercasing on win32 then absorbs drive-letter and component case (c:\ vs
 * C:\), which are the same path there.
 *
 * The fallback matters: isolated-home-setup.mjs removes its temp home in a
 * process 'exit' handler, so the directory the child printed is already gone
 * by the time this process looks at it and .native would throw ENOENT. That
 * string is safe to use unresolved -- applyIsolatedHome() built it by passing
 * the freshly created dir through fs/promises realpath (the native binding)
 * inside the child, so it is already in long, symlink-free form.
 */
function normalizeForCompare(p: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(p);
  } catch {
    resolved = path.resolve(p);
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True when `child` is a strict descendant of `parent`. */
function isInside(parent: string, child: string): boolean {
  // path.relative, not startsWith: a raw prefix test also accepts a sibling
  // that merely shares the prefix (/tmp/foo-bar under a /tmp/foo parent) and
  // is sensitive to separator spelling. Checking the first segment rather
  // than rel.startsWith('..') keeps a legitimately '..'-prefixed directory
  // name from reading as an escape.
  const rel = path.relative(normalizeForCompare(parent), normalizeForCompare(child));
  return rel !== '' && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..';
}

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

    // Both comparisons go through normalizeForCompare(), so a respelling of
    // the same directory cannot make an UNisolated home look isolated (real
    // home reported in a different case on win32) nor an isolated one look
    // like an escape (8.3 temp root, macOS /var symlink).
    expect(normalizeForCompare(isolated)).not.toBe(normalizeForCompare(os.homedir()));
    expect(
      isInside(os.tmpdir(), isolated),
      `isolated home ${isolated} is not inside the temp dir ${os.tmpdir()}`,
    ).toBe(true);
  }, 30_000);
});
