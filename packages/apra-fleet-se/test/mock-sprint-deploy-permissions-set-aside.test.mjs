// =============================================================================
// A deploy that fails at the deploy.md Permissions check (deployer Step 0a, no
// deploy command ran) is set aside for the rest of the run: the deployer
// reports it with the structured `failedStep: 'permissions'` field, the engine
// records sprintState.deploySetAside (reason + first-seen cycle), and no later
// cycle dispatches the deployer again. The verdict gate still sees the deploy
// as failed.
//
// The other half of the rule -- a failure WITHOUT the field keeps the normal
// per-cycle retry -- is pinned by mock-sprint-deploy-failure-verdict.test.mjs
// scenario 1 (the deployer fails every cycle with no failedStep and is
// dispatched in each of the 3 cycles).
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { validateVerdict } from '../fleet-sprint/contracts.mjs';
import {
    latestDeployFailure, formatDeploySetAsideNotes, DEPLOY_PERMISSIONS_FAILED_STEP,
} from '../fleet-sprint/phases/deploy.mjs';

const PERMISSION_NOTES = 'Missing permission grant(s): Bash(docker compose:*).';

const closeAssignedDoer = async ({ opts, tempDir }) => {
    const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    for (const id of ids) await runCmd(`bd close ${id}`, tempDir);
    return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed all assigned beads.' }) }] };
};
const approvingReviewer = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Looks good.', reopenIds: [], newTasks: [] }) }],
});
const rubberStampPass = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'PASS', notes: 'Rubber-stamp PASS from the final reviewer.' }) }],
});

test('unit: deployer output validates with and without failedStep; unknown failedStep values are rejected', () => {
    assert.equal(validateVerdict('deployerReport', { deployed: true, notes: 'ok' }).valid, true, 'output without the new field stays valid');
    assert.equal(validateVerdict('deployerReport', { deployed: false, notes: PERMISSION_NOTES, failedStep: 'permissions' }).valid, true);
    assert.equal(validateVerdict('deployerReport', { deployed: false, notes: 'x', failedStep: 'smoke-test' }).valid, false);
    assert.equal(DEPLOY_PERMISSIONS_FAILED_STEP, 'permissions');
});

test('unit: latestDeployFailure reports the set-aside reason for a cycle with no deployer dispatch', () => {
    const setAside = { reason: 'deployer stopped at the deploy.md Permissions check', notes: PERMISSION_NOTES, cycle: 1 };
    const failures = [{ cycle: 1, notes: PERMISSION_NOTES }];
    // The cycle that failed keeps its own deployer notes.
    assert.deepEqual(latestDeployFailure({ hasDeploy: true, deployedThisCycle: false, cycle: 1, deployFailures: failures, deploySetAside: setAside }),
        { cycle: 1, notes: PERMISSION_NOTES });
    // A later, skipped cycle reports the set-aside.
    assert.deepEqual(latestDeployFailure({ hasDeploy: true, deployedThisCycle: false, cycle: 2, deployFailures: failures, deploySetAside: setAside }),
        { cycle: 2, notes: formatDeploySetAsideNotes(setAside) });
    // Unchanged without a set-aside.
    assert.deepEqual(latestDeployFailure({ hasDeploy: true, deployedThisCycle: false, cycle: 2, deployFailures: failures }),
        { cycle: 2, notes: '(deployer returned no notes)' });
    assert.equal(latestDeployFailure({ hasDeploy: false, deployedThisCycle: false, cycle: 2, deployFailures: failures, deploySetAside: setAside }), null);
});

test('mock sprint: a deploy failing at the Permissions pre-step in C1 is never dispatched again', async () => {
    await withScenarioMarkers('deploypermsetaside', async () => {
        let deployCalls = 0;
        const run = await runDevelopLoopScenario('deploypermsetaside', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: work whose deploy lacks permissions' }],
            maxCycles: 3,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approvingReviewer,
            deployHandler: async () => {
                deployCalls++;
                return { content: [{ text: JSON.stringify({ deployed: false, failedStep: 'permissions', notes: PERMISSION_NOTES }) }] };
            },
            finalReviewHandler: rubberStampPass,
        });
        assert.ok(!run.error, `scenario must not throw: ${run.error && run.error.message}`);
        assert.equal(deployCalls, 1, 'the deployer must be dispatched only in C1');
        assert.equal(run.dispatched.filter((d) => d.agent === 'deployer').length, 1);
        assert.equal(run.dispatched.filter((d) => d.agent === 'integ-test-runner').length, 0);

        // Recorded on sprintState with its reason and first-seen cycle.
        const recorded = run.logs.find((l) => l.startsWith('Deploy SET ASIDE for the rest of this run'));
        assert.ok(recorded, `expected the set-aside log, logs: ${JSON.stringify(run.logs.filter((l) => /Deploy/.test(l)))}`);
        assert.match(recorded, /\(first seen C1\): deployer stopped at the deploy\.md Permissions check before running any deploy command/);
        // Later cycles skip the dispatch and carry the C1 set-aside forward.
        for (const c of [2, 3]) {
            assert.ok(run.logs.some((l) => l.startsWith(`Skipping Deploy Phase C${c}: deploy not dispatched -- set aside for this run since C1`)),
                `C${c} must skip the deployer, logs: ${JSON.stringify(run.logs.filter((l) => /Deploy/.test(l)))}`);
        }

        // The verdict gate still sees a failed deploy and names the set-aside.
        assert.equal(run.result.verdict, 'FAIL', JSON.stringify(run.result));
        assert.match(run.result.notes, /Deploy FAILED in the last cycle \(C3\)/);
        assert.ok(run.result.notes.includes('set aside for this run since C1'), run.result.notes);
    });
});
