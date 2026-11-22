// =============================================================================
// PHASE MODULE: Integ Test (apra-fleet-3swo.6.8).
//
// The SEVENTH of runSprintCycle's twelve phase() boundaries -- the per-cycle
// integration-test pass against the build the Deploy phase just stood up. It
// scopes the run (this cycle's open features plus the verify-set beads whose
// children have ALL closed), dispatches the integ-test-runner ladder, records
// the verdict -- PASSED, FAILED or INCONCLUSIVE, the last being an infra
// dispatch failure that produced no verdict at all -- and returns the gap
// bugs it filed. Moved verbatim out of runner.js: every prompt, log line,
// dispatch option, branch and bd command is byte-identical to the inline
// version, so the golden transcript is unchanged.
//
// The verify-fail bounce cap on those gap bugs lives in this file too
// (applyVerifyGapAccounting, exported below) but is NOT called from the
// phase: runner.js calls it after Cycle Evaluation's backlog D-pull, because
// the integ runner's new bug beads reach the backlog clone only through that
// pull when the integ runner is a different member (see its doc comment).
//
// WHERE THIS PHASE STARTS AND STOPS. It is the body of runSprintCycle's
// `if (hasPlaybook && deployedThisCycle)` branch, and nothing else. The two
// `probeFileExists` runbook probes that produce `hasPlaybook`/`deployedThisCycle`,
// the `let verifySetForIntegTest = []` declaration hoisted ABOVE that `if`
// (apra-fleet-66u.2 -- Cycle Evaluation reads it whether or not this phase
// ran) and both `else` branches' "Skipping Integration Test Phase" log lines
// all stay in runner.js: the probes decide WHETHER this phase runs at all, and
// the flags they produce are read by phases this one does not own. Same
// boundary rule as ./deploy.mjs's `if (hasDeploy)` branch and ./replan.mjs's
// `if (eligibleReplan.length > 0)` one. The trailing `await updateDashboard()`
// IS part of this phase -- unlike Review's, it is the last statement of the
// phase's own branch body rather than the surrounding loop's continue/break
// decision.
//
// EXPLICIT STATE, NOT A CLOSURE -- AND WHY THREE VALUES COME BACK. The inline
// version read its inputs off the enclosing runSprintCycle scope; they arrive
// as one explicit state argument now. What this phase writes is mostly
// MUTATED IN PLACE on objects the caller still holds -- `integFailures` (an
// array it pushes a FAILED/INCONCLUSIVE record onto), `verifyEverIds` (the
// monotone Set feeding the stall-abort's still-open-verify report) --
// which is exactly equivalent to the closure it replaces, because runner.js
// never reassigns those bindings either.
//
// Three values are genuinely REASSIGNED rather than mutated, so they cannot
// travel that way and are returned instead: `verifySetForIntegTest` (reset to
// [] then re-derived from classifyVerifySet every dispatch attempt, and read
// afterwards by Cycle Evaluation's verifyDispatchAttempts/verifyDispatchClosures
// tracking), `integTestRunnerDispatchCount` and `integTestRunnerSpend` (the two
// per-phase cost accumulators buildCostAnalysis() reports at Harvest time).
// All three are also passed IN, so the caller's single destructuring
// assignment restores them and no `if` is needed at the call site.
//
// WHY SOME HELPERS ARE INJECTED RATHER THAN IMPORTED. bdListScoped,
// fetchAllBeadsShared, updateDashboard, getMemberForRole, ensureUnattendedAuto,
// ensureDeployPermissions, budget and (for applyVerifyGapAccounting)
// VERIFY_GAP_LIMIT are all runSprintCycle-scoped (several of them
// context-overridable seams), so there is nothing to import. parseBdJson
// (applyVerifyGapAccounting) is exported BY runner.js; importing it here
// would make phases/integ-test.mjs <-> runner.js a circular pair for the sake
// of one helper, so it comes through the state argument instead -- the same
// rule ./plan.mjs's, ./develop.mjs's and ./review.mjs's headers state. The one
// dependency that lives in a real sibling module -- classifyVerifySet from
// ../beads-scope.mjs -- is imported directly, even though runner.js also
// re-exports it.
//
// GUARD COVERAGE: registered as 'phases/integ-test.mjs' in
// ../guarded-modules.mjs. It took TWO member_name-bearing command() call sites
// out of runner.js -- the bounce cap's `bd show <bugId> --json` parent lookup
// and its `bd update <parentId> --status=deferred --append-notes` deferral --
// plus the ONE dispatchRole call site for the integ-test-runner ladder, which
// is exactly what dispatch-safety-guard and the phase 3 dispatch census must
// keep seeing after the slice. Both command() call sites now live in
// applyVerifyGapAccounting, still in this file.
// =============================================================================

