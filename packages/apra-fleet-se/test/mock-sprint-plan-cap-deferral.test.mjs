import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { SprintPlanRejectedError } from '../auto-sprint/errors.mjs';
import { checkPath } from '../auto-sprint/dispatch-safety-guard.mjs';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNNER_PATH = path.join(__dirname, '../auto-sprint/runner.js');

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-eft.72.2 -- mock-sprint coverage for apra-fleet-eft.72.1's
// plan-cap-exhaustion deferral fix.
//
// Prior behavior (the bug, apra-fleet-eft.72): 3 rounds of plan-review
// CHANGES_NEEDED with no APPROVED ever unconditionally aborted the WHOLE
// sprint via SprintPlanRejectedError, even when the plan-reviewer's own
// findings named only ONE contested bead out of a much larger, otherwise
// clean plan.
//
// Fixed behavior (runner.js, apra-fleet-eft.72.1): when the last verdict's
// `notes` name a STRICT SUBSET of the plan's taskAssignments ids
// (extractContestedBeadIds()), the engine defers just those bead(s)
// (`bd update <id> --status=deferred` + the finding attached as a note),
// logs `[auto-sprint] plan-cap deferral: ...` naming them, and proceeds to
// Develop with the remaining approved task set. It still aborts exactly as
// before when the contested set spans the WHOLE plan (or ready set would go
// empty).
//
// Scenario A below drives a genuine CHANGES_NEEDED-every-round plan-reviewer
// mock (via the new `planReviewerHandler` harness hook -- the fixed
// `planReviewerMode` string switch can't express "notes name exactly one of
// N real created bead ids", so this bead's acceptance criteria required a
// handler with access to the actual bead ids `setupMinimal` created).
// Scenario B is the control: an otherwise-identical mock whose findings name
// EVERY taskAssignments id -- the whole plan -- and must still abort, unchanged.
// =============================================================================

test('mock sprint: plan-cap exhaustion confined to one bead defers it and develops the remainder', async () => {
    await withScenarioMarkers('plan-cap deferral (single contested bead)', async () => {
        console.log('Running mock sprint scenario (plan-cap exhaustion, one contested bead)...');

        const scoped = await runDevelopLoopScenario('plancapscoped', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Contested bookkeeping bead' },
                { title: 'Task: Clean feature bead' },
            ],
            // Every plan-review round returns schema-valid CHANGES_NEEDED
            // whose `notes` name ONLY the contested bead's id (never the
            // clean bead's id) -- confined-findings shape, every round,
            // exhausting all 3 plan rounds with no APPROVED.
            planReviewerHandler: async ({ tempDir, runCmd, epicBead }) => {
                const list = JSON.parse((await runCmd(`bd list --parent ${epicBead.id} --json`, tempDir)).stdout || '[]');
                const contested = list.find((b) => b.title.includes('Contested'));
                const clean = list.find((b) => b.title.includes('Clean'));
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'CHANGES_NEEDED',
                            notes: `${contested.id} is missing a supersede link on its bookkeeping form -- fix that before this plan can be approved.`,
                            taskAssignments: [
                                { id: contested.id, bucket: 'S', model: 'standard' },
                                { id: clean.id, bucket: 'S', model: 'standard' },
                            ],
                        }),
                    }],
                };
            },
        });

        check(!scoped.error, `Expected engine.executeFile() to resolve (deferral, not abort), got error: ${scoped.error ? scoped.error.constructor.name + ': ' + scoped.error.message : 'none'}`);

        const contestedId = scoped.tasks.find((t) => t.title.includes('Contested')).id;
        const cleanId = scoped.tasks.find((t) => t.title.includes('Clean')).id;

        // Exactly 3 plan-reviewer rounds ran (the plan-cap) before the engine
        // gave up on ever getting an APPROVED and fell through to the
        // deferral path.
        const planReviewerDispatches = scoped.dispatched.filter((d) => d.agent === 'plan-reviewer');
        check(
            planReviewerDispatches.length === 3,
            `Expected exactly 3 plan-reviewer dispatches (plan-cap exhaustion), got ${planReviewerDispatches.length}`
        );

        // The contested bead was deferred (with the finding attached as a
        // note), NOT left open and NOT aborted.
        const contestedFinal = scoped.finalBeadsById.get(contestedId);
        check(
            contestedFinal && contestedFinal.status === 'deferred',
            `Expected contested bead ${contestedId} to be status=deferred, got: ${contestedFinal ? contestedFinal.status : '(bead not found)'}`
        );
        check(
            scoped.commandLog.includes(`bd update ${contestedId} --status=deferred`),
            `Expected 'bd update ${contestedId} --status=deferred' in commandLog: ${JSON.stringify(scoped.commandLog)}`
        );
        check(
            scoped.commandLog.some((c) => c.startsWith(`bd note ${contestedId} --file`)),
            `Expected the plan-cap deferral finding to be attached via 'bd note ${contestedId} --file ...': ${JSON.stringify(scoped.commandLog)}`
        );

        // The '[auto-sprint] plan-cap deferral' log line names the deferred
        // bead.
        check(
            scoped.logs.some((l) => l.includes('[auto-sprint] plan-cap deferral') && l.includes(contestedId)),
            `Expected a '[auto-sprint] plan-cap deferral' log line naming ${contestedId}, logs: ${JSON.stringify(scoped.logs.filter((l) => l.includes('plan-cap')))}`
        );

        // Develop proceeded with the remaining approved task set: the clean
        // bead was dispatched to (and closed by) a doer; the contested bead
        // -- deferred, therefore no longer ready -- was NEVER dispatched to
        // any doer. This is the "fails if partial-approval work is discarded"
        // guard: if the fix regresses to discarding the whole plan, there
        // will be zero doer dispatches here at all.
        const doerDispatches = scoped.dispatched.filter((d) => d.agent === 'doer');
        check(doerDispatches.length > 0, 'Expected at least one doer dispatch (Develop proceeding with the approved remainder), got zero');
        check(
            doerDispatches.every((d) => !d.prompt.includes(contestedId)),
            `Expected no doer dispatch to ever be assigned the deferred/contested bead ${contestedId}`
        );
        check(
            doerDispatches.some((d) => d.prompt.includes(cleanId)),
            `Expected the clean bead ${cleanId} to be dispatched to a doer`
        );
        const cleanFinal = scoped.finalBeadsById.get(cleanId);
        check(
            cleanFinal && cleanFinal.status === 'closed',
            `Expected the clean bead ${cleanId} to be closed by Develop, got: ${cleanFinal ? cleanFinal.status : '(bead not found)'}`
        );

        // dispatch-safety-guard invariant (bead acceptance: "dispatch-safety-
        // guard count unchanged"): this test exercises runner.js's plan-cap
        // deferral call sites (bd update --status=deferred / bd note --file)
        // added by apra-fleet-eft.72.1 -- confirm they (and every other
        // command()/agent() call site in runner.js) still pass member_name/
        // member_id. The fixed baseline COUNTS (37 command() / 18 agent())
        // are asserted by dispatch-safety-guard.test.mjs itself, which this
        // test-only change does not touch or need to bump.
        const { violations } = checkPath(RUNNER_PATH);
        check(violations.length === 0, `Expected zero dispatch-safety-guard violations in runner.js, got: ${JSON.stringify(violations)}`);
    });
});

