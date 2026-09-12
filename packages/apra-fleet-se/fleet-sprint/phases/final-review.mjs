// =============================================================================
// PHASE MODULE: Final Review (apra-fleet-3swo.6.6).
//
// The NINTH of runSprintCycle's twelve phase() boundaries -- the sprint's
// closing, evidence-based verdict. It D-pulls the orchestrator's beads clone so
// the closing counts reflect every member's pushed state, dispatches the
// REVIEWER persona over the whole sprint, and then has the ORCHESTRATOR -- never
// the LLM -- apply every structured transition that verdict asks for (validated
// newTask creation, guarded reopens) before D-pushing the beads it just mutated.
// Moved verbatim out of runner.js: every prompt, log line, dispatch option,
// validation branch and sync call is byte-identical to the inline version, so
// the golden transcript is unchanged. Move-only, no behaviour change.
//
// WHERE THIS PHASE STARTS AND STOPS. It runs from its own phase() call to the
// findings D-push that closes it. The `group('Finalization')` banner above the
// call site stays in runner.js -- it wraps Finalization as a WHOLE (this phase,
// Regression Test, Harvest and Publish PR), not this phase alone -- and
// everything after the findings D-push belongs to the phases that follow.
//
// WHAT COMES BACK, AND WHY IT MATTERS THAT IT DOES. `finalVerdictResult` IS the
// sprint's outcome: Publish PR reads its verdict and notes, and the analysis doc
// the harvester writes renders it alongside `finalClosedCount` /
// `finalOpenAtGoalCount`. Those three are the phase's return value rather than
// closure writes. The ORDER this creates is load-bearing and is not merely
// cosmetic: the once-per-sprint Regression Test phase runs AFTER this one
// precisely so `finalVerdictResult` is already computed by the time it runs, so
// a regression failure structurally CANNOT perturb the sprint verdict. See the
// "6b. Regression Test" banner at its call site in runner.js for the full
// statement of that guarantee, and ./regression-test.mjs's header for the other
// half of it. `rejectedNewTasks` and `deployFailures`/`integFailures` are arrays
// this phase pushes to or reads, so passing the arrays themselves is exactly
// equivalent to the closure they replace.
//
// THE FINDINGS PUSH MUST STAY BRACKETED. The D-push at the end of this phase
// used to be a BARE doltPushAfter() outside every bracket, so the clean-state
// pause guard reported "safe to pause" while the Final Review findings were
// mid-push (apra-fleet-3swo.4.1). It moved here as gitSync.pushBeadsAfter(),
// the bracketed entry point, and must stay that way -- there is no unbracketed
// way to reach doltPushAfter() from this module, and unbracketed-push-guard.mjs
// enforces that now this file is registered in ../guarded-modules.mjs.
//
// THE GUARDED VERDICT PATH IS NOT OPTIONAL. This is one of the three verdict
// sites that apply reopens, and all three go through the SHARED
// applyGuardedReopens() helper in ../beads-transitions.mjs so a below-goal
// bead named by a reviewer is never pulled back into a scope this sprint no
// longer targets. That import moved here INTACT: this module must never grow a
// private reopen loop or a private allowlist of its own (pinned by
// test/beads-transitions-extraction.test.mjs, which scans phases/review.mjs,
// phases/re-review.mjs and this file as separate sources and asserts which one
// owns which of the three sites -- runner.js itself now owns none).
//
// WHY SOME HELPERS ARE INJECTED RATHER THAN IMPORTED. dispatchCtx, gitSync,
// bdListScoped, decomposedParentIds, goalMax, kbPriming, kbWork,
// getMemberForRole, childIdAllocator, sprintMutexId and args are
// runSprintCycle-scoped locals, and NOT_DONE_STATUSES and resolveSettleShell
// are runner-module-private, so there is nothing to import. computeChildFloor,
// createChildBeadWithAllocatedId and sanitizePrText are exported BY runner.js;
// importing them here would make phases/final-review.mjs <-> runner.js a
// circular pair for the sake of three helpers, so they come through the state
// argument instead -- the same rule ./review.mjs's and ./re-review.mjs's
// headers state. The dependencies that live in real sibling modules
// (dispatchRole/TURN_BASES, buildFinalVerdictPrompt, applyGuardedReopens/
// parseIdWithReasonEntry, the abort.mjs newTask helpers, buildSettleCallback)
// are imported directly.
//
// GUARD COVERAGE: registered as 'phases/final-review.mjs' in
// ../guarded-modules.mjs. It took NO member_name-bearing command() call site
// out of runner.js -- its bead reads go through the injected bdListScoped and
// its writes through applyGuardedReopens and computeChildFloor/
// createChildBeadWithAllocatedId, whose command() sites live in the modules
// that already own them -- but it took ONE dispatchRole() site (the
// final-review ladder), which is exactly what dispatch-safety-guard and the
// phase 3 dispatch census read. It also owns a real gitSync bracket at each
// end. Both the zero command() baseline and the one dispatch site are pinned
// rather than assumed, so a future edit that reaches for a raw command() here
// turns red instead of landing on an unguarded site.
// =============================================================================

