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
    {
        role: 'final-review',
        kind: 'main',
        name: 'final review (once)',
        // Final Review is the SAME reviewer ROLE member -- not a distinct
        // final-review role, and not the per-round reviewer's POOL HEAD. That
        // difference is the whole point of the member-routing pin.
        memberRole: 'reviewer',
        agentType: 'reviewer',
        modelTier: 'premium',
        maxTurns: 500,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        bracketed: true,
        pushCode: false,
        pushBeads: false,
        watchdog: false,
        watchdogLabel: null,
        schema: 'finalVerdict',
        resume: null,
    },
    {
        role: 'final-review',
        kind: 'max-turns-resume',
        name: 'final review (resume after max_turns exhaustion)',
        memberRole: 'reviewer',
        agentType: 'reviewer',
        modelTier: 'premium',
        maxTurns: 1000,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        bracketed: true,
        pushCode: false,
        pushBeads: false,
        watchdog: false,
        watchdogLabel: null,
        schema: 'finalVerdict',
        resume: true,
    },
    {
        role: 'integ-test-runner',
        kind: 'main',
        name: 'integ test runner (once)',
        memberRole: 'integ-test-runner',
        agentType: 'integ-test-runner',
        modelTier: 'standard',
        maxTurns: 500,
        // Shorter INACTIVITY timer, longer HARD elapsed ceiling: a hung runner
        // still dies on silence, an active long pass is never killed. Two
        // DISTINCT symbolic budgets, so a pin that resolved both to the same
        // number could not pass.
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'INTEG_MAX_TOTAL_S',
        bracketed: true,
        // Closes passing features and files bug beads, but never touches code.
        pushCode: false,
        pushBeads: true,
        watchdog: false,
        watchdogLabel: null,
        schema: 'integReport',
        resume: null,
    },
    {
        role: 'integ-test-runner',
        kind: 'max-turns-resume',
        name: 'integ test runner (resume after max_turns exhaustion)',
        memberRole: 'integ-test-runner',
        agentType: 'integ-test-runner',
        modelTier: 'standard',
        maxTurns: 1000,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'INTEG_MAX_TOTAL_S',
        bracketed: true,
        pushCode: false,
        pushBeads: true,
        watchdog: false,
        watchdogLabel: null,
        schema: 'integReport',
        resume: true,
    },
    {
        role: 'regression-test-runner',
        kind: 'main',
        name: 'regression test runner (once)',
        memberRole: 'regression-test-runner',
        agentType: 'regression-test-runner',
        modelTier: 'standard',
        maxTurns: 500,
        // Shorter INACTIVITY timer, longer HARD elapsed ceiling. Both are
        // still SYMBOLIC: the pin names the budget and the engine must resolve
        // it through ctx.budgets, so a hard-coded number cannot pass.
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'REGRESSION_TEST_MAX_TOTAL_S',
        bracketed: true,
        // Mutates beads (files carry-over bugs) but never touches code.
        pushCode: false,
        pushBeads: true,
        watchdog: false,
        watchdogLabel: null,
        schema: 'regressionReport',
        resume: null,
    },
    {
        role: 'regression-test-runner',
        kind: 'max-turns-resume',
        name: 'regression test runner (resume after max_turns exhaustion)',
        memberRole: 'regression-test-runner',
        agentType: 'regression-test-runner',
        modelTier: 'standard',
        maxTurns: 1000,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'REGRESSION_TEST_MAX_TOTAL_S',
        bracketed: true,
        pushCode: false,
        pushBeads: true,
        watchdog: false,
        watchdogLabel: null,
        schema: 'regressionReport',
        resume: true,
    },
    {
        role: 'deployer',
        kind: 'main',
        name: 'deployer (once)',
        memberRole: 'deployer',
        agentType: 'deployer',
        modelTier: 'standard',
        maxTurns: 500,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        // A read-side role (pushCode false) -- but a deployer on a stale
        // checkout is as damaging as a stale reviewer diff, so it still gets
        // the pre-dispatch G-pull the bracket performs.
        bracketed: true,
        pushCode: false,
        // Pre-migration this pin read `pushBeads: null` -- absent at the source
        // call site, i.e. withGitSync's own default. Post-migration it is the
        // VALUE the bracket receives, which is that same default.
        pushBeads: false,
        watchdog: false,
        watchdogLabel: null,
        schema: 'deployerReport',
        resume: null,
    },
    {
        role: 'deployer',
        kind: 'max-turns-resume',
        name: 'deployer (resume after max_turns exhaustion)',
        memberRole: 'deployer',
        agentType: 'deployer',
        modelTier: 'standard',
        maxTurns: 1000,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        bracketed: true,
        pushCode: false,
        pushBeads: false,
        watchdog: false,
        watchdogLabel: null,
        schema: 'deployerReport',
        resume: true,
    },
    {
        role: 'harvester',
        kind: 'main',
        name: 'harvester (once)',
        memberRole: 'harvester',
        agentType: 'harvester',
        // Pre-migration this pin read 'FIXED_ROLE_TIER.harvester' -- the source
        // expression at the call site. Post-migration it is the VALUE that
        // expression resolves to, read out of runner.js's own FIXED_ROLE_TIER
        // by the harness rather than re-typed here. Same fact, resolved.
        modelTier: 'standard',
        maxTurns: 500,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        bracketed: true,
        // Writes docs/changelog/sprint-analysis commits AND defers low-priority
        // beads, so it is one of only four dispatches that G-push, and it
        // D-pushes too.
        pushCode: true,
        pushBeads: true,
        watchdog: false,
        watchdogLabel: null,
        schema: 'harvesterReport',
        resume: null,
    },
    {
        role: 'harvester',
        kind: 'max-turns-resume',
        name: 'harvester (resume after max_turns exhaustion)',
        memberRole: 'harvester',
        agentType: 'harvester',
        modelTier: 'standard',
        maxTurns: 1000,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        bracketed: true,
        pushCode: true,
        pushBeads: true,
        watchdog: false,
        watchdogLabel: null,
        schema: 'harvesterReport',
        resume: true,
    },
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
];
