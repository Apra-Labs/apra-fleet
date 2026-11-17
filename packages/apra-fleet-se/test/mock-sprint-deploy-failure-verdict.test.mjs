// =============================================================================
// apra-fleet-b4g.102.2: a sprint whose deploy failed cannot publish a PASS.
//
// Drives the REAL runner (runSprintCycle -> Final Review -> Publish PR)
// through the mock-sprint harness:
//
//   1. deploy.md present, the deployer fails EVERY cycle, the reviewer
//      APPROVES, 0 open beads, and the Final Review LLM rubber-stamps PASS.
//      The orchestrator must still end the sprint FAIL: status 'failed', the
//      PR title is not [PASS], and the PR body + verdict notes name the deploy
//      failure (cycle and deployer notes).
//   2. deploy.md present, the deploy fails in C1 and succeeds in C2, integ
//      passes: the re-attempt path works and the sprint ends PASS.
//   3. no deploy.md: unchanged -- Deploy and Integ are skipped with the
//      existing log lines and the sprint can PASS.
//
// Scenario 1's final reviewer deliberately returns PASS whatever the evidence
// says: the gate must not depend on the LLM reading "Deploy phase FAILED" in
// its prompt (the harness's default evidence-based mock would FAIL on its own
// and mask a missing gate).
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const DEPLOY_NOTES = 'smoke test could not reach the sandbox instance on port 4100';

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

const findPrCreate = (commandLog) => commandLog.find((c) => c.startsWith('curl -sS -X POST') && c.includes('/pulls'));

test('mock sprint: a deploy that fails every cycle can never publish a PASS sprint, and the PR names the failure', async () => {
    await withScenarioMarkers('deployfailverdict', async () => {
        let deployCalls = 0;
        const run = await runDevelopLoopScenario('deployfailverdict', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: work that is done but never deployed' }],
            maxCycles: 3,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approvingReviewer,
            deployHandler: async () => {
                deployCalls++;
                return { content: [{ text: JSON.stringify({ deployed: false, notes: DEPLOY_NOTES }) }] };
            },
            finalReviewHandler: rubberStampPass,
        });
        assert.ok(!run.error, `scenario must not throw: ${run.error && run.error.message}`);
        assert.equal(run.result.verdict, 'FAIL', `verdict must not be PASS after a failed last-cycle deploy: ${JSON.stringify(run.result)}`);
        assert.equal(run.result.status, 'failed');
        assert.match(run.result.notes, /Deploy FAILED in the last cycle \(C3\)/);
        assert.ok(run.result.notes.includes(DEPLOY_NOTES), `verdict notes must carry the deployer notes: ${run.result.notes}`);

        // Re-attempted every cycle the budget allowed, never integ-tested.
        assert.equal(deployCalls, 3, 'deploy must be re-attempted in each cycle up to maxCycles');
        assert.equal(run.dispatched.filter((d) => d.agent === 'integ-test-runner').length, 0);
        assert.ok(run.logs.some((l) => /NOT exiting as satisfied/.test(l) && l.includes('C1')), `expected the deploy-blocked exit refusal, logs: ${JSON.stringify(run.logs)}`);
        // From C2 the epic is verify-routed and stays unverified (integ never
        // runs), so the loop ends on maxCycles; the Final Review gate is what
        // turns the rubber-stamp PASS into FAIL.
        assert.ok(run.logs.some((l) => /sprint verdict forced to FAIL \(Final Review returned PASS\)/.test(l) && l.includes('(C3)')),
            `expected the Final Review override log, logs: ${JSON.stringify(run.logs)}`);
        assert.ok(!run.logs.some((l) => /satisfied: 0 open bead\(s\) in scope and last reviewer verdict was APPROVED\. Exiting cycle loop\./.test(l)),
            'the goal-priority "satisfied" exit must never fire while the latest deploy failed');

        const pr = findPrCreate(run.commandLog);
        assert.ok(pr, `a FAIL sprint still publishes its PR, commandLog: ${JSON.stringify(run.commandLog)}`);
        const title = (pr.match(/"title":"([^"]*)"/) || [])[1] || '';
        assert.ok(!title.includes('[PASS]') && /FAIL/.test(title), `PR title must not be [PASS]: ${title}`);
        assert.match(pr, /## Sprint verdict: FAIL/);
        assert.match(pr, /Deploy FAILED in the last cycle \(C3\)/);
        assert.ok(pr.includes(DEPLOY_NOTES), 'PR body must carry the deployer notes');
    });
});

