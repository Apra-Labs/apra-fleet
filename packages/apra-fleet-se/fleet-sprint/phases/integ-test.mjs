// =============================================================================
// PHASE MODULE: Integ Test (apra-fleet-3swo.6.8).
//
// The SEVENTH of runSprintCycle's twelve phase() boundaries -- the per-cycle
// integration-test pass against the build the Deploy phase just stood up. It
// scopes the run (this cycle's open features plus the verify-set beads whose
// children have ALL closed), dispatches the integ-test-runner ladder, records
// the verdict -- PASSED, FAILED or INCONCLUSIVE, the last being an infra
// dispatch failure that produced no verdict at all -- and applies the
// verify-fail bounce cap to any gap bug filed under a verify-set parent. Moved
// verbatim out of runner.js: every prompt, log line, dispatch option, branch
// and bd command is byte-identical to the inline version, so the golden
// transcript is unchanged. Move-only, no behaviour change.
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
// monotone Set feeding the stall-abort's still-open-verify report) and
// `verifyGapCounts` (the Map the bounce cap counts in) -- which is exactly
// equivalent to the closure it replaces, because runner.js never reassigns
// those bindings either.
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
// ensureDeployPermissions, budget and VERIFY_GAP_LIMIT are all
// runSprintCycle-scoped (several of them context-overridable seams), so there
// is nothing to import. parseBdJson is exported BY runner.js; importing it here
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
// keep seeing after the slice.
// =============================================================================

import { dispatchRole, TURN_BASES } from '../dispatch-role.mjs';
import { classifyVerifySet } from '../beads-scope.mjs';

/**
 * Runs the per-cycle Integ Test phase.
 *
 * @param {object} state Explicit phase state; see this file's header.
 * @returns {Promise<{
 *   verifySetForIntegTest: string[],
 *   integTestRunnerDispatchCount: number,
 *   integTestRunnerSpend: number,
 * }>} The three REASSIGNED values described in the header. Every other output
 *   of this phase is an in-place mutation of an array/Set/Map the caller still
 *   holds (`integFailures`, `verifyEverIds`, `verifyGapCounts`).
 */
export async function runIntegTestPhase({
    // Presentation + dispatch seams.
    phase,
    log,
    command,
    dispatchCtx,
    // Sprint identity/config.
    cycle,
    targetIssues,
    orchestratorMember,
    sprintSelfIdLine,
    // The per-sprint budget meter -- read for this phase's own spend delta.
    budget,
    // Mutated in place; never reassigned by this phase (see header).
    integFailures,
    verifyEverIds,
    verifyGapCounts,
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
    parseBdJson,
    updateDashboard,
    VERIFY_GAP_LIMIT,
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
    // integ-test-playbook.md owns no sandbox, no smoke test, and no
    // real-bd suite -- those belong to regression-test-playbook.md,
    // dispatched once per sprint in Finalization below.
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
        resumeLabel: `Integ Test (resume, max_turns=${TURN_BASES.INTEG_TEST_MAX_TURNS * 2})`,
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
    // apra-fleet-jfo D6: verify-fail bounce cap. A gap bug filed under a
    // verify-set parent makes that parent structurally ineligible again
    // at next classification (its child count now includes an open bug)
    // -- no sticky "bounced" flag is needed for the round-trip itself.
    // This only tracks HOW MANY TIMES a given parent has bounced, so a
    // parent that keeps failing verification is deferred rather than
    // looping forever.
    if (Array.isArray(integResult.bugsFiled) && integResult.bugsFiled.length > 0 && verifySetForIntegTest.length > 0) {
        for (const bugId of integResult.bugsFiled) {
            try {
                const bugShowRaw = await command(`bd show ${bugId} --json`, { member_name: orchestratorMember, silent: true });
                const bugBeads = parseBdJson(bugShowRaw, `bd show ${bugId} --json`);
                const parentId = Array.isArray(bugBeads) ? bugBeads[0]?.parent : bugBeads?.parent;
                if (!parentId || !verifySetIdSet.has(parentId)) continue;
                const gapCount = (verifyGapCounts.get(parentId) ?? 0) + 1;
                verifyGapCounts.set(parentId, gapCount);
                if (gapCount > VERIFY_GAP_LIMIT) {
                    log(`Verify-route bounce cap: ${parentId} has failed verification ${gapCount} time(s) this sprint (limit ${VERIFY_GAP_LIMIT}) -- deferring rather than bouncing again.`);
                    await command(
                        `bd update ${parentId} --status=deferred --append-notes "Deferred by the verify-route bounce cap: failed integration-test verification ${gapCount} times this sprint (limit ${VERIFY_GAP_LIMIT}). Latest gap: ${bugId}."`,
                        { member_name: orchestratorMember, silent: true }
                    );
                } else {
                    log(`Verify-route bounce: ${parentId} failed verification (gap bug ${bugId} filed), attempt ${gapCount}/${VERIFY_GAP_LIMIT} -- will re-route to plan/develop once ${bugId} closes.`);
                }
            } catch (bugLookupErr) {
                log(`Verify-route bounce-cap lookup for ${bugId} failed (non-fatal, cap tracking skipped for this bug): ${bugLookupErr.message}`);
            }
        }
    }
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

    return { verifySetForIntegTest, integTestRunnerDispatchCount, integTestRunnerSpend };
}
