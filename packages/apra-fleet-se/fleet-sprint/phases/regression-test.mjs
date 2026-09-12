// =============================================================================
// PHASE MODULE: Regression Test (apra-fleet-3swo.6.6).
//
// The TENTH of runSprintCycle's twelve phase() boundaries -- the sprint's
// standing, once-per-sprint confidence check that EXISTING functionality still
// works. Moved verbatim out of runner.js: every prompt, log line and dispatch
// option is byte-identical to the inline version, so the golden transcript is
// unchanged. Move-only, no behaviour change.
//
// WHERE THIS PHASE STARTS AND STOPS. It is the body of the
// `if (hasRegressionPlaybook)` branch, and nothing else. The
// probeFileExists('regression-test-playbook.md') call that PRODUCES
// hasRegressionPlaybook, the `let regressionResult = null` it defaults to, and
// the "Skipping Regression Test Phase" else branch all stay in runner.js --
// exactly as ./deploy.mjs's deploy.md probe and ./integ-test.mjs's runbook
// probes stayed behind. The trailing `await updateDashboard()` inside that
// branch comes WITH the phase, same as ./integ-test.mjs's does.
//
// WHY IT SITS WHERE IT SITS -- THIS IS THE SAFETY PROPERTY, NOT A PREFERENCE.
// This phase runs AFTER Final Review and BEFORE Harvest, and both halves of
// that sandwich are load-bearing:
//
//   - After Final Review, because `finalVerdictResult` is ALREADY COMPUTED by
//     the time this runs -- so a regression failure structurally CANNOT perturb
//     the sprint's verdict. No LLM-trusted "please ignore this" instruction is
//     needed; the ordering IS the guarantee. That guarantee is enforced by TWO
//     TEST PINS, not by the language: this phase never so much as NAMES
//     finalVerdictResult, so there is no binding for a hoist above Final Review
//     to trip a ReferenceError on -- verified by experiment (apra-fleet-3swo.38)
//     that hoisting this phase's call site above Final Review runs to
//     completion with no error. test/regression-phase-never-gates.test.mjs's
//     source-shape ordering pin and the A/B mock sprint in
//     test/mock-sprint-regression-failure-never-gates.test.mjs are what
//     actually hold the line; ./final-review.mjs RETURNING finalVerdictResult
//     to runner.js documents the intended order for a reader, it does not
//     enforce it.
//   - Before Harvest, because the harvester writes
//     docs/sprint-analysis-<slug>.md and this phase's summary is folded into
//     that document as an informational section (see buildAnalysisText).
//
// Its failures are filed as STANDALONE, PARENT-LESS `[regression][carry-over]`
// beads: bdListScoped() builds the sprint's scope tree by walking `.parent`
// edges only, so a parent-less bead is mechanically invisible to openAtGoal /
// finalOpenAtGoal, and a regression failure therefore carries over to a future
// sprint instead of retroactively blocking the sprint that happened to find it.
//
// NO CATCH BLOCK HERE, BY DESIGN. This phase is informational and must never
// abort the sprint, but the soft-fail that guarantees it is NOT a try/catch in
// this file -- it is the 'regression-test-runner' row's catch-all degrade in
// ../role-policies.mjs, executed by ../dispatch-role.mjs (apra-fleet-3swo.5.7).
// Do not reintroduce a local catch: the row already enumerates every class it
// fabricates a summary for, states that unrecognised classes degrade too, and
// names the only two signals it deliberately rethrows (an operator cancellation
// and a blown spend ceiling, both RUN-level control signals rather than "the
// regression phase failed"). See the comment kept at the dispatch below.
//
// WHY ITS HELPERS ARE INJECTED RATHER THAN IMPORTED. dispatchCtx,
// getMemberForRole, ensureUnattendedAuto, ensureDeployPermissions,
// updateDashboard and sprintSelfIdLine are all runSprintCycle-scoped locals, so
// there is nothing to import; dispatchRole/TURN_BASES live in a real sibling
// module and are imported directly.
//
// GUARD COVERAGE: registered as 'phases/regression-test.mjs' in
// ../guarded-modules.mjs. It took NO member_name-bearing command() call site
// out of runner.js -- it issues no bd/git command of its own; the carry-over
// beads are filed by the DISPATCHED runner inside its own repo -- but it took
// ONE dispatchRole() site (the regression-test-runner ladder), which is exactly
// what dispatch-safety-guard and the phase 3 dispatch census read. Both
// baselines are pinned rather than assumed.
// =============================================================================

import { dispatchRole, TURN_BASES } from '../dispatch-role.mjs';

/**
 * Runs the once-per-sprint Regression Test phase. Informational: its result
 * never gates the sprint (see this file's header for why the ordering, not a
 * flag, is what guarantees that).
 *
 * @param {object} state Explicit phase state; see this file's header.
 * @returns {Promise<{ regressionResult: object|null }>} The regression report
 *   the dispatched runner returned (or the policy row's degraded stand-in),
 *   which runner.js folds into the sprint analysis document.
 */
