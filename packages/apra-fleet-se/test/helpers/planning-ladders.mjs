// Shared data: the planning-side dispatch-pin table.
//
// This table used to live inline in planning-role-dispatch-pins.test.mjs. It
// was moved here (apra-fleet-3swo.28 AC#5) so execution-role-dispatch-pins.
// test.mjs can read PLANNING_LADDERS.length to derive the total agent() site
// count without hard-coding a literal that the dispatchRole migration is
// guaranteed to invalidate as ladders move out of runner.js.
//
// This file is PURE DATA -- no functions, no SRC-scanning, no test()/
// describe() calls -- so importing it from a second test file does not
// re-execute planning-role-dispatch-pins.test.mjs's tests a second time.
//
// WHAT PLANNING_LADDERS IS (apra-fleet-3swo.5.3): a CENSUS of every real
// planning-side `agent(...)` call site in the scanned module set
// (dispatch-pin-scanner.mjs's DISPATCH_LADDER_MODULES). That is exactly the
// contract execution-role-dispatch-pins.test.mjs's total-site-count
// assertion depends on -- "every agent() site is pinned by one of the two
// tables" -- and it is what keeps that sibling file passing UNCHANGED while
// this migration moves ladders around.
//
// Two entry shapes, because the migration creates two kinds of call site:
//
//   mode: 'inline'  -- a ladder still hand-written in runner.js. Its facts
//                      are properties of runner.js SOURCE TEXT, so its fields
//                      are source EXPRESSIONS ("getMemberForRole('planner')")
//                      and the pin file asserts them with the textual scanner.
//                      This is the pre-migration shape, unchanged.
//
//   mode: 'engine'  -- the ONE generic dispatch in fleet-sprint/
//                      dispatch-role.mjs that every MIGRATED ladder now runs
//                      through. Exactly one such entry exists. Its own facts
//                      are not textual (the engine resolves member/model/
//                      budgets/bracket/watchdog from the frozen ROLE_POLICIES
//                      row at run time), so the dispatches it serves are
//                      listed under `dispatches` with RESOLVED values and
//                      asserted BEHAVIOURALLY -- the pin file runs the real
//                      engine against a recording ctx (see ./dispatch-role-
//                      harness.mjs) and observes what it actually passes.
//
// MIGRATION BOOKKEEPING: migrating a role MOVES its pin from the inline list
// into the engine entry's `dispatches` list. The census length therefore
// tracks the real agent() site count automatically at every intermediate
// commit, and no pinned FACT is ever dropped in the move -- only the way it
// is proved changes (source text -> executed behaviour). The per-pin
// inventory mapping each pre-migration assertion to its post-migration
// replacement is in planning-role-dispatch-pins.test.mjs's header.

/**
 * Every dispatch the dispatchRole engine (fleet-sprint/dispatch-role.mjs)
 * serves on the planning side, with the values it must RESOLVE for each --
 * the post-migration replacement for the inline entries' source expressions.
 *
 *   role/kind        -- which ROLE_POLICIES row and which dispatch of it
 *   member           -- the member the dispatch (and its bracket/watchdog)
 *                       must route to, as the harness resolves role members
 *   modelTier        -- the resolved tier VALUE (from runner.js's real
 *                       FIXED_ROLE_TIER, read from source by the harness)
 *   maxTurns/timeoutS/maxTotalS -- resolved budgets; null means "pass
 *                       nothing and take the transport default"
 *   bracketed/pushCode/pushBeads -- the withGitSync bracket really opened
 *   watchdog/watchdogLabel       -- the client-side watchdog really armed
 *   agentType/schema/resume      -- persona, verdict schema, resume argument
 */
