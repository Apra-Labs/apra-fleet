import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SprintPlanRejectedError } from '../auto-sprint/errors.mjs';
import { runRejectedPlanScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// apra-fleet-unw.15, acceptance criteria 1-3: a plan-reviewer that never
// returns an APPROVED schema-valid verdict (here: persistent non-JSON free
// text containing "APPROVED" inside a rejection sentence) must abort the
// sprint with SprintPlanRejectedError after 3 rounds, and must NEVER
// dispatch a doer.
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
            rejected.error instanceof SprintPlanRejectedError,
            `Expected a SprintPlanRejectedError, got: ${rejected.error ? rejected.error.constructor.name + ': ' + rejected.error.message : 'no error'}`
        );
        check(
            !rejected.dispatched.some((d) => d.agent === 'doer'),
            `Expected zero doer dispatches when the plan is never approved, got: ${JSON.stringify(rejected.dispatched.map((d) => d.agent))}`
        );
        const rejectedPlannerCalls = rejected.dispatched.filter((d) => d.agent === 'planner' && !d.prompt.includes('Ready bead ids:'));
        check(rejectedPlannerCalls.length === 3, `Expected exactly 3 plan-phase planner dispatches (3 rejected rounds), got ${rejectedPlannerCalls.length}`);
    });
});
