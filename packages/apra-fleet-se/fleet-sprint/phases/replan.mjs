// =============================================================================
// PHASE MODULE: Replan (apra-fleet-3swo.6.7).
//
// The THIRD of runSprintCycle's twelve phase() boundaries -- the IN-CYCLE
// SCOPED REPLAN. It fires inside the Develop/Review round loop, on the FIRST
// round in which a still-ready bead carries a reviewer `replanIds` flag: the
// bead is reopened, but its ACCEPTANCE CRITERIA are themselves defective, so
// re-development cannot satisfy them. Rather than defer to the next cycle's
// full planner, this phase dispatches a planner pass scoped to exactly those
// beads' subtree plus a scoped plan-review of the result, then hands control
// back to the round loop so an APPROVED amendment is re-dispatched to a doer
// in this same cycle. Moved verbatim out of runner.js: every prompt, log
// line, dispatch option and sync call is byte-identical to the inline
// version, so the golden transcript is unchanged. Move-only, no behaviour
// change.
//
// WHERE THIS PHASE STARTS AND STOPS. It is the body of the round loop's
// `if (eligibleReplan.length > 0)` branch, and nothing else. The eligibility
// filter itself (`replanIds` minus `replannedThisCycle`) and the `continue`
// that restarts the round loop stay in runner.js: the filter decides whether
// this phase runs at all, and `continue` is loop control that cannot be
// expressed from inside a function. The "replan short-circuit" block that
// follows the branch is NOT part of this phase -- it emits no phase() of its
// own, it `break`s the round loop, and it computes `currentReady`, which is
// the Develop phase's input.
//
// WHY devRounds IS PASSED IN ALREADY INCREMENTED. `devRounds` is a round-loop
// local that this phase used to increment before labelling itself. A replan
// pass CONSUMES one develop round -- that is what stops a replan<->develop
// ping-pong outrunning the round cap -- so the increment stays in runner.js
// next to the loop variable it belongs to, and the incremented value arrives
// here purely to build the `Replan C{cycle} R{devRounds}` label. The order of
// the two statements is the only thing that changed and neither reads the
// other.
//
// EXPLICIT STATE, NOT A CLOSURE. The inline version read its inputs off the
// enclosing runSprintCycle/round-loop scope; they arrive as one explicit
// state argument now. Two of them -- `replanIds` and `replannedThisCycle` --
// are Sets this phase MUTATES IN PLACE (mark-before-attempt, then clear on an
// approved amendment). Passing the Set objects themselves is exactly
// equivalent to the closure they replace: neither binding is ever reassigned,
// only added to and deleted from, so runner.js observes every mutation
// without anything being threaded back. That is why this phase, unlike
// phases/plan.mjs, returns nothing.
//
// WHY NOTHING IS INJECTED HERE. Every dependency this phase has lives in a
// real sibling module (dispatchRole, the two prompt builders) or is a seam
// already passed to every phase, so -- unlike phases/plan.mjs -- there are no
// runner.js-exported helpers to route around a circular import.
//
// GUARD COVERAGE: registered as 'phases/replan.mjs' in ../guarded-modules.mjs.
// It carries NO command() call site of its own (its only repo-side effect is
// the shared gitSync bracket below) plus the two dispatchRole call sites for
// the scoped planner and scoped plan-reviewer ladders.
// =============================================================================

import { dispatchRole } from '../dispatch-role.mjs';
import { buildPlannerPrompt, buildPlanReviewerPrompt } from '../prompts.mjs';

/**
 * Runs the in-cycle scoped Replan phase for ONE develop round.
 *
 * @param {object} state Explicit phase state; see this file's header.
 * @returns {Promise<void>} Nothing: the only outputs are the in-place
 *   mutations of `replanIds`/`replannedThisCycle` described in the header,
 *   which runner.js's round loop reads back off its own bindings.
 */
