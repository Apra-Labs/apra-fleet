import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkPath } from '../auto-sprint/dispatch-safety-guard.mjs';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNNER_PATH = path.join(__dirname, '../auto-sprint/runner.js');

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-eft.67.3 -- mock-sprint coverage for apra-fleet-eft.67.2's replan
// short-circuit fix.
//
// Scenario: a review round returns reopenIds=[X] + replanIds=[X], where X is
// the ONLY still-ready bead. The fix (runner.js's Develop/Review loop) must
// then skip all remaining develop/review rounds THIS cycle -- re-dispatching
// X to a doer again is a predictably wasted round, since X's acceptance
// criteria are themselves flagged as defective and can only be corrected by
// the next cycle's planner. Assert:
//   - no further doer dispatch happens this cycle (dev loop stops at 1 round)
//   - the '[auto-sprint] replan short-circuit' log line appears, naming X
//   - Cycle Eval runs and the NEXT cycle's planner dispatch happens
//
// Control: identical reopenIds but WITHOUT replanIds -- today's normal round
// behavior must be preserved exactly (X is re-dispatched to a doer again in
// round 2 of the SAME cycle).
// =============================================================================

test('mock sprint: replan short-circuit skips remaining develop/review rounds and hands off to the next cycle', async () => {
    await withScenarioMarkers('replan short-circuit (single ready bead)', async () => {
        console.log('Running mock sprint scenario (replan short-circuit)...');

        const sc = await runDevelopLoopScenario('replansc', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Replan target X' },
            ],
            maxCycles: 2,
            // First (and only) review round this cycle: reopen X AND flag it
            // as replan-needed. Every subsequent review round (cycle 2)
            // approves outright, so the sprint completes cleanly once the
            // next cycle's planner/doer/reviewer have run.
            reviewerHandler: async ({ tempDir, runCmd, epicBead, reviewRound: rRound }) => {
                if (rRound === 1) {
                    // The doer already closed X before this review round
                    // runs, so a default (open-only) `bd list` would miss it
                    // -- use --all like mock-sprint-develop-reopen.test.mjs does.
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
                            notes: 'X was re-scoped by the planner and is now implemented correctly.',
                            reopenIds: [],
                            newTasks: [],
                        }),
                    }],
                };
            },
        });

        check(!sc.error, `Expected engine.executeFile() to resolve, got error: ${sc.error ? sc.error.constructor.name + ': ' + sc.error.message : 'none'}`);

        const xId = sc.tasks.find((t) => t.title.includes('Replan target X')).id;

        // Exactly ONE doer dispatch happened before the short-circuit fired
        // (i.e. no SECOND round this cycle re-dispatched X to a doer). Find
        // the second (cycle-2) planner dispatch and confirm only one doer
        // dispatch precedes it.
        const plannerIdxs = sc.dispatched
            .map((d, i) => ({ d, i }))
            .filter(({ d }) => d.agent === 'planner')
            .map(({ i }) => i);
        check(
            plannerIdxs.length >= 2,
            `Expected at least 2 fresh planner dispatches (cycle 1 + cycle 2), got ${plannerIdxs.length}: ${JSON.stringify(sc.dispatched.map((d) => d.agent))}`
        );
        const secondPlannerIdx = plannerIdxs[1];
        const doerDispatchesBeforeCycle2Planner = sc.dispatched
            .slice(0, secondPlannerIdx)
            .filter((d) => d.agent === 'doer');
        check(
            doerDispatchesBeforeCycle2Planner.length === 1,
            `Expected exactly 1 doer dispatch in cycle 1 (short-circuit skips the remaining rounds), got ${doerDispatchesBeforeCycle2Planner.length}: ${JSON.stringify(sc.dispatched.map((d) => d.agent))}`
        );

        // The '[auto-sprint] replan short-circuit' log line fired, naming X.
        check(
            sc.logs.some((l) => l.includes('[auto-sprint] replan short-circuit') && l.includes(xId)),
            `Expected a '[auto-sprint] replan short-circuit' log line naming ${xId}, logs: ${JSON.stringify(sc.logs.filter((l) => l.includes('replan short-circuit')))}`
        );

        // The next cycle's planner dispatch happened (asserted above via
        // plannerIdxs.length >= 2) and the sprint went on to actually
        // complete X in cycle 2.
        const xFinal = sc.finalBeadsById.get(xId);
        check(
            xFinal && xFinal.status === 'closed',
            `Expected ${xId} to end up closed (cycle 2 develop/review completed it), got: ${xFinal ? xFinal.status : '(bead not found)'}`
        );

        // dispatch-safety-guard invariant (bead acceptance: "dispatch-safety-
        // guard count unchanged"): this test exercises no NEW command()/
        // agent() call sites in runner.js (the fix under test, eft.67.2, was
        // pinned by its own mock-sprint coverage) -- confirm every call site
        // still passes member_name/member_id.
        const { violations } = checkPath(RUNNER_PATH);
        check(violations.length === 0, `Expected zero dispatch-safety-guard violations in runner.js, got: ${JSON.stringify(violations)}`);
    });
});

test('mock sprint: control -- reopenIds WITHOUT replanIds keeps normal round behavior (doer re-dispatched same cycle)', async () => {
    await withScenarioMarkers('replan short-circuit control (no replanIds)', async () => {
        console.log('Running mock sprint scenario (replan short-circuit control, no replanIds)...');

        const ctrl = await runDevelopLoopScenario('replansctrl', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Reopen target Y' },
            ],
            // Same reopenIds shape as the short-circuit scenario, but
            // deliberately WITHOUT replanIds -- today's normal round
            // behavior must be preserved: Y is re-dispatched to a doer
            // again in round 2 of the SAME cycle.
            reviewerHandler: async ({ tempDir, runCmd, epicBead, reviewRound: rRound }) => {
                if (rRound === 1) {
                    // The doer already closed Y before this review round
                    // runs, so a default (open-only) `bd list` would miss it
                    // -- use --all like mock-sprint-develop-reopen.test.mjs does.
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
        // per round -- since replanIds was never populated, so the
        // short-circuit filter is a no-op.
        const doerDispatches = ctrl.dispatched.filter((d) => d.agent === 'doer');
        check(
            doerDispatches.length === 2,
            `Expected exactly 2 doer dispatches in the control scenario (normal round behavior, no short-circuit), got ${doerDispatches.length}`
        );
        check(
            doerDispatches.every((d) => d.prompt.includes(yId)),
            `Expected both doer dispatches to include ${yId}, prompts: ${JSON.stringify(doerDispatches.map((d) => d.prompt))}`
        );

        // No short-circuit log line in the control scenario.
        check(
            !ctrl.logs.some((l) => l.includes('[auto-sprint] replan short-circuit')),
            `Did NOT expect a '[auto-sprint] replan short-circuit' log line in the control scenario, logs: ${JSON.stringify(ctrl.logs.filter((l) => l.includes('replan')))}`
        );

        const yFinal = ctrl.finalBeadsById.get(yId);
        check(
            yFinal && yFinal.status === 'closed',
            `Expected ${yId} to end up closed, got: ${yFinal ? yFinal.status : '(bead not found)'}`
        );
    });
});
