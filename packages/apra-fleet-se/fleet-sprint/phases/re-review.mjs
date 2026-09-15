// =============================================================================
// PHASE MODULE: Re-Review (apra-fleet-3swo.6.8).
//
// The EIGHTH of runSprintCycle's twelve phase() boundaries -- the ONE fresh
// review Cycle Evaluation dispatches when the goal-priority bead count already
// reads 0 but no review ran THIS cycle (the Develop/Review loop was skipped
// because there were no ready beads). Without it the exit decision would rest
// on a verdict from an earlier cycle, or the loop would spin with no way to
// confirm completion. Like ./review.mjs it then has the ORCHESTRATOR -- never
// the LLM -- apply every structured transition the verdict asks for (guarded
// reopens, validated newTask creation) before D-pushing the beads it just
// mutated. Moved verbatim out of runner.js: every prompt, log line, dispatch
// option, validation branch and sync call is byte-identical to the inline
// version, so the golden transcript is unchanged. Move-only, no behaviour
// change.
//
// WHERE THIS PHASE STARTS AND STOPS. It is the body of Cycle Evaluation's
// `if (openAtGoal.length === 0 && !reviewedThisCycle)` branch, and nothing
// else -- from its own phase() call to the post-mutation
// `gitSync.syncBeadsAfter(...)` that closes it. The `if` itself stays in
// runner.js because it is built out of Cycle Evaluation's own freshly-read
// counts, exactly as ./deploy.mjs's `if (hasDeploy)` probe and ./replan.mjs's
// `if (eligibleReplan.length > 0)` filter stayed behind; the
// stillOpenVerifyIds exit gate that follows it belongs to Cycle Evaluation,
// not to this phase.
//
// THE GUARDED VERDICT PATH IS NOT OPTIONAL. apra-fleet-3swo.4.7 brought this
// site's reopenIds under the SHARED applyGuardedReopens() path from
// ../beads-transitions.mjs -- it was previously the only one of the three
// verdict sites applying reopens with NO goal-scope guard, so a below-goal
// DEFERRED bead named here was pulled back into a sprint that no longer
// targeted it. That import, and the Re-review reopenIds site it wraps, moved
// here INTACT: this module must never grow a private reopen loop or a private
// allowlist of its own (pinned by
// test/beads-transitions-extraction.test.mjs, which now scans runner.js,
// phases/review.mjs and this file as separate sources and asserts which one
// owns which of the three sites).
//
// EXPLICIT STATE, NOT A CLOSURE -- AND WHY THREE VALUES COME BACK. Same shape
// as ./review.mjs, whose newTasks half this phase mirrors line for line.
// `rejectedNewTasks` is an array this phase PUSHES to, so passing the array
// itself is exactly equivalent to the closure it replaces. The three genuinely
// REASSIGNED values -- `lastReviewVerdict` and `reviewedThisCycle` (which the
// exit decision immediately below this phase's call site reads) and
// `pendingRejectedNewTasks` (which trackRejectedNewTaskForResurfacing()/
// clearResubmittedNewTask() return a NEW list from every time) -- are passed
// in and returned instead.
//
// WHY SOME HELPERS ARE INJECTED RATHER THAN IMPORTED. dispatchReview,
// bdListScoped, goalMax, recordReopen, childIdAllocator and sprintMutexId are
// runSprintCycle-scoped locals, so there is nothing to import. computeChildFloor,
// createChildBeadWithAllocatedId, trackRejectedNewTaskForResurfacing and
// clearResubmittedNewTask are exported BY runner.js; importing them here would
// make phases/re-review.mjs <-> runner.js a circular pair for the sake of four
// helpers, so they come through the state argument instead -- the same rule
// ./review.mjs's header states. The dependencies that live in real sibling
// modules (applyGuardedReopens from ../beads-transitions.mjs, validateNewTask/
// appendRejectedFindingToParentNotes/persistNewTaskBestEffort from ../abort.mjs)
// are imported directly.
//
// GUARD COVERAGE: registered as 'phases/re-review.mjs' in
// ../guarded-modules.mjs. It took NO command() call site out of runner.js --
// its reopen and newTask writes reach bd through injected helpers that issue
// their own command() calls in the modules that already own them, exactly as
// ./review.mjs's do -- and NO dispatchRole() site either: the reviewer ladder
// runs through runner.js's shared dispatchReview() helper, which the per-round
// Review and Final Review phases call too. Its only repo-side effect is the
// shared gitSync bracket at the end. Both zero baselines are pinned rather
// than assumed, so a future edit that reaches for a raw command() here turns
// red instead of landing on an unguarded site.
// =============================================================================