export async function runReplanPhase({
    // Presentation + dispatch seams.
    phase,
    log,
    dispatchCtx,
    // Sprint identity/config.
    cycle,
    validated,
    targetIssues,
    requirementsContent,
    orchestratorMember,
    // The git/beads sync bracket the post-replan D-push goes through, plus the
    // dashboard refresh that follows it.
    gitSync,
    updateDashboard,
    // Per-cycle inputs.
    verifySetThisCycle,
    pendingRejectedNewTasks,
    // Per-round inputs. `devRounds` arrives already incremented (see header);
    // `replanIds` and `replannedThisCycle` are mutated in place.
    devRounds,
    eligibleReplan,
    replanIds,
    replannedThisCycle,
}) {
    const replanScopeIds = eligibleReplan.map((b) => b.id);
    phase(`Replan C${cycle} R${devRounds}`);
    log(
        `[fleet-sprint] in-cycle scoped replan: reviewer flagged bead(s) ${replanScopeIds.join(', ')} as ` +
        `having defective acceptance criteria -- dispatching a SCOPED planner + plan-review pass for their ` +
        `subtree THIS cycle (replan round R${devRounds}) instead of deferring to the next cycle, then ` +
        `resuming develop rounds.`
    );
    // Guard: mark up front so a SECOND replan flag for the same bead
    // this cycle is refused (see the reviewer fold-in below), whatever
    // the outcome of this pass.
    for (const id of replanScopeIds) replannedThisCycle.add(id);

    // --- Scoped planner pass ---
    // apra-fleet-3swo.5.3: the 'scoped-replan-planner' row of
    // role-policies.mjs, executed by dispatchRole. That row owns
    // the turn budget, the read-side pushBeads:true bracket (this
    // dispatch re-scopes the flagged subtree, so its beads writes
    // must be D-pushed), the client-side watchdog, the SINGLE
    // bounded attempt (no retry ladder of its own), the one auth
    // self-heal -- so the next cycle's planner, which this bead is
    // deferred to below, does not hit the identical wall -- and the
    // defer-to-next-cycle degrade, which never aborts the sprint.
    //
    // apra-fleet-zmqm: the policy's 'invalidate-beads-cache'
    // postResult step is the same reasoning as the main Planning
    // Loop's -- a successful dispatch mutated beads on its own
    // clone, and everything after it in this same "Replan
    // C{cycle} R{devRounds}" phase (the scoped plan-reviewer, the
    // resumed develop round) must see those mutations, not the
    // pre-replan snapshot taken when this phase() started. The
    // engine runs it only on success, exactly as this ladder did.
    const scopedPlannerOutcome = await dispatchRole(dispatchCtx, 'scoped-replan-planner', {
        prompt: buildPlannerPrompt({
            isDeltaCycle: true,
            targetIssues,
            goal: validated.goal,
            requirementsFile: validated.requirementsFile,
            requirementsContent,
            feedback: null,
            replanScope: replanScopeIds,
            // The scoped replan is a real planner dispatch like the
            // main Plan phase, so a pending rejected newTask must
            // resurface here too.
            rejectedNewTasksToResubmit: pendingRejectedNewTasks,
            verifyExcluded: verifySetThisCycle,
        }),
        label: 'Scoped Replan Plan (interactive)',
        roleLabel: 'Scoped Replan Plan',
    });
    const scopedPlannerOk = scopedPlannerOutcome.ok;
    if (scopedPlannerOk) {
        log(`Scoped Replan Planner: ${scopedPlannerOutcome.value}`);
    } else {
        log(`[fleet-sprint] in-cycle scoped replan: planner dispatch failed (${scopedPlannerOutcome.error.message}) -- leaving bead(s) ${replanScopeIds.join(', ')} flagged for the next cycle's planner.`);
    }
    // --- Scoped plan-review pass ---
    let scopedReplanApproved = false;
    if (scopedPlannerOk) {
        // The 'scoped-replan-plan-reviewer' row of
        // role-policies.mjs, executed by dispatchRole. That row
        // owns the turn budget, the read-side bracket, the single
        // bounded attempt, the auth self-heal (same rationale as
        // the scoped planner above: heal before deferring to the
        // next cycle's planner/plan-reviewer pass) and the
        // non-approval degrade -- a schema-repair-exhausted or
        // failed dispatch is a FAILED scoped review, never an
        // approval, and never an abort, the same discipline as the
        // main plan loop.
        const scopedReviewOutcome = await dispatchRole(dispatchCtx, 'scoped-replan-plan-reviewer', {
            prompt: buildPlanReviewerPrompt({ targetIssues, goal: validated.goal, replanScope: replanScopeIds, verifyExcluded: verifySetThisCycle }),
            label: 'Scoped Replan Review',
            roleLabel: 'Scoped Replan Review',
        });
        if (scopedReviewOutcome.ok) {
            log(`Scoped Replan Reviewer: ${JSON.stringify(scopedReviewOutcome.value)}`);
            // ONLY an explicit APPROVED approves.
            scopedReplanApproved = scopedReviewOutcome.value.verdict === 'APPROVED';
        } else {
            log(`[fleet-sprint] in-cycle scoped replan: plan-review dispatch failed (${scopedReviewOutcome.error.message}) -- treating the scoped replan as NOT approved; bead(s) ${replanScopeIds.join(', ')} handed to the next cycle's planner.`);
        }
    }

    if (scopedReplanApproved) {
        // The planner re-scoped the flagged bead(s) and the
        // plan-reviewer approved the amendment -- clear them from
        // replanIds so the NEXT loop iteration re-dispatches them to a
        // doer IN THIS SAME cycle.
        for (const id of replanScopeIds) replanIds.delete(id);
        log(`[fleet-sprint] in-cycle scoped replan: plan-review APPROVED the amendment for ${replanScopeIds.join(', ')} -- resuming develop rounds; the re-scoped bead(s) are re-dispatchable to a doer this cycle.`);
    } else {
        // Not approved (or the planner/reviewer dispatch failed): the
        // bead(s) stay in replanIds AND are now marked
        // replannedThisCycle, so the next iteration's exclude/break
        // short-circuit defers them to the next cycle's planner.
        log(`[fleet-sprint] in-cycle scoped replan: the scoped replan of ${replanScopeIds.join(', ')} was not approved -- they stay excluded from this cycle's develop rounds (deferred to the next cycle's planner).`);
    }

    // The scoped planner just MUTATED beads in this clone -- D-push
    // and refresh the dashboard before re-evaluating the loop top.
    // Routed through the single dolt-sync module's AFTER bracket
    // (apra-fleet-417.2.1); behavior is identical.
    await gitSync.syncBeadsAfter(orchestratorMember, { pushBeads: true });
    await updateDashboard();
}
