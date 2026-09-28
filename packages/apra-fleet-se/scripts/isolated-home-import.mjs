// Single resolution of the run-level home-isolation preload for this
// package's `node --test` runs.
//
// test/isolated-home-setup.mjs (apra-fleet-v6t7.16) only isolates a run's
// HOME/USERPROFILE/HOMEDRIVE+HOMEPATH, APRA_FLEET_DATA_DIR, FLEET_SE_DATA_DIR
// and APPDATA/LOCALAPPDATA if it is actually preloaded via `--import` before
// any test file's own top-level code runs. That made the flag a thing every
// entry point into this suite has to remember, and one of them did not:
// scripts/run-integ-suites.mjs's real-bd lanes spawned `node --test` without
// it (apra-fleet-y3xp / v9p2), so that lane ran against the operator's REAL
// home while the bounded scripts/run-tests.mjs lane did not.
//
// Exported from here rather than recomputed per caller so a new entry point
// gets the isolation by importing one value instead of re-deriving a path,
// and so there is exactly one place the setup module's location is written
// down. Resolved from THIS file's own URL, so it is correct regardless of
// the calling process's cwd, and a file:// URL rather than a bare path
// because `--import` resolves a bare relative specifier against cwd while a
// file URL is unambiguous.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Absolute path of the run-level isolation setup module. */
export const ISOLATED_HOME_SETUP_PATH = path.join(pkgRoot, 'test', 'isolated-home-setup.mjs');

/** The same module as a file:// URL, the form `--import` must receive. */
export const ISOLATED_HOME_SETUP_IMPORT = pathToFileURL(ISOLATED_HOME_SETUP_PATH).href;

/** The complete `node` flag to put in a `node --test ...` argv. */
export const ISOLATED_HOME_IMPORT_FLAG = `--import=${ISOLATED_HOME_SETUP_IMPORT}`;
