import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkPath } from '../fleet-sprint/dispatch-safety-guard.mjs';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNNER_PATH = path.join(__dirname, '../fleet-sprint/runner.js');

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-eft.68.1 -- mock-sprint coverage for the FULL same-cycle scoped
// replan.
//
// eft.68 SUPERSEDES the old eft.67.2 "defer to the next cycle" short-circuit
// for the FIRST replan of a bead: instead of ending the cycle when a reviewer
// flags a bead via `replanIds` (its acceptance criteria are themselves
// defective and cannot be satisfied by re-development), the orchestrator now
// dispatches a SCOPED planner pass for exactly that bead's subtree PLUS a
// scoped plan-review of the result WITHIN the same cycle, then resumes develop
// rounds so the amended bead is re-dispatched to a doer THIS cycle. A loop
// guard (`replannedThisCycle`) caps this at one scoped replan per bead per
// cycle: a bead flagged for replan a SECOND time in one cycle is refused with a
// logged guard line and handed off to the next cycle's planner instead.
//
// Scenario 1 (in-cycle scoped replan): a single ready bead X, maxCycles=1.
//   Review round 1 flags reopenIds=[X] + replanIds=[X]; every later round
//   approves. With only ONE cycle allowed, X can only end up closed if the
//   scoped replan + re-dispatch genuinely happened IN-cycle. Assert:
//     - a SCOPED planner dispatch fired for X (prompt names X + the scoped
//       clause)
//     - a SCOPED plan-review dispatch fired for X
//     - X was re-dispatched to a doer in the SAME cycle (2 doer dispatches,
//       both naming X; exactly ONE non-scoped planner dispatch == one cycle)
//     - the in-cycle-scoped-replan log line fired, naming X
//     - the old '[fleet-sprint] replan short-circuit' log line did NOT fire
//     - X ends up closed
//
// Scenario 2 (loop guard): review rounds 1 AND 2 both flag replanIds=[X].
//   The first triggers exactly one scoped replan; the second is REFUSED with a
//   logged guard line (max one scoped replan per bead per cycle). maxCycles=2
//   so the next cycle's plan/doer/reviewer finish X cleanly. Assert:
//     - exactly ONE scoped planner dispatch (the second replan was refused,
//       not acted on)
//     - the '[fleet-sprint] replan loop guard' log line fired, naming X
//     - X ends up closed
//
// Control (Scenario 3): identical reopenIds but WITHOUT replanIds -- today's
// normal round behavior must be preserved exactly (X is re-dispatched to a doer
// again in round 2 of the SAME cycle, with no scoped planner/plan-review pass).
// =============================================================================

