import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createWatchdog, WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';

/**
 * apra-fleet-cvb.4: test that a terminal record written under a slash-containing
 * (branch-name-shaped) runId is still located by hasTerminalState() and the
 * watchdog classifies the sprint as FINISHED, not CRASHED.
 *
 * Background: apra-fleet-4ul -- the watchdog misclassified a cleanly-finished
 * sprint as CRASHED when the terminal state was keyed by a branch name (containing
 * '/'), because the path containing the slash created nested directories and
 * hasTerminalState() could not find the flat-file record.
 *
 * The fix (apra-fleet-cvb.3): terminal-state writes are keyed by sprintId
 * (never branch name), and getTerminalRunStatePath() sanitizes path separators,
 * so old_runs/ is always flat.
 */

async function tmpDataDir(prefix) {
    return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** A REAL dead OS pid: spawn a trivial child and let it exit+get reaped. */
function realDeadPid() {
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.ok(Number.isInteger(child.pid) && child.pid > 0, 'expected spawnSync to report a pid');
    return child.pid;
}

describe('apra-fleet-cvb.4: branch-name-shaped runId (with '/') cannot cause CRASHED misclassification', () => {
    test('a terminal state keyed by sprintId is located even when sprintId contains a slash (e.g., branch-name-shaped runId)', async () => {
        const dataDir = await tmpDataDir('4ul-slash-runid-');
        try {
            const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };

            // Simulate a sprint ID that looks like a branch name (contains slashes).
            // This used to cause problems: if the terminal state was keyed by this
            // slash-containing ID, the path would nest (e.g., old_runs/feat/my-feature/)
            // instead of remaining flat, and hasTerminalState() would fail to find it.
            const sprintId = 'feat/my-feature-12345';  // Slash-containing ID
            const deadPid = realDeadPid();

            const { getTerminalRunStatePath } = await import('@apralabs/apra-fleet-workflow/viewer/run-state-paths');

            // Write terminal state keyed by sprintId (the new, correct way per cvb.3).
            // getTerminalRunStatePath() sanitizes the slash, producing a flat filename.
            const statePath = getTerminalRunStatePath(sprintId, env);
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            fs.writeFileSync(statePath, JSON.stringify({
                sprintId,
                status: 'closed',
                terminalReason: 'SPRINT_SUCCEEDED',
                extensions: {
                    terminal: {
                        verdict: 'approved',
                    },
                },
            }));

            // Verify the file was created in a flat structure (no slash in the filename itself).
            // The path may be sanitized (e.g., slashes replaced with underscores or hyphens),
            // but it must be in a single directory level under old_runs/.
            const oldRunsDir = path.join(dataDir, 'old_runs');
            const filesInOldRuns = fs.readdirSync(oldRunsDir);
            assert.ok(
                filesInOldRuns.some(f => !f.includes('/') && f.endsWith('.json')),
                `expected a flat JSON file in old_runs/, got: ${JSON.stringify(filesInOldRuns)}`
            );

            // Create the watchdog with a minimal fake ledger
            const ledger = {
                list: () => [{ sprintId, childPid: deadPid, branch: null }],
                get: (id) => id === sprintId ? { members: ['tester'], issueRoots: ['apra-fleet-x'] } : undefined,
                release: async () => true,  // Ignore release for this test
            };

            const watchdog = createWatchdog({ ledger, env, logger: { error() {}, log() {} } });

            // Classify the dead sprint
            const results = await watchdog.classifyAll();
            assert.equal(results.length, 1);
            const [classification] = results;

            // CRITICAL: the sprint must classify as FINISHED, NOT CRASHED,
            // even though its ID contains a slash.
            assert.equal(
                classification.status,
                WATCHDOG_STATUS.FINISHED,
                `sprint with slash-containing ID must classify FINISHED, not ${classification.status}`
            );
            assert.equal(
                classification.pidAlive,
                false,
                'pid should be gone'
            );
        } finally {
            await fsp.rm(dataDir, { recursive: true, force: true });
        }
    });

    test('hasTerminalState() finds terminal record when invoked with a slash-containing sprintId', async () => {
        const dataDir = await tmpDataDir('4ul-hasTerminal-');
        try {
            const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
            const sprintId = 'fix/some-issue-98765';

            const { getTerminalRunStatePath } = await import('@apralabs/apra-fleet-workflow/viewer/run-state-paths');

            // Write a terminal state
            const statePath = getTerminalRunStatePath(sprintId, env);
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            fs.writeFileSync(statePath, JSON.stringify({
                sprintId,
                terminalReason: 'DONE',
            }));

            // Import hasTerminalState from watchdog
            const { defaultHasTerminalState } = await import('../src/supervisor/watchdog.mjs');

            // Verify hasTerminalState() can find it
            const found = defaultHasTerminalState(sprintId, null, env);
            assert.ok(
                found,
                `hasTerminalState() must locate terminal record for sprintId '${sprintId}'`
            );
            assert.ok(
                found.terminalReason === 'DONE',
                `located state must preserve terminalReason field`
            );
        } finally {
            await fsp.rm(dataDir, { recursive: true, force: true });
        }
    });

    test('watchdog correctly distinguishes FINISHED from CRASHED for slash-containing IDs across multiple sprints', async () => {
        const dataDir = await tmpDataDir('4ul-multi-');
        try {
            const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
            const finishedSprintId = 'feature/finished-one';
            const crashedSprintId = 'chore/crashed-one';
            const deadPid1 = realDeadPid();
            const deadPid2 = realDeadPid();

            const { getTerminalRunStatePath } = await import('@apralabs/apra-fleet-workflow/viewer/run-state-paths');

            // Create terminal state ONLY for the finished sprint
            const finishedStatePath = getTerminalRunStatePath(finishedSprintId, env);
            fs.mkdirSync(path.dirname(finishedStatePath), { recursive: true });
            fs.writeFileSync(finishedStatePath, JSON.stringify({
                sprintId: finishedSprintId,
                terminalReason: 'SPRINT_SUCCEEDED',
            }));

            // No terminal state for the crashed sprint

            const ledger = {
                list: () => [
                    { sprintId: finishedSprintId, childPid: deadPid1, branch: null },
                    { sprintId: crashedSprintId, childPid: deadPid2, branch: null },
                ],
                get: (id) => {
                    if (id === finishedSprintId) return { members: ['alice'], issueRoots: ['apra-fleet-x'] };
                    if (id === crashedSprintId) return { members: ['bob'], issueRoots: ['apra-fleet-y'] };
                    return undefined;
                },
                release: async () => true,
            };

            const watchdog = createWatchdog({ ledger, env, logger: { error() {}, log() {} } });
            const results = await watchdog.classifyAll();

            assert.equal(results.length, 2);
            const byId = Object.fromEntries(results.map((r) => [r.sprintId, r]));

            // Finished sprint with slash-containing ID must classify as FINISHED
            assert.equal(
                byId[finishedSprintId].status,
                WATCHDOG_STATUS.FINISHED,
                `finished sprint '${finishedSprintId}' must classify FINISHED`
            );

            // Crashed sprint with slash-containing ID and no terminal state must classify as CRASHED
            assert.equal(
                byId[crashedSprintId].status,
                WATCHDOG_STATUS.CRASHED,
                `crashed sprint '${crashedSprintId}' must classify CRASHED`
            );
        } finally {
            await fsp.rm(dataDir, { recursive: true, force: true });
        }
    });
});