import { dispatchRole, TURN_BASES } from '../dispatch-role.mjs';
import { buildFinalVerdictPrompt } from '../prompts.mjs';
import { applyGuardedReopens, parseIdWithReasonEntry } from '../beads-transitions.mjs';
import {
    validateNewTask, appendRejectedFindingToParentNotes, persistNewTaskBestEffort,
} from '../abort.mjs';
import { buildSettleCallback } from '../dolt-settle.mjs';

/**
 * Runs the Final Review phase: the sprint's closing evidence-based verdict,
 * plus the orchestrator-applied transitions that verdict asks for.
 *
 * @param {object} state Explicit phase state; see this file's header.
 * @returns {Promise<{
 *   finalVerdictResult: object,
 *   finalClosedCount: number,
 *   finalOpenAtGoalCount: number,
 * }>} The sprint verdict and the two closing counts the analysis doc renders.
 *   Every other output of this phase is an in-place mutation of an array the
 *   caller still holds, or a bead/KB write already performed.
 */
export async function runFinalReviewPhase({
    // Presentation + dispatch seams.
    phase,
    log,
    command,
    dispatchCtx,
    // Sprint identity/config.
    args,
    validated,
    targetIssues,
    orchestratorMember,
    finalCycleLabel,
    sprintState,
    // The git/beads sync brackets this phase's pre-read D-pull and its
    // post-mutation findings D-push go through.
    gitSync,
    // Evidence this phase reads (deployFailures/integFailures) or pushes to
    // (rejectedNewTasks); never reassigned by this phase (see header).
    deployFailures,
    integFailures,
    rejectedNewTasks,
    verifyEverIds,
    // runSprintCycle-scoped locals and runner-module-private values, injected
    // rather than imported (see header).
    bdListScoped,
    decomposedParentIds,
    goalMax,
    NOT_DONE_STATUSES,
    kbPriming,
    kbWork,
    getMemberForRole,
    childIdAllocator,
    sprintMutexId,
    resolveSettleShell,
    // Exported BY runner.js; injected to avoid a circular import (see header).
    computeChildFloor,
    createChildBeadWithAllocatedId,
    sanitizePrText,
}) {
    phase(`Final Review C${finalCycleLabel}`);

    // D-pull the orchestrator's beads clone BEFORE the final-review counts so
    // the sprint's closing evidence (finalOpenAtGoal / finalClosedCount)
    // reflects every member's D-pushed beads state, not the orchestrator's
    // stale local copy.
    // Thread the orchestrator member's REGISTERED shell into dolt-settle,
    // guarded on args.callTool the same way the pre-dispatch bracket is
    // (apra-fleet-7dir.24).
    const finalReviewSettleShell = await resolveSettleShell({ args, member: orchestratorMember, log, sprintState });
    await gitSync.syncBeadsBefore(orchestratorMember, { fatal: true, settle: buildSettleCallback(orchestratorMember, { command, log, shell: finalReviewSettleShell }) });
    const [finalOpenAtGoalRaw, finalOpenAtGoalParentIds, finalClosedBeads] = await Promise.all([
        bdListScoped(`--status=${NOT_DONE_STATUSES} --priority-max=${goalMax} --json`),
        decomposedParentIds(),
        bdListScoped('--status=closed --json'),
    ]);
    const finalOpenAtGoal = finalOpenAtGoalRaw.filter((b) => !finalOpenAtGoalParentIds.has(b.id));
    const finalClosedCount = finalClosedBeads.length;
    // apra-fleet-jfo.2: same structural blind spot as the per-cycle exit
    // check -- verify-routed beads are decomposed parents, so they never
    // appear in finalOpenAtGoal (post-filtered via decomposedParentIds()),
    // so a sprint that exhausted MAX_CYCLES with Deploy failing every time
    // could otherwise reach Final Review reporting "0 open bead(s)" while
    // the verify-routed targets were never actually re-verified. Surface it
    // as explicit evidence rather than leaving the Final Review to
    // rubber-stamp PASS on an incomplete count. Guarded on
    // `verifyEverIds.size > 0` -- see the per-cycle check above for why.
    // Uses the same fresh finalClosedBeads read as finalClosedCount above,
    // not fetchAllBeadsShared()'s cache (apra-fleet-66u.2).
    let finalUnclosedVerifyIds = [];
    if (verifyEverIds.size > 0) {
        const finalClosedIds = new Set(finalClosedBeads.map((b) => b.id));
        finalUnclosedVerifyIds = [...verifyEverIds].filter((id) => !finalClosedIds.has(id));
    }

    let finalVerdictResult;
    // The Final Review covers an entire epic's worth of work, categorically
    // LARGER than a per-round review, so it gets an explicit budget plus the
    // same same-session resume-and-continue treatment as the doer and per-round
    // reviewer. Without it a large sprint's final review dies at the default
    // turn limit and flips the whole sprint to a FAIL whose notes carry no
    // findings at all.
    // apra-fleet-nx7: offer the final reviewer the same INFERRED candidates a
    // per-round reviewer gets. Fetched once, before the dispatch, so the retry
    // and resume paths reuse the identical block rather than re-querying a
    // KB that its own earlier promotions may have already changed.
    const finalReviewRepoPath = kbPriming.folderOf(getMemberForRole('reviewer'));
    const finalKbCandidates = await kbWork.promotionCandidates(finalReviewRepoPath);
    if (finalKbCandidates.length > 0) {
        log(`[kb-work] offering ${finalKbCandidates.length} INFERRED entr(ies) to the final reviewer for promotion.`);
    }
    // apra-fleet-3swo.5.7: the final-review ladder -- its dispatch, its
    // read-side git-sync bracket, its max_turns-exhaustion resume at doubled
    // turns, its retry-once wrapper, its auth self-heal and its FAIL degrade --
    // is now the 'final-review' row of fleet-sprint/role-policies.mjs.
    //
    // WHY THE HEAL SHORT-CIRCUIT IS POLICY DATA. Final Review is the LAST and
    // most expensive dispatch of the sprint, and its verdict IS the sprint's
    // outcome. An auth/trust failure is deterministic, so the generic
    // retry-once ladder would only reproduce it -- but an LLM-auth failure gets
    // exactly ONE self-heal, and on success the healed verdict is
    // authoritative and MUST end the ladder: falling through to the generic
    // retry as well would fire a SECOND full Final Review, silently discard the
    // healed verdict (a PASS could become a FAIL) and double the cost. That is
    // retry.authSelfHealShortCircuits. A heal that does NOT succeed leaves the
    // channel walled off with no judgement to fabricate, so
    // retry.rethrowsUnhealedNonRetryable propagates it rather than degrading to
    // a FAIL nobody decided.
    //
    // Note Final Review has no role member of its own: it is the REVIEWER role,
    // dispatching the reviewer persona over the whole sprint -- so its policy
    // routes to getMemberForRole('reviewer'), unlike the per-round reviewer
    // which takes the pool head.
    const finalReviewOutcome = await dispatchRole(dispatchCtx, 'final-review', {
        prompt: buildFinalVerdictPrompt({
            targetIssues,
            branch: validated.branch,
            baseBranch: validated.baseBranch,
            goal: validated.goal,
            cyclesRun: finalCycleLabel,
            closedCount: finalClosedCount,
            openAtGoalCount: finalOpenAtGoal.length,
            deployFailures,
            integFailures,
            rejectedNewTasks,
            unclosedVerifyIds: finalUnclosedVerifyIds,
            kbCandidates: finalKbCandidates,
            kbKnowledge: kbPriming.knowledgeOf(getMemberForRole('reviewer')),
        }),
        resumePrompt: 'Continue your final review exactly where you left off in this same session -- do not restart or re-read the diff from scratch. Weigh the remaining evidence and return your final PASS/FAIL verdict now (with newTasks findings if FAIL).',
        roleLabel: 'Final Review',
        label: 'Final Review',
        resumeLabel: `Final Review (resume, max_turns=${TURN_BASES.FINAL_REVIEW_MAX_TURNS * 2})`,
    });
    finalVerdictResult = finalReviewOutcome.value;
    // No duplicate log() dump -- see dispatchReview() for why.
    // `finalVerdictResult.verdict` also surfaces via the generic,
    // workflow-agnostic Result strip in the dashboard header (state.result --
    // see src/viewer/index.mjs), a second independent reason a raw JSON
    // re-print here would be redundant.

    // apra-fleet-nx7: the final reviewer's KB decisions are executed through
    // the same path every per-round review uses -- now as the 'final-review'
    // row's 'kb-apply' postResult step (apra-fleet-3swo.5.7), which the engine
    // runs immediately after a successful dispatch. Deliberately NOT gated on
    // the VERDICT -- a fact can be verified even when the sprint as a whole
    // fails, and the reviewer contract already says as much ("Not tied to the
    // verdict"). It is gated on there BEING a verdict: a degraded FAIL is
    // fabricated by the engine and carries no KB fields at all, so there is
    // nothing to apply.

    // Publish what this sprint confirmed. Immediately after the LAST promotion
    // of the run, so the bible carries every CONFIRMED entry including the ones
    // minted a line above. Without this the sprint's knowledge never left the
    // member's local sqlite store -- see createKbWorkClient.exportBible.
    await kbWork.exportBible(finalReviewRepoPath);

    // Persist the Final Review's actionable findings to BEADS -- the only
    // artifact the next sprint's planner reads (notes reach only the PR body
    // and the analysis doc). NOT gated to FAIL: a PASS can still surface real
    // secondary findings (defects that don't block this epic's own
    // acceptance criteria) that would otherwise be lost prose with no
    // follow-up mechanism. Same orchestrator-applies contract, allowlist
    // validation, and id-allocator path as the per-round reviewer's
    // newTasks; a rejected finding is logged and recorded, never sprint-fatal.
    const finalNewTasks = Array.isArray(finalVerdictResult.newTasks) ? finalVerdictResult.newTasks : [];
    let dPushNeededAfterFinalFindings = false;
    if (finalNewTasks.length > 0) {
        const createdIds = [];
        let createdCountUnknownId = 0;
        for (const newTask of finalNewTasks) {
            const validation = validateNewTask(newTask);
            if (!validation.ok) {
                log(`Final Review newTasks: REJECTED (not sent to bd create) -- ${validation.reason}`);
                rejectedNewTasks.push({ cycle: finalCycleLabel, reason: validation.reason, raw: newTask });
                // Never let a rejected finding vanish -- persist it verbatim to
                // the parent bead's notes as a fallback. This is the
                // highest-stakes site of the three: Final Review's findings
                // are the handoff to the next sprint's planner. Non-fatal;
                // degrades to the run log.
                try {
                    await appendRejectedFindingToParentNotes({
                        command, member: orchestratorMember, parentId: targetIssues[0],
                        newTask, reason: validation.reason, cycle: finalCycleLabel, log,
                    });
                } catch (noteErr) {
                    log(`[fleet-sprint] rejected-finding notes fallback FAILED (non-fatal): ${noteErr.message}; finding preserved VERBATIM in this run log: ${JSON.stringify(newTask)}`);
                }
                continue;
            }
            const { title, description, priority } = validation;
            const created = await persistNewTaskBestEffort({
                command, member: orchestratorMember, parentId: targetIssues[0],
                newTask, cycle: finalCycleLabel, log, stage: 'final-review',
                createFn: async () => {
                    const floor = await computeChildFloor({ command, member: orchestratorMember, parentId: targetIssues[0] });
                    return createChildBeadWithAllocatedId({
                        command, allocator: childIdAllocator, member: orchestratorMember,
                        title, description, priority, parentId: targetIssues[0],
                        sprintId: sprintMutexId, floor, log,
                        label: `Create follow-up task from Final Review findings: ${title}`,
                    });
                },
            });
            if (created) {
                dPushNeededAfterFinalFindings = true;
                if (created.childId) {
                    createdIds.push(created.childId);
                    log(`Final Review newTasks: created ${created.childId} ("${title}") under ${targetIssues[0]}.`);
                } else {
                    createdCountUnknownId += 1;
                    log(`Final Review newTasks: created a follow-up task ("${title}") under ${targetIssues[0]} (bd-derived id, not tracked by the allocator).`);
                }
            }
        }
        if (createdIds.length > 0 || createdCountUnknownId > 0) {
            log(`Final Review: persisted ${createdIds.length + createdCountUnknownId} finding(s) to beads as follow-up task(s) under ${targetIssues[0]}${createdIds.length > 0 ? `: ${createdIds.join(', ')}` : ''}.`);
        }
    }

    // Beads the Final Review flagged for reopening -- each with its OWN
    // reason (unlike the per-round reviewer's reopenIds, which shares one
    // blanket `notes` string across every id this round). Same goal-scope
    // guard as the per-round reviewer: never reopen a below-goal-priority
    // bead into scope this sprint no longer targets. Reason is appended
    // (never overwritten) via --append-notes so it never clobbers the
    // bead's existing notes.
    const finalReopenIds = Array.isArray(finalVerdictResult.reopenIds) ? finalVerdictResult.reopenIds : [];
    if (finalReopenIds.length > 0) {
        // Same guard, same fail-open, same skip log as the other two verdict
        // sites -- only the entry shape ({id, reason}, both required) and the
        // --append-notes command text are this site's own.
        const reopenedIds = await applyGuardedReopens({
            entries: finalReopenIds,
            bdListScoped, goalMax, goal: validated.goal, log, command,
            member: orchestratorMember,
            logPrefix: 'Final Review reopenIds',
            parseEntry: parseIdWithReasonEntry,
            buildReopenCommand: ({ id, reason }) => {
                // bd update has no --append-notes-file / --stdin equivalent for
                // notes (only --body-file/--stdin, and only for description) --
                // --append-notes only accepts an inline string. reason is
                // LLM-authored free text, so it must go through the same
                // flatten-to-single-line, shell-injection-safe sanitizer used
                // for the PR body's notes, never interpolated raw.
                const safeReason = sanitizePrText(reason);
                if (!safeReason) {
                    log(`Final Review reopenIds: SKIPPED '${id}' (reason sanitized to empty -- nothing safe to record).`);
                    return null;
                }
                return {
                    cmd: `bd update ${id} --status=open --append-notes "[Final Review C${finalCycleLabel}] Reopened -- ${safeReason}"`,
                    label: `Reopen ${id} per Final Review verdict`,
                };
            },
            onReopened: ({ id, reason }) => {
                dPushNeededAfterFinalFindings = true;
                log(`Final Review reopenIds: reopened ${id} -- ${sanitizePrText(reason)}`);
            },
            // A single bead's reopen failing must never abort Final Review;
            // the reason is preserved verbatim in the run log instead.
            onEntryError: ({ id, reason }, reopenErr) => {
                log(`[fleet-sprint] Final Review reopen FAILED (non-fatal) for '${id}': ${reopenErr.message} -- reason preserved verbatim in this run log: ${reason}`);
            },
        });
        if (reopenedIds.length > 0) {
            log(`Final Review: reopened ${reopenedIds.length} bead(s): ${reopenedIds.join(', ')}.`);
        }
    }
    if (dPushNeededAfterFinalFindings) {
        // (apra-fleet-3swo.4.1) This D-push used to be a BARE doltPushAfter()
        // outside every bracket, so the clean-state pause guard reported
        // "safe to pause" while the Final Review findings were mid-push.
        // pushBeadsAfter() is the bracketed entry point -- there is no
        // unbracketed way to reach doltPushAfter() from this file any more.
        await gitSync.pushBeadsAfter(orchestratorMember, { pushBeads: true });
    }

    return { finalVerdictResult, finalClosedCount, finalOpenAtGoalCount: finalOpenAtGoal.length };
}