test('mock sprint: replanIds triggers an in-cycle scoped planner + plan-review and re-dispatches the amended bead the SAME cycle', async () => {
    await withScenarioMarkers('in-cycle scoped replan (single ready bead)', async () => {
        console.log('Running mock sprint scenario (in-cycle scoped replan)...');

        const sc = await runDevelopLoopScenario('replansc', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Replan target X' },
            ],
            // Deliberately ONE cycle: X can only end closed if the scoped
            // replan + re-dispatch all happened within cycle 1.
            maxCycles: 1,
            reviewerHandler: async ({ tempDir, runCmd, epicBead, reviewRound: rRound }) => {
                if (rRound === 1) {
                    // The doer already closed X before this review round runs,
                    // so a default (open-only) `bd list` would miss it -- use
                    // --all like mock-sprint-develop-reopen.test.mjs does.
                    const list = JSON.parse((await runCmd(`bd list --parent ${epicBead.id} --all --json`, tempDir)).stdout || '[]');
                    const x = list.find((b) => b.title.includes('Replan target X'));
                    return {
                        content: [{
                            text: JSON.stringify({
                                verdict: 'CHANGES_NEEDED',
                                notes: `${x.id}'s acceptance criteria are ambiguous and cannot be satisfied as written -- needs replanning.`,
                                reopenIds: [x.id],
                                replanIds: [x.id],
                                newTasks: [],
                            }),
                        }],
                    };
                }
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'APPROVED',
                            notes: 'X was re-scoped by the in-cycle scoped planner and is now implemented correctly.',
                            reopenIds: [],
                            newTasks: [],
                        }),
                    }],
                };
            },
        });

        check(!sc.error, `Expected engine.executeFile() to resolve, got error: ${sc.error ? sc.error.constructor.name + ': ' + sc.error.message : 'none'}`);

        const xId = sc.tasks.find((t) => t.title.includes('Replan target X')).id;

        // A SCOPED planner dispatch fired for X (its prompt carries the scoped
        // clause AND names X). This is a SECOND 'planner' agent dispatch beyond
        // the cycle's initial plan.
        const scopedPlanner = sc.dispatched.filter(
            (d) => d.agent === 'planner' && d.prompt.includes('SCOPED IN-CYCLE REPLAN') && d.prompt.includes(xId)
        );
        check(
            scopedPlanner.length >= 1,
            `Expected at least one SCOPED in-cycle-replan planner dispatch naming ${xId}, got ${scopedPlanner.length}: ` +
            `${JSON.stringify(sc.dispatched.map((d) => d.agent))}`
        );

        // A SCOPED plan-review dispatch fired for X.
        const scopedReview = sc.dispatched.filter(
            (d) => d.agent === 'plan-reviewer' && d.prompt.includes('SCOPED IN-CYCLE REPLAN REVIEW') && d.prompt.includes(xId)
        );
        check(
            scopedReview.length >= 1,
            `Expected at least one SCOPED in-cycle-replan plan-review dispatch naming ${xId}, got ${scopedReview.length}: ` +
            `${JSON.stringify(sc.dispatched.map((d) => d.agent))}`
        );

        // Exactly ONE non-scoped 'planner' dispatch (the cycle's initial plan)
        // -- proof the whole thing happened inside ONE cycle, not by deferring
        // to a second cycle's fresh planner.
        const nonScopedPlanners = sc.dispatched.filter(
            (d) => d.agent === 'planner' && !d.prompt.includes('SCOPED IN-CYCLE REPLAN')
        );
        check(
            nonScopedPlanners.length === 1,
            `Expected exactly ONE non-scoped planner dispatch (single cycle), got ${nonScopedPlanners.length}: ` +
            `${JSON.stringify(sc.dispatched.map((d) => d.agent))}`
        );

        // X was re-dispatched to a doer in the SAME cycle: once before the
        // replan, once after the scoped replan amended it.
        const doerDispatches = sc.dispatched.filter((d) => d.agent === 'doer');
        check(
            doerDispatches.length === 2,
            `Expected exactly 2 doer dispatches (develop, then re-develop after the in-cycle scoped replan), got ${doerDispatches.length}: ` +
            `${JSON.stringify(sc.dispatched.map((d) => d.agent))}`
        );
        check(
            doerDispatches.every((d) => d.prompt.includes(xId)),
            `Expected both doer dispatches to name ${xId}, prompts: ${JSON.stringify(doerDispatches.map((d) => d.prompt))}`
        );

        // The in-cycle scoped replan log line fired, naming X.
        check(
            sc.logs.some((l) => l.includes('[fleet-sprint] in-cycle scoped replan') && l.includes(xId)),
            `Expected a '[fleet-sprint] in-cycle scoped replan' log line naming ${xId}, logs: ${JSON.stringify(sc.logs.filter((l) => l.includes('scoped replan')))}`
        );

        // The old (superseded) short-circuit log line did NOT fire.
        check(
            !sc.logs.some((l) => l.includes('[fleet-sprint] replan short-circuit')),
            `Did NOT expect the old '[fleet-sprint] replan short-circuit' log line, logs: ${JSON.stringify(sc.logs.filter((l) => l.includes('short-circuit')))}`
        );

        // X ended up closed within the single allowed cycle.
        const xFinal = sc.finalBeadsById.get(xId);
        check(
            xFinal && xFinal.status === 'closed',
            `Expected ${xId} to end up closed (in-cycle scoped replan + re-dispatch completed it), got: ${xFinal ? xFinal.status : '(bead not found)'}`
        );

        // dispatch-safety-guard invariant: every command()/agent() call site in
        // runner.js still passes member_name/member_id (the two NEW scoped
        // dispatch sites this feature added are counted by the guard's own
        // EXPECTED_AGENT_COUNT bump).
        const { violations } = checkPath(RUNNER_PATH);
        check(violations.length === 0, `Expected zero dispatch-safety-guard violations in runner.js, got: ${JSON.stringify(violations)}`);
    });
});

