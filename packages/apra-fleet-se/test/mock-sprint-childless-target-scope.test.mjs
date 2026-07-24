import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { setupMinimal, buildMockFleetApi, runCmd, teardown, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, '../auto-sprint/runner.js');

// =============================================================================
// apra-fleet-eft.24.2: real-bd/mock-sprint coverage for the eft.24.1 fix
// (bdListScoped seeds scopeIds with any target issue that has zero children
// of its own, so a bare, undecomposed sprint target is not silently
// invisible to the whole sprint). Two things must hold at once:
//
//   1. A childless leaf target (no children at all) is genuinely IN SCOPE
//      for bdListScoped, for both its cheap in-memory-only path (the plain
//      '' query, exercised via updateDashboard()'s sprintTasks) and its
//      second-query-then-intersect path (any non-empty `rest`, including a
//      `--status=...` filter, exercised via the Cycle Evaluation/
//      Finalization goal-priority queries) -- and pre-sprint validation
//      does not hard-fail for it, so the sprint actually reaches Planning.
//   2. The pre-existing decomposed-target guard (apra-fleet-xbu.C5) is
//      unaffected: a target that already has children must still never be
//      dispatched to a doer alongside its own children.
//
// Uses the real `bd` CLI via the record/replay harness (test/helpers/
// mock-sprint-harness.mjs + bd-replay.mjs) -- scopeIds is computed by
// runner.js's own bdListScoped against genuine `bd list` output, not a
// hand-crafted JSON stand-in.
// =============================================================================

test('childless leaf target: bdListScoped(\'\') includes the target itself, pre-sprint validation does not hard-fail, and the cycle reaches Planning', async () => {
    await withScenarioMarkers('childless-a', async () => {
        // taskSpecs: [] -- the created epic bead has ZERO children, i.e. a
        // bare, undecomposed leaf target (eft.24's exact repro shape).
        const { tempDir, epicBead } = await setupMinimal('childless-a', []);
        const dispatched = [];
        const commandLog = [];
        const publishedStates = [];
        try {
            const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, {
                planReviewerMode: 'approve-immediately',
                addExtraTaskDuringPlan: false,
            });
            const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
            workflow.on('state', (evt) => publishedStates.push(evt));
            const engine = new WorkflowEngine(workflow);

            const result = await engine.executeFile(scriptPath, {
                target_issue: epicBead.id,
                members: ['local'],
                branch: 'auto-sprint/mock-childless-a',
                base_branch: 'main',
                goal: 'P1/P2',
                max_cycles: 1,
            }, true);

            assert.strictEqual(
                result.status, 'success',
                `expected the sprint to complete successfully for a childless target (proves pre-sprint validation did not hard-fail), got: ${JSON.stringify(result)}`
            );

            // Reached Planning: a real Planning-phase planner dispatch (NOT
            // the later streak-assignment reuse of the planner MEMBER,
            // which carries no agentType-distinguishing persona of its own
            // but is identifiable by its distinctive 'Ready bead ids:'
            // prompt -- see buildStreakAssignmentPrompt in runner.js).
            const planningDispatches = dispatched.filter((d) => d.agent === 'planner' && !d.prompt.includes('Ready bead ids:'));
            assert.ok(
                planningDispatches.length > 0,
                `expected at least one real Planning-phase planner dispatch, proving the sprint advanced past 'Sprint Setup' into Planning for the childless target. dispatched: ${JSON.stringify(dispatched.map((d) => d.agent))}`
            );

            // bdListScoped('') -- updateDashboard()'s sprintTasks query --
            // includes the childless target itself at some point during the
            // sprint (pre-eft.24.1, scopeIds stayed empty for a childless
            // target and this list would never contain it).
            const beadsStates = publishedStates.filter((e) => e.namespace === 'beads');
            assert.ok(beadsStates.length > 0, 'expected at least one publishState("beads", ...) call');
            const sawTargetInSprintTasks = beadsStates.some((e) => (e.data.sprintTasks || []).some((t) => t.id === epicBead.id));
            assert.ok(
                sawTargetInSprintTasks,
                `expected the childless target ${epicBead.id} to appear in sprintTasks (bdListScoped('') output); ` +
                    `sprintTasks snapshots seen: ${JSON.stringify(beadsStates.map((e) => (e.data.sprintTasks || []).map((t) => t.id)))}`
            );
        } finally {
            await teardown(tempDir);
        }
    });
});

