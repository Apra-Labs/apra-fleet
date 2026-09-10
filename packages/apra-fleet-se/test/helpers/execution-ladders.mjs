// Shared data: the execution-side dispatch-pin table.
//
// Sibling of ./planning-ladders.mjs, and it exists for the same two reasons:
// so a pin TABLE can be read by more than one test file without re-running
// that file's tests, and so the dispatchRole migration
// (apra-fleet-3swo.5.3/.5.7) has somewhere to MOVE a pin to rather than
// delete it.
//
// This file is PURE DATA -- no functions, no SRC-scanning, no test()/
// describe() calls.
//
// TWO LISTS, ONE PER SIDE OF THE MIGRATION (read planning-ladders.mjs's
// header for the full reasoning; it is identical):
//
//   EXECUTION_INLINE_LADDERS   -- ladders still hand-written in runner.js.
//                                 Their facts are properties of runner.js
//                                 SOURCE TEXT, so their fields are source
//                                 EXPRESSIONS ("getMemberForRole('deployer')")
//                                 and the pin file asserts them with the
//                                 textual scanner. This is the pre-migration
//                                 shape, moved here verbatim.
//
//   EXECUTION_ENGINE_DISPATCHES -- dispatches now served by the ONE generic
//                                 agent() call in fleet-sprint/dispatch-role.
//                                 mjs. Their facts are not textual (the engine
//                                 resolves member/model/budgets/bracket from
//                                 the frozen ROLE_POLICIES row at run time),
//                                 so they carry RESOLVED values and are
//                                 asserted BEHAVIOURALLY -- the pin file runs
//                                 the real engine against a recording ctx and
//                                 observes what it actually passes.
//
// MIGRATING A ROLE MOVES ITS TWO ENTRIES from the first list to the second.
// Nothing is dropped in the move: only the way each fact is PROVED changes
// (source text -> executed behaviour). The per-pin inventory mapping each
// pre-migration assertion to its post-migration replacement is in
// execution-role-dispatch-pins.test.mjs's header.
//
// WHY THE CENSUS STILL ADDS UP: execution-role-dispatch-pins.test.mjs asserts
// PLANNING_LADDERS.length + EXECUTION_INLINE_LADDERS.length equals the real
// agent() site count in the scanned module set. PLANNING_LADDERS contributes
// exactly ONE entry -- the engine's own call site -- and that single site
// serves BOTH sides' engine dispatches, which is why migrating an execution
// ladder shortens EXECUTION_INLINE_LADDERS by two and adds nothing to the
// census: the site those two pins used to name is gone, and the site their
// replacements run through was already counted.

/**
 * Every dispatch the dispatchRole engine serves on the EXECUTION side, with
 * the values it must RESOLVE for each. Same field vocabulary as
 * planning-ladders.mjs's ENGINE_DISPATCHES -- see that file for what each
 * field means.
 */
export const EXECUTION_ENGINE_DISPATCHES = [
];

/**
 * Execution-side ladders still living inline in runner.js. Every value was
 * read off the unrefactored runner.js source.
 *   maxTurnsExpr  -- the literal max_turns expression at the dispatch
 *   maxTurnsValue -- what it resolves to, or null when it is a runtime value
 *                    (the doer's escalating resume ladder), pinned separately
 */
