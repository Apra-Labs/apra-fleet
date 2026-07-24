/**
 * BOUNDARY-COMPAT (apra-fleet-eft.37.1 / M1a): thin re-export shim for the
 * pre-runId subpath '@apralabs/apra-fleet-workflow/viewer/sprint-state-paths'.
 *
 * The domain-neutral implementation now lives in run-state-paths.mjs and speaks
 * "runs" (getRunningRunStatePath/getTerminalRunStatePath) instead of "sprints".
 * This module keeps the old subpath and the old sprint-named exports resolvable
 * so the apra-fleet-se supervisor consumers (watchdog/proxy/history-view) keep
 * working until M1b (eft.37.2) migrates them to the run-state-paths API. Delete
 * this shim once eft.37.2 lands and no consumer imports the sprint-* names.
 */
import {
    getRunningRunsDir,
    getOldRunsDir,
    getRunningRunStatePath,
    getTerminalRunStatePath,
} from './run-state-paths.mjs';

/** @deprecated use getRunningRunsDir from run-state-paths.mjs */
export const getRunningSprintsDir = getRunningRunsDir;

/** @deprecated use getOldRunsDir from run-state-paths.mjs */
export const getOldSprintsDir = getOldRunsDir;

/** @deprecated use getRunningRunStatePath from run-state-paths.mjs */
export const getRunningSprintStatePath = getRunningRunStatePath;

/** @deprecated use getTerminalRunStatePath from run-state-paths.mjs */
export const getOldSprintStatePath = getTerminalRunStatePath;
