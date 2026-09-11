// =============================================================================
// PHASE MODULE: Develop (apra-fleet-3swo.6.7).
//
// The FOURTH of runSprintCycle's twelve phase() boundaries -- one round of
// doer work: group this round's ready beads into streaks, pack the streaks
// into per-doer ordered worklists, and run every streak turn through the
// serialized doer barrier, recording a per-streak (and per-bead) outcome for
// each. Moved verbatim out of runner.js: every prompt, log line, dispatch
// option, sync bracket and outcome shape is byte-identical to the inline
// version, so the golden transcript is unchanged. Move-only, no behaviour
// change.
//
// WHERE THIS PHASE STARTS AND STOPS. It starts at its own phase() call and
// ends at the "streak outcomes" log line -- NOT at the next phase() call.
// Review runs in the SAME round loop iteration and consumes this phase's
// results, so the boundary is drawn where the doer work finishes rather than
// where the next label is emitted. Everything before the phase() call (the
// round loop's ready-set query, the scoped-replan branch -- now
// ./replan.mjs -- and the replan short-circuit that computes `currentReady`)
// stays in runner.js, because all three decide WHETHER this phase runs and
// two of them use loop control (`break`/`continue`) that cannot be expressed
// from inside a function.
//
// WHY devRounds IS PASSED IN ALREADY INCREMENTED. Same reason as ./replan.mjs:
// `devRounds` is the round loop's own counter, so the increment stays next to
// the loop and the incremented value arrives here only to build the
// `Develop C{cycle} R{devRounds}` label (and the two log lines that name the
// round).
//
// EXPLICIT STATE, NOT A CLOSURE. The inline version read roughly twenty
// runSprintCycle/round-loop locals off the enclosing scope. They arrive as
// one explicit state argument now, including `sprintState` -- the per-sprint
// resolved state from ../sprint-state.mjs, which the post-dispatch
// verifyDoerStreakClosed() read genuinely consumes -- and `parallel`, the
// workflow seam the per-worklist fan-out runs through. `perBeadFeedback` is a
// Map this phase only READS (the reviewer populates it); nothing here
// reassigns a caller binding, which is why the two values Review needs come
// back as an ordinary return value rather than being threaded.
//
// WHY THE RUNNER HELPERS ARE INJECTED RATHER THAN IMPORTED. claimBeadsBatched,
// verifyDoerStreakClosed, normalizeTierToken and kbQueryTerms are all exported
// BY runner.js. Importing them here would make phases/develop.mjs <->
// runner.js a circular pair for the sake of four helpers, so they come through
// the state argument instead -- the same rule phases/plan.mjs's header states.
// The dependencies that live in real sibling modules (dispatchRole/TURN_BASES,
// the prompt builders, the worklist/streak functions, policyFor, the error
// classes) are imported directly.
//
// GUARD COVERAGE: registered as 'phases/develop.mjs' in ../guarded-modules.mjs.
// It carries NO command() call site of its own -- every bd read/write it needs
// goes through an injected runner helper or a gitSync bracket -- plus the two
// dispatchRole call sites for the streak-assignment and doer ladders.
// =============================================================================

import { WorkflowError } from '@apralabs/apra-fleet-workflow';

import { dispatchRole, TURN_BASES } from '../dispatch-role.mjs';
import { buildStreakAssignmentPrompt, buildDoerPrompt } from '../prompts.mjs';
import {
    selectStreaks, groupStreaksFromLaneMetadata, streakRequiredTier,
    resolveWorklistTierPolicy, hasContextHeadroomForResume, assignDoerWorklists,
} from '../worklists.mjs';
import { isPostDispatchSyncFailure } from '../errors.mjs';
import { policyFor } from '../role-policies.mjs';

/**
 * Runs ONE Develop round: streak grouping, per-doer worklist packing, and the
 * serialized doer streak turns, with per-streak outcome attribution.
 *
 * @param {object} state Explicit phase state; see this file's header.
 * @returns {Promise<{
 *   streakOutcomes: object[],
 *   readyTitleById: Map<string, string>,
 * }>} `streakOutcomes` is this round's per-streak attribution (the Review
 *   phase filters its scope off it); `readyTitleById` is the stable
 *   (title, id) sort key Review's evidence command and reviewer prompt use so
 *   the non-deterministic completion order of parallel doer dispatches never
 *   leaks into a prompt.
 */
