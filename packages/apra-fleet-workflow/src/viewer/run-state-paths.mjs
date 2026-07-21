/**
 * apra-fleet-eft.2.3 (renamed under eft.37.1): path resolution for the
 * continuous per-run state file, keyed by run id (NOT the HHMMSS key used by
 * the crash-safety snapshot net, which collides across days -- see
 * src/viewer/index.mjs persistState()).
 *
 * This module is domain-neutral core: it knows about "workflow runs", not
 * about sprints. auto-sprint is one workflow that happens to run on top of it.
 *
 * Layout, under the SERVICE data directory (never the repo checkout, so a
 * `git status`/`git clean` in the working tree never touches it):
 *   <serviceDataDir>/running/<runId>.json   - live run, in-place overwrite
 *   <serviceDataDir>/old_runs/<runId>.json  - terminal run, moved (not copied) here
 *
 * `<serviceDataDir>` reuses the SAME ~/.apra-fleet/data convention (honoring
 * APRA_FLEET_DATA_DIR) as the fleet client's server-resolution module, so
 * there is exactly one "where does apra-fleet keep its runtime state" answer
 * across the whole codebase rather than a second, viewer-local one.
 */
import path from 'node:path';
import fs from 'node:fs';
import { getFleetDataDir } from '@apralabs/apra-fleet-client/server-resolution';

/** @returns {string} <serviceDataDir>/running -- live, in-place-overwritten run state files. */
export function getRunningRunsDir(env = process.env) {
    return path.join(getFleetDataDir(env), 'running');
}

/** @returns {string} <serviceDataDir>/old_runs -- terminal run state files, moved (not copied) here. */
export function getOldRunsDir(env = process.env) {
    return path.join(getFleetDataDir(env), 'old_runs');
}

/**
 * @param {string} runId - stable per-run id (e.g. a caller-supplied runId or a
 *   generated UUID), NOT an HHMMSS-style clock key, which collides across two
 *   runs started in the same second on different days.
 * @returns {string} path to the run's live state file: <serviceDataDir>/running/<runId>.json
 */
export function getRunningRunStatePath(runId, env = process.env) {
    if (!runId) {
        throw new TypeError('getRunningRunStatePath requires a runId');
    }
    return path.join(getRunningRunsDir(env), `${runId}.json`);
}

/**
 * Resolve the terminal-state file path for a run.
 *
 * As a READER: returns the existing file, checking old_runs/ first and then
 * falling back to the legacy directory (read-only) so history for runs that
 * terminated before this rename still loads.
 *
 * As a WRITE target: for a fresh runId neither location exists yet, so this
 * returns the canonical old_runs/<runId>.json destination -- new terminal
 * writes always land in old_runs/, never in the legacy directory.
 *
 * @param {string} runId
 * @returns {string} path to the run's terminal state file.
 */
export function getTerminalRunStatePath(runId, env = process.env) {
    if (!runId) {
        throw new TypeError('getTerminalRunStatePath requires a runId');
    }
    const oldRunsPath = path.join(getOldRunsDir(env), `${runId}.json`);
    if (fs.existsSync(oldRunsPath)) {
        return oldRunsPath;
    }
    // BOUNDARY-COMPAT: terminal run state written by pre-runId releases lives
    // under the legacy old_sprints/ directory. Resolve it read-only so history
    // for runs that terminated before this rename still loads; this branch
    // never creates or writes that directory -- fresh terminal writes always
    // go to old_runs/ (returned below). Remove one release after the se
    // consumers stop producing legacy files.
    const legacyTerminalPath = path.join(getFleetDataDir(env), 'old_sprints', `${runId}.json`);
    if (fs.existsSync(legacyTerminalPath)) {
        return legacyTerminalPath;
    }
    return oldRunsPath;
}
