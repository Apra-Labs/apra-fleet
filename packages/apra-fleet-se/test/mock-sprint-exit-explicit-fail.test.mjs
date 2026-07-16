import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-unw.17 (A6) acceptance criterion 4: a final verdict of FAIL
// propagates to the workflow's returned status, and no unconditional
// {status:'success'} exists in runner.js's source
// =============================================================================
// apra-fleet-fih.2: also folds in the former dedicated 'prverdictfail'
// scenario (apra-fleet-unw2.9 (N11) acceptance criterion 2, FAIL side) --
// identical 1-task/maxCycles-1/FAIL shape, disjoint assertions on result
// fields (this scenario) vs the `gh pr create` title/body (below).
test('mock sprint: an explicit final FAIL verdict propagates to status:failed and still publishes the PR', async () => {
    await withScenarioMarkers('explicitfail (+prverdictfail)', async () => {
        console.log('Running mock sprint scenario (explicit final verdict FAIL propagates; PR still published with FAIL verdict)...');
        const explicitFail = await runDevelopLoopScenario('explicitfail', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Fully closed but explicitly failed by final review' }],
            maxCycles: 1,
            finalReviewHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'FAIL', notes: 'Explicit test-injected FAIL despite all beads closing.' }) }]
            }),
        });
        check(!explicitFail.error, `Explicit-FAIL scenario should not throw: ${explicitFail.error ? explicitFail.error.message : ''}`);
        check(
            explicitFail.result && explicitFail.result.status === 'failed',
            `Expected a FAIL final verdict to produce status:'failed', got: ${JSON.stringify(explicitFail.result)}`
        );
        check(
            explicitFail.result && explicitFail.result.verdict === 'FAIL' && explicitFail.result.notes === 'Explicit test-injected FAIL despite all beads closing.',
            `Expected the final verdict/notes to be surfaced on the result, got: ${JSON.stringify(explicitFail.result)}`
        );
        // apra-fleet-unw2.9 (N11) acceptance criterion 2 (FAIL side): per
        // plan.md's already-decided rule, a FAIL verdict still publishes the PR --
        // the verdict is stated plainly in the title/body, not suppressed.
        const explicitFailPrCmd = explicitFail.commandLog.find((c) => c.startsWith('gh pr create'));
        check(
            !!explicitFailPrCmd,
            `A FAIL verdict must still publish the PR (plan.md's already-made decision) -- expected a 'gh pr create' command, commandLog: ${JSON.stringify(explicitFail.commandLog)}`
        );
        check(
            !!explicitFailPrCmd && /--title "[^"]*FAIL[^"]*"/.test(explicitFailPrCmd) && /--body "[^"]*FAIL[^"]*"/.test(explicitFailPrCmd),
            `Expected the PR title AND body to include the FAIL verdict, got: ${explicitFailPrCmd}`
        );
    });
});