export async function runRegressionTestPhase({
    // Presentation + dispatch seams.
    phase,
    log,
    dispatchCtx,
    // Sprint identity/config.
    finalCycleLabel,
    sprintSelfIdLine,
    // Reassigned, so passed in and returned (see header).
    regressionResult,
    // runSprintCycle-scoped locals, injected rather than imported (see header).
    getMemberForRole,
    ensureUnattendedAuto,
    ensureDeployPermissions,
    updateDashboard,
}) {
    phase(`Regression Test C${finalCycleLabel}`);
    await ensureUnattendedAuto(getMemberForRole('regression-test-runner'));
    await ensureDeployPermissions(getMemberForRole('regression-test-runner'));
    // The real functional suite alone spends roughly one turn per liveness
    // poll for the better part of an hour, and this single dispatch carries
    // both it and the sandbox smoke sprint -- hence the large turn budget
    // and the wider hard ceiling.
    const regressionPrompt =
        `Run the full regression pass using regression-test-playbook.md at the repo root: part 1 ` +
        `(the real functional suite) and part 2 (the sandbox smoke test), then ALWAYS run the ` +
        `playbook's Teardown before returning, pass or fail. ` +
        `File every failure you find as a STANDALONE bead: run bd create WITHOUT any --parent flag ` +
        `and do NOT bd dep add it to any sprint bead, titled "[regression][carry-over] <description>". ` +
        `Search bd for "[carry-over]" first and update an existing bead rather than filing a duplicate. ` +
        `Filing these parent-less is what makes them carry over to a future sprint instead of blocking ` +
        `this one -- do not "helpfully" parent them under a sprint bead. ` +
        `This sprint's verdict has already been decided and your result is informational: report it ` +
        `honestly, and never soften a failure because the sprint has otherwise passed.\n` +
        // Same generic hand-off as the integ prompt: a leftover isolated
        // test instance from this sprint's deploy (Deploy succeeded but
        // Integ Test never ran) is the playbook's to sweep, keyed on the id.
        `${sprintSelfIdLine}\n` +
        `If an isolated test instance from this sprint's deploy is still up, the playbook says how to ` +
        `locate it from that id; tear it down too before you return.`;
    // apra-fleet-3swo.5.7: the regression ladder -- its dispatch, its
    // pushBeads git-sync bracket, its max_turns-exhaustion resume at
    // doubled turns, its refusal to re-dispatch a pass that already ran,
    // and its load-bearing CATCH-ALL degrade -- is now the
    // 'regression-test-runner' row of fleet-sprint/role-policies.mjs.
    //
    // WHY THE CATCH-ALL IS POLICY DATA AND NOT A try/catch HERE: this
    // phase is informational and must never abort the sprint. The dispatch
    // is bracketed with pushBeads:true, and this is the ONE phase whose
    // whole job is mutating beads (filing carry-over bugs), so a D-push
    // failure is a routine outcome. Among the classes it can throw are
    // typed sprint aborts (GitDivergedError, DoltDivergedError bare or
    // wrapped in a PostDispatchSyncError) -- without the catch-all the
    // top-level handler would turn one into a terminal verdict:'ABORTED',
    // skipping Harvest AND Publish PR and discarding an already-computed
    // finalVerdictResult. A green sprint would be reported as ABORTED
    // because an informational pass could not push a bug bead. The row
    // says all of that as data: degrade.classes lists all four error
    // classes it fabricates a summary for, and
    // degrade.classifiesUnrecognisedErrors is what stops an unknown class
    // from escaping.
    //
    // Two deliberate exceptions, both RUN-level control signals rather than
    // "the regression phase failed", recorded as
    // degrade.rethrowsRunControlSignals: CancelledError (honouring an
    // operator cancellation outranks finishing an informational phase) and
    // BudgetExceededError (swallowing a blown spend ceiling would let
    // Harvest keep spending past a limit the operator set).
    const regressionOutcome = await dispatchRole(dispatchCtx, 'regression-test-runner', {
        prompt: regressionPrompt,
        // A resume DELIVERS A NEW prompt artifact, so restate the
        // dispatch's scope/filing rules -- a bare "continue" would lose the
        // parent-less filing rule, which is the whole point of this phase.
        resumePrompt:
            'Continue the regression pass exactly where you left off in this same session -- do not restart the playbook or rebuild the sandbox if it is already up. Finish the remaining work, run Teardown, and return your final report now. ' +
            'Your original instructions, restated so a resumed dispatch never loses them: ' + regressionPrompt,
        roleLabel: 'Regression Test Runner',
        resumeLabel: `Regression Test (resume, max_turns=${TURN_BASES.REGRESSION_TEST_MAX_TURNS * 2})`,
    });
    regressionResult = regressionOutcome.value;
    // No duplicate log() dump -- see dispatchReview() for why. Only an
    // explicit passed:true is treated as a green regression pass.
    if (regressionResult.passed !== true) {
        log(`Regression pass reported FAILURES (carry-over beads: ${(regressionResult.bugsFiled || []).join(', ') || 'none'}): ${regressionResult.summary}`);
    } else {
        log(`Regression pass PASSED (suite: ${regressionResult.suitePassed}, smoke: ${regressionResult.smokePassed}).`);
    }
    await updateDashboard();

    return { regressionResult };
}