import { dispatchRole, secondaryMaxTurns } from '../dispatch-role.mjs';
import { classifyVerifySet } from '../beads-scope.mjs';
import { markBounceCapDeferral } from '../verify-carry-over.mjs';

/**
 * Runs the per-cycle Integ Test phase.
 *
 * @param {object} state Explicit phase state; see this file's header.
 * @returns {Promise<{
 *   verifySetForIntegTest: string[],
 *   integTestRunnerDispatchCount: number,
 *   integTestRunnerSpend: number,
 *   integVerifyOutcome: { dispatchedIds: string[], gapParentIds: string[], bugsFiled: string[], leftOpenReasons: Map<string, string>, summary: string, inconclusive: boolean },
 * }>} The three REASSIGNED values described in the header, plus this
 *   dispatch's per-verify-bead outcome for the needs-external-evidence count
 *   (its gapParentIds stay empty until the caller runs
 *   applyVerifyGapAccounting() on its bugsFiled after the backlog D-pull).
 *   Every other output of this phase is an in-place mutation of an
 *   array/Set the caller still holds (`integFailures`, `verifyEverIds`).
 */
export async function runIntegTestPhase({
    // Presentation + dispatch seams.
    phase,
    log,
    dispatchCtx,
    // Sprint identity/config.
    cycle,
    targetIssues,
    sprintSelfIdLine,
    // The per-sprint budget meter -- read for this phase's own spend delta.
    budget,
    // Mutated in place; never reassigned by this phase (see header).
    integFailures,
    verifyEverIds,
    // Verify-routed ids carried over as needs-external-evidence
    // (../verify-carry-over.mjs): never dispatched to verify again this run.
    excludedVerifyIds = null,
    // Reassigned, so passed in and returned (see header).
    verifySetForIntegTest,
    integTestRunnerDispatchCount,
    integTestRunnerSpend,
    // runSprintCycle-scoped locals and runner.js-exported helpers, injected
    // rather than imported (see header).
    getMemberForRole,
    ensureUnattendedAuto,
    ensureDeployPermissions,
    bdListScoped,
    fetchAllBeadsShared,
    updateDashboard,
}) {
    phase(`Integ Test C${cycle}`);
    await ensureUnattendedAuto(getMemberForRole('integ-test-runner'));
    await ensureDeployPermissions(getMemberForRole('integ-test-runner'));
    // apra-fleet-nwh.1: snapshot the running total BEFORE this
    // cycle's Integ Test dispatch(es) so the delta after (below) is
    // this phase's own spend, not the whole run's. budget.spent()
    // may be absent on an injected test double; that degrades to
    // "not tracked" exactly like buildCostAnalysis()'s own total
    // spend line already does, never a thrown error.
    const integSpendBefore = typeof budget?.spent === 'function' ? budget.spent() : null;
    integTestRunnerDispatchCount += 1;
    let integResult;
    // Set when the integ dispatch failed for an INFRASTRUCTURE reason
    // (empty_response / inactivity timeout / orphan-recovery timeout)
    // rather than producing a real pass/fail verdict -- recorded as
    // INCONCLUSIVE below instead of a false passed:false FAIL. Carries
    // {reason, message} for the note.
    let integInfraInconclusive = null;
    // apra-fleet-jfo: verifySetForIntegTest is now declared at the
    // outer per-cycle scope (apra-fleet-66u.2, just above this `if`
    // block) rather than here, so the bounce-cap logic after the
    // try/catch AND Cycle Evaluation's dispatch-outcome tracking can
    // both still see it even when the try block throws early or
    // never runs at all. Reset to empty at the top of every dispatch
    // attempt regardless -- an early-thrown dispatch simply skips the
    // bounce-cap block below (its `verifySetForIntegTest.length > 0`
    // guard short-circuits).
    verifySetForIntegTest = [];
    let verifySetIdSet = new Set();
    // apra-fleet-3swo.5.7: the try/catch that used to wrap this whole
    // block was the integ ladder's degrade, which is now the
    // 'integ-test-runner' policy row executed by dispatchRole. Nothing
    // else it covered was ever caught by it: the bd scope reads below
    // throw CommandError, which the old catch's final `else` rethrew
    // anyway, so removing the wrapper changes no failure path.
    // integ-test-runner.md's contract requires "an explicit list of
    // feature ids ... already scoped for you by the orchestrator" as
    // a required input, and forbids the agent from deriving that list
    // itself via a bare, unscoped `bd list --type=feature`. Fetch the
    // scope's open features here and name them explicitly -- always
    // dispatch, even with zero open features this cycle: deploy
    // succeeded and a playbook exists, so this phase runs regardless,
    // per the fixed per-cycle phase sequence every other
    // cycle-evaluation check in this file assumes.
    const openFeatures = await bdListScoped('--type=feature --status=open --json');
    // apra-fleet-jfo: replaces the old bug-only pendingClosureBugs
    // derivation. Any issue_type qualifies (bug, feature, task-parent,
    // epic); classified against the FULL unfiltered project bead list
    // (fetchAllBeadsShared, not a scope-filtered subset) so an
    // out-of-scope open child still blocks eligibility. These beads
    // have no other closure owner: doers refuse non-task beads,
    // reviewers may not close, and the plain feature prompt below only
    // names features -- without this they would linger open at goal
    // priority forever. The integ runner has bead-closing authority
    // and pushBeads: true, so it owns verify-set closure.
    ({ verifyIds: verifySetForIntegTest } = classifyVerifySet(await fetchAllBeadsShared(), targetIssues));
    // A verify-routed bead carried over as needs-external-evidence is not
    // re-dispatched: two consecutive passes could neither confirm nor refute
    // it on these members, so another pass only burns a cycle.
    if (excludedVerifyIds && excludedVerifyIds.size > 0) {
        const skipped = verifySetForIntegTest.filter((id) => excludedVerifyIds.has(id));
        if (skipped.length > 0) {
            verifySetForIntegTest = verifySetForIntegTest.filter((id) => !excludedVerifyIds.has(id));
            log(`Integ Test C${cycle}: not re-dispatching ${skipped.length} verify-routed bead(s) carried over as needs-external-evidence: ${skipped.join(', ')}`);
        }
    }
    // apra-fleet-66u.2: a bead can become verify-eligible AFTER
    // this cycle's Route step already ran (e.g. its last child
    // closes during THIS cycle's own Develop/Review, before
    // Deploy/IntegTest) -- this classifyVerifySet call, not the
    // Route step's, is what first discovers it. Feed it into
    // verifyEverIds here too so the exit-gate's
    // stillOpenVerifyIds safety net (further down) never has a
    // same-cycle blind spot for a bead that was genuinely just
    // dispatched to verify but not yet closed.
    for (const id of verifySetForIntegTest) verifyEverIds.add(id);
    verifySetIdSet = new Set(verifySetForIntegTest);
    // Dedupe: a feature already in the verify set gets the stronger
    // verify clause below (real evidence, gap filed under itself), not
    // also the generic "run tests for this feature" line.
    const openFeaturesNotInVerifySet = openFeatures.filter((f) => !verifySetIdSet.has(f.id));
    const verifyClause = verifySetForIntegTest.length > 0
        ? ` Additionally, these bead(s) have ALL their children closed and await ` +
          `verification-closure: ${verifySetForIntegTest.join(', ')}. For each, verify against the ` +
          `deployed build per the playbook. If your pass shows the underlying work holds (the ` +
          `defect no longer reproduces, or the feature behaves as specified), close it (bd close) ` +
          `with a note citing the commands run and the observed output. If it does NOT hold, leave ` +
          `it open and file a bug describing the gap with evidence, parented under THAT bead ` +
          `specifically (--parent <that bead's own id>, NOT ${targetIssues[0]}) -- filing it under ` +
          `the right parent is required so the gap is correctly attributed and that parent is ` +
          `re-routed to development next cycle instead of staying stuck in verify.`
        : '';
    // The per-cycle Integ Test phase is FEATURE CLOSURE ONLY:
    // whole-product regression checks belong to the target's
    // regression-test-playbook.md, dispatched once per sprint in
    // Finalization below.
    const featurePrompt = (openFeaturesNotInVerifySet.length > 0
        ? `Run tests using integ-test-playbook.md, for these open feature id(s) only: ` +
          `${openFeaturesNotInVerifySet.map((f) => f.id).join(', ')}. Add bug beads if needed, filed under ` +
          `--parent ${targetIssues[0]}.`
        : `Run tests using integ-test-playbook.md. No open type=feature beads are in scope ` +
          `this cycle -- report nothing to test. Add bug beads if needed, filed under ` +
          `--parent ${targetIssues[0]}.`) + verifyClause +
        // Generic hand-off to a target that deploys an isolated test
        // instance per sprint (see sprintSelfIdLine above): the
        // playbook, not this engine, says how to locate it from the
        // id and what tearing it down means.
        `\n${sprintSelfIdLine}\n` +
        `If this cycle's deploy stood up an isolated test instance for this sprint, the playbook ` +
        `says how to locate it from that id; tear it down before you return, pass or fail.`;
    // integ-test-runner does NOT touch code (pushCode: false, no git
    // push) but it DOES mutate beads -- it closes passing features
    // and files bug beads -- so it must D-push those mutations
    // (pushBeads: true), a D-push with no git push. G-pull before,
    // no-op G-push after.
    // apra-fleet-3swo.5.7: the integ ladder -- its dispatch, its
    // pushBeads git-sync bracket, its max_turns-exhaustion resume
    // at doubled turns, its ONE bounded infra-failure recovery
    // resume, its auth self-heal and its degrade -- is now the
    // 'integ-test-runner' row of fleet-sprint/role-policies.mjs.
    //
    // WHY THE INCONCLUSIVE PATH IS POLICY DATA. An INFRA dispatch
    // failure (empty_response / inactivity timeout / orphan-recovery
    // timeout) is NOT a test verdict: the runner's CLI died mid-turn
    // or lost its result envelope without ever reporting pass or
    // fail. Recording it as passed:false is a false negative that
    // blocks the sprint's confidence check on an infra fault. The
    // row says this as data: degrade.classifiesInfraFailures makes
    // 'infra' a class of its own, retry.infraResumeAttempts spends
    // ONE session resume trying to recover it (the run may have made
    // real progress and merely lost its envelope, and the resume
    // prompt already restates the full scope), and 'infra' is
    // deliberately absent from degrade.classes so the engine
    // fabricates no report for it -- it returns an `inconclusive`
    // record instead, which is what this call site turns into an
    // INCONCLUSIVE cycle entry below.
    //
    // The max_total_s ceiling is a HARD kill regardless of activity
    // and surfaces as a plain AgentDispatchError, so it gets real
    // headroom (INTEG_MAX_TOTAL_S) while the shorter INACTIVITY
    // timer still kills a genuinely hung runner. Both budgets are
    // named symbolically by the row.
    const integOutcome = await dispatchRole(dispatchCtx, 'integ-test-runner', {
        prompt: featurePrompt,
        // A resumed dispatch DELIVERS A NEW PROMPT ARTIFACT to the
        // member (replacing the original one, e.g. .fleet-task.md),
        // so a bare "continue" resume erases the dispatch's scope
        // from the artifact a contract may treat as its scope source
        // of truth. Every resume prompt that carries per-dispatch
        // scope must restate it.
        resumePrompt:
            'Continue the integration test run exactly where you left off in this same session -- do not restart the playbook or rebuild the sandbox if it is already up. Finish the remaining suites, close passing features / file bugs per your contract, and return your final report now. ' +
            'Your original scope, restated so a resumed dispatch never loses it: ' + featurePrompt,
        roleLabel: 'Integ Test Runner',
        resumeLabel: `Integ Test (resume, max_turns=${secondaryMaxTurns('integ-test-runner')})`,
    });
    integResult = integOutcome.value;
    integInfraInconclusive = integOutcome.inconclusive;
    if (integInfraInconclusive) {
        // integResult is stubbed only so downstream references stay
        // defined; the integInfraInconclusive branch below owns what
        // actually gets recorded.
        integResult = {
            featuresClosed: 0,
            issuesCreated: 0,
            passed: false,
            bugsFiled: [],
            summary: `Integ test runner infra dispatch failure (${integInfraInconclusive.reason}): ${integInfraInconclusive.message}`,
        };
    }
    // No duplicate log() dump -- see dispatchReview() for why.
    //
    // Feature closure is judged against the features' own `[test]` tasks
    // in the branch working tree, which is inherently current, so no
    // SHA-freshness gate is needed here.
    //
    // An infra dispatch failure (empty_response / inactivity timeout /
    // orphan-recovery timeout) produced no test verdict at all, and must
    // be recorded INCONCLUSIVE -- tagged and worded distinctly -- so the
    // final reviewer/harvester can tell an infra fault apart from real
    // test evidence, and it is never counted as a genuine pass or fail.
    // Checked BEFORE `passed` because the stubbed integResult carries no
    // meaningful verdict.
    if (integInfraInconclusive) {
        const inconclusiveNote = `INCONCLUSIVE (infra dispatch failure -- ${integInfraInconclusive.reason}; the member CLI produced no test verdict): ${integInfraInconclusive.message}`;
        integFailures.push({ cycle, notes: inconclusiveNote, bugsFiled: [], inconclusive: true });
        log(`Integration tests INCONCLUSIVE this cycle (C${cycle}): infra dispatch failure (${integInfraInconclusive.reason}) -- not accepted as pass or fail evidence.`);
    } else if (integResult.passed !== true) {
        // Never swallow a failure just because the agent chose to (or
        // didn't) file bugs -- `passed` is the source of truth, checked
        // explicitly and propagated below regardless of
        // `bugsFiled.length`.
        integFailures.push({ cycle, notes: integResult.summary, bugsFiled: integResult.bugsFiled });
        log(`Integration tests FAILED this cycle (C${cycle}, bugsFiled: ${integResult.bugsFiled.join(', ') || 'none'}): ${integResult.summary}`);
    } else {
        // apra-fleet-4bg: a successful/no-op cycle previously produced NO
        // log line at all, making it indistinguishable from a silent
        // contract violation (an agent that never touched its scope but
        // still reported passed:true). Log every outcome, not just
        // failures.
        log(`Integration tests PASSED this cycle (C${cycle}): ${integResult.featuresClosed} feature(s) closed, ${integResult.issuesCreated} bug(s) filed. ${integResult.summary}`);
    }
    // apra-fleet: Step 1c in integ-test-runner.md requires out-of-scope
    // failures observed during verification to be cross-linked or filed,
    // not silently dropped just because the cycle otherwise passed.
    if (Array.isArray(integResult.observedFailures) && integResult.observedFailures.length > 0) {
        log(`Integration tests C${cycle}: ${integResult.observedFailures.length} out-of-scope failure(s) observed and tracked -- ` +
            integResult.observedFailures.map((f) => `${f.test} (${f.cause}) -> ${f.beadId}`).join(' | '));
    }
    // The verify-fail bounce cap (which verify-set parent each filed gap bug
    // belongs to) is NOT applied here: the integ runner D-pushed its new bug
    // beads from its own member, and the backlog clone only D-pulls them at
    // Cycle Evaluation. runner.js calls applyVerifyGapAccounting() (below)
    // right after that pull, with the bugsFiled this phase returns.
    // apra-fleet-nwh.1: fold this cycle's Integ Test spend (dispatch
    // plus any resume/retry inside the try/catch above) into the
    // running total buildCostAnalysis() reports at Harvest time. A
    // negative/NaN delta (a test double whose spent() does not
    // monotonically increase) is clamped to 0 rather than corrupting
    // the accumulator.
    if (integSpendBefore !== null && typeof budget?.spent === 'function') {
        const delta = budget.spent() - integSpendBefore;
        if (Number.isFinite(delta) && delta > 0) integTestRunnerSpend += delta;
    }
    await updateDashboard();

    // What this dispatch said about each verify-set bead it was handed, for
    // Cycle Evaluation's engine-derived needs-external-evidence count
    // (../verify-carry-over.mjs). The count itself is the engine's: whether
    // the bead is still open is read from live state there, and a gap bug
    // from the bounce-cap lookup above. The runner's own verifySetLeftOpen
    // reason is carried only as the human-readable reason. An infra dispatch
    // failure produced no verdict, so it is flagged and neither counts nor
    // resets.
    const leftOpenReasons = new Map();
    if (Array.isArray(integResult.verifySetLeftOpen)) {
        for (const e of integResult.verifySetLeftOpen) {
            if (e && typeof e.id === 'string' && typeof e.reason === 'string') leftOpenReasons.set(e.id, e.reason);
        }
    }
    const integVerifyOutcome = {
        dispatchedIds: [...verifySetForIntegTest],
        // Filled in by runner.js from applyVerifyGapAccounting() after Cycle
        // Evaluation's backlog D-pull; empty until then.
        gapParentIds: [],
        bugsFiled: Array.isArray(integResult.bugsFiled) ? integResult.bugsFiled.filter((id) => typeof id === 'string' && id) : [],
        leftOpenReasons,
        summary: typeof integResult.summary === 'string' ? integResult.summary : '',
        inconclusive: Boolean(integInfraInconclusive),
    };

    return { verifySetForIntegTest, integTestRunnerDispatchCount, integTestRunnerSpend, integVerifyOutcome };
}

