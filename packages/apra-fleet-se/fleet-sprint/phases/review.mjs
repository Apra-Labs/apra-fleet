// =============================================================================
// PHASE MODULE: Review (apra-fleet-3swo.6.5).
//
// The FIFTH of runSprintCycle's twelve phase() boundaries -- the per-round
// REVIEW of the work the Develop phase just produced: gather the round's
// acceptance criteria, dispatch the reviewer, and then have the ORCHESTRATOR
// (never the LLM) apply every structured transition the verdict asks for --
// guarded reopens, the in-cycle replan fold-in, and validated newTask
// creation -- before D-pushing the beads it just mutated. Moved verbatim out
// of runner.js: every prompt, log line, dispatch option, validation branch and
// sync call is byte-identical to the inline version, so the golden transcript
// is unchanged. Move-only, no behaviour change.
//
// WHERE THIS PHASE STARTS AND STOPS. It starts at its own phase() call and
// ends at the post-mutation `gitSync.syncBeadsAfter(...)` that closes the
// `assignedBeadIds.length > 0` branch. The `await updateDashboard()` and the
// `readyLeafBeads()` still-open check that follow it in runner.js are NOT part
// of this phase: they are the round loop's own continue/break decision (the
// second one `break`s, which cannot be expressed from inside a function), and
// they run identically whether or not a review was dispatched this round.
//
// WHY devRounds IS PASSED IN ALREADY INCREMENTED. Same reason as
// ./replan.mjs and ./develop.mjs: `devRounds` is the round loop's own counter,
// so the increment stays next to the loop and the incremented value arrives
// here only to build the `Review C{cycle} R{devRounds}` label.
//
// EXPLICIT STATE, NOT A CLOSURE -- AND WHY THREE VALUES COME BACK. The inline
// version read its inputs off the enclosing runSprintCycle/round-loop scope.
// They arrive as one explicit state argument now. Most of what this phase
// writes is MUTATED IN PLACE on objects the caller still holds -- `replanIds`
// and `replannedThisCycle` (Sets), `perBeadFeedback` (a Map, written through
// applyGuardedReopens' onReopened hook) and `rejectedNewTasks` (an array) --
// which is exactly equivalent to the closure it replaces, because runner.js
// never reassigns those bindings either.
//
// Three values are genuinely REASSIGNED rather than mutated, so they cannot
// travel that way and are returned instead: `lastReviewVerdict` and
// `reviewedThisCycle`, which the Cycle Evaluation section reads to decide
// whether a real review happened this cycle and what it concluded, and
// `pendingRejectedNewTasks`, which trackRejectedNewTaskForResurfacing()/
// clearResubmittedNewTask() return a NEW list from every time. They are also
// passed IN, so the round where the empty-guard skips the review dispatch
// returns them unchanged and the caller's single destructuring assignment is
// a no-op -- which is what keeps the call site free of an `if`.
//
// WHY SOME HELPERS ARE INJECTED RATHER THAN IMPORTED. dispatchReview,
// bdListScoped, goalMax, recordReopen, childIdAllocator and sprintMutexId are
// runSprintCycle-scoped locals, so there is nothing to import. computeChildFloor,
// createChildBeadWithAllocatedId, trackRejectedNewTaskForResurfacing and
// clearResubmittedNewTask are exported BY runner.js; importing them here would
// make phases/review.mjs <-> runner.js a circular pair for the sake of four
// helpers, so they come through the state argument instead -- the same rule
// phases/plan.mjs's and phases/develop.mjs's headers state. The dependencies
// that live in real sibling modules (applyGuardedReopens/foldReplanIds from
// ../beads-transitions.mjs, validateNewTask/appendRejectedFindingToParentNotes/
// persistNewTaskBestEffort from ../abort.mjs) are imported directly.
//
// GUARD COVERAGE: registered as 'phases/review.mjs' in ../guarded-modules.mjs.
// It took ONE member_name-bearing command() call site out of runner.js (the
// `bd show <ids> --json` acceptance-criteria read); the reopen and newTask
// writes reach bd through injected helpers that issue their own command()
// calls in the modules that already own them, and its only push is the shared
// gitSync bracket at the end. It carries NO dispatchRole() call site of its
// own: the reviewer ladder runs through runner.js's dispatchReview() helper,
// which stays there because the Re-Review and Final Review phases call it too.
// =============================================================================

import { applyGuardedReopens, foldReplanIds } from '../beads-transitions.mjs';
import {
    validateNewTask, appendRejectedFindingToParentNotes, persistNewTaskBestEffort,
} from '../abort.mjs';