test('mock sprint: a SECOND replan of the same bead in one cycle is refused with a logged loop-guard line', async () => {
    await withScenarioMarkers('in-cycle scoped replan loop guard', async () => {
        console.log('Running mock sprint scenario (scoped replan loop guard)...');

        const sc = await runDevelopLoopScenario('replanguard', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Replan target Z' },
            ],
            // Two cycles: cycle 1 exercises the guard (two replan flags, only
            // the first acted on); cycle 2's plan/doer/reviewer finish Z.
            maxCycles: 2,
            reviewerHandler: async ({ tempDir, runCmd, epicBead, reviewRound: rRound }) => {
                // Reviewer rounds are cumulative across cycles: rounds 1 and 2
                // both fall in cycle 1 (develop R1, then the post-scoped-replan
                // re-develop). Both flag Z for replan; the second must be
                // refused by the loop guard. Round 3 (cycle 2) approves.
                if (rRound === 1 || rRound === 2) {
                    const list = JSON.parse((await runCmd(`bd list --parent ${epicBead.id} --all --json`, tempDir)).stdout || '[]');
                    const z = list.find((b) => b.title.includes('Replan target Z'));
                    return {
                        content: [{
                            text: JSON.stringify({
                                verdict: 'CHANGES_NEEDED',
                                notes: `${z.id}'s acceptance criteria are still ambiguous -- needs replanning (round ${rRound}).`,
                                reopenIds: [z.id],
                                replanIds: [z.id],
                                newTasks: [],
                            }),
                        }],
                    };
                }
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'APPROVED',
                            notes: 'Z was re-scoped by the next cycle\'s planner and is now implemented correctly.',
                            reopenIds: [],
                            newTasks: [],
                        }),
                    }],
                };
            },
        });

        check(!sc.error, `Expected engine.executeFile() to resolve, got error: ${sc.error ? sc.error.constructor.name + ': ' + sc.error.message : 'none'}`);

        const zId = sc.tasks.find((t) => t.title.includes('Replan target Z')).id;

        // Exactly ONE scoped planner dispatch: the FIRST replan flag triggered
        // a scoped replan; the SECOND (same cycle) was refused by the loop
        // guard, so no second scoped planner ran.
        const scopedPlanner = sc.dispatched.filter(
            (d) => d.agent === 'planner' && d.prompt.includes('SCOPED IN-CYCLE REPLAN')
        );
        check(
            scopedPlanner.length === 1,
            `Expected exactly ONE scoped planner dispatch (the second in-cycle replan of ${zId} must be refused), got ${scopedPlanner.length}: ` +
            `${JSON.stringify(sc.dispatched.map((d) => d.agent))}`
        );

        // The loop-guard log line fired, naming Z.
        check(
            sc.logs.some((l) => l.includes('[fleet-sprint] replan loop guard') && l.includes(zId)),
            `Expected a '[fleet-sprint] replan loop guard' log line naming ${zId}, logs: ${JSON.stringify(sc.logs.filter((l) => l.includes('loop guard')))}`
        );

        // Z is completed by the next cycle (which the guard defers it to).
        const zFinal = sc.finalBeadsById.get(zId);
        check(
            zFinal && zFinal.status === 'closed',
            `Expected ${zId} to end up closed (cycle 2 develop/review completed it), got: ${zFinal ? zFinal.status : '(bead not found)'}`
        );
    });
});