test('childless leaf target: bdListScoped(--status=...) also includes the target itself (proven via Final Review goal-priority evidence)', async () => {
    await withScenarioMarkers('childless-b', async () => {
        const { tempDir, epicBead } = await setupMinimal('childless-b', []);
        const dispatched = [];
        const commandLog = [];
        try {
            // Deliberately does NOT close the assigned bead -- keeps it
            // 'open' across Cycle Evaluation/Finalization so bdListScoped's
            // `--status=<NOT_DONE_STATUSES> --priority-max=...` query (used
            // for openAtGoal/finalOpenAtGoal, runner.js's non-empty-`rest`
            // second-query-then-intersect code path) has a real,
            // structurally-in-scope open bead to find. If the eft.24.1
            // childless-target scope seed regressed, this bead would be
            // silently invisible to that query and the Final Review
            // evidence text below would report 0 open beads even though the
            // real bead is still open.
            const doerHandler = async ({ opts }) => {
                const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                return {
                    content: [{
                        text: JSON.stringify({
                            status: 'VERIFY',
                            closedIds: [],
                            notes: `Intentionally left bead(s) ${ids.join(', ')} open (apra-fleet-eft.24.2 --status-query regression coverage).`,
                        })
                    }]
                };
            };

            const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, {
                planReviewerMode: 'approve-immediately',
                addExtraTaskDuringPlan: false,
                doerHandler,
            });
            const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
            const engine = new WorkflowEngine(workflow);

            let error = null;
            let result = null;
            try {
                result = await engine.executeFile(scriptPath, {
                    target_issue: epicBead.id,
                    members: ['local'],
                    branch: 'auto-sprint/mock-childless-b',
                    base_branch: 'main',
                    goal: 'P1/P2',
                    max_cycles: 1,
                }, true);
            } catch (err) {
                error = err;
            }

            assert.strictEqual(error, null, `expected the sprint to run to completion (not throw) even though the target bead was left open: ${error && error.message}`);

            const finalReviewDispatch = dispatched.find((d) => d.label === 'Final Review');
            assert.ok(finalReviewDispatch, `expected a Final Review dispatch, dispatched: ${JSON.stringify(dispatched.map((d) => ({ agent: d.agent, label: d.label })))}`);

            const openMatch = finalReviewDispatch.prompt.match(/(\d+) bead\(s\) still open at or above goal priority/);
            assert.ok(openMatch, `expected the Final Review prompt to report an open-bead count, got prompt: ${finalReviewDispatch.prompt}`);
            assert.strictEqual(
                Number(openMatch[1]), 1,
                `expected bdListScoped('--status=...') to include the still-open childless target ${epicBead.id} (openAtGoalCount should be 1), got ${openMatch[1]}. Full prompt: ${finalReviewDispatch.prompt}`
            );

            // The target itself is still open in real bd -- confirms the
            // scenario setup (and this test) genuinely exercised an OPEN
            // bead, not an accidentally-closed one.
            const finalBeadsRaw = JSON.parse((await runCmd('bd list --all --json', tempDir)).stdout || '[]');
            const targetBead = finalBeadsRaw.find((b) => b.id === epicBead.id);
            assert.ok(targetBead, `expected to find ${epicBead.id} in the final bd state`);
            assert.strictEqual(targetBead.status, 'open', `expected ${epicBead.id} to still be open at the end of the sprint`);

            assert.strictEqual(result.status, 'failed', `expected an evidence-based FAIL verdict (1 open goal-priority bead), got: ${JSON.stringify(result)}`);
        } finally {
            await teardown(tempDir);
        }
    });
});

test('decomposed-target regression guard: a target with children is never returned as a directly-dispatchable ready bead alongside its own children', async () => {
    await withScenarioMarkers('childless-c', async () => {
        // One child task -- the target itself is decomposed, unlike the two
        // scenarios above.
        const { tempDir, epicBead, tasks } = await setupMinimal('childless-c', [{ title: 'Task: Only child of the decomposed target' }]);
        const childId = tasks[0].id;
        const dispatched = [];
        const commandLog = [];
        try {
            const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, {
                planReviewerMode: 'approve-immediately',
                addExtraTaskDuringPlan: false,
            });
            const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
            const engine = new WorkflowEngine(workflow);

            const result = await engine.executeFile(scriptPath, {
                target_issue: epicBead.id,
                members: ['local'],
                branch: 'auto-sprint/mock-childless-c',
                base_branch: 'main',
                goal: 'P1/P2',
                max_cycles: 1,
            }, true);

            assert.strictEqual(result.status, 'success', `expected the sprint to complete successfully, got: ${JSON.stringify(result)}`);

            // Streak-assignment dispatch(es): the 'Ready bead ids:' list must
            // never include the decomposed target itself -- only its leaf
            // child.
            const streakDispatches = dispatched.filter((d) => d.prompt.includes('Ready bead ids:'));
            assert.ok(streakDispatches.length > 0, 'expected at least one streak-assignment dispatch');
            for (const d of streakDispatches) {
                const idsMatch = d.prompt.match(/Ready bead ids:\s*(.+)/);
                const ids = idsMatch ? idsMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                assert.ok(
                    !ids.includes(epicBead.id),
                    `expected the decomposed target ${epicBead.id} to be excluded from the ready-dispatch set alongside its own child, got ready ids: ${JSON.stringify(ids)}`
                );
                assert.ok(ids.includes(childId), `expected the leaf child ${childId} to be present in the ready-dispatch set, got: ${JSON.stringify(ids)}`);
            }

            // Doer dispatch(es): 'Assigned bead ids' must likewise never
            // name the decomposed target itself.
            const doerDispatches = dispatched.filter((d) => d.agent === 'doer');
            assert.ok(doerDispatches.length > 0, 'expected at least one doer dispatch');
            for (const d of doerDispatches) {
                const idsMatch = d.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                const ids = idsMatch ? idsMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                assert.ok(
                    !ids.includes(epicBead.id),
                    `expected the decomposed target ${epicBead.id} to never be assigned to a doer alongside its own child, got assigned ids: ${JSON.stringify(ids)}`
                );
            }
        } finally {
            await teardown(tempDir);
        }
    });
});
