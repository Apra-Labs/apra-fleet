// =============================================================================
// Integration Test is never dispatched while the last review reported a red
// build.
//
// Incident: the reviewer reported the test suite red, the round cap ended the
// Develop/Review loop, Integration Test still ran (a hand-picked subset of
// tests that excluded the failing file), PASSED, and closed the verify-set
// bead the red test covers.
//
// Drives the REAL runner (runSprintCycle) through the mock-sprint harness.
// DAG for both scenarios: under the sprint epic, task T and bead B; B has one
// child C that is already closed, so B is verify-routed (childful, every
// child closed) and the integ-test-runner would close it.
//
//   1. Red through the round cap: every review returns CHANGES_NEEDED +
//      buildFailing:true and reopens T. No integ-test-runner dispatch is
//      recorded, the run log says integ was skipped because the last review
//      reported the build/tests failing, the skip is recorded as an
//      integFailures entry (visible in the Final Review evidence), and B stays
//      open. The Final Review LLM rubber-stamps PASS; the sprint verdict is
//      still FAIL, naming the red-build integ skip, and the PR is not [PASS].
//   2. Sticky, then cleared: C1 is red through the cap (T is then closed
//      out-of-band during C1's deploy, so C2 has no ready work and runs no
//      review). C2 carries the red flag and skips integ. C2's re-review
//      reports the build green, so C3 dispatches integ, which closes B. The
//      Final Review PASS stands (control: the verdict gate does not fire).
//
// REVERT CHECK: with the `lastBuildFailing` integ gate in fleet-sprint/
// runner.js removed (the `hasPlaybook && deployedThisCycle && lastBuildFailing`
// branch), scenario 1 dispatches the integ-test-runner in C1 and closes B, so
// this file fails. With only the Final Review verdict gate removed
// (phases/final-review.mjs, the `if (redBuildIntegSkip)` block), scenario 1's
// verdict assertion fails (the rubber-stamp PASS stands).
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const T_TITLE = 'Task: T work the reviewer keeps finding red';
const B_TITLE = 'Task: B implementation-complete parent awaiting verification';
const SKIP_LOG = /^Skipping Integration Test Phase C(\d+): the last review reported the build\/tests failing/;

/** B gets one already-closed child, so B is verify-routed. */
const buildShape = (ids) => async ({ tempDir, tasks }) => {
    ids.t = tasks[0].id;
    ids.b = tasks[1].id;
    const created = await runCmd('bd create "Task: C child of B" -d "Already implemented." --silent', tempDir);
    ids.c = String(created.stdout || '').trim();
    assert.ok(ids.c, `child create must return an id: ${JSON.stringify(created)}`);
    await runCmd(`bd update ${ids.c} --parent ${ids.b}`, tempDir);
    await runCmd(`bd close ${ids.c}`, tempDir);
};

const closeAssignedDoer = async ({ opts, tempDir }) => {
    const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    const assigned = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    for (const id of assigned) await runCmd(`bd close ${id}`, tempDir);
    return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: assigned, notes: 'Closed all assigned beads.' }) }] };
};

const redReview = (reopenId) => ({
    content: [{
        text: JSON.stringify({
            verdict: 'CHANGES_NEEDED',
            notes: 'npm test fails: 2 failing tests in the suite the sprint touched.',
            reopenIds: [reopenId],
            buildFailing: true,
            newTasks: [],
        }),
    }],
});

const rubberStampPass = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'PASS', notes: 'Rubber-stamp PASS from the final reviewer.' }) }],
});

const findPrCreate = (commandLog) => commandLog.find((c) => c.startsWith('curl -sS -X POST') && c.includes('/pulls'));

const greenReview = () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Build and tests green.', reopenIds: [], newTasks: [] }) }],
});

