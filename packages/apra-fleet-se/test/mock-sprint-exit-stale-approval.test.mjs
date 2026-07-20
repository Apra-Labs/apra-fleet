import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-unw2.6 (N8) regression 1: stale APPROVED verdict must never
// back an exit decision for a LATER cycle it never actually reviewed --
// when the exit check's goal-priority count reaches 0 on a cycle whose
// Develop/Review loop was skipped (no ready beads), a fresh re-review of
// the current state must be dispatched before the sprint is allowed to
// exit.
// =============================================================================
test('mock sprint: a stale APPROVED verdict must not back a later cycle\'s exit without a fresh re-review', async () => {
    await withScenarioMarkers('staleapproval (N8 stale verdict)', async () => {
        console.log('Running mock sprint scenario (stale APPROVED verdict must not back a later cycle\'s exit without a fresh re-review)...');
        let staleDeployCalls = 0;
        const staleApproval = await runDevelopLoopScenario('staleapproval', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: A closes normally (stale-approval scenario)' },
                { title: 'Task: B stays blocked (stale-approval scenario)' },
            ],
            maxCycles: 2,
            withRunbooks: true,
            // Cycle 1: close A, but deliberately leave B `blocked` (an
            // out-of-scope/deferred condition) rather than closed or left
            // `open` -- `blocked` still counts toward the goal-priority open
            // count (NOT_DONE_STATUSES) but is never re-offered via `--ready`,
            // so cycle 2's Develop/Review loop is skipped entirely (no ready
            // beads) -- exactly the "develop skipped" half of the N8 bug.
            doerHandler: async ({ opts, tempDir: td }) => {
                const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                const listRes = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
                const bTask = listRes.find((b) => b.title === 'Task: B stays blocked (stale-approval scenario)');
                const closedIds = [];
                for (const id of ids) {
                    if (bTask && id === bTask.id) {
                        await runCmd(`bd update ${id} --status=blocked`, td);
                    } else {
                        await runCmd(`bd close ${id}`, td);
                        closedIds.push(id);
                    }
                }
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds, notes: 'Closed A; left B blocked (out-of-scope, deferred).' }) }] };
            },
            // Approves whatever was actually reviewed each round -- this is the
            // verdict cycle 1 ends on ('APPROVED', with B noted as an
            // out-of-scope blocker) AND the verdict a correctly-dispatched
            // fresh re-review in cycle 2 must independently reach.
            reviewerHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved what was reviewed; B intentionally deferred as out-of-scope.', reopenIds: [], newTasks: [] }) }]
            }),
            // Cycle 2's Deploy phase (which runs every cycle regardless of
            // whether Develop/Review ran) closes B out-of-band -- simulating
            // the goal-priority open count reaching 0 on a cycle that never
            // itself reviewed that closure. This is the exact condition a
            // stale `lastReviewVerdict` from cycle 1 could otherwise satisfy.
            deployHandler: async ({ tempDir: td }) => {
                staleDeployCalls++;
                if (staleDeployCalls === 2) {
                    const listRes = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
                    const bTask = listRes.find((b) => b.title === 'Task: B stays blocked (stale-approval scenario)');
                    if (bTask) await runCmd(`bd close ${bTask.id}`, td);
                }
                return { content: [{ text: JSON.stringify({ deployed: true, notes: `Deploy call #${staleDeployCalls}` }) }] };
            },
        });
        check(!staleApproval.error, `Stale-approval scenario should not throw: ${staleApproval.error ? staleApproval.error.message : ''}`);
        check(
            staleApproval.result && staleApproval.result.status === 'success',
            `Expected the stale-approval scenario to eventually succeed (backed by a fresh re-review), got: ${JSON.stringify(staleApproval.result)}`
        );
        const staleReviewCalls = staleApproval.dispatched.filter((d) => d.agent === 'reviewer' && d.label !== 'Final Review');
        check(
            staleReviewCalls.length === 2,
            `Expected exactly 2 non-final reviewer dispatches -- cycle 1's real review AND cycle 2's fresh re-review (never relying on cycle 1's stale verdict) -- got ${staleReviewCalls.length}: ${JSON.stringify(staleReviewCalls.map((d) => d.prompt.slice(0, 80)))}`
        );
        check(
            staleApproval.logs.some((m) => m.includes('no review ran THIS cycle') && m.includes('fresh re-review')),
            `Expected a logged re-review dispatch before exit, logs: ${JSON.stringify(staleApproval.logs)}`
        );
        const staleTaskA = staleApproval.tasks.find((t) => t.title === 'Task: A closes normally (stale-approval scenario)');
        const staleTaskB = staleApproval.tasks.find((t) => t.title === 'Task: B stays blocked (stale-approval scenario)');
        check(
            staleApproval.finalBeadsById.get(staleTaskA.id) && staleApproval.finalBeadsById.get(staleTaskA.id).status === 'closed',
            `Expected task A to be closed, got: ${JSON.stringify(staleApproval.finalBeadsById.get(staleTaskA.id))}`
        );
        check(
            staleApproval.finalBeadsById.get(staleTaskB.id) && staleApproval.finalBeadsById.get(staleTaskB.id).status === 'closed',
            `Expected task B to be closed (by the cycle-2 deploy side effect), got: ${JSON.stringify(staleApproval.finalBeadsById.get(staleTaskB.id))}`
        );
    });
});
