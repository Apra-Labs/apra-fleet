import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-unw.17 (A5) acceptance criterion 3: goal-priority exit --
// a P3 open bead does not block P1/P2 goal completion
// =============================================================================
test('mock sprint: an out-of-goal P3 bead does not block P1/P2 goal completion', async () => {
    await withScenarioMarkers('goalpriority (P3 left open)', async () => {
        console.log('Running mock sprint scenario (goal-priority exit: P3 bead left open)...');
        const goalPriority = await runDevelopLoopScenario('goalpriority', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: In-goal P2 work' },
                { title: 'Task: Out-of-goal P3 work', priority: 'P3' },
            ],
            maxCycles: 1,
            // Close only the in-goal (P2, default-priority) task; deliberately
            // leave the P3 task open every round -- it must never be dispatched
            // as "blocking" the P1/P2 goal from completing.
            doerHandler: async ({ opts, tempDir: td }) => {
                const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                const listRes = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
                const p3Task = listRes.find((b) => b.title === 'Task: Out-of-goal P3 work');
                for (const id of ids) {
                    if (p3Task && id === p3Task.id) continue; // never close the out-of-goal task
                    await runCmd(`bd close ${id}`, td);
                }
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids.filter((id) => !p3Task || id !== p3Task.id), notes: 'Closed in-goal work only.' }) }] };
            },
            reviewerHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'In-goal work approved.', reopenIds: [], newTasks: [] }) }]
            }),
        });
        check(!goalPriority.error, `Goal-priority scenario should not throw: ${goalPriority.error ? goalPriority.error.message : ''}`);
        check(
            goalPriority.result && goalPriority.result.status === 'success',
            `Expected goal-priority completion (P1/P2) despite an open P3 bead, got: ${JSON.stringify(goalPriority.result)}`
        );
        const inGoalId = goalPriority.tasks.find((t) => t.title === 'Task: In-goal P2 work').id;
        const outOfGoalId = goalPriority.tasks.find((t) => t.title === 'Task: Out-of-goal P3 work').id;
        check(
            goalPriority.finalBeadsById.get(inGoalId) && goalPriority.finalBeadsById.get(inGoalId).status === 'closed',
            `Expected the in-goal (P2) bead to be closed, got: ${JSON.stringify(goalPriority.finalBeadsById.get(inGoalId))}`
        );
        check(
            goalPriority.finalBeadsById.get(outOfGoalId) && goalPriority.finalBeadsById.get(outOfGoalId).status !== 'closed',
            `Expected the out-of-goal (P3) bead to remain open (never blocking completion), got: ${JSON.stringify(goalPriority.finalBeadsById.get(outOfGoalId))}`
        );
    });
});