test('mock sprint: control -- reopenIds WITHOUT replanIds keeps normal round behavior (doer re-dispatched same cycle, no scoped replan)', async () => {
    await withScenarioMarkers('scoped replan control (no replanIds)', async () => {
        console.log('Running mock sprint scenario (scoped replan control, no replanIds)...');

        const ctrl = await runDevelopLoopScenario('replansctrl', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Reopen target Y' },
            ],
            // Same reopenIds shape as the scoped-replan scenario, but
            // deliberately WITHOUT replanIds -- today's normal round behavior
            // must be preserved: Y is re-dispatched to a doer again in round 2
            // of the SAME cycle, with no scoped planner/plan-review pass.
            reviewerHandler: async ({ tempDir, runCmd, epicBead, reviewRound: rRound }) => {
                if (rRound === 1) {
                    // The doer already closed Y before this review round runs,
                    // so a default (open-only) `bd list` would miss it -- use
                    // --all like mock-sprint-develop-reopen.test.mjs does.
                    const list = JSON.parse((await runCmd(`bd list --parent ${epicBead.id} --all --json`, tempDir)).stdout || '[]');
                    const y = list.find((b) => b.title.includes('Reopen target Y'));
                    return {
                        content: [{
                            text: JSON.stringify({
                                verdict: 'CHANGES_NEEDED',
                                notes: `${y.id} needs a small fix, please address.`,
                                reopenIds: [y.id],
                                newTasks: [],
                            }),
                        }],
                    };
                }
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'APPROVED',
                            notes: 'Y looks good now.',
                            reopenIds: [],
                            newTasks: [],
                        }),
                    }],
                };
            },
        });

        check(!ctrl.error, `Expected engine.executeFile() to resolve, got error: ${ctrl.error ? ctrl.error.constructor.name + ': ' + ctrl.error.message : 'none'}`);

        const yId = ctrl.tasks.find((t) => t.title.includes('Reopen target Y')).id;

        // Normal behavior: doer dispatched TWICE this (single) cycle -- once
        // per round -- since replanIds was never populated, so the scoped
        // replan path is a no-op.
        const doerDispatches = ctrl.dispatched.filter((d) => d.agent === 'doer');
        check(
            doerDispatches.length === 2,
            `Expected exactly 2 doer dispatches in the control scenario (normal round behavior, no scoped replan), got ${doerDispatches.length}`
        );
        check(
            doerDispatches.every((d) => d.prompt.includes(yId)),
            `Expected both doer dispatches to include ${yId}, prompts: ${JSON.stringify(doerDispatches.map((d) => d.prompt))}`
        );

        // No scoped planner/plan-review dispatch, and no scoped-replan or
        // loop-guard log lines in the control scenario.
        check(
            !ctrl.dispatched.some((d) => (d.agent === 'planner' || d.agent === 'plan-reviewer') && d.prompt.includes('SCOPED IN-CYCLE REPLAN')),
            `Did NOT expect any scoped in-cycle-replan dispatch in the control scenario, dispatched: ${JSON.stringify(ctrl.dispatched.map((d) => d.agent))}`
        );
        check(
            !ctrl.logs.some((l) => l.includes('[fleet-sprint] in-cycle scoped replan') || l.includes('[fleet-sprint] replan loop guard')),
            `Did NOT expect a scoped-replan/loop-guard log line in the control scenario, logs: ${JSON.stringify(ctrl.logs.filter((l) => l.includes('replan')))}`
        );

        const yFinal = ctrl.finalBeadsById.get(yId);
        check(
            yFinal && yFinal.status === 'closed',
            `Expected ${yId} to end up closed, got: ${yFinal ? yFinal.status : '(bead not found)'}`
        );
    });
});