/**
 * The verify-fail bounce cap, applied to the gap bugs one Integ Test dispatch
 * filed (apra-fleet-jfo D6). A gap bug filed under a verify-set parent makes
 * that parent structurally ineligible again at next classification (its child
 * count now includes an open bug) -- no sticky "bounced" flag is needed for
 * the round-trip itself. This only tracks HOW MANY TIMES a given parent has
 * bounced, so a parent that keeps failing verification is deferred rather
 * than looping forever.
 *
 * WHEN IT RUNS. The integ-test-runner files its gap bugs on its OWN member
 * and D-pushes them; the backlog clone sees them only after it D-pulls, which
 * happens at Cycle Evaluation. runner.js therefore calls this right after
 * Cycle Evaluation's fatal backlog D-pull and before the exit-gate math --
 * never from inside runIntegTestPhase, where the lookup would read a clone
 * that has not yet pulled the integ member's push whenever the integ runner
 * is a different member. No extra D-pull is issued here.
 *
 * A LOOKUP MISS IS LOUD. A `bd show <bug>` that still fails after that pull
 * means the bounce cap and the needs-external-evidence reset cannot see this
 * gap: it is logged as a WARN naming the bug and pushed onto integFailures
 * (Final Review and the sprint report read it), never skipped silently.
 *
 * @param {object} state
 * @returns {Promise<{ gapParentIds: string[], lookupMisses: string[] }>}
 *   gapParentIds: verify-set parents a gap bug was filed under (read by the
 *   needs-external-evidence count -- a gap bug is a real verdict, so it resets
 *   that bead's inconclusive count). lookupMisses: the bug ids whose lookup
 *   failed.
 */