import { applyGuardedReopens } from '../beads-transitions.mjs';
import {
    validateNewTask, appendRejectedFindingToParentNotes, persistNewTaskBestEffort,
} from '../abort.mjs';

/**
 * Runs the Re-Review phase: one fresh review of the CURRENT state, plus the
 * orchestrator-applied transitions its verdict asks for.
 *
 * @param {object} state Explicit phase state; see this file's header.
 * @returns {Promise<{
 *   lastReviewVerdict: string|undefined,
 *   reviewedThisCycle: boolean,
 *   pendingRejectedNewTasks: object[],
 * }>} The three REASSIGNED values described in the header. Every other output
 *   of this phase is an in-place mutation of an array the caller still holds.
 */
export async function runReReviewPhase({
    // Presentation + dispatch seams.
    phase,
    log,
    command,
    // Sprint identity/config.
    cycle,
    validated,
    targetIssues,
    orchestratorMember,
    // The git/beads sync bracket this phase's post-mutation D-push goes
    // through.
    gitSync,
    // Mutated in place; never reassigned by this phase (see header).
    rejectedNewTasks,
    // Reassigned, so passed in and returned (see header).
    lastReviewVerdict,
    reviewedThisCycle,
    pendingRejectedNewTasks,
    // runSprintCycle-scoped locals and runner.js-exported helpers, injected
    // rather than imported (see header).
    dispatchReview,
    bdListScoped,
    goalMax,
    recordReopen,
    childIdAllocator,
    sprintMutexId,
    computeChildFloor,
    createChildBeadWithAllocatedId,
    trackRejectedNewTaskForResurfacing,
    clearResubmittedNewTask,
}) {
    phase(`Re-Review C${cycle}`);
    log(
        `Cycle ${cycle}: 0 open goal-priority bead(s) but no review ran THIS cycle (Develop/Review ` +
        `loop was skipped) -- dispatching a fresh re-review of the current state before deciding ` +
        `whether to exit, rather than trusting a verdict from an earlier cycle.`
    );
    const reReviewScope = await bdListScoped('--json');
    // apra-fleet-jfo.3: this call passed beadIds: [] unconditionally,
    // which buildReviewerPrompt renders as "Review the work just done
    // for the following bead id(s): ." -- no ids to review. The
    // reviewer correctly treats that as missing required input and
    // refuses (a CHANGES_NEEDED-shaped response with empty
    // reopenIds/newTasks), which after one retry throws
    // ReviewerContractViolationError and aborts the WHOLE sprint --
    // hit live 2026-08-02 on apra-fleet-l7n-style sprints (Deploy
    // fails on cycle 1 -> IntegTest skipped -> openAtGoal reads 0 ->
    // this branch -> crash, before the sprint ever gets a real
    // chance). The sprint's own root issue id(s) are always a valid,
    // in-scope target for "review the current state" -- pass them as
    // beadIds so the reviewer has something concrete to ground its
    // verdict in; acceptanceCriteriaJson still carries the full scope
    // for context.
    const reReviewVerdict = await dispatchReview({ beadIds: targetIssues, acceptanceCriteriaJson: JSON.stringify(reReviewScope) });
    lastReviewVerdict = reReviewVerdict.verdict;
    reviewedThisCycle = true;

    // Same orchestrator-applies-the-transition contract as the
    // regular Develop/Review dispatch above: a re-review that
    // reopens beads or proposes follow-up work must have those
    // effects actually applied, not silently discarded just because
    // this dispatch happened outside the normal Develop loop.
    //
    // apra-fleet-3swo.4.7: this site used to apply reopenIds with NO
    // goal-scope guard -- the only one of the three verdict sites that
    // did. It now goes through the same applyGuardedReopens() path as
    // the per-round reviewer and Final Review, so a below-goal
    // DEFERRED bead named here is skipped with the identical
    // "deferred scope, not reopened" outcome instead of being pulled
    // back into a sprint that no longer targets it.
    await applyGuardedReopens({
        entries: reReviewVerdict.reopenIds,
        bdListScoped, goalMax, goal: validated.goal, log, command,
        member: orchestratorMember,
        logPrefix: 'Re-review reopenIds',
        buildReopenCommand: ({ id }) => ({
            cmd: `bd update ${id} --status=open`,
            label: `Reopen ${id} per re-review verdict`,
        }),
        // Track per-bead reopen counts for reopen-thrash detection.
        onReopened: ({ id }) => recordReopen(id),
    });
    for (const newTask of reReviewVerdict.newTasks) {
        const validation = validateNewTask(newTask);
        if (!validation.ok) {
            log(`Re-review newTasks: REJECTED (not sent to bd create) -- ${validation.reason}`);
            rejectedNewTasks.push({ cycle, reason: validation.reason, raw: newTask });
            // Track it for resurfacing into the NEXT planning-phase
            // dispatch too -- see trackRejectedNewTaskForResurfacing()'s
            // doc comment.
            pendingRejectedNewTasks = trackRejectedNewTaskForResurfacing(pendingRejectedNewTasks, {
                title: newTask && newTask.title, description: newTask && newTask.description,
                reason: validation.reason, cycle,
            });
            // Never let a rejected finding vanish -- persist it verbatim
            // to the parent bead's notes as a fallback (non-fatal;
            // degrades to the run log).
            try {
                await appendRejectedFindingToParentNotes({
                    command, member: orchestratorMember, parentId: targetIssues[0],
                    newTask, reason: validation.reason, cycle, log,
                });
            } catch (noteErr) {
                log(`[fleet-sprint] rejected-finding notes fallback FAILED (non-fatal): ${noteErr.message}; finding preserved VERBATIM in this run log: ${JSON.stringify(newTask)}`);
            }
            continue;
        }
        const { title, description, priority } = validation;
        // A bead can only have one parent -- when multiple sprint-root
        // target issues are given, file follow-up work under the first
        // one. `--parent` never accepts a comma-joined list; passing one
        // silently creates an unparented/misparented bead.
        //
        // Same allocator-minted id path as the Develop/Review newTasks
        // site above -- concurrent sprints must never mint the same child
        // id under a shared parent.
        const persisted = await persistNewTaskBestEffort({
            command, member: orchestratorMember, parentId: targetIssues[0],
            newTask, cycle, log, stage: 're-review',
            createFn: async () => {
                const floor = await computeChildFloor({ command, member: orchestratorMember, parentId: targetIssues[0] });
                await createChildBeadWithAllocatedId({
                    command, allocator: childIdAllocator, member: orchestratorMember,
                    title, description, priority, parentId: targetIssues[0],
                    sprintId: sprintMutexId, floor, log,
                    label: `Create follow-up task from re-review newTasks: ${title}`,
                });
            },
        });
        // Same resurface-list bookkeeping (title+description) as the
        // Develop/Review newTasks site above.
        if (persisted) {
            pendingRejectedNewTasks = clearResubmittedNewTask(pendingRejectedNewTasks, { title, description });
        }
    }

    // D-push the orchestrator's applied re-review reopens/newTask
    // creates, same as the Develop/Review transition site above.
    await gitSync.syncBeadsAfter(orchestratorMember, { pushBeads: true });

    return { lastReviewVerdict, reviewedThisCycle, pendingRejectedNewTasks };
}
