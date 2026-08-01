/**
 * apra-fleet-eft.2.3 (renamed under eft.37.1): path resolution for the
 * continuous per-run state file, keyed by run id (NOT the HHMMSS key used by
 * the crash-safety snapshot net, which collides across days -- see
 * src/viewer/index.mjs persistState()).
 *
 * This module is domain-neutral core: it knows about "workflow runs", not
 * about the auto-sprint domain. auto-sprint is one workflow that happens to
 * run on top of it.
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
 * apra-fleet-4ul / apra-fleet-cvb.3: sanitize a runId for use as a SINGLE
 * flat filename component. A path separator in `runId` (e.g. a branch-name-
 * shaped runId like 'fix/fleet-sprint-stabilization' -- the pre-k7b.1
 * fallback for a launch with no supervisor-minted sprintId) previously
 * nested straight through an unsanitized `path.join`, so
 * `old_runs/<runId>.json` silently became a NESTED
 * `old_runs/fix/fleet-sprint-stabilization.json` instead of a flat file at
 * the path every reader (watchdog.mjs's hasTerminalState(), this module's
 * own getTerminalRunStatePath() reader branch) actually checks -- causing a
 * cleanly-finished sprint to misclassify as CRASHED (apra-fleet-4ul).
 *
 * This is a defense-in-depth BACKSTOP at the lowest layer that turns a runId
 * into a filename: every current launch/relaunch path already keys off the
 * ledger's own sprintId (apra-fleet-k7b.1, src/supervisor/api.mjs's
 * launch()), never a branch name, but this guarantees NO caller -- current
 * or future, this module or a caller three layers up -- can ever again
 * write a nested old_runs//running file, regardless of what string it
 * passes as runId.
 * @param {string} runId
 * @returns {string} `runId` with every '/' or '\' replaced by '_'.
 */
export function sanitizeRunIdForFilename(runId) {
    return String(runId).replace(/[\\/]+/g, '_');
}

/**
 * @param {string} runId - stable per-run id (e.g. a caller-supplied runId or a
 *   generated UUID), NOT an HHMMSS-style clock key, which collides across two
 *   runs started in the same second on different days.
 * @returns {string} path to the run's live state file: <serviceDataDir>/running/<runId>.json
 *   (runId is sanitized -- apra-fleet-4ul/cvb.3 -- so this is always a FLAT
 *   file directly under running/, never nested).
 */
export function getRunningRunStatePath(runId, env = process.env) {
    if (!runId) {
        throw new TypeError('getRunningRunStatePath requires a runId');
    }
    return path.join(getRunningRunsDir(env), `${sanitizeRunIdForFilename(runId)}.json`);
}

/**
 * Resolve the terminal-state file path for a run.
 *
 * As a READER: returns the existing file, checking old_runs/ first (by the
 * SANITIZED, always-flat key -- every write this module itself performs
 * lands there) and then falling back to the legacy directory (read-only) so
 * history for runs that terminated before this rename still loads.
 *
 * apra-fleet-4ul / apra-fleet-cvb.3: as a FINAL read-only fallback, also
 * checks the raw, UNSANITIZED path built directly from `runId` -- this is
 * what makes a pre-existing, already-on-disk LEGACY terminal record (written
 * before this sanitize existed, under a slash-nested branch-name key) still
 * discoverable, so a sprint that actually finished cleanly under one of
 * those legacy runIds keeps classifying FINISHED, not CRASHED. Only
 * consulted when the raw runId actually differs from its sanitized form (a
 * normal, separator-free runId has no legacy nested variant to check, so
 * this adds no extra fs.existsSync for the common case).
 *
 * As a WRITE target: for a fresh runId neither location exists yet, so this
 * returns the canonical, SANITIZED old_runs/<runId>.json destination -- new
 * terminal writes always land in old_runs/ as a flat file, never nested and
 * never in the legacy directory.
 *
 * @param {string} runId
 * @returns {string} path to the run's terminal state file.
 */
export function getTerminalRunStatePath(runId, env = process.env) {
    if (!runId) {
        throw new TypeError('getTerminalRunStatePath requires a runId');
    }
    const safeRunId = sanitizeRunIdForFilename(runId);
    const oldRunsPath = path.join(getOldRunsDir(env), `${safeRunId}.json`);
    if (fs.existsSync(oldRunsPath)) {
        return oldRunsPath;
    }
    // BOUNDARY-COMPAT: terminal run state written by pre-runId releases lives
    // under the legacy old_sprints/ directory. Resolve it read-only so history
    // for runs that terminated before this rename still loads; this branch
    // never creates or writes that directory -- fresh terminal writes always
    // go to old_runs/ (returned below). Remove one release after the se
    // consumers stop producing legacy files.
    const legacyTerminalPath = path.join(getFleetDataDir(env), 'old_sprints', `${safeRunId}.json`);
    if (fs.existsSync(legacyTerminalPath)) {
        return legacyTerminalPath;
    }
    // apra-fleet-4ul / apra-fleet-cvb.3: legacy, pre-sanitize nested write --
    // see this function's doc comment above.
    if (safeRunId !== runId) {
        const legacyNestedOldRunsPath = path.join(getOldRunsDir(env), `${runId}.json`);
        if (fs.existsSync(legacyNestedOldRunsPath)) {
            return legacyNestedOldRunsPath;
        }
    }
    return oldRunsPath;
}