export const EXECUTION_INLINE_LADDERS = [
    {
        ladder: 'reviewer',
        name: 'reviewer (per-round, once)',
        anchor: 'acceptanceCriteriaJson,',
        member: 'reviewerPool[0]',
        agentType: "'reviewer'",
        modelTier: 'FIXED_ROLE_TIER.reviewer',
        maxTurnsExpr: 'BASE_REVIEWER_MAX_TURNS',
        maxTurnsValue: 500,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        pushCode: 'false',
        pushBeads: null,
        schema: 'reviewerVerdict',
        resume: "roundSessions.resumeArgFor('reviewer', cycle)",
    },
    {
        ladder: 'reviewer',
        name: 'reviewer (resume after max_turns exhaustion)',
        anchor: 'Continue your review exactly where you left off',
        member: 'reviewerPool[0]',
        agentType: "'reviewer'",
        modelTier: 'FIXED_ROLE_TIER.reviewer',
        maxTurnsExpr: 'BASE_REVIEWER_MAX_TURNS * 2',
        maxTurnsValue: 1000,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        pushCode: 'false',
        pushBeads: null,
        schema: 'reviewerVerdict',
        resume: 'true',
    },
    {
        ladder: 'doer',
        name: 'doer (streak)',
        anchor: '(\n                        doerPrompt,',
        member: 'doerMember',
        agentType: "'doer'",
        // The doer is the ONE role dispatched at a per-bead declared tier
        // instead of a FIXED_ROLE_TIER constant.
        modelTier: 'doerModel',
        maxTurnsExpr: 'BASE_DOER_MAX_TURNS',
        maxTurnsValue: 500,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        pushCode: 'true',
        pushBeads: 'true',
        schema: 'doerReport',
        resume: 'worklistResumeArg',
    },
    {
        ladder: 'doer',
        name: 'doer (resume after max_turns exhaustion)',
        anchor: 'Continue exactly where you left off from this same session',
        member: 'doerMember',
        agentType: "'doer'",
        // Deliberately undefined: the tier was already resolved and priced on
        // the main dispatch this resume continues.
        modelTier: 'undefined',
        maxTurnsExpr: 'maxTurns',
        maxTurnsValue: null,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        pushCode: 'true',
        pushBeads: 'true',
        schema: 'doerReport',
        resume: 'true',
    },
    {
        ladder: 'deployer',
        name: 'deployer (once)',
        anchor: '(\n                        deployerPrompt,',
        member: "getMemberForRole('deployer')",
        agentType: "'deployer'",
        modelTier: 'FIXED_ROLE_TIER.deployer',
        maxTurnsExpr: 'DEPLOYER_MAX_TURNS',
        maxTurnsValue: 500,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        pushCode: 'false',
        pushBeads: null,
        schema: 'deployerReport',
        resume: null,
    },
    {
        ladder: 'deployer',
        name: 'deployer (resume after max_turns exhaustion)',
        anchor: 'Continue the deploy exactly where you left off',
        member: "getMemberForRole('deployer')",
        agentType: "'deployer'",
        modelTier: 'FIXED_ROLE_TIER.deployer',
        maxTurnsExpr: 'DEPLOYER_MAX_TURNS * 2',
        maxTurnsValue: 1000,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        pushCode: 'false',
        pushBeads: null,
        schema: 'deployerReport',
        resume: 'true',
    },
    {
        ladder: 'integ-test-runner',
        name: 'integ test runner (once)',
        anchor: '(\n                    featurePrompt,',
        member: "getMemberForRole('integ-test-runner')",
        agentType: "'integ-test-runner'",
        modelTier: "FIXED_ROLE_TIER['integ-test-runner']",
        maxTurnsExpr: 'INTEG_TEST_MAX_TURNS',
        maxTurnsValue: 500,
        // Shorter INACTIVITY timer, longer HARD elapsed ceiling: a hung runner
        // still dies on silence, an active long pass is never killed.
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'INTEG_MAX_TOTAL_S',
        pushCode: 'false',
        pushBeads: 'true',
        schema: 'integReport',
        resume: null,
    },
    {
        ladder: 'integ-test-runner',
        name: 'integ test runner (resume after max_turns exhaustion)',
        anchor: 'Continue the integration test run exactly where you left off',
        member: "getMemberForRole('integ-test-runner')",
        agentType: "'integ-test-runner'",
        modelTier: "FIXED_ROLE_TIER['integ-test-runner']",
        maxTurnsExpr: 'INTEG_TEST_MAX_TURNS * 2',
        maxTurnsValue: 1000,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'INTEG_MAX_TOTAL_S',
        pushCode: 'false',
        pushBeads: 'true',
        schema: 'integReport',
        resume: 'true',
    },
    {
        ladder: 'final-review',
        name: 'final review (once)',
        anchor: 'buildFinalVerdictPrompt({',
        // Final Review is the SAME reviewer role member -- not a distinct
        // final-review role.
        member: "getMemberForRole('reviewer')",
        agentType: "'reviewer'",
        modelTier: 'FIXED_ROLE_TIER.reviewer',
        maxTurnsExpr: 'FINAL_REVIEW_MAX_TURNS',
        maxTurnsValue: 500,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        pushCode: 'false',
        pushBeads: null,
        schema: 'finalVerdict',
        resume: null,
    },
    {
        ladder: 'final-review',
        name: 'final review (resume after max_turns exhaustion)',
        anchor: 'Continue your final review exactly where you left off',
        member: "getMemberForRole('reviewer')",
        agentType: "'reviewer'",
        modelTier: 'FIXED_ROLE_TIER.reviewer',
        maxTurnsExpr: 'FINAL_REVIEW_MAX_TURNS * 2',
        maxTurnsValue: 1000,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        pushCode: 'false',
        pushBeads: null,
        schema: 'finalVerdict',
        resume: 'true',
    },
    {
        ladder: 'regression-test-runner',
        name: 'regression test runner (once)',
        anchor: '(\n                    regressionPrompt,',
        member: "getMemberForRole('regression-test-runner')",
        agentType: "'regression-test-runner'",
        modelTier: "FIXED_ROLE_TIER['regression-test-runner']",
        maxTurnsExpr: 'REGRESSION_TEST_MAX_TURNS',
        maxTurnsValue: 500,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'REGRESSION_TEST_MAX_TOTAL_S',
        pushCode: 'false',
        pushBeads: 'true',
        schema: 'regressionReport',
        resume: null,
    },
    {
        ladder: 'regression-test-runner',
        name: 'regression test runner (resume after max_turns exhaustion)',
        anchor: 'Continue the regression pass exactly where you left off',
        member: "getMemberForRole('regression-test-runner')",
        agentType: "'regression-test-runner'",
        modelTier: "FIXED_ROLE_TIER['regression-test-runner']",
        maxTurnsExpr: 'REGRESSION_TEST_MAX_TURNS * 2',
        maxTurnsValue: 1000,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'REGRESSION_TEST_MAX_TOTAL_S',
        pushCode: 'false',
        pushBeads: 'true',
        schema: 'regressionReport',
        resume: 'true',
    },
    {
        ladder: 'harvester',
        name: 'harvester (once)',
        anchor: '(\n                harvesterPrompt,',
        member: "getMemberForRole('harvester')",
        agentType: "'harvester'",
        modelTier: 'FIXED_ROLE_TIER.harvester',
        maxTurnsExpr: 'HARVESTER_MAX_TURNS',
        maxTurnsValue: 500,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        pushCode: 'true',
        pushBeads: 'true',
        schema: 'harvesterReport',
        resume: null,
    },
    {
        ladder: 'harvester',
        name: 'harvester (resume after max_turns exhaustion)',
        anchor: 'Continue your harvest exactly where you left off',
        member: "getMemberForRole('harvester')",
        agentType: "'harvester'",
        modelTier: 'FIXED_ROLE_TIER.harvester',
        maxTurnsExpr: 'HARVESTER_MAX_TURNS * 2',
        maxTurnsValue: 1000,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        pushCode: 'true',
        pushBeads: 'true',
        schema: 'harvesterReport',
        resume: 'true',
    },
];
