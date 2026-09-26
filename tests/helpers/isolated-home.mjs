/**
 * Shared isolated-home test helper (apra-fleet-y3xp.1).
 *
 * Root cause this exists to fix: on win32, Node's os.homedir() reads
 * USERPROFILE, then HOMEDRIVE+HOMEPATH, and never HOME. A test that
 * overrides only process.env.HOME therefore silently keeps reading and
 * writing the REAL developer home directory (fleet.key under
 * ~/.apra-fleet, the real data/running dir) on any Windows box. This
 * module is the ONE place that isolates a test's notion of "home": every
 * vitest (.ts) test and every node --test (.mjs) suite in this repo should
 * import THIS file rather than hand-rolling its own HOME override.
 *
 * IMPORTANT -- import-time ordering: several modules (e.g. src/paths.ts's
 * FLEET_DIR) read the home / APRA_FLEET_DATA_DIR at MODULE-LOAD time, into
 * an eager top-level const. Calling applyIsolatedHome() after such a
 * module has already been imported does nothing for that module's cached
 * value. Apply this helper BEFORE importing anything that might read the
 * home eagerly -- e.g. via a dynamic `await import(...)` performed strictly
 * after applyIsolatedHome() resolves, or via a runner-level setup hook
 * (vitest `setupFiles`, or `node --test --import <this-style-setup>`) that
 * runs before any test file's own imports are evaluated.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {Object} IsolatedHome
 * @property {string} tempHome - the temp directory now acting as HOME/USERPROFILE.
 * @property {string} dataDir - tempHome/.apra-fleet/data (same relative layout src/paths.ts's default uses).
 * @property {() => Promise<void>} restore - restores every touched env var to its exact prior value (deleting any var that was previously unset) and removes the temp dir. Idempotent.
 */

// The full set of env vars this helper owns. Order matters for HOMEDRIVE/HOMEPATH
// derivation below but not for save/restore.
const HOME_VARS = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APRA_FLEET_DATA_DIR'];

/**
 * Derive the win32 HOMEDRIVE/HOMEPATH pair from a directory the same way
 * console-server.test.ts's original hand-rolled isolation did, so behaviour
 * is unchanged for callers migrating onto this helper.
 * @param {string} dir
 */
function deriveHomeDriveAndPath(dir) {
  const parsed = path.parse(dir);
  const homedrive = parsed.root.replace(/[\\/]+$/, '');
  const homepath = dir.slice(homedrive.length);
  return { homedrive, homepath };
}

/**
 * The relative layout under a home dir that src/paths.ts's default FLEET_DIR
 * uses (path.join(os.homedir(), '.apra-fleet', 'data')) and src/services/jwt.ts
 * uses for fleet.key (path.join(os.homedir(), '.apra-fleet', 'fleet.key')).
 * Keeping APRA_FLEET_DATA_DIR at this same relative path under the temp home
 * means a test that isolates HOME automatically gets a consistent, colocated
 * data dir and fleet.key -- both land under the same temp tree instead of two
 * unrelated locations.
 * @param {string} homeDir
 */
export function fleetDataDirFor(homeDir) {
  return path.join(homeDir, '.apra-fleet', 'data');
}

/**
 * Throws unless homedirFn() resolves to exactly `expected`. Exported
 * separately (with an injectable homedirFn, default node:os's real
 * os.homedir) so a test can force the mismatch case without needing to
 * actually break process-wide env state.
 *
 * Comparison is a strict string match against the path we set -- no
 * realpath/normalize -- because both macOS (/var -> /private/var symlink)
 * and Windows (8.3 short paths) can otherwise make an already-correct
 * isolation look like a mismatch.
 *
 * @param {string} expected
 * @param {() => string} [homedirFn]
 */
export function assertHomeResolves(expected, homedirFn = os.homedir) {
  const actual = homedirFn();
  if (actual !== expected) {
    throw new Error(
      'isolated-home guard: os.homedir() resolved to "' +
        actual +
        '" but this test expected the isolated temp home "' +
        expected +
        '". HOME/USERPROFILE/HOMEDRIVE+HOMEPATH did not take effect for this ' +
        'process, so continuing could read or write the real developer home ' +
        'directory (including the real fleet.key). Refusing to continue.',
    );
  }
}

