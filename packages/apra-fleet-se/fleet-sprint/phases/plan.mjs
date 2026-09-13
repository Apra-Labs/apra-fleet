// =============================================================================
// PHASE MODULE: Plan (apra-fleet-3swo.6.2).
//
// The SECOND of runSprintCycle's twelve phase() boundaries -- the per-cycle
// planner <-> plan-reviewer approval loop, plus the plan-cap deferral that
// decides what happens when that loop exhausts its rounds without an
// APPROVED verdict. Moved verbatim out of runner.js: every prompt, log line,
// dispatch option and thrown error is byte-identical to the inline version,
// so the golden transcript is unchanged. Move-only, no behaviour change.
//
// WHERE THIS PHASE STOPS. It ends exactly where the inline version did, at
// the plan-cap deferral -- NOT at the next phase() call. "2. Execution Prep"
// (the ready-bead query, the per-cycle stale-in_progress self-heal, and the
// second deferral abort condition) issues no phase() of its own and feeds the
// Develop loop's locals directly, so it stays in runner.js with the Develop
// phase it belongs to. The four values Execution Prep still needs from here
// are RETURNED rather than left in a shared scope: see the return shape below.
//
// EXPLICIT STATE, NOT A CLOSURE. The inline version read ~25 runSprintCycle
// locals off the enclosing scope. They arrive as one explicit state argument
// now, including `sprintState` -- the per-sprint resolved state from
// ../sprint-state.mjs, which this phase genuinely consumes: the post-plan
// beads re-pull for a planner on a DIFFERENT clone than the orchestrator
// resolves that member's registered shell through the sprint-scoped fleet
// client rather than building a client of its own.
//
// WHY THE RUNNER HELPERS ARE INJECTED RATHER THAN IMPORTED. parseBdJson,
// extractContestedBeadIds, reconcilePendingRejectedNewTasks and
// stageCommandBodyMemberSide are all exported BY runner.js, and
// resolveSettleShell is runner-module-private. Importing them here would make
// phases/plan.mjs <-> runner.js a circular pair for the sake of four pure
// helpers, so they come through the state argument instead. The dependencies
// that live in real sibling modules (dispatchRole, the prompt builders, the
// error classes, buildSettleCallback) are imported directly.
//
// MUTABLE STATE IS THREADED, NOT SHARED. `pendingRejectedNewTasks` is the one
// runSprintCycle local this phase REASSIGNS (the post-planner reconciliation
// against what now exists as a child of each target parent). It is passed in
// and handed back in the return value; runner.js reassigns its own binding
// from that. The helpers that produce it are pure and never mutate in place,
// which is what makes threading it equivalent to the closure it replaces.
//
// GUARD COVERAGE: registered as 'phases/plan.mjs' in ../guarded-modules.mjs.
// It carries three command() call sites (the per-parent child listing and the
// two plan-cap deferral bd mutations), all member_name-bearing, plus the two
// dispatchRole call sites for the planner and plan-reviewer ladders.
// =============================================================================

import { dispatchRole, TURN_BASES } from '../dispatch-role.mjs';
import { buildPlannerPrompt, buildPlanReviewerPrompt } from '../prompts.mjs';
import { PlanReviewDispatchFailedError, SprintPlanRejectedError } from '../errors.mjs';
import { buildSettleCallback } from '../dolt-settle.mjs';

/**
 * Runs the Plan phase for ONE sprint cycle: up to three planner <->
 * plan-reviewer rounds, then -- if no round returned APPROVED -- either the
 * plan-cap deferral of the specifically contested beads, or a throw when the
 * whole plan is contested (or was never actually reviewed).
 *
 * @param {object} state Explicit phase state; see this file's header.
 * @returns {Promise<{
 *   planCapDeferredIds: string[],
 *   lastVerdict: object|null,
 *   planningRounds: number,
 *   pendingRejectedNewTasks: object[],
 * }>} `planCapDeferredIds`, `lastVerdict` and `planningRounds` are what
 *   Execution Prep's own deferral abort reports on; `pendingRejectedNewTasks`
 *   is the threaded-back mutable list described in the header.
 */