export const ENGINE_DISPATCHES = [
    {
        role: 'planner',
        kind: 'main',
        name: 'planner (interactive)',
        memberRole: 'planner',
        agentType: 'planner',
        modelTier: 'premium',
        maxTurns: 500,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        bracketed: true,
        pushCode: false,
        // Pre-migration this pin read `pushBeads: 'true'` -- the literal at
        // runner.js's bracket call. Post-migration it is the VALUE the bracket
        // actually receives. Same fact, resolved instead of quoted.
        pushBeads: true,
        watchdog: true,
        watchdogLabel: 'Plan (interactive)',
        schema: null,
        // 'call-site': the engine passes through whatever the runner's
        // per-round session lookup handed it (roundSessions.resumeArgFor).
        resume: 'call-site',
    },
    {
        role: 'planner',
        kind: 'max-turns-resume',
        name: 'planner (resume after max_turns exhaustion)',
        memberRole: 'planner',
        agentType: 'planner',
        modelTier: 'premium',
        maxTurns: 1000,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        bracketed: true,
        pushCode: false,
        pushBeads: true,
        watchdog: true,
        watchdogLabel: 'Plan (resume, max_turns=1000)',
        schema: null,
        resume: true,
    },
    {
        role: 'plan-reviewer',
        kind: 'main',
        name: 'plan-reviewer (once)',
        memberRole: 'plan-reviewer',
        agentType: 'plan-reviewer',
        modelTier: 'premium',
        maxTurns: 500,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        bracketed: true,
        pushCode: false,
        // Pre-migration this pin read `pushBeads: null` -- absent at the
        // source call site, i.e. withGitSync's own default. Post-migration it
        // is the VALUE the bracket receives, which is that same default.
        pushBeads: false,
        watchdog: false,
        watchdogLabel: null,
        schema: 'planReviewerVerdict',
        resume: null,
    },
    {
        role: 'plan-reviewer',
        kind: 'max-turns-resume',
        name: 'plan-reviewer (resume after max_turns exhaustion)',
        memberRole: 'plan-reviewer',
        agentType: 'plan-reviewer',
        modelTier: 'premium',
        maxTurns: 1000,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        bracketed: true,
        pushCode: false,
        pushBeads: false,
        watchdog: false,
        watchdogLabel: null,
        schema: 'planReviewerVerdict',
        resume: true,
    },
    {
        role: 'scoped-replan-planner',
        kind: 'main',
        name: 'scoped replan planner',
        memberRole: 'planner',
        agentType: 'planner',
        modelTier: 'premium',
        maxTurns: 500,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        bracketed: true,
        pushCode: false,
        pushBeads: true,
        watchdog: true,
        watchdogLabel: 'Scoped Replan Plan (interactive)',
        schema: null,
        resume: null,
    },
    {
        role: 'scoped-replan-plan-reviewer',
        kind: 'main',
        name: 'scoped replan plan-reviewer',
        memberRole: 'plan-reviewer',
        agentType: 'plan-reviewer',
        modelTier: 'premium',
        maxTurns: 500,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        bracketed: true,
        pushCode: false,
        pushBeads: false,
        watchdog: false,
        watchdogLabel: null,
        schema: 'planReviewerVerdict',
        resume: null,
    },
    {
        role: 'streak-assignment',
        kind: 'main',
        name: 'streak assignment',
        memberRole: 'planner',
        // No persona of its own, so no engine-injected KNOWLEDGE BANK block.
        agentType: null,
        modelTier: 'cheap',
        // The one dispatch that passes neither a turn budget nor a timeout:
        // it takes the transport defaults.
        maxTurns: null,
        timeoutS: null,
        maxTotalS: null,
        // The one dispatch outside any git-sync bracket: pure compute.
        bracketed: false,
        pushCode: null,
        pushBeads: null,
        watchdog: false,
        watchdogLabel: null,
        schema: 'streakAssignment',
        resume: null,
    },
    {
        role: 'streak-assignment',
        kind: 'semantic-repair-re-ask',
        name: 'streak assignment (semantic repair re-ask)',
        memberRole: 'planner',
        agentType: null,
        modelTier: 'cheap',
        maxTurns: null,
        timeoutS: null,
        maxTotalS: null,
        bracketed: false,
        pushCode: null,
        pushBeads: null,
        watchdog: false,
        watchdogLabel: null,
        schema: 'streakAssignment',
        resume: null,
    },
];

export const PLANNING_LADDERS = [
    {
        mode: 'engine',
        ladder: 'dispatch-role engine',
        name: 'dispatchRole engine (the ONE data-driven dispatch)',
        // The engine spells `member_name` at its own call site rather than
        // folding it into the spread options object, because dispatch-safety-
        // guard.mjs requires every agent() call site to name its member
        // explicitly. That literal is also what anchors this census entry.
        anchor: 'member_name: member,',
        dispatches: ENGINE_DISPATCHES,
    },
];
