import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanReviewDispatchFailedError } from '../fleet-sprint/errors.mjs';
import { runRejectedPlanScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// apra-fleet-unw.15, acceptance criteria 1-3 (ORIGINAL): a plan-reviewer that
// never returns an APPROVED schema-valid verdict (here: persistent non-JSON
// free text containing "APPROVED" inside a rejection sentence) must abort the
// sprint after 3 rounds, and must NEVER dispatch a doer.
//
// apra-fleet-9ta.4 (already landed on main before this scenario's error-class
// assertion was last touched) refined WHICH abort class that is: persistent
// non-JSON output never produces a schema-valid verdict, so it exhausts
// agent()'s bounded schema-repair loop every round -- that is a plan-reviewer
// dispatch channel that never came back with a usable verdict
// (PlanReviewDispatchFailedError), not a case where the reviewer genuinely,
// legibly rejected the plan (SprintPlanRejectedError). This test's assertion
// was never updated for that distinction and kept passing only by accident:
// the pre-apra-fleet-dnri lean repair re-ask didn't reattach "scope"/the epic
// id, so this scenario's own promptHasScope sniff (mock-sprint-harness.mjs)
// missed on repair attempts and silently substituted a schema-valid "missing
// scope" CHANGES_NEEDED verdict instead of re-invoking the always-non-JSON
// mock -- masking the exhaustion 'always-reject-free-text' is documented to
// exercise. Commit 71960822 (apra-fleet-dnri, buildRepairPrompt reattaches
// the original prompt/schema) removed that accidental masking, surfacing the
// stale assertion (apra-fleet-ot2z.19 triage).
//
// Note (fih.2): the former dedicated 'reviewerpromptfence' and
// 'prverdictpass' scenarios that used to live in this group were folded
// into run1 (see mock-sprint-happy-path.test.mjs) -- they are not recreated
// here.
test('mock sprint: plan-reviewer that never approves aborts after 3 rounds with zero doer dispatches', async () => {
    await withScenarioMarkers('rejected plan (3x CHANGES_NEEDED)', async () => {
        console.log('Running mock sprint scenario (rejected plan, 3x CHANGES_NEEDED)...');
        const rejected = await runRejectedPlanScenario('rejected');
        check(!!rejected.error, 'Expected engine.executeFile() to reject when the plan is never approved, but it resolved successfully');
        check(
            rejected.error instanceof PlanReviewDispatchFailedError,
            `Expected a PlanReviewDispatchFailedError, got: ${rejected.error ? rejected.error.constructor.name + ': ' + rejected.error.message : 'no error'}`
        );
        check(
            !rejected.dispatched.some((d) => d.agent === 'doer'),
            `Expected zero doer dispatches when the plan is never approved, got: ${JSON.stringify(rejected.dispatched.map((d) => d.agent))}`
        );
        const rejectedPlannerCalls = rejected.dispatched.filter((d) => d.agent === 'planner' && !d.prompt.includes('Ready bead ids:'));
        check(rejectedPlannerCalls.length === 3, `Expected exactly 3 plan-phase planner dispatches (3 rejected rounds), got ${rejectedPlannerCalls.length}`);
    });
});
