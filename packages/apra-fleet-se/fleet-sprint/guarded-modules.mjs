import path from 'path';
import { fileURLToPath } from 'url';

// =============================================================================
// SHARED GUARDED-MODULE LIST -- the single place a newly extracted fleet-sprint
// module is registered for mechanical guard coverage.
//
// WHY THIS EXISTS: every mechanical guard in this directory
// (dispatch-safety-guard.mjs, dolt-literal-guard.mjs, full-db-fetch-guard.mjs,
// shell-command-guard.mjs) was originally pointed at ONE hard-coded file --
// runner.js -- by each of its own tests. runner.js is being decomposed into
// smaller modules; under the old wiring, the moment a guarded construct moved
// out of runner.js into a newly extracted module, EVERY guard silently stopped
// covering it while continuing to report a green baseline. That is the exact
// failure mode this list prevents: extract a module, add ONE line here, and
// all four guards pick it up at once.
//
// REGISTERING A NEWLY EXTRACTED MODULE: add its filename to GUARDED_MODULES
// below. Do not add a second list anywhere else, and do not re-point an
// individual guard at its own private array of paths -- a guard that does not
// consume this list is a guard whose coverage silently rots.
//
// WHAT DOES *NOT* BELONG HERE: the per-shell command builders --
// se-posix.mjs, se-windows.mjs, se-windows-gitbash.mjs, se-os-commands.mjs and
// dolt-settle.mjs. They deliberately emit `$HOME`, `$env:USERPROFILE`,
// `$env:TEMP` and `$( )` because they ARE the OS-branched command surface the
// shell-command invariant tells everyone else to route through; scanning them
// would report their entire reason for existing as violations. Likewise
// dolt-sync.mjs, which legitimately builds the `bd dolt pull`/`bd dolt push`
// command strings (see DOLT_LITERAL_EXEMPT below and dolt-literal-guard.mjs's
// own header).
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Filenames (relative to this directory) of every fleet-sprint module the
 * mechanical guards must scan. Add a newly extracted module here -- this is
 * the single registration point.
 */
export const GUARDED_MODULES = ['runner.js'];

/**
 * Modules the dolt-literal guard must NEVER scan, by basename. dolt-sync.mjs
 * is the single permitted dolt command surface: it builds the literal
 * `bd dolt pull` / `bd dolt push` strings on purpose (apra-fleet-417.2.1/
 * 417.2.2), so pointing the dolt-literal guard at it would flag the sync
 * module for being the sync module. Documented verbatim in
 * dolt-literal-guard.mjs's header; enforced here so the exemption survives
 * anyone adding dolt-sync.mjs to GUARDED_MODULES (or passing it explicitly).
 */
export const DOLT_LITERAL_EXEMPT = ['dolt-sync.mjs'];

/** Absolute path to a fleet-sprint module by filename. */
export function guardedModulePath(fileName) {
    return path.join(__dirname, fileName);
}

/**
 * Absolute paths of every registered guarded module, plus any `extraPaths`
 * the caller appends (tests pass a throwaway fixture module this way, proving
 * the list is what the guards actually read rather than a hard-coded name).
 */
export function guardedModulePaths(extraPaths = []) {
    if (!Array.isArray(extraPaths)) {
        throw new TypeError('guardedModulePaths(extraPaths): extraPaths must be an array of file paths');
    }
    return [...GUARDED_MODULES.map(guardedModulePath), ...extraPaths];
}

/**
 * The guarded-module list as the dolt-literal guard must see it: the shared
 * list with DOLT_LITERAL_EXEMPT basenames filtered out. Takes the same
 * `extraPaths` as guardedModulePaths so the exemption applies to caller-
 * supplied paths too -- a fixture literally named dolt-sync.mjs is exempt,
 * while byte-identical content under any other name is not.
 */
export function doltLiteralModulePaths(extraPaths = []) {
    return guardedModulePaths(extraPaths).filter((p) => !DOLT_LITERAL_EXEMPT.includes(path.basename(p)));
}
