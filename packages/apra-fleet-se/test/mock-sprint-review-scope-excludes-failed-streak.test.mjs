import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-wrc.2 -- end-to-end (mock-sprint) verification of the
// apra-fleet-wrc.1 fix: within a single Develop round whose streakOutcomes
// contains ONE permanently-failed streak and ONE succeeded streak,
// `assignedBeadIds` (streakOutcomes filtered to outcome !== 'failed') must
// carry ONLY the succeeded streak's bead id(s) into the Review dispatch --
// the failed streak's bead id must never appear in the reviewer's prompt.
//
// Pre-fix, runner.js built assignedBeadIds via an unfiltered
// streakOutcomes.flatMap(), so the failed streak's bead id would leak into
// the Review dispatch alongside the succeeded one -- asking the Reviewer to
// judge work that was never actually done. This test fails against that
// code path (the failed bead's id shows up in the round-1 review prompt) and
// passes once assignedBeadIds is properly filtered.
//
// Round 1 has both streaks open (mixed outcome): exactly one develop-round
// Review dispatch fires, scoped to the succeeded bead only. On rounds 2/3
// the succeeded bead is already closed and only the still-failing streak
// remains, so assignedBeadIds is empty and the empty-guard (apra-fleet-wrc.1)
// skips Review entirely -- incidentally also covering this bead's second
// acceptance clause ("an all-failed round performs zero review dispatch")
// without duplicating the dedicated all-failed scenario in
// mock-sprint-all-streaks-failed-no-review.test.mjs.
// =============================================================================

const reviewScopeIds = (d) => {
    const match = d.prompt.match(/Review the work just done for the following bead id\(s\):\s*(.+)\./);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};

test('mock sprint: a mixed develop round (one failed streak, one succeeded streak) sends only the succeeded bead into Review', async () => {
    await withScenarioMarkers('review scope excludes failed streak', async () => {
        console.log('Running mock sprint scenario (mixed round: one always-throwing streak, one succeeding streak)...');

        const scenario = await runDevelopLoopScenario('review-scope', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Always throws (review-scope scenario)' },
                { title: 'Task: Always succeeds (review-scope scenario)' },
            ],
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                const listRes = JSON.parse((await rc('bd list --json', td)).stdout || '[]');
                const throwsTask = listRes.find((b) => b.title === 'Task: Always throws (review-scope scenario)');
                if (throwsTask && ids.includes(throwsTask.id)) {
                    throw new Error(`mock doer failure for bead ${throwsTask.id}`);
                }
                for (const id of ids) {
                    await rc(`bd close ${id}`, td);
                }
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed successfully.' }) }] };
            },
            reviewerHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved whatever closed.', reopenIds: [], newTasks: [] }) }]
            }),
        });

        check(!scenario.error, `Mixed-round review-scope scenario should not abort/throw: ${scenario.error ? scenario.error.message : ''}`);
        check(scenario.result && scenario.result.status === 'failed', `Expected a FAIL verdict (the always-throwing bead never closes): ${JSON.stringify(scenario.result)}`);

        const throwsTaskId = scenario.tasks.find((t) => t.title === 'Task: Always throws (review-scope scenario)').id;
        const succeedsTaskId = scenario.tasks.find((t) => t.title === 'Task: Always succeeds (review-scope scenario)').id;

        // The develop-round Review (as opposed to the unconditional
        // end-of-sprint Final Review, a separate dispatch site) must have
        // fired exactly once -- round 1, the only round where a streak
        // actually succeeded (assignedBeadIds non-empty).
        const developRoundReviewDispatches = scenario.dispatched.filter((d) => d.agent === 'reviewer' && d.label !== 'Final Review');
        check(
            developRoundReviewDispatches.length === 1,
            `Expected exactly ONE develop-round Review dispatch (round 1 only; rounds 2/3 have zero succeeded streaks so Review is skipped), got ${developRoundReviewDispatches.length}: ${JSON.stringify(developRoundReviewDispatches.map(reviewScopeIds))}`
        );

        // That single review dispatch's scope (assignedBeadIds) must contain
        // ONLY the succeeded bead -- the failed bead must never leak in.
        const reviewedIds = reviewScopeIds(developRoundReviewDispatches[0]);
        check(
            reviewedIds.includes(succeedsTaskId),
            `Expected the succeeded bead '${succeedsTaskId}' to reach the Review dispatch, got scope: ${JSON.stringify(reviewedIds)}`
        );
        check(
            !reviewedIds.includes(throwsTaskId),
            `Expected the failed bead '${throwsTaskId}' to NEVER reach the Review dispatch (this is the pre-fix leak this test guards against), got scope: ${JSON.stringify(reviewedIds)}`
        );
        check(
            reviewedIds.length === 1,
            `Expected the Review dispatch scope to contain exactly the one succeeded bead id, got: ${JSON.stringify(reviewedIds)}`
        );

        // Rounds 2 and 3 (only the still-failing streak remains, so
        // assignedBeadIds is empty each time) hit the empty-guard skip --
        // this is this bead's second acceptance clause ("an all-failed round
        // performs zero review dispatch"), exercised here for the
        // subsequent rounds of the SAME scenario rather than a fully
        // separate all-failed sprint.
        check(
            scenario.logs.some((m) => m.includes('all streaks this round failed with no beadIds assigned -- skipping Review dispatch')),
            `Expected the empty-guard skip log line to fire for the later all-failed rounds, got logs: ${JSON.stringify(scenario.logs.filter((m) => m.includes('skipping Review')))}`
        );

        // Final state: the succeeded bead stayed closed; the always-throwing
        // bead never closed.
        check(
            scenario.finalBeadsById.get(succeedsTaskId) && scenario.finalBeadsById.get(succeedsTaskId).status === 'closed',
            `Expected succeeded bead '${succeedsTaskId}' to be closed, got: ${JSON.stringify(scenario.finalBeadsById.get(succeedsTaskId))}`
        );
        check(
            scenario.finalBeadsById.get(throwsTaskId) && scenario.finalBeadsById.get(throwsTaskId).status !== 'closed',
            `Expected the always-throwing bead '${throwsTaskId}' to remain open (never closed), got: ${JSON.stringify(scenario.finalBeadsById.get(throwsTaskId))}`
        );
    });
});