export async function applyVerifyGapAccounting({
    log,
    command,
    cycle,
    backlogMember,
    // The gap bugs the integ dispatch reported (integVerifyOutcome.bugsFiled).
    bugsFiled,
    // The verify-set ids that dispatch was handed (integVerifyOutcome.dispatchedIds).
    verifySetIds,
    // Mutated in place.
    verifyGapCounts,
    integFailures,
    // Verify-routed ids the bounce cap deferred this run, id -> reason
    // (../verify-carry-over.mjs): added to in place when a parent is
    // deferred, so the exit gate drops it and names it as a deferred
    // carry-over. Optional.
    deferredVerifyIds = null,
    parseBdJson,
    VERIFY_GAP_LIMIT,
}) {
    const gapParentIds = new Set();
    const lookupMisses = [];
    const verifySetIdSet = new Set(verifySetIds || []);
    if (!Array.isArray(bugsFiled) || bugsFiled.length === 0 || verifySetIdSet.size === 0) {
        return { gapParentIds: [], lookupMisses };
    }
    for (const bugId of bugsFiled) {
        let parentId;
        try {
            const bugShowRaw = await command(`bd show ${bugId} --json`, { member_name: backlogMember, silent: true });
            const bugBeads = parseBdJson(bugShowRaw, `bd show ${bugId} --json`);
            parentId = Array.isArray(bugBeads) ? bugBeads[0]?.parent : bugBeads?.parent;
        } catch (bugLookupErr) {
            const detail = bugLookupErr && bugLookupErr.message ? bugLookupErr.message : String(bugLookupErr);
            const note = `Verify-route gap-bug lookup MISSED for ${bugId} after the backlog D-pull: verify bounce-cap tracking and the needs-external-evidence reset were skipped for this bug, so its parent's gap count is not recorded. ${detail}`;
            log(`WARN: ${note}`);
            integFailures.push({ cycle, notes: note, bugsFiled: [bugId], gapLookupMiss: true });
            lookupMisses.push(bugId);
            continue;
        }
        if (!parentId || !verifySetIdSet.has(parentId)) continue;
        gapParentIds.add(parentId);
        const gapCount = (verifyGapCounts.get(parentId) ?? 0) + 1;
        verifyGapCounts.set(parentId, gapCount);
        if (gapCount > VERIFY_GAP_LIMIT) {
            log(`Verify-route bounce cap: ${parentId} has failed verification ${gapCount} time(s) this sprint (limit ${VERIFY_GAP_LIMIT}) -- deferring rather than bouncing again.`);
            try {
                await command(
                    `bd update ${parentId} --status=deferred --append-notes "Deferred by the verify-route bounce cap: failed integration-test verification ${gapCount} times this sprint (limit ${VERIFY_GAP_LIMIT}). Latest gap: ${bugId}."`,
                    { member_name: backlogMember, silent: true }
                );
            } catch (deferErr) {
                const detail = deferErr && deferErr.message ? deferErr.message : String(deferErr);
                const note = `Verify-route bounce cap could not defer ${parentId} (latest gap ${bugId}): the deferral write failed, so it is not carried over as deferred. ${detail}`;
                log(`WARN: ${note}`);
                integFailures.push({ cycle, notes: note, bugsFiled: [bugId] });
                continue;
            }
            if (deferredVerifyIds) {
                markBounceCapDeferral(deferredVerifyIds, parentId, `deferred by the verify-route bounce cap after failing verification ${gapCount} times (latest gap: ${bugId})`);
            }
        } else {
            log(`Verify-route bounce: ${parentId} failed verification (gap bug ${bugId} filed), attempt ${gapCount}/${VERIFY_GAP_LIMIT} -- will re-route to plan/develop once ${bugId} closes.`);
        }
    }
    return { gapParentIds: [...gapParentIds], lookupMisses };
}