export async function runDevelopPhase({
    // Presentation + dispatch seams.
    phase,
    log,
    command,
    parallel,
    dispatchCtx,
    // Sprint identity/config.
    cycle,
    validated,
    args,
    orchestratorMember,
    // Per-sprint resolved state (../sprint-state.mjs), the git/beads sync
    // brackets every doer dispatch and verification read goes through, and the
    // dashboard refresh each completed streak turn triggers.
    sprintState,
    gitSync,
    updateDashboard,
    // The KB clients the doer prompt is primed from.
    kbPriming,
    kbWork,
    // Per-round inputs. `devRounds` arrives already incremented (see header);
    // `perBeadFeedback` is read-only here.
    devRounds,
    currentReady,
    doerPool,
    perBeadFeedback,
    // Injected runner helpers -- see the header for why these are not imports.
    claimBeadsBatched,
    verifyDoerStreakClosed,
    normalizeTierToken,
    kbQueryTerms,
}) {
    phase(`Develop C${cycle} R${devRounds}`);

    // --- Streak grouping ------------------------------------------
    // PREFER deterministic grouping straight from the planner's lane
    // metadata (`streak`/`streakOrder`, emitted per planner.md through
    // the same `--metadata` channel as `model`), intersected with THIS
    // round's ready set. When every ready bead carries a `streak` id the
    // grouping is fully determined by the plan, so the runtime "Streak
    // Assignment" LLM dispatch is skipped entirely -- deterministic,
    // zero prompt drift, one fewer agent round-trip. The LLM path below
    // is retained ONLY as a fallback for plans that lack lane metadata;
    // see groupStreaksFromLaneMetadata() for the all-or-nothing rule.
    let streaks, usedFallback, reason;
    const laneGrouping = groupStreaksFromLaneMetadata(currentReady);
    if (laneGrouping) {
        ({ streaks, reason } = laneGrouping);
        usedFallback = false;
        log(
            `Streak grouping: deterministic from lane metadata -- ${laneGrouping.streaks.length} streak(s), ` +
            `no Streak Assignment dispatch (${laneGrouping.streaks.map((s) => `[${s.map((b) => b.id).join(', ')}]`).join(' ')}).`
        );
    } else {
    // --- Streak assignment (FALLBACK) ---------------------------------
    // Reached only when the plan lacks lane metadata (see above).
    // Schema-validated {streaks: string[][]}; falls back to a
    // deterministic one-bead-per-streak grouping whenever the candidate
    // does not cover every ready bead id exactly once -- invalid output,
    // or agent()'s own bounded schema-repair loop exhausted. See
    // selectStreaks().
    log('Streak grouping: no lane metadata on this round\'s ready beads -- falling back to LLM Streak Assignment dispatch (back-compat with pre-eft.76 plans).');
    // apra-fleet-3swo.5.3: the 'streak-assignment' row of
    // role-policies.mjs, executed by dispatchRole. That row owns the
    // one variance nothing else in the table has -- NO git-sync
    // bracket at all, because this is pure compute with no repo access
    // -- plus the deliberate absence of an agentType (this call has no
    // vendored persona of its own; see the streakAssignment schema
    // comment in contracts.mjs, and activating the full `planner`
    // persona on this narrow grouping task makes the model go
    // exploring with its Bash/Read/Grep tools instead of answering
    // from the prompt, which can run long enough to hit the transport
    // timeout), the planner MEMBER borrowed purely for model-tier
    // routing, its own cheap tier, and the transport-default budgets.
    //
    // The bounded semantic-repair re-ask is the row's
    // `semanticRepairReAsks: 1` plus its `select-streaks-validate`
    // postResult step: agent()'s own schema-repair only fixes
    // JSON-shape problems, so a candidate can be schema-valid yet
    // semantically invalid (e.g. bead ids returned with their prefix
    // stripped). Dropping the whole grouping to the one-bead-per-streak
    // fallback silently discards sequencing intent, which on a
    // multi-doer fleet would PARALLELIZE beads the model said must run
    // sequentially. The engine re-asks ONCE with the exact validation
    // failure -- guarded, never looped -- and only then falls back.
    //
    // `validate` is that step: selectStreaks() is what decides whether
    // the fallback is used, and the engine hands its result back as
    // `validation` on BOTH the success path and the degrade path (a
    // spent ladder validates a null candidate, which is exactly the
    // deterministic one-bead-per-streak grouping the old ladder fell
    // back to).
    const streakPrompt = buildStreakAssignmentPrompt({ readyBeadIds: currentReady.map((b) => b.id) });
    const streakOutcome = await dispatchRole(dispatchCtx, 'streak-assignment', {
        prompt: streakPrompt,
        label: 'Streak Assignment',
        repairPrompt: (rejectionReason) => streakPrompt
            + `\n\nYour previous answer was REJECTED: ${rejectionReason}. `
            + 'Return the bead ids exactly as listed -- verbatim, full prefix included.',
        repairLabel: 'Streak Assignment (semantic repair)',
        roleLabel: 'Streak Assignment',
        validate: (candidate) => {
            const selected = selectStreaks(candidate, currentReady);
            return { ok: !selected.usedFallback, reason: selected.reason, result: selected };
        },
    });
    // No duplicate log() dump -- see dispatchReview() for why. The
    // standard AGENT row (label 'Streak Assignment') already renders
    // through the same generic path as every other dispatch.
    ({ streaks, usedFallback, reason } = streakOutcome.validation);
    if (usedFallback) {
        log(`Streak Assignment: using one-bead-per-streak fallback (${reason}).`);
    }
    } // end LLM-fallback branch (no lane metadata)
    // Title lookup for the assignedBeadIds sort below. Doer dispatches
    // run in `parallel`, so the order their outcomes are recorded in is
    // completion order -- correctly non-deterministic. The Review
    // phase's `bd show` evidence command and reviewer prompt must not
    // inherit that race as prompt drift; see the sort-by-title comment
    // above for why `title` is the only stable key.
    const readyTitleById = new Map(currentReady.map((b) => [b.id, b.title]));

    // beadId -> declared model tier, read out of the SAME `bd list
    // --ready --json` response already fetched to build `currentReady`:
    // that response carries each bead's full record including metadata,
    // so no extra `bd show` round-trip is needed to recover the `model`
    // key the planner records via `--metadata`. See resolveDoerModel()
    // for how a possibly-multi-bead streak's model is picked from this
    // map. normalizeTierToken() guards this single read site -- see its
    // doc comment.
    const modelByBeadId = new Map(currentReady.map((b) => [b.id, normalizeTierToken(b.metadata && b.metadata.model)]));

    // --- Doer barrier: serialized turns, isolated failures ---
    // Streak turns are strictly serialized through `globalDoerTurn`: a
    // promise chain each turn awaits before doing any work and releases
    // in a `finally`, so at most one doer dispatch is ever in flight and
    // a thrown streak can never deadlock the next one. Serialization is
    // required because concurrent writers break the
    // fast-forward-by-construction invariant the git/beads sync brackets
    // depend on. parallel() with continueOnError is retained only for
    // per-worklist failure isolation and outcome accounting.
    let globalDoerTurn = Promise.resolve();
    const streakOutcomes = [];

    // --- Per-doer ORDERED WORKLISTS -----------------------------------
    // When this round has more ready streaks than doers, pack them into
    // per-doer ordered worklists (dependency order -> priority -> the
    // existing tie-break, plus tier grouping and an effort budget -- see
    // assignDoerWorklists) instead of feeding one streak per doer. Each
    // doer then works its worklist back to back: mode 'resume' (the
    // default) re-dispatches per streak, resuming the SAME doer session
    // by explicit session id so warm context carries across streaks
    // while every engine checkpoint (sync bracket, per-streak failure
    // attribution) is kept BETWEEN streaks; mode 'batch' sends one
    // dispatch carrying the whole ordered worklist. When streaks <=
    // doers, assignDoerWorklists is a pass-through.
    const worklistMode = validated.doerWorklistMode || 'resume';
    const { tierHomogeneous } = resolveWorklistTierPolicy({
        mode: worklistMode,
        resumeModelSwitch: validated.resumeModelSwitch === true,
    });
    const worklistPacking = assignDoerWorklists(streaks, doerPool.length, {
        effortBudget: validated.worklistEffortBudget,
        tierHomogeneous,
    });
    if (worklistPacking.packed) {
        const fmtStreak = (s) => `(${s.map((b) => b.id).join(', ')})`;
        const fmtWorklist = (wl) => `[${wl.map(fmtStreak).join(' -> ')}]`;
        log(
            `Doer worklists: ${streaks.length} ready streak(s) > ${doerPool.length} doer(s) -- ` +
            `packed into per-doer ordered worklists (mode: ${worklistMode}, ` +
            `${tierHomogeneous ? 'tier-homogeneous' : 'mixed tiers allowed (resume_model_switch)'}): ` +
            worklistPacking.worklists.map((wl, i) => `doer '${doerPool[i % doerPool.length]}': ${fmtWorklist(wl)}`).join('; ') +
            (worklistPacking.overflow.length > 0
                ? `; overflow queued to the next round (effort budget/tier grouping): ${worklistPacking.overflow.map(fmtStreak).join(' ')}`
                : '')
        );
    }

    // One streak's full dispatch turn (claim -> dispatch -> verify ->
    // attribute), run once per streak of a worklist. Each call captures
    // and replaces the global gate synchronously, before its first
    // `await`, so the FIRST turn of each worklist enqueues in
    // deterministic worklist order; subsequent turns of a worklist
    // enqueue as their predecessors complete.
    // `worklistCtx` carries the doer's session id + last reported usage
    // across the streaks of ONE worklist (never across worklists/doers);
    // `batchStreaks` (mode 'batch') is the ordered list of sub-streaks a
    // single merged dispatch carries, for per-streak outcome
    // attribution.
    const runStreakTurn = async ({ streak, doerMember, worklistCtx, worklistPosition = 0, worklistLength = 1, packed = false, batchStreaks = null }) => {
        const priorTurn = globalDoerTurn;
        let releaseTurn;
        globalDoerTurn = new Promise((resolve) => { releaseTurn = resolve; });
        await priorTurn;
        try {
        let actualBeadIds = streak.map((b) => b.id);  // May be reduced by claiming if assignee is set
        let hasClaimedBeads = false;  // Track whether we've done claiming yet

        // The base turn budget the resume ladder escalates from. Read
        // out of the ENGINE's TURN_BASES (apra-fleet-3swo.5.7) rather
        // than re-declared here: the 'doer' policy row records its turn
        // budget symbolically, by the NAME of this constant, and a
        // second copy in runner.js is a second thing to drift.
        const BASE_DOER_MAX_TURNS = TURN_BASES.BASE_DOER_MAX_TURNS;
        // apra-fleet-3swo.5.7: the doer ladder -- its dispatch, its
        // pushCode/pushBeads git-sync bracket, its bounded escalating
        // max_turns resume ladder, its closed-streak short-circuit, its
        // refusal to re-dispatch a streak whose post-dispatch sync
        // failed, its auth self-heal plus bounded retry, its generic
        // retry onto the streak branch's remote tip, and its per-bead
        // attribution degrade -- is now the 'doer'/'doer-resume' rows of
        // fleet-sprint/role-policies.mjs, executed by dispatchRole.
        //
        // THREE things make this ladder different from every other one,
        // and all three are expressed as data:
        //
        //  1. The claim runs INSIDE the bracket. Per-bead claiming is
        //     only meaningful once the bracket's D-pull has brought in
        //     which beads other sprints already hold, so
        //     'claim-beads-batched' is one of role-policies.mjs's
        //     PRE_DISPATCH_STEPS_IN_BRACKET. It can NARROW the streak,
        //     which is why the prompt, the label and the tier this
        //     dispatch is priced at are all built by `prepare` -- inside
        //     the bracket, after the claim -- rather than passed in.
        //
        //  2. The resume ladder ESCALATES and is bounded. The row records
        //     resumeAttempts: 2 and a 'runtime' turn budget; the bindings
        //     thunk below is handed the attempt number and doubles from
        //     the base each time. A resume that fails for any reason
        //     other than spending its turns again is not something more
        //     turns can fix, and the engine stops escalating there.
        //
        //  3. A turn-exhausted streak whose beads are ALL already closed
        //     is a SUCCESS, not a failure -- the doer merely ran past its
        //     VERIFY checkpoint. That is the 'verify-streak-closed'
        //     preDispatch step on the RESUME dispatch, recorded before
        //     'kill-stale-session' precisely so the check happens before
        //     anything is killed or re-dispatched, and it short-circuits
        //     the resume entirely.
        //
        // The per-bead attribution below is what the CALLER does with a
        // failed outcome, so it stays here: the row's degrade is
        // 'per-bead-attribution' and fabricates nothing.
        const streakScope = () => `[${actualBeadIds.join(', ')}]`;
        const doerOutcome = await dispatchRole(dispatchCtx, 'doer', {
            roleLabel: `Doer streak ${streakScope()}`,
            // Never used: `prepare` builds both prompts, because both
            // depend on the streak the claim actually secured.
            prompt: null,
            resumePrompt: null,
            onSessionId: (id, meta) => {
                if (!worklistCtx) return;
                worklistCtx.sessionId = id;
                worklistCtx.usage = meta && meta.usage ? meta.usage : null;
            },
            // The escalating resume ladder: BASE * 2^n, bounded by the
            // row's resumeAttempts. resumeAttempt 0 is the main
            // dispatch, which takes its budget from the row's constant.
            bindings: ({ resumeAttempt }) => ({
                doerMember,
                maxTurns: BASE_DOER_MAX_TURNS * (2 ** Math.max(resumeAttempt, 1)),
            }),
            // Claim once per streak turn, after the D-pull. Batched into
            // ONE bd update id-list --claim --json call
            // (apra-fleet-7h6n.7) instead of one call per bead -- see the
            // claimBeadsBatched doc comment above for the verified
            // multi-id --claim contract (non-atomic, JSON-array-only
            // success signal) this relies on.
            claimBeads: async () => {
                if (hasClaimedBeads) return;
                hasClaimedBeads = true;
                if (!validated.assignee) return;
                const { claimedBeadIds, skippedBeadIds } = await claimBeadsBatched({
                    command, orchestratorMember, beadIds: actualBeadIds, log,
                });
                if (claimedBeadIds.length === 0) {
                    // All beads in this streak are already claimed by
                    // other sprints. Skip this streak entirely.
                    log(`Doer streak: all beads ${streakScope()} are already claimed by other sprints -- skipping this streak.`);
                    throw new WorkflowError(
                        `All beads already claimed by other sprints`,
                        { beadIds: actualBeadIds, reason: 'all-beads-already-claimed' }
                    );
                }
                if (skippedBeadIds.length > 0) {
                    actualBeadIds = claimedBeadIds; // Only the successfully claimed ones
                }
            },
            // CRITICAL: never trust the doer's own success claim -- verify
            // via `bd show` that the assigned bead ids are actually
            // closed. verifyDoerStreakClosed() D-pulls the orchestrator's
            // OWN beads clone BEFORE this read: the doer closed its beads
            // in ITS clone and D-pushed them, so on a multi-member sprint
            // the orchestrator's clone is a DIFFERENT clone and without
            // that D-pull this read sees stale (still-open) status and
            // EVERY remote doer streak is falsely marked FAILED.
            // (apra-fleet-p2to.4.1) it D-pulls internally
            // (DoltSync.syncBefore) -- treat the whole call as one bracket.
            verifyStreakClosed: async (phase) => {
                const unclosed = await gitSync.withOpenSyncBracket(() => verifyDoerStreakClosed({
                    command, orchestratorMember, beadIds: actualBeadIds, log, args, sprintState,
                }));
                if (phase === 'preDispatch' && unclosed.length === 0) {
                    log(
                        `Doer streak ${streakScope()} on member '${doerMember}' exhausted its turn limit ` +
                        '(max_turns), but all assigned bead id(s) are already closed -- WARNING: the doer ' +
                        'missed the VERIFY checkpoint (kept running after its last bd close instead of ' +
                        'stopping). Treating this streak as a successful completion, not a failure; ' +
                        'issuing NO resume dispatch.'
                    );
                }
                return unclosed;
            },
            // Built INSIDE the bracket, after the claim: the streak this
            // dispatch actually owns is only known once the claim has run.
            prepare: async ({ dispatch, resumeAttempt }) => {
                if (dispatch.kind === 'max-turns-resume') {
                    const resumeTurns = BASE_DOER_MAX_TURNS * (2 ** resumeAttempt);
                    log(
                        `Doer streak ${streakScope()} on member '${doerMember}' exhausted its turn limit ` +
                        `(max_turns) -- resuming the same session with max_turns=${resumeTurns} ` +
                        `(attempt ${resumeAttempt}/${policyFor('doer').retry.resumeAttempts}) instead of ` +
                        'giving up or regrouping.'
                    );
                    return {
                        // Restate the streak's scope: a resumed dispatch
                        // replaces the delivered prompt artifact, so a
                        // bare "continue" leaves the session with no
                        // record of what it was asked to do.
                        prompt:
                            'Continue exactly where you left off from this same session -- do not restart, re-read from scratch, or re-plan. ' +
                            `Your scope, restated so a resumed dispatch never loses it: assigned bead id(s) ${actualBeadIds.join(', ')} on sprint branch ${validated.branch}. ` +
                            'Pick up from your last action on those bead(s) and proceed to the VERIFY checkpoint.',
                        label: `Streak ${streakScope()} (resume, max_turns=${resumeTurns})`,
                    };
                }

                const feedbackForStreak = actualBeadIds
                    .map((id) => perBeadFeedback.get(id))
                    .filter(Boolean)
                    .join('\n\n');

                // Resolve the model to price this dispatch against. Beads
                // are normally streaked one-per-model, but when a streak
                // DOES span beads with different declared models this
                // deterministically picks the first (by bead-id order, not
                // dispatch completion order) and logs the discrepancy
                // rather than guessing a blended price. A bead with no
                // `model` metadata resolves to `undefined`, which
                // FleetWorkflow treats the same as never passing `model`
                // -- the dispatch still runs, it is simply not priced
                // (calculateCost() returns null; see pricing.mjs).
                // CAVEAT: this is the model the PLANNER ASKED the doer to
                // run on. The fleet does not echo back the model it
                // actually resolved/ran with, so this -- and therefore
                // budget._spent / BudgetExceededError -- is an ESTIMATE,
                // not a verified actual.
                const streakModels = [...new Set(actualBeadIds.map((id) => modelByBeadId.get(id)).filter(Boolean))];
                let doerModel = streakModels[0];
                // In a PACKED worklist round a streak must never dispatch
                // below its REQUIRED tier (the max of its beads' declared
                // models) -- override the first-bead pick with that tier.
                // The non-packed (streaks <= doers) path keeps the
                // first-bead behavior.
                if (packed) {
                    const requiredTier = streakRequiredTier(streak);
                    if (requiredTier) doerModel = requiredTier;
                }
                if (streakModels.length > 1) {
                    log(`Doer streak ${streakScope()} spans beads with different declared models (${streakModels.join(', ')}) -- pricing this dispatch as '${doerModel}'.`);
                }

                // Mode (ii) RESUMED SEQUENCE: resume the doer's OWN
                // prior-streak session by EXPLICIT session id when one was
                // captured for this worklist and
                // hasContextHeadroomForResume() passes. On refusal, or
                // when no session id exists (first streak of the worklist,
                // provider without resume support, prior streak failed),
                // fall back to a FRESH session carrying the FULL prompt --
                // never a delta prompt into a fresh session.
                let worklistResumeArg = false;
                if (worklistCtx && worklistCtx.sessionId) {
                    if (hasContextHeadroomForResume(worklistCtx.usage)) {
                        worklistResumeArg = worklistCtx.sessionId;
                    } else {
                        log(
                            `Doer worklist on '${doerMember}': context headroom insufficient to resume session ` +
                            `'${worklistCtx.sessionId}' for streak ${worklistPosition + 1}/${worklistLength} ` +
                            `${streakScope()} -- starting a FRESH session with the full prompt instead.`
                        );
                        worklistCtx.sessionId = null;
                        worklistCtx.usage = null;
                    }
                }
                if (worklistResumeArg) {
                    log(
                        `Doer worklist on '${doerMember}': dispatching streak ${worklistPosition + 1}/${worklistLength} ` +
                        `${streakScope()} as a RESUME of session '${worklistResumeArg}'` +
                        `${doerModel ? ` (model=${doerModel})` : ''} -- warm context carries over.`
                    );
                }

                // The doer cannot read the KB itself (the member's
                // composed permission config disables the fleet MCP
                // server), so the entries primed for THIS member travel in
                // its prompt. Relevance-ranked read for THESE beads,
                // falling back to the sprint-start primed set when the
                // query returns nothing. The query terms are the bead ids
                // and titles the engine already holds; expand_related on
                // that call is what traverses the refines/contradiction_of
                // edges.
                const doerRepoPath = kbPriming.folderOf(doerMember);
                const doerKnowledge = await kbWork.relevantKnowledge(doerRepoPath, kbQueryTerms(streak, actualBeadIds));
                const basePrompt = buildDoerPrompt({
                    beadIds: actualBeadIds,
                    branch: validated.branch,
                    feedback: feedbackForStreak || null,
                    kbKnowledge: doerKnowledge.length > 0 ? doerKnowledge : kbPriming.knowledgeOf(doerMember),
                });
                let doerPrompt = basePrompt;
                if (batchStreaks) {
                    // Mode (i) BATCH: one dispatch carries the whole
                    // ordered worklist. The prompt names each streak
                    // boundary and mandates strict in-order completion.
                    doerPrompt =
                        'ORDERED MULTI-STREAK WORKLIST (single batched dispatch): your assigned beads below form ' +
                        `${batchStreaks.length} streak(s). Work them strictly in this order, fully completing each ` +
                        'streak (implement, verify, `bd close` its beads) before starting the next: ' +
                        batchStreaks.map((s, i) => `streak ${i + 1}: [${s.map((b) => b.id).join(', ')}]`).join('; ') +
                        '.\n\n' + basePrompt;
                } else if (worklistResumeArg) {
                    // A resumed dispatch restates its FULL scope (the
                    // entire buildDoerPrompt output), never a bare
                    // "continue" delta -- the preamble only tells the
                    // session it may reuse its warm context.
                    doerPrompt =
                        'WORKLIST CONTINUATION: you are the same doer session that just completed the previous ' +
                        'streak of your worklist. Your warm context (repository layout, conventions, files already ' +
                        'read) carries over -- do not re-explore the repository from scratch. Your NEXT assigned ' +
                        'streak follows, with its scope restated in full.\n\n' + basePrompt;
                }
                return {
                    prompt: doerPrompt,
                    label: `Streak ${streakScope()}`,
                    resumeArg: worklistResumeArg,
                    bindings: { doerMember, doerModel },
                };
            },
        });
        const report = doerOutcome.value;
        const dispatchError = doerOutcome.error;
        // A streak that needed a second dispatch of any kind -- a generic
        // retry or a turn-exhaustion resume -- is recorded as retried.
        const wasRetried = doerOutcome.attempts > 1 || doerOutcome.resumesIssued > 0;
        if (dispatchError) {
            // A dispatch-level failure means this worklist's captured
            // session can no longer be trusted (the failed attempt may
            // have run partial turns in it) -- clear it so the worklist's
            // NEXT streak starts from a FRESH session with the full
            // prompt, mirroring createRoundSessionRegistry's
            // clear-on-failure rule. (The max-turns ladder is unaffected:
            // it resumes the member's last session via `resume: true`,
            // not this id.)
            if (worklistCtx) {
                worklistCtx.sessionId = null;
                worklistCtx.usage = null;
            }
            if (isPostDispatchSyncFailure(dispatchError)) {
                log(`Doer streak ${streakScope()} on member '${doerMember}' COMPLETED but its post-dispatch sync failed: ${dispatchError.message} Not re-dispatching -- the work is already committed locally.`);
            } else if (doerOutcome.resumesIssued > 0) {
                log(`Doer streak ${streakScope()} on member '${doerMember}' still failing after ${doerOutcome.resumesIssued} resume attempt(s) (last: ${dispatchError.message}) -- flagging as too-complex-for-one-streak.`);
            }
        }

        if (dispatchError) {
            // Per-bead failure attribution: a dispatch-level throw
            // (crash, transport error, exhausted resumes) does NOT mean
            // none of this streak's beads closed -- a doer can close bead
            // 1 of 2, then error out on bead 2. Verify via `bd show`
            // (same D-pull-then-read as the happy path below) rather than
            // assuming every bead in the streak is still open, so
            // completed work is never discarded because a sibling in the
            // same streak was never reached.
            // (apra-fleet-p2to.4.1) verifyDoerStreakClosed() D-pulls internally
            // (DoltSync.syncBefore) -- treat the whole call as one sync bracket.
            const unclosedIds = await gitSync.withOpenSyncBracket(() => verifyDoerStreakClosed({
                command, orchestratorMember, beadIds: actualBeadIds, log, args, sprintState,
            }));
            const closedIds = actualBeadIds.filter((id) => !unclosedIds.includes(id));
            log(`Doer streak attribution [${actualBeadIds.join(', ')}]: closed=[${closedIds.join(', ')}] failed=[${unclosedIds.join(', ')}] (dispatch error: ${dispatchError.message}).`);
            if (batchStreaks) {
                // Mode (i): PER-STREAK attribution for a failed batch
                // dispatch -- a sub-streak whose beads all verifiably
                // closed before the failure keeps its work (outcome
                // 'success', its closes stand and go to review); only
                // sub-streaks with still-open beads are 'failed' and
                // re-lane next round.
                for (const sub of batchStreaks) {
                    const subIds = sub.map((b) => b.id).filter((id) => actualBeadIds.includes(id));
                    if (subIds.length === 0) continue;
                    const subUnclosed = subIds.filter((id) => unclosedIds.includes(id));
                    const subClosed = subIds.filter((id) => !subUnclosed.includes(id));
                    streakOutcomes.push({
                        beadIds: subIds, doerMember, wasRetried, report: null,
                        unclosedIds: subUnclosed, closedIds: subClosed,
                        outcome: subUnclosed.length > 0 ? 'failed' : 'success',
                        ...(subUnclosed.length > 0 ? { error: dispatchError.message } : {}),
                    });
                }
            } else {
                streakOutcomes.push({
                    beadIds: actualBeadIds, doerMember, outcome: 'failed', wasRetried,
                    report: null, unclosedIds, closedIds, error: dispatchError.message,
                });
            }
            // Rethrow so parallel()'s continueOnError:true isolates
            // this failure from sibling streaks (the outcome above
            // is already recorded via closure, so no information is
            // lost when parallel() substitutes `null` for this branch).
            throw dispatchError;
        }

        // No duplicate log() dump of `report` here -- see dispatchReview()
        // for why. The doer streak's own AGENT row already carries this
        // verbatim as its `output`, and its label names the bead ids.

        // CRITICAL: never trust the doer's own success claim -- verify
        // via `bd show` that the assigned bead ids are actually closed. A
        // doer that returns a success-looking report but leaves a bead
        // open is treated as a FAILED streak regardless of what it said.
        //
        // apra-fleet-3swo.5.7: that verification is the 'doer' row's
        // 'verify-streak-closed' postResult step, which the engine ran
        // immediately after the successful dispatch -- read its answer
        // back off the outcome rather than doing the (D-pulling) read a
        // second time. The row's 'kb-apply' step ran right after it:
        // the doer decides what to capture and the engine executes it
        // against the repo THAT doer worked in.
        const unclosedIds = doerOutcome.stepResults['verify-streak-closed'];
        const closedIds = actualBeadIds.filter((id) => !unclosedIds.includes(id));

        // apra-fleet-eft.76.4: per-bead failure attribution -- always
        // emitted (not only when something failed) so every streak's
        // report leaves an audit trail of exactly which beads closed
        // vs which stayed open. Closed beads stay closed regardless
        // of a sibling bead in the same streak being refused; only
        // the still-open ones are eligible for re-laning next round
        // (the next dev round's `currentReady` query naturally omits
        // whatever already closed here).
        log(`Doer streak attribution [${actualBeadIds.join(', ')}]: closed=[${closedIds.join(', ')}] failed=[${unclosedIds.join(', ')}].`);

        if (unclosedIds.length > 0) {
            log(`Doer streak [${actualBeadIds.join(', ')}] reported status '${report ? report.status : 'unknown'}' but bead(s) still open: ${unclosedIds.join(', ')} -- treating streak as FAILED.`);
        }

        if (batchStreaks) {
            // Mode (i): PER-STREAK outcome attribution for the batch
            // dispatch -- one outcome per sub-streak, so review scope and
            // re-laning stay per-streak exactly as in mode (ii).
            for (const sub of batchStreaks) {
                const subIds = sub.map((b) => b.id).filter((id) => actualBeadIds.includes(id));
                if (subIds.length === 0) continue;
                const subUnclosed = subIds.filter((id) => unclosedIds.includes(id));
                const subClosed = subIds.filter((id) => !subUnclosed.includes(id));
                streakOutcomes.push({
                    beadIds: subIds, doerMember, wasRetried, report,
                    unclosedIds: subUnclosed, closedIds: subClosed,
                    outcome: subUnclosed.length > 0 ? 'failed' : (wasRetried ? 'retried' : 'success'),
                });
            }
        } else {
            streakOutcomes.push({
                beadIds: actualBeadIds, doerMember, wasRetried, report, unclosedIds, closedIds,
                outcome: unclosedIds.length > 0 ? 'failed' : (wasRetried ? 'retried' : 'success'),
            });
        }
        await updateDashboard();
        } finally {
            releaseTurn();
        }
    };

    await parallel(worklistPacking.worklists, async (worklist, index) => {
        if (!worklist || worklist.length === 0) return;  // a packed round can leave a doer idle
        const doerMember = doerPool[index % doerPool.length];
        // Per-worklist session context: the doer's captured session id +
        // last reported usage, carried across the streaks of THIS
        // worklist only -- never across doers or rounds.
        const worklistCtx = { sessionId: null, usage: null };

        if (worklistMode === 'batch' && worklist.length > 1) {
            // Mode (i) BATCH: one dispatch carries the whole ordered
            // worklist (assignDoerWorklists guarantees it is
            // tier-homogeneous). Per-streak outcomes are attributed
            // after the fact via `batchStreaks`.
            await runStreakTurn({
                streak: worklist.flat(),
                doerMember,
                worklistCtx,
                packed: worklistPacking.packed,
                batchStreaks: worklist,
            });
            return;
        }

        // Mode (ii) RESUMED SEQUENCE (default): one dispatch per streak,
        // in worklist order, each going through the SAME global FIFO
        // gate (runStreakTurn acquires it per streak) and the same
        // git/dolt sync brackets -- so every engine checkpoint is kept
        // BETWEEN streaks. A failure in streak N is recorded and
        // isolated: streaks 1..N-1's closes already stand (per-bead
        // attribution), and N+1.. still dispatch (fresh session -- the
        // catch clears the worklist session so a broken session is
        // never resumed).
        let firstError = null;
        for (let wIdx = 0; wIdx < worklist.length; wIdx++) {
            try {
                await runStreakTurn({
                    streak: worklist[wIdx],
                    doerMember,
                    worklistCtx,
                    worklistPosition: wIdx,
                    worklistLength: worklist.length,
                    packed: worklistPacking.packed,
                });
            } catch (err) {
                firstError = firstError || err;
                worklistCtx.sessionId = null;
                worklistCtx.usage = null;
            }
        }
        // Rethrow (after ALL streaks ran) so parallel()'s
        // continueOnError:true accounting records this worklist's
        // failure.
        if (firstError) throw firstError;
    }, { continueOnError: true });

    log(`Develop C${cycle} R${devRounds} streak outcomes: ${JSON.stringify(streakOutcomes.map((o) => ({ beadIds: o.beadIds, outcome: o.outcome })))}`);

    // The two values the Review phase (still inline in runner.js, in this same
    // round loop iteration) reads out of this round -- see the return shape in
    // this function's doc comment.
    return { streakOutcomes, readyTitleById };
}