export async function runPlanPhase({
    // Presentation + dispatch seams.
    phase,
    log,
    command,
    dispatchCtx,
    // Sprint identity/config.
    cycle,
    validated,
    targetIssues,
    requirementsContent,
    orchestratorMember,
    getMemberForRole,
    // Per-sprint resolved state (../sprint-state.mjs) and the git/beads sync
    // bracket the post-plan cross-clone re-pull goes through.
    sprintState,
    gitSync,
    args,
    // Per-cycle inputs.
    verifySetThisCycle,
    roundSessions,
    pendingRejectedNewTasks: initialPendingRejectedNewTasks,
    // Injected runner helpers -- see the header for why these are not imports.
    resolveSettleShell,
    parseBdJson,
    extractContestedBeadIds,
    reconcilePendingRejectedNewTasks,
    stageCommandBodyMemberSide,
    updateDashboard,
}) {
    // The one reassigned input (header: MUTABLE STATE IS THREADED). Rebound to
    // a local so the body below reads exactly as it did inline, and handed
    // back to runner.js in the return value.
    let pendingRejectedNewTasks = initialPendingRejectedNewTasks;

    // =======================
    // 1. Planning Loop
    // =======================
    // Approval is `verdict === 'APPROVED'` EXACTLY, read from the
    // plan-reviewer's schema-validated structured output (contracts.mjs
    // `planReviewerVerdict`). No substring matching anywhere in this phase,
    // so free text like "This can NOT be APPROVED" can never be misread as
    // an approval. A plan-reviewer that persistently fails to return
    // schema-valid JSON (after agent()'s own bounded schema-repair loop) is
    // a failed, CHANGES_NEEDED-equivalent round, never an approval.
    //
    // `cycle > 1` means this Plan phase is a RE-PLANNING pass after an
    // earlier Develop/Review cycle needed more work -- distinct from
    // `planningRounds`, which counts rounds *within* one Plan phase's
    // planner<->plan-reviewer approval loop. Only the outer `cycle`
    // controls the delta-vs-full prompt framing.
    const isDeltaCycle = cycle > 1;

    let planApproved = false;
    let planningRounds = 0;
    let plannerFeedback = null;
    let lastVerdict = null;
    // Every earlier round's verdict for THIS cycle's plan-review loop,
    // oldest first -- fed to buildPlanReviewerPrompt from round 2 on, so
    // the no-goalpost-moving rule (plan-reviewer.md) has prior-round
    // rulings to bind against. Scoped to the cycle, like lastReviewVerdict.
    const priorPlanRoundVerdicts = [];

    while (!planApproved && planningRounds < 3) {
        planningRounds++;
        phase(`Plan C${cycle} R${planningRounds}`);

        const plannerPrompt = buildPlannerPrompt({
            isDeltaCycle,
            targetIssues,
            goal: validated.goal,
            requirementsFile: validated.requirementsFile,
            requirementsContent,
            feedback: plannerFeedback,
            rejectedNewTasksToResubmit: pendingRejectedNewTasks,
            verifyExcluded: verifySetThisCycle,
        });
        // The planner writes no code but MUTATES beads (it creates the task
        // DAG), so its policy is bracketed pushCode:false / pushBeads:true --
        // its new tasks are D-pushed for the next dispatch to observe. Each
        // retried attempt gets its own bracket, since a retry may follow a
        // meaningful gap. Like every dispatch site, max_turns exhaustion is
        // answered with a same-session resume at doubled turns; the planner
        // gets a doer-sized base because it builds the whole epic DAG.
        //
        // apra-fleet-3swo.5.3: all of that -- the turn budget, the bounded
        // [0, 5s, 15s, 30s, 60s] backoff ladder sized for a real member
        // busy-lock, the one LLM-auth self-heal, the abort-without-
        // re-dispatch on a post-dispatch sync failure, the no-mutation
        // pre-sync skip, the same-session resume at doubled turns, and the
        // FATAL degrade (there is no sprint without a plan, so an exhausted
        // ladder rethrows rather than synthesizing one) -- is now the
        // 'planner' row of fleet-sprint/role-policies.mjs, executed by
        // dispatchRole (fleet-sprint/dispatch-role.mjs). What stays here is
        // what is genuinely NOT policy: the prompts, the presentation
        // labels, the per-round session wiring, and the two runner-local
        // decisions below.
        //
        // The sprint's FIRST Planner dispatch reads/mutates the SAME beads
        // clone the orchestrator's pre-sprint doltPullBefore just freshened,
        // with only non-mutating `bd list` reads in between, so its own
        // pre-dispatch `bd dolt pull` is redundant. Skipping it also keeps
        // the terminal auth-abort path from hanging on that bracket. Scoped
        // out -- all keeping the full D-pull -- are: a later cycle (a re-plan
        // follows real beads mutation), a later planning round (round 1's
        // planner already mutated beads), any retry attempt, and a planner on
        // a DISTINCT clone from the orchestrator (never freshened by the
        // setup pull).
        const plannerSharesOrchestratorClone = getMemberForRole('planner') === orchestratorMember;
        await dispatchRole(dispatchCtx, 'planner', {
            prompt: plannerPrompt,
            resumePrompt: 'Continue your planning pass exactly where you left off in this same session -- do not restart or re-derive the DAG from scratch. Finish creating/updating the remaining beads and return your final summary now.',
            roleLabel: 'Planner',
            resumeLabel: `Plan (resume, max_turns=${TURN_BASES.PLANNER_MAX_TURNS * 2})`,
            // Within THIS cycle's plan-review loop, resume the planner's own
            // prior-round session by explicit session id so a re-plan keeps
            // warm context. False on the first round of any cycle
            // (roundSessions never resumes across cycles). The
            // max_turns-exhaustion path overrides this to `resume: true` --
            // an in-dispatch continuation of the session just run,
            // orthogonal to cross-round resume.
            resumeArg: roundSessions.resumeArgFor('planner', cycle),
            onSessionId: (id, meta) => roundSessions.record('planner', cycle, id, meta),
            attemptOptions: ({ attempt }) => ({
                skipPreDispatchDoltPull:
                    attempt === 1 && cycle === 1 && planningRounds === 1 && plannerSharesOrchestratorClone,
            }),
            // Runs INSIDE the attempt's try, so a failure here is classified
            // by the same ladder that classifies the dispatch itself.
            // apra-fleet-jxdf.1: when the planner runs on a DIFFERENT clone
            // than the orchestrator, its newly-created/mutated beads are
            // invisible to the orchestrator's own Dolt clone until that
            // clone is actually pulled -- invalidating the JS-level cache
            // (the policy's 'invalidate-beads-cache' postResult step, which
            // the engine runs right after this) is not enough, since the
            // cache's NEXT read still hits stale on-disk data. Fatal on
            // failure: proceeding to Execution Prep against a plan the
            // orchestrator cannot actually see reproduces exactly the "epic
            // looks like a childless ready leaf" failure this fix closes.
            afterAttempt: async () => {
                if (plannerSharesOrchestratorClone) return;
                const postPlanSettleShell = await resolveSettleShell({ args, member: orchestratorMember, log, sprintState });
                await gitSync.syncBeadsBefore(orchestratorMember, {
                    fatal: true,
                    settle: buildSettleCallback(orchestratorMember, { command, log, shell: postPlanSettleShell }),
                });
            },
        });
        // The planner resubmits a corrected rejected finding directly via
        // `bd create`, never through
        // persistNewTaskBestEffort/clearResubmittedNewTask -- and correcting
        // the stated defect usually means changing the title, so a
        // title-keyed pending entry would stay stuck and reappear in every
        // later planning prompt this run. Reconcile against what now exists
        // as a child of each target parent, matching on description
        // (title-independent); see reconcilePendingRejectedNewTasks().
        // Best-effort: a listing failure leaves the pending list as-is, so
        // the worst case is one more resurfacing, never a sprint abort.
        if (pendingRejectedNewTasks.length > 0) {
            for (const parentId of targetIssues) {
                try {
                    const label = `bd list --parent ${parentId} --json`;
                    const raw = await command(label, { member_name: orchestratorMember, silent: true });
                    const children = parseBdJson(raw, label);
                    pendingRejectedNewTasks = reconcilePendingRejectedNewTasks(pendingRejectedNewTasks, children);
                } catch (err) {
                    log(`[fleet-sprint] pending-rejected-newTask reconciliation against '${parentId}' children FAILED (non-fatal, list stays as-is): ${err.message}`);
                }
            }
        }
        // Deliberately no log() dump of the planner's response here: the
        // agent() call inside dispatchPlanner() already emits it as the
        // dispatch's own AGENT activity row, so logging it again would
        // render a duplicate row in the viewer. The same rule applies at
        // every role's dispatch site in this file.

        // apra-fleet-3swo.5.3: the plan-review ladder is the 'plan-reviewer'
        // row of role-policies.mjs, executed by dispatchRole. What that row
        // owns, and what used to be spelled out here: the reviewer-sized
        // turn base with the same same-session turn-exhaustion resume every
        // dispatch site uses; the read-side git-sync bracket; the TWO
        // attempts per round (an infrastructure dispatch failure -- schema-
        // repair exhaustion, a dropped transport -- gets exactly one extra
        // attempt WITHIN this same planning round, so it does not consume a
        // second round out of the 3-round planningRounds cap); the one
        // bounded LLM-auth self-heal (an unhealed auth failure would
        // reproduce identically on every remaining planning round); and the
        // degrade, which synthesizes a non-approving CHANGES_NEEDED verdict
        // and can never fabricate an approval.
        //
        // Every synthesized fallback verdict carries `dispatchFailed: true`
        // so the plan-cap exhaustion check after this loop can tell "the
        // plan-reviewer's dispatch channel never came back" apart from "the
        // reviewer genuinely rejected the plan" and throw the
        // correctly-flavored error for each (apra-fleet-9ta.4). The engine
        // stamps that marker from the policy row; the notes below are the
        // per-error-class text this call site still owns.
        const planReviewOutcome = await dispatchRole(dispatchCtx, 'plan-reviewer', {
            prompt: buildPlanReviewerPrompt({ targetIssues, goal: validated.goal, priorRoundVerdicts: priorPlanRoundVerdicts, verifyExcluded: verifySetThisCycle }),
            resumePrompt: 'Continue your plan review exactly where you left off in this same session -- do not restart or re-read the DAG from scratch. Finish the remaining criteria and return your final verdict now.',
            roleLabel: 'Plan Reviewer',
            resumeLabel: `Plan Review (resume, max_turns=${TURN_BASES.PLAN_REVIEWER_MAX_TURNS * 2})`,
        });
        const verdict = planReviewOutcome.value;
        lastVerdict = verdict;
        // No duplicate log() dump -- see dispatchReview() for why.
        // This round's verdict is recorded AFTER the dispatch that consumed
        // the accumulated prior rounds, so a round never sees its own
        // not-yet-returned verdict.
        priorPlanRoundVerdicts.push({ round: planningRounds, verdict: verdict.verdict, notes: verdict.notes });

        if (verdict.verdict === 'APPROVED') {
            planApproved = true;
        } else {
            plannerFeedback = verdict.notes; // Pass textual feedback to planner, wrapped as untrusted by buildPlannerPrompt
        }
        await updateDashboard();
    }

    // Plan-cap exhaustion (every round CHANGES_NEEDED, never an APPROVED)
    // does not necessarily condemn the whole plan: one bead's unresolved
    // finding can pin the verdict while the rest of the task set is clean.
    // The contested set now comes from the verdict's STRUCTURED `findings`
    // array (extractContestedBeadIds reads it directly; the free-text `notes`
    // scan survives only as a deprecated fallback for a verdict carrying no
    // findings key). The routing policy below is unchanged by that swap -- it
    // is the input channel that moved, not the decision.
    // When the last verdict's findings name specific beads, defer just
    // those (status=deferred plus the finding attached as a note) and
    // proceed to Develop with the remaining approved set. Abort only when
    // the contested set is the whole plan, or when deferring it would leave
    // nothing ready to dispatch (checked once readyBeads is computed).
    let planCapDeferredIds = [];
    if (!planApproved) {
        const allTaskIds = (lastVerdict && Array.isArray(lastVerdict.taskAssignments))
            ? lastVerdict.taskAssignments.map((a) => a && a.id).filter((id) => typeof id === 'string' && id.length > 0)
            : [];
        const contestedIds = extractContestedBeadIds(lastVerdict);
        const wholePlanContested = allTaskIds.length === 0
            || contestedIds.length === 0
            || contestedIds.length >= allTaskIds.length;

        if (wholePlanContested) {
            // apra-fleet-9ta.4: a `dispatchFailed` last verdict means the
            // plan-reviewer's dispatch channel never came back with a real
            // verdict (schema-repair exhaustion / transport failure, even
            // after the one same-round retry above) -- the plan was never
            // actually reviewed, so this must NOT be misreported as
            // SprintPlanRejectedError (which asserts a genuine rejection).
            if (lastVerdict && lastVerdict.dispatchFailed) {
                throw new PlanReviewDispatchFailedError(
                    `Plan phase for cycle ${cycle} exhausted ${planningRounds} plan round(s) without a usable ` +
                    'plan-reviewer verdict -- the last round\'s verdict was synthesized from a dispatch failure, ' +
                    'not a genuine review. The plan was never actually reviewed; re-run the sprint once the ' +
                    'plan-reviewer dispatch channel recovers.',
                    {
                        notes: lastVerdict ? lastVerdict.notes : null,
                        cycle,
                        planningRounds,
                    }
                );
            }
            throw new SprintPlanRejectedError(
                `Plan phase for cycle ${cycle} was not approved after ${planningRounds} round(s). ` +
                'Refusing to proceed to Develop with an unapproved plan.',
                {
                    notes: lastVerdict ? lastVerdict.notes : null,
                    cycle,
                    planningRounds,
                }
            );
        }

        log(`[fleet-sprint] plan-cap deferral: cycle ${cycle} exhausted ${planningRounds} plan round(s) with ` +
            `CHANGES_NEEDED confined to bead(s) [${contestedIds.join(', ')}] -- deferring ${contestedIds.length === 1 ? 'it' : 'them'} ` +
            `and proceeding to Develop with the remaining approved task set.`);

        for (const id of contestedIds) {
            await command(
                `bd update ${id} --status=deferred`,
                { member_name: orchestratorMember, silent: true, label: `Defer contested bead ${id} per plan-cap exhaustion` }
            );
            // Stage the deferral note member-side: the orchestrator member
            // can itself be remote, so a host-local body-file path would be
            // unreachable to `bd note`.
            const noteFile = await stageCommandBodyMemberSide({
                command, member: orchestratorMember,
                content:
                    `[fleet-sprint plan-cap deferral] Deferred after ${planningRounds} plan round(s) of CHANGES_NEEDED ` +
                    `confined to this bead (cycle ${cycle}). Plan reviewer finding:\n${lastVerdict.notes}`,
                label: `Stage plan-cap deferral finding for ${id}`,
            });
            await command(
                `bd note ${id} --file "${noteFile}"`,
                { member_name: orchestratorMember, silent: true, label: `Attach plan-cap deferral finding to ${id}` }
            );
        }
        await gitSync.syncBeadsAfter(orchestratorMember, { pushBeads: true });
        planCapDeferredIds = contestedIds;
    }

    return { planCapDeferredIds, lastVerdict, planningRounds, pendingRejectedNewTasks };
}