/**
 * Applies isolated-home env vars to process.env for the current process:
 * HOME, USERPROFILE, HOMEDRIVE+HOMEPATH (win32) and APRA_FLEET_DATA_DIR, all
 * pointed at a fresh temp directory. Self-checks with assertHomeResolves
 * before returning.
 *
 * @param {string} [prefix] - mkdtemp prefix, so different suites' temp dirs are recognizable in a temp listing.
 * @returns {Promise<IsolatedHome>}
 */
export async function applyIsolatedHome(prefix = 'apra-fleet-isolated-home-') {
  // Resolve symlinks (e.g. macOS's /var -> /private/var) up front, before
  // anything derives a path from tempHome. A caller that later spawns a
  // child process pointed at a path built from this home (e.g. installed-
  // supervisor.test.mjs's WORKFLOWS_DIR, itself built from os.homedir())
  // would otherwise hand that child an UNRESOLVED argv path, while Node
  // resolves import.meta.url through realpath when loading the ES module --
  // serve.mjs's own isMainModule() compares the two for strict string
  // equality, so an unresolved tempHome makes it silently return false
  // there (see mkTmp()'s identical comment in
  // packages/apra-fleet-se/test/installed-supervisor.test.mjs, the case
  // this fixes). Resolving here keeps every derived path and the
  // assertHomeResolves() comparison below on the SAME resolved string, so
  // the "no realpath in the comparison itself" property this module's
  // header promises still holds -- there's nothing left to resolve later.
  const tempHome = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), prefix)));
  const dataDir = fleetDataDirFor(tempHome);

  /** @type {Record<string, string | undefined>} */
  const saved = {};
  for (const key of HOME_VARS) saved[key] = process.env[key];

  const { homedrive, homepath } = deriveHomeDriveAndPath(tempHome);
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.HOMEDRIVE = homedrive;
  process.env.HOMEPATH = homepath;
  process.env.APRA_FLEET_DATA_DIR = dataDir;

  assertHomeResolves(tempHome);

  let restored = false;
  /**
   * @param {{ keepDir?: boolean }} [opts] - keepDir: true skips removing
   *   tempHome, for the rare caller that installs real files under the
   *   isolated home and needs them to outlive the env-var restore (e.g. a
   *   later step in the same test spawns a child process pointed at that
   *   same directory). Env vars are always restored regardless.
   */
  const restore = async (opts = {}) => {
    if (restored) return;
    restored = true;
    for (const key of HOME_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    if (!opts.keepDir) {
      await fsp.rm(tempHome, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    }
  };

  return { tempHome, dataDir, restore };
}

/**
 * Builds a child-process env object carrying the same isolated-home
 * variable set as applyIsolatedHome(), for spawn(..., { env }) callers that
 * need a fresh temp home of their own (rather than inheriting the current
 * process's already-isolated one). Does NOT touch process.env.
 *
 * On win32, process.env / a base env object can carry a differently-cased
 * duplicate of a var this helper sets (e.g. "UserProfile" alongside
 * "USERPROFILE" -- Windows env vars are case-insensitive but Node's
 * process.env representation is not guaranteed to dedupe by case). Any
 * case-insensitive duplicate of a var this helper owns is dropped from the
 * base before the canonical-cased value is set, so the child process never
 * sees two conflicting entries for the same variable.
 *
 * @param {string} tempHome
 * @param {Record<string, string | undefined>} [baseEnv]
 * @returns {Record<string, string>}
 */
export function buildIsolatedHomeEnv(tempHome, baseEnv = process.env) {
  const ownedUpper = new Set(HOME_VARS.map((k) => k.toUpperCase()));
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (ownedUpper.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  const { homedrive, homepath } = deriveHomeDriveAndPath(tempHome);
  env.HOME = tempHome;
  env.USERPROFILE = tempHome;
  env.HOMEDRIVE = homedrive;
  env.HOMEPATH = homepath;
  env.APRA_FLEET_DATA_DIR = fleetDataDirFor(tempHome);
  return env;
}