test('mock sprint: a review reporting a red build through the round cap -> integ not dispatched, skip logged and recorded, verify-set bead stays open, verdict FAIL', async () => {
    await withScenarioMarkers('redbuildintegskip', async () => {
        const ids = {};
        let finalPrompt = null;
        const run = await runDevelopLoopScenario('redbuildintegskip', {
            members: ['local'],
            taskSpecs: [{ title: T_TITLE }, { title: B_TITLE }],
            maxCycles: 1,
            withRunbooks: true,
            beforeSprint: buildShape(ids),
            doerHandler: closeAssignedDoer,
            reviewerHandler: async () => redReview(ids.t),
            finalReviewHandler: async ({ opts }) => {
                finalPrompt = opts.prompt;
                // Deliberately PASS whatever the evidence says: the verdict
                // must not depend on the LLM reading the skip in its prompt.
                return rubberStampPass();
            },
        });
        assert.ok(!run.error, `scenario must not throw: ${run.error && run.error.message}`);

        const reviews = run.dispatched.filter((d) => d.agent === 'reviewer' && d.label !== 'Final Review');
        assert.equal(reviews.length, 3, `the red reviews must run through the 3-round cap, got ${reviews.length}`);
        assert.equal(run.dispatched.filter((d) => d.agent === 'integ-test-runner').length, 0,
            'no integ-test-runner may be dispatched while the last review reported a red build');

        const skips = run.logs.filter((l) => SKIP_LOG.test(l));
        assert.equal(skips.length, 1, `expected exactly one red-build integ skip line, logs: ${JSON.stringify(run.logs.filter((l) => /Integration Test/.test(l)))}`);
        assert.equal(SKIP_LOG.exec(skips[0])[1], '1', `the skip must name C1: ${skips[0]}`);

        // Recorded in integFailures: Final Review's evidence carries it.
        assert.ok(finalPrompt, 'Final Review must be dispatched');
        assert.match(finalPrompt, /Integration tests FAILED in 1 cycle\(s\): C1 \(bugsFiled: none\): Skipping Integration Test Phase C1: the last review reported the build\/tests failing/);

        assert.equal(run.finalBeadsById.get(ids.b).status, 'open', 'the verify-set bead must stay open: integ never ran against the red branch');

        // Never PASS, and the reason names the red-build integ skip.
        assert.equal(run.result.verdict, 'FAIL', `verdict must not be PASS after a red-build integ skip: ${JSON.stringify(run.result)}`);
        assert.equal(run.result.status, 'failed');
        assert.match(run.result.notes, /Integration Test was skipped in C1 because the last review reported the build\/tests failing/);
        assert.ok(run.logs.some((l) => /sprint verdict forced to FAIL \(Final Review returned PASS\)/.test(l) && /skipped in C1/.test(l)),
            `expected the Final Review override log, logs: ${JSON.stringify(run.logs.filter((l) => /Final Review/.test(l)))}`);
        const pr = findPrCreate(run.commandLog);
        assert.ok(pr, 'a FAIL sprint still publishes its PR');
        const title = (pr.match(/"title":"([^"]*)"/) || [])[1] || '';
        assert.ok(!title.includes('[PASS]'), `PR title must not be [PASS]: ${title}`);
    });
});

test('mock sprint: the red-build flag carries through a cycle with no review and clears on a later green review, after which integ dispatches', async () => {
    await withScenarioMarkers('redbuildintegclear', async () => {
        const ids = {};
        let reviewCalls = 0;
        let deployCalls = 0;
        const run = await runDevelopLoopScenario('redbuildintegclear', {
            members: ['local'],
            taskSpecs: [{ title: T_TITLE }, { title: B_TITLE }],
            maxCycles: 3,
            withRunbooks: true,
            beforeSprint: buildShape(ids),
            doerHandler: closeAssignedDoer,
            // C1 rounds 1-3: red. Every later review (the C2/C3 re-reviews of
            // the current state) reports the build green.
            reviewerHandler: async () => {
                reviewCalls++;
                return reviewCalls <= 3 ? redReview(ids.t) : greenReview();
            },
            // C1's deploy lands with T closed out-of-band (the fix was made
            // elsewhere), so C2 has no ready work and runs no Develop/Review.
            deployHandler: async ({ tempDir }) => {
                deployCalls++;
                if (deployCalls === 1) await runCmd(`bd close ${ids.t}`, tempDir);
                return { content: [{ text: JSON.stringify({ deployed: true, notes: 'Deployed.' }) }] };
            },
            finalReviewHandler: rubberStampPass,
        });
        assert.ok(!run.error, `scenario must not throw: ${run.error && run.error.message}`);

        const skippedCycles = run.logs.filter((l) => SKIP_LOG.test(l)).map((l) => SKIP_LOG.exec(l)[1]);
        assert.deepEqual(skippedCycles, ['1', '2'],
            `integ must be skipped in C1 (red review) and C2 (no review: flag carried), logs: ${JSON.stringify(run.logs.filter((l) => /Integration Test|Re-Review|Cycle \d/.test(l)))}`);
        assert.ok(run.logs.some((l) => /^Cycle 2: 0 open goal-priority bead\(s\) but no review ran THIS cycle/.test(l)),
            'C2 must run no Develop/Review (its only review is the cycle-end re-review)');

        const integ = run.dispatched.filter((d) => d.agent === 'integ-test-runner');
        assert.equal(integ.length, 1, `integ must dispatch once, in C3 after the green re-review, got ${integ.length}`);
        assert.ok(integ[0].prompt.includes(ids.b), 'the C3 integ dispatch must name B for verification-closure');
        assert.equal(run.finalBeadsById.get(ids.b).status, 'closed', 'integ closes B once the build is reported green');

        // Cleared by the green review and the C3 integ run: the PASS stands.
        assert.equal(run.result.verdict, 'PASS', `the cleared skip must not force FAIL: ${JSON.stringify(run.result)}`);
        assert.ok(!run.logs.some((l) => /forced to FAIL/.test(l)), 'no verdict gate may fire once the skip is cleared');
    });
});
