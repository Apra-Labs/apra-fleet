import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-wrc.1 -- when EVERY doer streak in a Develop round permanently
// fails (no sibling streak succeeds), `assignedBeadIds` (built from
// streakOutcomes filtered to outcome !== 'failed') is empty. Prior to this
// fix, the Review phase was STILL dispatched unconditionally with an empty
// bead list -- wasted work, and an empty-scope CHANGES_NEEDED verdict risks
// tripping the reviewer contract-violation guard. The fix skips the
// develop-round Review dispatch entirely whenever assignedBeadIds is empty;
// the failed bead simply stays ready for the next Develop round.
//
// This is distinct from the existing "isolation" test
// (mock-sprint-develop-doer-throws.test.mjs), which has a SUCCEEDING sibling
// streak, so assignedBeadIds is never empty there and Review still runs
// (correctly) for the sibling's bead. This scenario has NO succeeding
// sibling -- every streak in every round fails -- so Review must never be
// dispatched at all during the Develop/Review loop.
// =============================================================================

test('mock sprint: when every doer streak in a round fails, the develop-round Review is never dispatched', async () => {
    await withScenarioMarkers('all streaks failed -- no review dispatch', async () => {
        console.log('Running mock sprint scenario (single always-throwing streak, no succeeding sibling)...');

        const scenario = await runDevelopLoopScenario('allfail', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Always throws (all-fail scenario)' },
            ],
            doerHandler: async ({ opts, tempDir: td }) => {
                const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                throw new Error(`mock doer failure for bead(s) ${ids.join(', ')}`);
            },
            reviewerHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved whatever closed.', reopenIds: [], newTasks: [] }) }]
            }),
        });

        check(!scenario.error, `All-streaks-failed scenario should not abort/throw: ${scenario.error ? scenario.error.message : ''}`);
        check(scenario.result && scenario.result.status === 'failed', `Expected a FAIL verdict (the only bead never closed): ${JSON.stringify(scenario.result)}`);

        // The develop-round Review (as opposed to the unconditional
        // end-of-sprint Final Review, which is a separate dispatch site) must
        // never have been called -- every round's assignedBeadIds was empty.
        const developRoundReviewDispatches = scenario.dispatched.filter((d) => d.agent === 'reviewer' && d.label !== 'Final Review');
        check(
            developRoundReviewDispatches.length === 0,
            `Expected ZERO develop-round Review dispatches (all streaks failed every round), got ${developRoundReviewDispatches.length}: ${JSON.stringify(developRoundReviewDispatches.map((d) => d.label))}`
        );

        // The empty-guard skip log line fired (at least once -- one per
        // develop round the 3-round cap ran through).
        check(
            scenario.logs.some((m) => m.includes('all streaks this round failed with no beadIds assigned -- skipping Review dispatch')),
            `Expected the empty-guard skip log line, got logs: ${JSON.stringify(scenario.logs.filter((m) => m.includes('skipping Review')))}`
        );

        const throwsTaskId = scenario.tasks.find((t) => t.title === 'Task: Always throws (all-fail scenario)').id;
        check(
            scenario.finalBeadsById.get(throwsTaskId) && scenario.finalBeadsById.get(throwsTaskId).status !== 'closed',
            `Expected the always-throwing bead '${throwsTaskId}' to remain open (never closed), got: ${JSON.stringify(scenario.finalBeadsById.get(throwsTaskId))}`
        );
    });
});