test('mock sprint: control -- plan-cap exhaustion confined to the WHOLE plan still aborts the run', async () => {
    await withScenarioMarkers('plan-cap deferral (whole-plan control, still aborts)', async () => {
        console.log('Running mock sprint scenario (plan-cap exhaustion, whole plan contested -- control)...');

        const whole = await runDevelopLoopScenario('plancapwhole', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Bead A needs rework' },
                { title: 'Task: Bead B needs rework' },
            ],
            // Every plan-review round returns schema-valid CHANGES_NEEDED
            // whose `notes` name BOTH ids -- the contested set is the WHOLE
            // plan, not a subset -- so this must still abort exactly as
            // before apra-fleet-eft.72.1.
            planReviewerHandler: async ({ tempDir, runCmd, epicBead }) => {
                const list = JSON.parse((await runCmd(`bd list --parent ${epicBead.id} --json`, tempDir)).stdout || '[]');
                const a = list.find((b) => b.title.includes('Bead A'));
                const b = list.find((b) => b.title.includes('Bead B'));
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'CHANGES_NEEDED',
                            notes: `Both ${a.id} and ${b.id} need rework before this plan can be approved.`,
                            taskAssignments: [
                                { id: a.id, bucket: 'S', model: 'standard' },
                                { id: b.id, bucket: 'S', model: 'standard' },
                            ],
                        }),
                    }],
                };
            },
        });

        check(!!whole.error, 'Expected engine.executeFile() to reject (whole plan contested -> abort), but it resolved successfully');
        check(
            whole.error instanceof SprintPlanRejectedError,
            `Expected a SprintPlanRejectedError, got: ${whole.error ? whole.error.constructor.name + ': ' + whole.error.message : 'no error'}`
        );

        const planReviewerDispatches = whole.dispatched.filter((d) => d.agent === 'plan-reviewer');
        check(
            planReviewerDispatches.length === 3,
            `Expected exactly 3 plan-reviewer dispatches (plan-cap exhaustion) before aborting, got ${planReviewerDispatches.length}`
        );

        // The whole-plan-contested abort must behave exactly like today:
        // zero doer dispatches, and no bead ever deferred (there is no
        // "approved remainder" to defer into -- the plan is rejected outright).
        check(
            !whole.dispatched.some((d) => d.agent === 'doer'),
            `Expected zero doer dispatches when the whole plan is contested, got: ${JSON.stringify(whole.dispatched.map((d) => d.agent))}`
        );
        check(
            !whole.commandLog.some((c) => c.includes('--status=deferred')),
            `Expected no bead to be deferred on a whole-plan-contested abort, commandLog: ${JSON.stringify(whole.commandLog)}`
        );
    });
});
