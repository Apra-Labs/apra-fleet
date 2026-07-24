import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-eft.71.3 -- mock-sprint coverage for apra-fleet-eft.71.1's
// no-goalpost-moving contract + apra-fleet-eft.71.2's engine change (prior-
// round plan-review verdicts now ride along in the plan-reviewer dispatch
// input for round N>1 of a cycle).
//
// Reproduces the exact shape from the apra-fleet-eft.71 bug report (run 21,
// Plan C2): round 2 (R2) of the plan-review loop offers a specific
// resolution X ("link the legacy bead as blocked-by the successor bead") as
// EXPLICITLY ACCEPTABLE. Round 3's planner implements X exactly as stated.
// The fixed engine must feed R2's verdict into R3's plan-reviewer dispatch
// input, and R3's plan-reviewer (this mock, standing in for a contract-
// obeying real reviewer) must return APPROVED rather than re-litigating with
// a different demand (e.g. "close as superseded" instead of the link R2
// already blessed) -- the bug that aborted run 21's whole sprint.
//
// This mock plan-reviewer is intentionally evidence-based, not a scripted
// round-number switch: round 3 only approves if the dependency edge X
// actually named was actually created (queried live against the mock's real
// bd tempDir) -- so this test also verifies the R3 planner really
// implemented X, not merely that 3 rounds elapsed.
// =============================================================================