test('mock sprint: the root/target-already-closed exit obeys the same rule -- a failed deploy re-attempts, then ends FAIL', async () => {
    await withScenarioMarkers('deployfailrootclosed', async () => {
        let deployCalls = 0;
        const run = await runDevelopLoopScenario('deployfailrootclosed', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: work whose root closes out-of-band' }],
            maxCycles: 2,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approvingReviewer,
            // The deploy fails, but closes the sprint root as a side effect --
            // the condition the root-closed exit fires on.
            deployHandler: async ({ tempDir, epicBead }) => {
                deployCalls++;
                await runCmd(`bd close ${epicBead.id}`, tempDir);
                return { content: [{ text: JSON.stringify({ deployed: false, notes: DEPLOY_NOTES }) }] };
            },
            finalReviewHandler: rubberStampPass,
        });
        assert.ok(!run.error, `scenario must not throw: ${run.error && run.error.message}`);
        assert.equal(run.result.verdict, 'FAIL', JSON.stringify(run.result));
        assert.equal(deployCalls, 2);
        assert.ok(run.logs.some((l) => /every configured sprint root\/target bead is closed, but NOT exiting as satisfied/.test(l) && l.includes('(C1)')),
            `expected the root-closed exit to be refused in C1, logs: ${JSON.stringify(run.logs)}`);
        assert.ok(run.logs.some((l) => /deploy re-attempt budget is exhausted/.test(l) && l.includes('(C2)')));
        assert.ok(!run.logs.some((l) => /every configured sprint root\/target bead is already closed/.test(l)),
            'the unconditional root-closed exit must not fire while the latest deploy failed');
        const pr = findPrCreate(run.commandLog);
        const title = pr ? ((pr.match(/"title":"([^"]*)"/) || [])[1] || '') : '';
        assert.ok(pr && !title.includes('[PASS]'), `PR title must not be [PASS]: ${title}`);
        assert.match(pr, /Deploy FAILED in the last cycle \(C2\)/);
    });
});

test('mock sprint: a deploy that fails in C1 and succeeds in C2 can still end PASS after integ runs', async () => {
    await withScenarioMarkers('deployretrypass', async () => {
        let deployCalls = 0;
        const run = await runDevelopLoopScenario('deployretrypass', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: work deployed on the second attempt' }],
            maxCycles: 3,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approvingReviewer,
            deployHandler: async () => {
                deployCalls++;
                return deployCalls === 1
                    ? { content: [{ text: JSON.stringify({ deployed: false, notes: DEPLOY_NOTES }) }] }
                    : { content: [{ text: JSON.stringify({ deployed: true, notes: 'Deployed on retry.' }) }] };
            },
            // The final reviewer weighs the C1 failure the C2 deploy recovered
            // from and passes; the orchestrator must not override that.
            finalReviewHandler: rubberStampPass,
        });
        assert.ok(!run.error, `scenario must not throw: ${run.error && run.error.message}`);
        assert.equal(run.result.verdict, 'PASS', `expected PASS after a successful re-attempted deploy: ${JSON.stringify(run.result)}`);
        assert.equal(run.result.status, 'success');
        assert.equal(deployCalls, 2);
        assert.ok(run.dispatched.filter((d) => d.agent === 'integ-test-runner').length >= 1, 'integ must run after the successful deploy');
        assert.ok(run.logs.some((l) => /Re-attempting deploy next cycle/.test(l)));
        assert.ok(!run.logs.some((l) => /Deploy FAILED in the last cycle/.test(l) && /forced to FAIL/.test(l)));
        const pr = findPrCreate(run.commandLog);
        assert.ok(pr && /"title":"[^"]*PASS[^"]*"/.test(pr), `PR title should carry PASS: ${pr}`);
    });
});

test('mock sprint: with no deploy.md the sprint is unchanged -- deploy and integ skipped, PASS possible', async () => {
    await withScenarioMarkers('nodeployunchanged', async () => {
        const run = await runDevelopLoopScenario('nodeployunchanged', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: work in a repo with no deploy.md' }],
            maxCycles: 2,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approvingReviewer,
        });
        assert.ok(!run.error, `scenario must not throw: ${run.error && run.error.message}`);
        assert.equal(run.result.verdict, 'PASS', JSON.stringify(run.result));
        assert.equal(run.result.status, 'success');
        assert.equal(run.dispatched.filter((d) => d.agent === 'deployer').length, 0);
        assert.ok(run.logs.some((l) => l.includes('Skipping Deploy Phase (no deploy.md found')));
        assert.ok(run.logs.some((l) => l.includes('Skipping Integration Test Phase (no playbook found')));
        assert.ok(run.logs.some((l) => /satisfied: 0 open bead\(s\) in scope and last reviewer verdict was APPROVED\. Exiting cycle loop\./.test(l)));
        assert.ok(!run.logs.some((l) => /NOT exiting as satisfied|forced to FAIL/.test(l)));
    });
});
