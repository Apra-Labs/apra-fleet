// =============================================================================
// A deploy that fails at the deploy.md Permissions check (deployer Step 0a, no
// deploy command ran) is set aside for the rest of the run: the deployer
// reports it with the structured `failedStep: 'permissions'` field, the engine
// records sprintState.deploySetAside (reason + first-seen cycle), and no later
// cycle dispatches the deployer again. Once the work is closed, the sprint's
// epic can only close through Integration Test, which cannot run while the
// deploy is set aside -- so the run stops at once in C1 (set-aside.mjs),
// naming the deploy reason, instead of re-running empty cycles.
//
// POLICY (set-aside carry-over): the task closed this run, so that stop is no
// longer a SPRINT_STALLED abort: the run exits to Finalization (Final Review,
// Harvest, Publish PR) with the deploy and the IntegTest-bound epic carried
// over, and the verdict is forced FAIL. The assertions below were flipped
// deliberately from SPRINT_STALLED.
//
// The other half of the rule -- a failure WITHOUT the field keeps the normal
// per-cycle retry -- is pinned by mock-sprint-deploy-failure-verdict.test.mjs
// scenario 1 (the deployer fails every cycle with no failedStep and is
// dispatched in each of the 3 cycles).
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers, withStagedBodies } from './helpers/mock-sprint-harness.mjs';
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

test('mock sprint: a deploy failing at the Permissions pre-step in C1 is never dispatched again; the run finishes in C1 with a carry-over', async () => {
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
        // POLICY (set-aside carry-over): not SPRINT_STALLED -- the closed
        // task goes through Finalization with a forced FAIL.
        assert.ok(!run.error, `no abort with work closed this run: ${run.error && run.error.message}`);
        assert.equal(run.result.exitReason, 'set-aside-carry-over', JSON.stringify(run.result));
        assert.equal(run.result.verdict, 'FAIL', 'the rubber-stamp PASS must be forced to FAIL');
        assert.ok(run.logs.some((l) => /^Cycle 1: Carried over \(Cycle 1 evaluation\)/.test(l)), 'the carry-over exit must fire in C1');
        assert.ok(run.dispatched.some((d) => d.agent === 'harvester'), 'Harvest must run');
        assert.equal(deployCalls, 1, 'the deployer must be dispatched only in C1');
        assert.equal(run.dispatched.filter((d) => d.agent === 'deployer').length, 1);
        assert.equal(run.dispatched.filter((d) => d.agent === 'integ-test-runner').length, 0);
        assert.ok(!run.logs.some((l) => /\bC2 R\d|Cycle 2\b|Deploy Phase C2/.test(l)), 'no second cycle may start');

        // Recorded on sprintState with its reason and first-seen cycle.
        const recorded = run.logs.find((l) => l.startsWith('Deploy SET ASIDE for the rest of this run'));
        assert.ok(recorded, `expected the set-aside log, logs: ${JSON.stringify(run.logs.filter((l) => /Deploy/.test(l)))}`);
        assert.match(recorded, /\(first seen C1\): deployer stopped at the deploy\.md Permissions check before running any deploy command/);

        // The carry-over names the deploy reason and the IntegTest-bound epic.
        const reasons = Object.fromEntries(run.result.carryOver.map((e) => [e.id, e.reason]));
        assert.ok(reasons.deploy, JSON.stringify(reasons));
        assert.ok(reasons[run.epicBeadId], JSON.stringify(reasons));
        assert.ok(reasons.deploy.includes(PERMISSION_NOTES), reasons.deploy);
        assert.match(reasons.deploy, /first seen C1/);
        assert.ok(run.result.notes.includes(PERMISSION_NOTES), run.result.notes);
        const prCmd = withStagedBodies(run.commandLog).find((cmd) => cmd.includes('Set aside this run'));
        assert.ok(prCmd && prCmd.includes('- deploy: '), 'the published PR body must list the set-aside deploy');
    });
});