/**
 * Runs ONE Review round: reviewer dispatch plus the orchestrator-applied
 * transitions its verdict asks for.
 *
 * @param {object} state Explicit phase state; see this file's header.
 * @returns {Promise<{
 *   lastReviewVerdict: string|undefined,
 *   reviewedThisCycle: boolean,
 *   pendingRejectedNewTasks: object[],
 * }>} The three REASSIGNED values described in the header. Every other output
 *   of this phase is an in-place mutation of a Set/Map/array the caller still
 *   holds. On the empty-scope round (every streak failed) all three come back
 *   exactly as they were passed in.
 */
export async function runReviewPhase({
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
    // Per-cycle state. `replanIds`, `replannedThisCycle`, `perBeadFeedback` and
    // `rejectedNewTasks` are mutated in place (see header).
    replanIds,
    replannedThisCycle,
    perBeadFeedback,
    rejectedNewTasks,
    // Per-round inputs. `devRounds` arrives already incremented (see header);
    // the other two are this round's Develop phase output.
    devRounds,
    streakOutcomes,
    readyTitleById,
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
    // --- Review: self-contained, schema-validated, orchestrator-applied ---
    phase(`Review C${cycle} R${devRounds}`);
    // Sort by (title, id) -- not raw outcome-recording order -- so this
    // evidence-gathering step is deterministic. See the readyTitleById
    // comment just above.
    // Failed streaks' beadIds are excluded from this round's review
    // scope.
    const assignedBeadIds = streakOutcomes.filter((o) => o.outcome !== 'failed').flatMap((o) => o.beadIds)
        .slice().sort((a, b) => {
            const ta = readyTitleById.get(a) || a;
            const tb = readyTitleById.get(b) || b;
            return ta.localeCompare(tb) || a.localeCompare(b);
        });
    const acceptanceCriteriaJson = assignedBeadIds.length > 0
        ? await command(`bd show ${assignedBeadIds.join(' ')} --json`, { member_name: orchestratorMember, silent: true })
        : '[]';

    // Empty-guard: when EVERY streak this round failed, assignedBeadIds
    // is [] and there is nothing for the Reviewer to look at. Skip the
    // dispatch entirely rather than sending an empty-scope review: an
    // empty review is prone to returning CHANGES_NEEDED with empty
    // reopenIds+newTasks, which trips the contract-violation check below
    // and, after the retry-once path, throws
    // ReviewerContractViolationError -- a hard sprint abort over a round
    // where no work happened at all. The `stillOpen` check just below
    // still runs, so the loop correctly continues instead of prematurely
    // treating the cycle as organically complete.
    if (assignedBeadIds.length === 0) {
        log(`Develop C${cycle} R${devRounds}: all streaks this round failed with no beadIds assigned -- skipping Review dispatch (nothing to review). Failed-streak beads remain ready for the next Develop round.`);
    } else {
    // dispatchReview() applies the shared contract-violation
    // retry-once-then-throw rule (see its own doc comment and
    // ReviewerContractViolationError) -- a CHANGES_NEEDED verdict with
    // both reopenIds and newTasks empty is self-contradictory and must
    // never be treated as an ordinary "more work needed" round.
    const verdict = await dispatchReview({ beadIds: assignedBeadIds, acceptanceCriteriaJson });
    // KB trust pipeline Phase 2: the reviewer decides, the engine
    // executes. Reviewer is the ONLY role whose kb_promotions are
    // honoured. apra-fleet-3swo.5.7: performed by the 'reviewer' row's
    // 'kb-apply' postResult step inside dispatchReview, so BOTH of its
    // call sites get it and a degraded round (which fabricates a
    // verdict carrying no KB fields) does not.
    // A5: the last reviewer verdict seen THIS cycle feeds the Cycle
    // Evaluation section's completion check below -- goal-priority
    // completion requires this to be exactly 'APPROVED', not just
    // an empty ready-bead list.
    lastReviewVerdict = verdict.verdict;
    // A review genuinely ran THIS cycle -- the Cycle Evaluation section
    // below only trusts `lastReviewVerdict` when this is true (see the
    // `reviewedThisCycle` reset at the top of the cycle loop and the
    // re-review dispatch it guards).
    reviewedThisCycle = true;

    // Orchestrator (this code) -- NOT the LLM -- applies every
    // structured transition: reopenIds via `bd update --status=open`,
    // newTasks via `bd create`. The reviewer's dispatch prompt above
    // explicitly forbade it from mutating beads itself; this is the
    // enforcement side of that contract (SKILL.md).
    // Deterministic goal-scope guard on reopenIds: the prompt-side
    // instruction (buildReviewerPrompt) asks the reviewer not to reopen
    // below-goal beads, but the orchestrator enforces it -- reopening a
    // DEFERRED P3 feature in a P1/P2 sprint injects out-of-scope work and
    // pins the verdict at CHANGES_NEEDED forever.
    // Ids actually reopened this round (survived the goal-scope
    // allowlist) -- gates which `replanIds` entries below are trusted,
    // so a reviewer naming a replanIds id that was never really
    // reopened (out of scope, or simply absent from reopenIds) can
    // never short-circuit the loop.
    const reopenedIds = new Set(await applyGuardedReopens({
        entries: verdict.reopenIds,
        bdListScoped, goalMax, goal: validated.goal, log, command,
        member: orchestratorMember,
        logPrefix: 'Reviewer reopenIds',
        buildReopenCommand: ({ id }) => ({
            cmd: `bd update ${id} --status=open`,
            label: `Reopen ${id} per reviewer verdict`,
        }),
        onReopened: ({ id }) => {
            // Track per-bead reopen counts for reopen-thrash detection.
            recordReopen(id);
            // Per-bead feedback routing: only beads named in reopenIds
            // carry this round's feedback into the next round's doer
            // prompt -- never a blanket broadcast.
            perBeadFeedback.set(id, verdict.notes);
        },
    }));
    // Fold this round's reviewer `replanIds` (absent/undefined on
    // verdicts that do not use it, so a no-op then) into the cycle's
    // running union, consulted at the top of the next iteration's
    // currentReady computation above. Only ids that were ACTUALLY
    // reopened this round are tracked -- an id the reviewer named in
    // replanIds without ALSO naming it in reopenIds (contrary to the
    // buildReviewerPrompt instruction above) is dropped rather than
    // silently ignored: logged here so the drop is visible in the run
    // log instead of vanishing with no trace.
    // This is the replan loop guard's single enforcement point. A bead
    // that has ALREADY been through one in-cycle scoped replan this cycle
    // (replannedThisCycle) is refused a SECOND: it stays reopened (real
    // dev feedback still applies) but is NOT re-added to replanIds, so
    // the develop loop above never dispatches a second scoped planner
    // pass for it -- it is handed to the next cycle's planner instead.
    // This is what makes "max one scoped replan per bead per cycle" hold
    // regardless of the round budget.
    for (const id of foldReplanIds({
        replanIds: verdict.replanIds, reopenedIds, replannedThisCycle, cycle, log,
    })) {
        replanIds.add(id);
    }
    for (const newTask of verdict.newTasks) {
        // Validate BEFORE interpolation -- see validateNewTask() above
        // for why this is an allowlist, not escaping. A rejection is
        // logged, recorded for the final-review evidence summary, and
        // skipped; it must never abort the sprint over one bad newTask.
        const validation = validateNewTask(newTask);
        if (!validation.ok) {
            log(`Reviewer newTasks: REJECTED (not sent to bd create) -- ${validation.reason}`);
            rejectedNewTasks.push({ cycle, reason: validation.reason, raw: newTask });
            // Track it for resurfacing into the NEXT planning-phase
            // dispatch too -- see trackRejectedNewTaskForResurfacing()'s
            // doc comment.
            pendingRejectedNewTasks = trackRejectedNewTaskForResurfacing(pendingRejectedNewTasks, {
                title: newTask && newTask.title, description: newTask && newTask.description,
                reason: validation.reason, cycle,
            });
            // A rejected finding must never simply vanish -- persist it
            // verbatim to the parent bead's notes as a fallback (itself
            // non-fatal: a notes write failure degrades to the run log,
            // never an abort).
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
        // A bead can only have one parent -- see the matching
        // comment on the re-review newTasks site below.
        //
        // Mint the child id through the supervisor-owned allocator so two
        // concurrent sprints creating follow-up work under the SAME
        // parent never derive the same child id. Under the null client
        // (lone sprint) childId is null and bd derives the id as before.
        const persisted = await persistNewTaskBestEffort({
            command, member: orchestratorMember, parentId: targetIssues[0],
            newTask, cycle, log, stage: 'develop-review',
            createFn: async () => {
                const floor = await computeChildFloor({ command, member: orchestratorMember, parentId: targetIssues[0] });
                await createChildBeadWithAllocatedId({
                    command, allocator: childIdAllocator, member: orchestratorMember,
                    title, description, priority, parentId: targetIssues[0],
                    sprintId: sprintMutexId, floor, log,
                    label: `Create follow-up task from reviewer newTasks: ${title}`,
                });
            },
        });
        // This title just landed as a real bead -- if it was a
        // resubmission of an earlier rejected item, drop it from the
        // pending resurface list so it stops reappearing in future
        // planning prompts. Pass title+description (not just title) so a
        // resubmission that also corrected its title still clears via its
        // unchanged description.
        if (persisted) {
            pendingRejectedNewTasks = clearResubmittedNewTask(pendingRejectedNewTasks, { title, description });
        }
    }

    // The orchestrator just MUTATED beads (reopens + newTask creates) in
    // its own clone -- D-push so members observe them on their next
    // dispatch's D-pull.
    await gitSync.syncBeadsAfter(orchestratorMember, { pushBeads: true });
    } // end assignedBeadIds.length > 0 (Review dispatch + orchestrator-applied transitions)

    return { lastReviewVerdict, reviewedThisCycle, pendingRejectedNewTasks };
}
