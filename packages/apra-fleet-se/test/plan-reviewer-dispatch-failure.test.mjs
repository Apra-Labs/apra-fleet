import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanReviewDispatchFailedError, SprintPlanRejectedError } from '../fleet-sprint/errors.mjs';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-9ta.4 -- the plan-reviewer's synthesized dispatch-failure
// fallbacks (schema-repair exhaustion / transport failure) used to look
// IDENTICAL to a genuine CHANGES_NEEDED verdict: no `dispatchFailed` marker,
// no retry. Three rounds of pure transport failures produced three
// CHANGES_NEEDED verdicts with empty taskAssignments, so the plan-cap
// exhaustion check's wholePlanContested===true fired
// SprintPlanRejectedError -- a misdiagnosis, since the plan-reviewer never
// actually looked at the plan. runner.js now marks those fallbacks
// dispatchFailed:true, retries once within the SAME round before recording a
// round as a dispatch failure, and throws the distinct
// PlanReviewDispatchFailedError when the LAST round's verdict was itself a
// dispatch failure.
// =============================================================================

test('mock sprint: plan-reviewer transport failures on every round produce PlanReviewDispatchFailedError, not SprintPlanRejectedError', async () => {
    await withScenarioMarkers('plan-reviewer all-rounds transport failure', async () => {
        console.log('Running mock sprint scenario (plan-reviewer transport failure every round)...');
        let planReviewerCalls = 0;
        const sc = await runDevelopLoopScenario('prdispatchfail', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: plan-reviewer all-rounds dispatch-failure scenario work' }],
            maxCycles: 1,
            planReviewerHandler: async () => {
                planReviewerCalls++;
                return {
                    content: [{ text: 'transport reset mid-dispatch' }],
                    structuredContent: { isError: true, reason: 'dispatch_failed' },
                };
            },
        });

        check(!!sc.error, 'Expected engine.executeFile() to reject when the plan-reviewer dispatch never comes back with a real verdict');
        check(
            sc.error instanceof PlanReviewDispatchFailedError,
            `Expected a PlanReviewDispatchFailedError, got: ${sc.error ? sc.error.constructor.name + ': ' + sc.error.message : 'no error'}`
        );
        check(
            !(sc.error instanceof SprintPlanRejectedError),
            'Expected the infra-flavored error, NOT the genuine-rejection error (SprintPlanRejectedError) -- the plan was never actually reviewed'
        );
        check(
            !sc.dispatched.some((d) => d.agent === 'doer'),
            `Expected zero doer dispatches -- the sprint must never reach Develop off a dispatch-failed plan, got: ${JSON.stringify(sc.dispatched.map((d) => d.agent))}`
        );
        // 3 planning rounds (the outer cap), each retried once in-round per the
        // dispatchReview()-mirrored ladder before the round is recorded as a
        // dispatch failure -- 6 plan-reviewer dispatches total, never a 7th.
        check(planReviewerCalls === 6, `Expected exactly 6 plan-reviewer dispatches (3 rounds x 2 attempts each), got ${planReviewerCalls}`);
        check(
            sc.logs.some((m) => m.includes('Plan Reviewer: dispatch-level failure on attempt 1 of 2')),
            `Expected the in-round retry log line, logs: ${JSON.stringify(sc.logs)}`
        );
    });
});

test('mock sprint: a genuine plan-reviewer CHANGES_NEEDED verdict (not a dispatch failure) still routes to SprintPlanRejectedError after 3 rounds', async () => {
    await withScenarioMarkers('plan-reviewer genuine rejection (not dispatch failure)', async () => {
        console.log('Running mock sprint scenario (plan-reviewer genuinely never approves)...');
        let planReviewerCalls = 0;
        const sc = await runDevelopLoopScenario('prgenuinereject', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: plan-reviewer genuine-rejection scenario work' }],
            maxCycles: 1,
            planReviewerHandler: async () => {
                planReviewerCalls++;
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'CHANGES_NEEDED',
                            notes: 'The DAG genuinely needs more decomposition.',
                            taskAssignments: [],
                        }),
                    }],
                };
            },
        });

        check(!!sc.error, 'Expected engine.executeFile() to reject when the plan is genuinely never approved');
        check(
            sc.error instanceof SprintPlanRejectedError,
            `Expected the genuine-rejection error (SprintPlanRejectedError), got: ${sc.error ? sc.error.constructor.name + ': ' + sc.error.message : 'no error'}`
        );
        check(
            !(sc.error instanceof PlanReviewDispatchFailedError),
            'A genuine reviewer verdict must never be misclassified as a dispatch failure'
        );
        // No in-round retry fires here -- every dispatch succeeds with a real
        // (non-dispatchFailed) verdict, one per round.
        check(planReviewerCalls === 3, `Expected exactly 3 plan-reviewer dispatches (one genuine verdict per round, no retries), got ${planReviewerCalls}`);
    });
});
