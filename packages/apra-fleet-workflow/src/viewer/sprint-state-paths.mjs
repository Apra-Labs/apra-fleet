/**
 * apra-fleet-eft.2.3: path resolution for the continuous per-sprint state
 * file, keyed by sprint id (NOT the HHMMSS key used by the existing
 * sprint-logs/ crash-safety net, which collides across days -- see
 * src/viewer/index.mjs persistState()).
 *
 * Layout, under the SERVICE data directory (never the repo checkout, so a
 * `git status`/`git clean` in the working tree never touches it):
 *   <serviceDataDir>/running/<sprintId>.json      - live sprint, in-place overwrite
 *   <serviceDataDir>/old_sprints/<sprintId>.json  - terminal sprint, moved (not copied) here
 *
 * `<serviceDataDir>` reuses the SAME ~/.apra-fleet/data convention (honoring
 * APRA_FLEET_DATA_DIR) as the fleet client's server-resolution module, so
 * there is exactly one "where does apra-fleet keep its runtime state" answer
 * across the whole codebase rather than a second, viewer-local one.
 */
import path from 'node:path';
import { getFleetDataDir } from '@apralabs/apra-fleet-client/server-resolution';

/** @returns {string} <serviceDataDir>/running -- live, in-place-overwritten sprint state files. */
export function getRunningSprintsDir(env = process.env) {
    return path.join(getFleetDataDir(env), 'running');
}

/** @returns {string} <serviceDataDir>/old_sprints -- terminal sprint state files, moved (not copied) here. */
export function getOldSprintsDir(env = process.env) {
    return path.join(getFleetDataDir(env), 'old_sprints');
}

/**
 * @param {string} sprintId - stable per-sprint id (e.g. a runId), NOT an
 *   HHMMSS-style clock key, which collides across two sprints started in the
 *   same second on different days.
 * @returns {string} path to the sprint's live state file: <serviceDataDir>/running/<sprintId>.json
 */
export function getRunningSprintStatePath(sprintId, env = process.env) {
    if (!sprintId) {
        throw new TypeError('getRunningSprintStatePath requires a sprintId');
    }
    return path.join(getRunningSprintsDir(env), `${sprintId}.json`);
}

/**
 * @param {string} sprintId
 * @returns {string} path to the sprint's terminal state file: <serviceDataDir>/old_sprints/<sprintId>.json
 */
export function getOldSprintStatePath(sprintId, env = process.env) {
    if (!sprintId) {
        throw new TypeError('getOldSprintStatePath requires a sprintId');
    }
    return path.join(getOldSprintsDir(env), `${sprintId}.json`);
}