test('mock sprint: R2 names acceptable alternative X, R3 implements X, R3 plan-reviewer APPROVEs (no re-litigation)', async () => {
    await withScenarioMarkers('plan-review acceptable-alternative binds across rounds', async () => {
        console.log('Running mock sprint scenario (R2 acceptable-alternative binds at R3)...');

        let plannerCallCount = 0;
        const plannerHandler = async ({ tempDir, runCmd, epicBead }) => {
            plannerCallCount++;
            // Only the THIRD plan-phase planner dispatch (round 3, following
            // R2's verdict naming resolution X as acceptable) implements X:
            // link the legacy bead as blocked-by the successor bead. Rounds
            // 1-2 are plain acknowledgement passes -- deliberately do NOT
            // implement anything early, so a pass here can only be explained
            // by the planner having actually acted on R2's specific verdict.
            if (plannerCallCount === 3) {
                const list = JSON.parse((await runCmd(`bd list --parent ${epicBead.id} --json`, tempDir)).stdout || '[]');
                const legacy = list.find((b) => b.title.includes('Legacy'));
                const successor = list.find((b) => b.title.includes('Successor'));
                if (legacy && successor) {
                    await runCmd(`bd dep add ${legacy.id} ${successor.id}`, tempDir);
                }
            }
            return { content: [{ text: 'Planner pass complete; addressed the plan-reviewer feedback from the prior round.' }] };
        };

        const planReviewerHandler = async ({ tempDir, runCmd, epicBead, planRound }) => {
            const list = JSON.parse((await runCmd(`bd list --parent ${epicBead.id} --json`, tempDir)).stdout || '[]');
            const legacy = list.find((b) => b.title.includes('Legacy'));
            const successor = list.find((b) => b.title.includes('Successor'));
            const taskAssignments = [
                { id: legacy.id, bucket: 'S', model: 'standard' },
                { id: successor.id, bucket: 'S', model: 'standard' },
            ];

            if (planRound === 1) {
                // R1: flags the duplication, no resolution offered yet.
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'CHANGES_NEEDED',
                            notes: `${legacy.id} duplicates work now handled by ${successor.id}; this must be resolved before approval.`,
                            taskAssignments,
                        }),
                    }],
                };
            }

            if (planRound === 2) {
                // R2: explicitly names resolution X as ACCEPTABLE.
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'CHANGES_NEEDED',
                            notes: `Acceptable resolution: link ${legacy.id} as blocked-by ${successor.id} (that exact edge). If implemented exactly as stated, this criterion is satisfied.`,
                            taskAssignments,
                        }),
                    }],
                };
            }

            // R3: the no-goalpost-moving rule -- since the planner implemented
            // X exactly as R2 named it acceptable, this round MUST accept it
            // rather than re-litigate with a different demand. Verified here
            // against the mock's OWN real bd state (not hardcoded), so this
            // branch genuinely depends on the planner having acted.
            const legacyFresh = list.find((b) => b.id === legacy.id);
            const hasAcceptedLink = (legacyFresh.dependencies || []).some(
                (d) => d.type === 'blocks' && d.depends_on_id === successor.id
            );
            if (hasAcceptedLink) {
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'APPROVED',
                            notes: `${legacy.id} is now blocked-by ${successor.id} exactly as accepted in the prior round. Approved.`,
                            taskAssignments,
                        }),
                    }],
                };
            }
            // Fail-safe (should not trigger in this scenario): if X was
            // somehow not implemented, do NOT invent a new demand -- restate
            // the SAME accepted resolution rather than moving the goalposts.
            return {
                content: [{
                    text: JSON.stringify({
                        verdict: 'CHANGES_NEEDED',
                        notes: `Acceptable resolution: link ${legacy.id} as blocked-by ${successor.id} (that exact edge). If implemented exactly as stated, this criterion is satisfied.`,
                        taskAssignments,
                    }),
                }],
            };
        };

        const scoped = await runDevelopLoopScenario('planrelitigate', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Legacy import handling' },
                { title: 'Task: Successor handling supersedes legacy' },
            ],
            plannerHandler,
            planReviewerHandler,
        });

        check(!scoped.error, `Expected engine.executeFile() to resolve (plan eventually APPROVED), got error: ${scoped.error ? scoped.error.constructor.name + ': ' + scoped.error.message : 'none'}`);

        const legacyId = scoped.tasks.find((t) => t.title.includes('Legacy')).id;
        const successorId = scoped.tasks.find((t) => t.title.includes('Successor')).id;

        // Exactly 3 plan-reviewer dispatches: R1 (flags issue), R2 (names X
        // acceptable), R3 (X implemented -> APPROVED).
        const planReviewerDispatches = scoped.dispatched.filter((d) => d.agent === 'plan-reviewer');
        check(
            planReviewerDispatches.length === 3,
            `Expected exactly 3 plan-reviewer dispatches, got ${planReviewerDispatches.length}`
        );

        // R3 (the plan reviewer dispatch that runs AFTER R2's verdict) must
        // carry R2's prior verdict as its dispatch input -- both round 1's and
        // round 2's verdicts (per buildPlanReviewerPrompt: "most recent
        // last"), labeled per-round so the reviewer can bind against them.
        const r3Prompt = planReviewerDispatches[2].prompt;
        check(
            r3Prompt.includes('plan-reviewer.round-1-verdict'),
            `Expected the R3 plan-reviewer dispatch prompt to carry round 1's verdict block, got:\n${r3Prompt}`
        );
        check(
            r3Prompt.includes('plan-reviewer.round-2-verdict'),
            `Expected the R3 plan-reviewer dispatch prompt to carry round 2's verdict block, got:\n${r3Prompt}`
        );
        check(
            r3Prompt.includes(`Acceptable resolution: link ${legacyId} as blocked-by ${successorId}`),
            `Expected the R3 plan-reviewer dispatch prompt to carry R2's exact acceptable-alternative notes text naming ${legacyId}/${successorId}, got:\n${r3Prompt}`
        );
        check(
            /no-goalpost-moving rule/.test(r3Prompt),
            `Expected the R3 plan-reviewer dispatch prompt to invoke the no-goalpost-moving rule around the prior-round verdicts, got:\n${r3Prompt}`
        );
        // R2's own dispatch prompt (round 2) must NOT yet contain a
        // round-2-verdict block (that verdict doesn't exist until AFTER R2
        // itself runs) -- only round 1's, confirming verdicts are recorded
        // strictly after use, never self-referentially.
        const r2Prompt = planReviewerDispatches[1].prompt;
        check(
            r2Prompt.includes('plan-reviewer.round-1-verdict') && !r2Prompt.includes('plan-reviewer.round-2-verdict'),
            `Expected R2's dispatch prompt to carry only round 1's verdict block (not its own not-yet-returned round 2 verdict), got:\n${r2Prompt}`
        );

        // R3's plan-reviewer (this mock) actually returned APPROVED -- not a
        // different re-litigated demand -- confirmed via the engine's own
        // "Plan Reviewer: <verdict json>" log line for that round.
        const planReviewerLogs = scoped.logs.filter((l) => l.startsWith('Plan Reviewer: '));
        check(
            planReviewerLogs.length === 3,
            `Expected exactly 3 'Plan Reviewer: ...' log lines, got ${planReviewerLogs.length}: ${JSON.stringify(planReviewerLogs)}`
        );
        check(
            planReviewerLogs[2].includes('"verdict":"APPROVED"'),
            `Expected R3's verdict log line to show APPROVED, got: ${planReviewerLogs[2]}`
        );

        // The R3 planner genuinely implemented X (not merely that round 3
        // happened): the legacy bead carries a real 'blocks' dependency on
        // the successor bead in final beads state.
        const legacyFinal = scoped.finalBeadsById.get(legacyId);
        check(
            legacyFinal && (legacyFinal.dependencies || []).some((d) => d.type === 'blocks' && d.depends_on_id === successorId),
            `Expected the legacy bead ${legacyId} to carry a 'blocks' dependency on ${successorId} in final beads state, got: ${JSON.stringify(legacyFinal ? legacyFinal.dependencies : null)}`
        );

        // No plan-cap deferral/abort path was taken (this is a genuine
        // APPROVED, not a confined-findings deferral) -- no bead ever
        // deferred.
        check(
            !scoped.commandLog.some((c) => c.includes('--status=deferred')),
            `Expected no plan-cap deferral on a genuine APPROVED, commandLog: ${JSON.stringify(scoped.commandLog)}`
        );

        // Develop proceeded normally past the approved plan: both beads were
        // dispatched to (and closed by) a doer.
        const doerDispatches = scoped.dispatched.filter((d) => d.agent === 'doer');
        check(doerDispatches.length > 0, 'Expected at least one doer dispatch once the plan was approved');
        const successorFinal = scoped.finalBeadsById.get(successorId);
        check(
            successorFinal && successorFinal.status === 'closed',
            `Expected the successor bead ${successorId} to be closed by Develop, got: ${successorFinal ? successorFinal.status : '(bead not found)'}`
        );
    });
});
