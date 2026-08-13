import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';

import { setupMinimal, buildMockFleetApi, runCmd, teardown, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_SCRIPT = path.join(__dirname, '../fleet-sprint/runner.js');

// apra-fleet-ot2z.14: runner.js's main() acquires the machine-local sprint
// pidfile mutex (fleet-sprint/sprint-lock.mjs) keyed on (branch, members)
// against the OS-tmpdir-wide default lock directory unless
// APRA_FLEET_SPRINT_LOCK_DIR is set. This file's `branch: 'auto-sprint/
// 19o3-resurface'` is a fixed literal, so without isolation it could
// spuriously collide with an unrelated REAL fleet-sprint concurrently
// running on the same host under `--test-concurrency=8`. Node's test runner
// spawns one process per test file, so setting this once at module scope (a
// fresh throwaway dir for this file's whole process lifetime) safely
// isolates this file without affecting other files.
process.env.APRA_FLEET_SPRINT_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-sprint-lock-19o3-'));

// =============================================================================
// apra-fleet-19o.3 -- end-to-end integration coverage for apra-fleet-19o.1
// (square-bracket titles now validate) and apra-fleet-19o.2/apra-fleet-xuo.4
// (a rejected newTask resurfaces verbatim into the NEXT planning-phase
// dispatch prompt instead of dead-ending in root-bead notes, and clears once
// successfully resubmitted). This drives a REAL runner.js sprint end to end
// (real FleetWorkflow + WorkflowEngine, real `bd`) rather than hand-invoking
// the pure helpers in isolation -- that unit-level coverage already exists in
// rejected-newtask-resurface.test.mjs; this file proves the wiring actually
// reaches a genuine dispatch prompt payload and a genuine bead.
//
// Scenario shape: two tasks under one epic, A and B. The mock doer always
// closes A and deliberately NEVER closes B, so the goal-priority (P1/P2)
// open-bead count never reaches zero and the outer cycle loop runs for all 3
// configured cycles -- giving 3 distinct real Plan-phase dispatches to assert
// against (see buildPlannerPrompt's rejectedNewTasksToResubmit call site,
// runner.js's main cycle loop):
//
//   Cycle 1 Plan prompt: baseline -- nothing pending yet.
//   Cycle 1 Review round 1: the mock reviewer proposes two newTasks --
//     one with a title that STILL fails validateNewTask()'s allowlist even
//     with '[' ']' now permitted (a backtick, still shell-unsafe), and one
//     titled '[test] foo' (brackets -- the planner.md convention
//     apra-fleet-19o.1 exists to unblock).
//   Cycle 2 Plan prompt (isDeltaCycle): MUST resurface the rejected item
//     verbatim -- title, description, and rejection reason.
//   Cycle 2 Review round 1: the mock reviewer resubmits a corrected title
//     (backtick removed) with the SAME description -- proves end-to-end
//     acceptance AND exercises apra-fleet-xuo.4's description-keyed clear
//     (a title-corrected resubmission must still clear the pending entry).
//   Cycle 3 Plan prompt: MUST NOT resurface the (now-resubmitted) item.
// =============================================================================

const BAD_TITLE = 'Fix the `env` leak';
const BAD_DESCRIPTION = 'Scrub the leaked credential from the log output.';
const CORRECTED_TITLE = 'Fix the env leak';
const GOOD_BRACKET_TITLE = '[test] foo';
const GOOD_BRACKET_DESCRIPTION = 'A bracketed-title newTask using the planner.md [test] convention.';

const TASK_A_TITLE = 'Task: A closes normally (19o3 resurface scenario)';
const TASK_B_TITLE = 'Task: B never closes (19o3 resurface scenario)';

describe('apra-fleet-19o.3: bracketed titles validate and rejected newTasks reappear in the next planning prompt', () => {
    test('a real 3-cycle sprint: [test] foo becomes a bead end to end; a rejected newTask resurfaces verbatim in the next Plan prompt; a successful resubmission stops it reappearing', async () => {
        await withScenarioMarkers('19o3-resurface', async () => {
            const { tempDir, epicBead } = await setupMinimal('19o3resurface', [
                { title: TASK_A_TITLE },
                { title: TASK_B_TITLE, priority: 'P1' },
            ]);
            const dispatched = [];
            const commandLog = [];
            const logs = [];
            let rejectedSubmitted = false;
            let resubmitted = false;

            const isPlanPhasePrompt = (d) => d.agent === 'planner' && !d.prompt.includes('Ready bead ids:');

            try {
                const doerHandler = async ({ opts, tempDir: td }) => {
                    const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                    const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                    const listRes = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
                    const taskB = listRes.find((b) => b.title === TASK_B_TITLE);
                    const closedIds = [];
                    for (const id of ids) {
                        if (taskB && id === taskB.id) continue; // deliberately never closed -- keeps every cycle open
                        // eslint-disable-next-line no-await-in-loop
                        await runCmd(`bd close ${id}`, td);
                        closedIds.push(id);
                    }
                    return {
                        content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds, notes: 'Closed A (and any filler/resurfaced tasks); left B open (deliberately unfinished, forces further cycles).' }) }],
                    };
                };

                // The stall detector (STALL_CYCLE_LIMIT=2) aborts the sprint
                // after 2 consecutive cycles with no NEW high-water-mark
                // closed-bead progress -- and with B deliberately never
                // closing, the resurface/resubmit newTasks alone do not
                // reliably land a fresh closable bead in every single cycle
                // (their timing depends on the review round they're proposed
                // in). Mint one distinct, always-closable filler task per
                // cycle here (in the real Plan-phase dispatch, exactly like a
                // real planner would) so genuine forward progress happens
                // every cycle regardless of the resurface scenario's own
                // timing -- this is scaffolding for cycle-forcing, not part
                // of what this test is asserting on.
                let planCallCount = 0;
                const plannerHandler = async ({ tempDir: td }) => {
                    planCallCount += 1;
                    const fillerTitle = `Task: filler cycle ${planCallCount} (19o3 resurface scenario)`;
                    const createRes = await runCmd(`bd create "${fillerTitle}" -d "Keeps forward progress happening every cycle." -p P2 --silent`, td);
                    const fillerId = createRes.stdout.trim();
                    if (fillerId) {
                        await runCmd(`bd update ${fillerId} --parent ${epicBead.id}`, td);
                    }
                    return {
                        content: [{ text: `Ensured filler progress task for cycle ${planCallCount}.` }],
                    };
                };

                // Uses `dispatched` (closed over live, not a snapshot) to
                // determine which real cycle this review round belongs to by
                // counting the real Plan-phase dispatches issued SO FAR --
                // the Plan phase for cycle N always runs before cycle N's
                // Develop/Review loop, so this count is exactly N at the time
                // this handler runs.
                const reviewerHandler = async () => {
                    const currentCycle = dispatched.filter(isPlanPhasePrompt).length;
                    let newTasks = [];
                    if (currentCycle === 1 && !rejectedSubmitted) {
                        rejectedSubmitted = true;
                        newTasks = [
                            { title: BAD_TITLE, description: BAD_DESCRIPTION, priority: 'P2' },
                            { title: GOOD_BRACKET_TITLE, description: GOOD_BRACKET_DESCRIPTION, priority: 'P2' },
                        ];
                    } else if (currentCycle === 2 && !resubmitted) {
                        resubmitted = true;
                        newTasks = [
                            { title: CORRECTED_TITLE, description: BAD_DESCRIPTION, priority: 'P2' },
                        ];
                    }
                    return {
                        content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks }) }],
                    };
                };

                const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, {
                    planReviewerMode: 'approve-immediately',
                    addExtraTaskDuringPlan: false,
                    doerHandler,
                    reviewerHandler,
                    plannerHandler,
                });
                const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
                workflow.on('log', (e) => logs.push(e.msg));
                const engine = new WorkflowEngine(workflow);

                let error = null;
                let result = null;
                try {
                    result = await engine.executeFile(RUNNER_SCRIPT, {
                        target_issue: epicBead.id,
                        members: ['local'],
                        branch: 'auto-sprint/19o3-resurface',
                        base_branch: 'main',
                        goal: 'P1/P2',
                        max_cycles: 3,
                    }, true);
                } catch (err) {
                    error = err;
                }

                assert.ok(!error, `expected the 3-cycle scenario to complete without throwing: ${error ? error.stack : ''}`);
                assert.ok(result, `expected a result object, got none. logs: ${JSON.stringify(logs)}`);

                const planPrompts = dispatched.filter(isPlanPhasePrompt);
                assert.equal(
                    planPrompts.length, 3,
                    `expected exactly 3 real Plan-phase dispatches (one per cycle), got ${planPrompts.length}: ${JSON.stringify(planPrompts.map((d) => d.prompt.slice(0, 60)))}`,
                );

                // ---- Cycle 1 Plan prompt: nothing pending yet ----
                assert.ok(!planPrompts[0].prompt.includes('previously REJECTED'), 'cycle 1 Plan prompt must not resurface anything -- nothing was rejected yet');

                // ---- Cycle 2 Plan prompt: the rejected item resurfaces verbatim ----
                const cycle2Prompt = planPrompts[1].prompt;
                assert.ok(cycle2Prompt.includes(BAD_TITLE), 'cycle 2 Plan prompt must carry the rejected title verbatim');
                assert.ok(cycle2Prompt.includes(BAD_DESCRIPTION), 'cycle 2 Plan prompt must carry the rejected description verbatim');
                assert.ok(/title fails safe-character allowlist/.test(cycle2Prompt), 'cycle 2 Plan prompt must carry the real validateNewTask() rejection reason, not a paraphrase');

                // ---- Cycle 3 Plan prompt: the resubmitted item must NOT reappear ----
                const cycle3Prompt = planPrompts[2].prompt;
                assert.ok(!cycle3Prompt.includes(BAD_TITLE), 'cycle 3 Plan prompt must NOT resurface the item again -- it was successfully resubmitted in cycle 2');
                assert.ok(!cycle3Prompt.includes('previously REJECTED'), 'cycle 3 Plan prompt must carry no resurface section once the pending list is empty');

                // ---- Real bead-level evidence ----
                const finalBeads = JSON.parse((await runCmd(`bd list --parent ${epicBead.id} --all --json`, tempDir)).stdout || '[]');
                const titles = finalBeads.map((b) => b.title);

                const goodBead = finalBeads.find((b) => b.title === GOOD_BRACKET_TITLE);
                assert.ok(goodBead, `expected '${GOOD_BRACKET_TITLE}' to be accepted end to end and land as a real bead under the parent, got: ${JSON.stringify(titles)}`);

                const correctedBead = finalBeads.find((b) => b.title === CORRECTED_TITLE);
                assert.ok(correctedBead, `expected the corrected resubmission '${CORRECTED_TITLE}' to land as a real bead, got: ${JSON.stringify(titles)}`);

                const badBead = finalBeads.find((b) => b.title === BAD_TITLE);
                assert.ok(!badBead, `the rejected title must never itself land as a bead, got: ${JSON.stringify(titles)}`);
            } finally {
                await teardown(tempDir);
            }
        });
    });
});
