import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StalledSprintError } from '../fleet-sprint/errors.mjs';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-mjo: an intermediate parent bead (one that is BOTH someone's
// child -- so it is in scope -- AND someone else's parent -- so readyLeafBeads
// refuses to dispatch it) must not count against the goal-priority completion
// gate once its own children have all closed.
//
// Observed live 2026-08-07 on sprint feat/forklift-stationary-handling: all 13
// task beads closed, 15 commits landed, the suite was green, and the sprint
// still died with
//   StalledSprintError: ... Closed-count history: [9, 14, 14, 14]
// because two open bug parents kept `openAtGoal` pinned above zero. They were
// simultaneously undispatchable (readyLeafBeads excludes any bead that is
// another bead's parent) and permanently blocking (openAtGoal applied no such
// exclusion), so neither the completion gate nor the re-review branch -- both
// guarded on `openAtGoal.length === 0` -- could ever be reached.
//
// The sprint epic itself does NOT reproduce this: a target issue WITH children
// never enters scopeIds (see bdListScoped's childless-target seeding), so it is
// invisible to every scoped query. Only a parent NESTED under the target hits
// both sides of the contradiction -- which is exactly the shape a planner
// produces when it decomposes a bug into tasks.
// =============================================================================
test('mock sprint: an all-children-closed parent must not block the completion gate', async () => {
    await withScenarioMarkers('parentgate', async () => {
        console.log('Running mock sprint scenario (all-children-closed parent must not block the gate)...');
        let bugParentId = null;
        const scenario = await runDevelopLoopScenario('parentgate', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: A directly under the epic (parent-gate scenario)' },
                { title: 'Task: B re-parented under a bug (parent-gate scenario)' },
            ],
            maxCycles: 3,
            // Build the epic -> bug -> task nesting the planner produces when
            // it decomposes a bug: the bug is in scope (it is the epic's
            // child) AND is a parent (task B hangs off it).
            beforeSprint: async ({ tempDir: td, runCmd: run, epicBead, tasks }) => {
                const createRes = await run(
                    'bd create -t bug "Bug: decomposed parent (parent-gate scenario)" '
                    + '-d "Parent bug whose only task child closes during the sprint." --silent',
                    td
                );
                bugParentId = createRes.stdout.trim();
                await run(`bd update ${bugParentId} --parent ${epicBead.id}`, td);
                await run(`bd update ${tasks[1].id} --parent ${bugParentId}`, td);
            },
            doerHandler: async ({ opts, tempDir: td }) => {
                const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                const closedIds = [];
                for (const id of ids) {
                    await runCmd(`bd close ${id}`, td);
                    closedIds.push(id);
                }
                return {
                    content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds, notes: 'Closed every assigned task.' }) }]
                };
            },
            reviewerHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'All assigned tasks verified.', reopenIds: [], newTasks: [] }) }]
            }),
        });

        check(
            !(scenario.error instanceof StalledSprintError),
            `The sprint must not stall on an undispatchable all-children-closed parent. Got: ${scenario.error ? scenario.error.message : ''}`
        );
        check(!scenario.error, `Scenario should not throw: ${scenario.error ? scenario.error.message : ''}`);
        check(
            scenario.result && scenario.result.status === 'success',
            `Expected the sprint to exit success once every dispatchable bead closed, got: ${JSON.stringify(scenario.result)}`
        );
        for (const t of scenario.tasks) {
            const bead = scenario.finalBeadsById.get(t.id);
            check(bead && bead.status === 'closed', `Expected ${t.title} to be closed, got: ${JSON.stringify(bead)}`);
        }
        // The fix makes the gate count only DISPATCHABLE work; it deliberately
        // does not close the parent on the sprint's behalf. Pin that: a future
        // auto-close would be a separate, explicit decision.
        const bugParent = scenario.finalBeadsById.get(bugParentId);
        check(
            bugParent && bugParent.status !== 'closed',
            `The parent bug is expected to remain open (the gate ignores it, it is not auto-closed), got: ${JSON.stringify(bugParent)}`
        );
    });
});
