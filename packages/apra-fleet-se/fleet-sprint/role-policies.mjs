// =============================================================================
// ROLE DISPATCH POLICY TABLE -- the per-role dispatch policy of every sprint
// role, expressed as DATA instead of as thirteen hand-written ladders inside
// runner.js.
//
// WHAT THIS IS FOR: runner.js currently spells out one bespoke dispatch ladder
// per role (planner, plan-reviewer, doer, reviewer, ...), and every ladder
// re-implements the same axes -- how the dispatch is wrapped in a git-sync
// bracket, its turn budget and timeouts, whether a client-side watchdog is
// armed, how retries and degrades work, where its knowledge block comes from,
// and what runs before/after it. This module records those axes, per role, as
// plain frozen data so a single engine can execute them.
//
// WHAT THIS IS NOT (yet): nothing consumes this table. It is deliberately
// landed on its own, ahead of the engine that will read it, so the table and
// the engine stay independently revertible. runner.js is untouched by the
// change that introduced this file.
//
// HOW IT IS KEPT HONEST: test/role-policies-table.test.mjs re-derives every
// value below from runner.js's real dispatch sites, using the same structural
// scanner the two behaviour-pin files use
// (test/planning-role-dispatch-pins.test.mjs and
// test/execution-role-dispatch-pins.test.mjs). The table therefore describes
// TODAY's behaviour -- a row that drifts from the runner fails that test, and
// a row that disagrees with a pin fails the pin too.
//
// SYMBOLIC VALUES: budgets and turn bases are recorded by the NAME of the
// runner constant that supplies them ('DISPATCH_TIMEOUT_S',
// 'BASE_DOER_MAX_TURNS', ...), not by a hard number, because those constants
// are derived per run (DISPATCH_TIMEOUT_S comes from the validated CLI args).
// Members and model tiers are recorded as a resolution KIND plus its argument
// ('role'/'pool-head'/'runtime', 'fixed'/'per-bead'/'inherited') rather than
// as the runner's expression text, so the engine can resolve them itself.
//
// DELIBERATELY OUT OF SCOPE: per-dispatch `label` strings and prompt building.
// A label is presentation, not policy, and the prompts each role sends are
// already owned by prompts.mjs; the pin files pin neither. Watchdog labels ARE
// here, because arming a watchdog is a policy decision and the label is part
// of its kill-path identity.
// =============================================================================

/** Recursively freezes plain objects and arrays. */
function freezeDeep(value) {
    if (Array.isArray(value)) {
        value.forEach(freezeDeep);
        return Object.freeze(value);
    }
    if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) freezeDeep(value[key]);
        return Object.freeze(value);
    }
    return value;
}

// -----------------------------------------------------------------------------
// Field vocabularies. Each is a closed set: a policy value outside these lists
// is a variance that could not be expressed as data, and must be added here
// (with its meaning) rather than special-cased at the call site.
// -----------------------------------------------------------------------------

/** The nine policy axes every role entry must carry. */
export const POLICY_FIELDS = Object.freeze([
    'bracket',
    'timeouts',
    'maxTurns',
    'watchdog',
    'retry',
    'degrade',
    'kbInjection',
    'preDispatch',
    'postResult',
]);

/** How a dispatch's member is resolved. */
export const MEMBER_KINDS = Object.freeze(['role', 'pool-head', 'runtime']);

/** How a dispatch's model tier is resolved. */
export const MODEL_KINDS = Object.freeze(['fixed', 'per-bead', 'inherited']);

/**
 * Where a dispatch's KNOWLEDGE BANK block comes from.
 *   'wrapper'        -- injected by the shared dispatch wrapper for any role
 *                       outside KB_SELF_INJECTING_ROLES;
 *   'prompt-builder' -- the role's own prompt builder places it (doer,
 *                       reviewer, and the reviewer-persona final review);
 *   'none'           -- the dispatch carries no role persona at all, so it
 *                       receives no block (streak assignment).
 */
export const KB_INJECTION_KINDS = Object.freeze(['wrapper', 'prompt-builder', 'none']);

/** How a failed ladder degrades once its attempts are spent. */
export const DEGRADE_KINDS = Object.freeze([
    'fatal',                  // rethrow; the sprint cannot continue (planner)
    'synthesized-verdict',    // fabricate a non-approving verdict
    'synthesized-report',     // fabricate a non-success report (deployer)
    'inconclusive',           // record "no verdict", never a false failure (integ)
    'fallback-value',         // substitute a deterministic value (streak assignment)
    'defer-to-next-cycle',    // leave the work for the next cycle (scoped replan)
    'non-approval',           // treat as "not approved" and continue
    'per-bead-attribution',   // attribute per bead, then isolate the streak (doer)
    'catch-all',              // swallow everything; the phase is informational
    'proceed-without-report', // continue with no validated report (harvester)
]);

/**
 * Steps the engine runs BEFORE a dispatch. Region-anchored evidence for each
 * lives in test/role-policies-table.test.mjs.
 *   'claim-beads-batched'      -- claim the streak's beads once per turn
 *   'kill-stale-session'       -- kill a still-alive session before resuming it
 *   'sprint-self-id-in-prompt' -- state the sprint's OWN reservation id so the
 *                                 deploy gate cannot self-block
 *   'verify-streak-closed'     -- check whether the work is already done, which
 *                                 can short-circuit the dispatch entirely
 */
export const PRE_DISPATCH_STEPS = Object.freeze([
    'claim-beads-batched',
    'kill-stale-session',
    'sprint-self-id-in-prompt',
    'verify-streak-closed',
]);

/**
 * Steps the engine runs AFTER the dispatch's result (or its failure) is in
 * hand.
 *   'invalidate-beads-cache'   -- the dispatch mutated beads on its own clone
 *   'verify-streak-closed'     -- confirm which beads really closed
 *   'kb-apply'                 -- apply the report's KB work
 *   'reviewer-contract-guard'  -- reject a self-contradictory reviewer verdict
 *   'clear-round-session'      -- do not let a failed round's session be resumed
 *   'select-streaks-validate'  -- validate the returned grouping before trusting it
 */
export const POST_RESULT_STEPS = Object.freeze([
    'invalidate-beads-cache',
    'verify-streak-closed',
    'kb-apply',
    'reviewer-contract-guard',
    'clear-round-session',
    'select-streaks-validate',
]);

/** Kinds of secondary dispatch a ladder can make. */
export const SECONDARY_KINDS = Object.freeze(['max-turns-resume', 'semantic-repair-re-ask']);

// -----------------------------------------------------------------------------
// Small constructors. They exist so every row is written the same way and so a
// defaulted field is defaulted in ONE place -- not to hide data: every value
// they produce is a plain frozen object.
// -----------------------------------------------------------------------------

const roleMember = (role) => ({ kind: 'role', role });
const poolHeadMember = (role, binding) => ({ kind: 'pool-head', role, binding });
const runtimeMember = (binding) => ({ kind: 'runtime', binding });

const fixedTier = (key) => ({ kind: 'fixed', key });
const perBeadTier = (binding) => ({ kind: 'per-bead', binding });
/** The resume of an already-priced dispatch passes no tier of its own. */
const INHERITED_TIER = { kind: 'inherited' };

/** A turn budget of `base` (a runner constant), optionally doubled. */
const turns = (base, multiplier, value) => ({
    kind: 'constant', base, multiplier, value: value * multiplier,
});
/** A turn budget only known at run time (the doer's escalating resume ladder). */
const runtimeTurns = (binding) => ({ kind: 'runtime', binding, base: null, multiplier: null, value: null });

/** A dispatch wrapped in the git-sync bracket, with its two push flags. */
const bracketed = (pushCode, pushBeads) => ({ wrapped: true, pushCode, pushBeads });
/** Streak assignment is pure compute: no repo access, so no bracket at all. */
const NO_BRACKET = { wrapped: false, pushCode: null, pushBeads: null };

const budgets = (timeoutS, maxTotalS) => ({ timeoutS, maxTotalS });
/** A dispatch that passes neither timeout, i.e. takes the transport defaults. */
const NO_BUDGETS = { timeoutS: null, maxTotalS: null };

const NO_WATCHDOG = { armed: false, timeoutS: null, member: null, label: null };
/**
 * An armed client-side watchdog. `member: 'dispatch'` records the pinned
 * invariant that a watchdog always names the same member its dispatch routes
 * to, so its kill path targets the right session. `label` is a segment list:
 * a plain string is literal text, an object is a runner expression
 * interpolated into it.
 */
const watchdog = (label) => ({ armed: true, timeoutS: 'DISPATCH_TIMEOUT_S', member: 'dispatch', label });

const SAME_SESSION_RESUME = { kind: 'same-session' };
const WORKLIST_RESUME = { kind: 'worklist' };
const roundSessionResume = (role) => ({ kind: 'round-session', role });

const retry = (over) => ({
    /** Dispatch attempts in the ladder, excluding any resume. */
    attempts: 1,
    /** Explicit backoff ladder in ms, when the role has one. */
    backoffMs: null,
    /** One bounded LLM-auth self-heal inside the ladder. */
    authSelfHeal: false,
    /** A healed attempt short-circuits the generic retry (final review only). */
    authSelfHealShortCircuits: false,
    /** Auth/workspace-trust failures end the ladder instead of burning attempts. */
    abortOnNonRetryable: false,
    /** A dispatch that already ran is never re-dispatched for a sync failure. */
    skipRedispatchOnPostDispatchSyncFailure: false,
    /** A provably no-mutation failure lets the next attempt skip its pre-sync. */
    skipPreDispatchSyncOnNoMutation: false,
    /** A generic retry resumes onto the branch's remote tip (doer). */
    resumeOntoRemoteTipOnRetry: false,
    /** Turn exhaustion resumes the SAME session rather than restarting. */
    maxTurnsResume: false,
    /** How many such resumes are allowed. */
    resumeAttempts: 0,
    /** How the turn budget grows per resume. */
    turnEscalation: null,
    /** Extra resumes granted for an infrastructure (no-envelope) failure. */
    infraResumeAttempts: 0,
    /** Bounded re-asks that feed the validation failure back to the model. */
    semanticRepairReAsks: 0,
    ...over,
});

const degrade = (over) => ({
    kind: 'fatal',
    /** The value fabricated by the degrade path, if any. */
    synthesized: null,
    /** A field stamped on every synthesized value so it is recognisable. */
    marker: null,
    /** How many distinct degrade paths produce that value. */
    paths: 0,
    /** Values no degrade path may ever fabricate. */
    neverSynthesizes: [],
    /** An unrecognised error class still propagates. */
    rethrowsUnrecognisedErrors: true,
    /**
     * Error classes that are RUN-level control signals rather than a failure
     * of this role, and so keep propagating even through a degrade that
     * swallows everything else.
     */
    rethrowsRunControlSignals: [],
    /** The degrade ends the sprint. */
    abortsSprint: false,
    ...over,
});

/**
 * Builds a role entry. Every entry carries all nine POLICY_FIELDS plus the
 * identity fields the dispatch needs (member, agentType, model, schema,
 * resumeArg) and an optional `secondary` dispatch.
 */
function policy(role, spec) {
    if (typeof spec.ladderAnchor !== 'string' || spec.ladderAnchor.length === 0) {
        throw new TypeError(`role-policies: policy('${role}', ...) requires a non-empty string spec.ladderAnchor.`);
    }
    return {
        role,
        /** 'main' for a role's primary dispatch. */
        kind: 'main',
        /** The ladder this dispatch belongs to; a role's own name by default. */
        ladder: role,
        /**
         * True once this role's dispatch has moved off its inline runner.js
         * agent() ladder onto the dispatchRole(ctx, roleName, opts) engine
         * (apra-fleet-3swo.5.3/.5.6). NOT one of the nine POLICY_FIELDS axes
         * (deliberately -- it is migration bookkeeping, not a dispatch
         * policy), so it is not asserted by the "every role carries all nine
         * policy fields" shape test. fleet-sprint/inline-ladder-guard.mjs
         * reads this field to know which roles must no longer have a
         * surviving inline ladder; false for every role until its migration
         * bead lands.
         */
        migrated: spec.migrated ?? false,
        /**
         * apra-fleet-3swo.24: a literal source substring, UNIQUE ACROSS EVERY
         * DISPATCH this table describes, that occurs inside this dispatch's
         * own real `agent(...)` call text in runner.js. NOT one of the nine
         * POLICY_FIELDS axes (same reasoning as `migrated` above -- it is
         * call-site identity, not dispatch policy).
         *
         * UNIQUENESS ACROSS THE TABLE, NOT EXCLUSIVITY TO ONE CALL SITE: a
         * dispatch's own anchor can legitimately appear at MORE than one real
         * agent() call site of its OWN ladder. integ-test-runner's and
         * regression-test-runner's main anchors ('featurePrompt,' /
         * 'regressionPrompt,') each match two sites, because each role's own
         * resume prompt re-embeds its main prompt variable verbatim
         * (inline-ladder-guard.test.mjs's apra-fleet-3swo.35 block records and
         * pins this). What matters is that no anchor is ever shared BETWEEN
         * two different dispatches (see this file's (d) anchor-uniqueness
         * test block).
         *
         * WHY THIS EXISTS: a role's `member` resolution expression
         * (memberExprFor()) is NOT role-unique -- roleMember('planner') is
         * shared by planner, scoped-replan-planner and streak-assignment, and
         * roleMember('plan-reviewer') by plan-reviewer and
         * scoped-replan-plan-reviewer. agentType and schema do not
         * disambiguate either (see inline-ladder-guard.mjs's header).
         * fleet-sprint/inline-ladder-guard.mjs therefore requires a call
         * site's text to include BOTH this role's member expression AND its
         * ladderAnchor before reporting a surviving inline ladder -- the
         * member expression alone would flag every sibling ladder that
         * happens to route through the same member.
         */
        ladderAnchor: spec.ladderAnchor,
        member: spec.member,
        agentType: spec.agentType ?? null,
        model: spec.model,
        schema: spec.schema ?? null,
        resumeArg: spec.resumeArg ?? null,
        bracket: spec.bracket,
        timeouts: spec.timeouts,
        maxTurns: spec.maxTurns ?? null,
        watchdog: spec.watchdog ?? NO_WATCHDOG,
        retry: spec.retry,
        degrade: spec.degrade,
        kbInjection: spec.kbInjection,
        preDispatch: spec.preDispatch ?? [],
        postResult: spec.postResult ?? [],
        secondary: null,
    };
}

/**
 * Builds a ladder's SECONDARY dispatch from its main one: the shape mirrors
 * the runner's own "spread the shared options, then override inline", so a
 * field not named in `over` is inherited verbatim.
 *
 * `over.ladderAnchor` is REQUIRED (not merely inherited): a secondary
 * dispatch is always a DIFFERENT real `agent(...)` call site in runner.js
 * than its main dispatch, so silently inheriting the main dispatch's anchor
 * would make the two indistinguishable -- exactly the collision this bead
 * (apra-fleet-3swo.24) exists to remove.
 */
function secondary(main, role, kind, over) {
    if (typeof over.ladderAnchor !== 'string' || over.ladderAnchor.length === 0) {
        throw new TypeError(
            `role-policies: secondary(..., '${role}', '${kind}', over) must override ladderAnchor with a ` +
            'non-empty string -- inheriting the main dispatch\'s anchor would make the two indistinguishable.'
        );
    }
    return {
        ...main,
        role,
        kind,
        ladder: main.ladder,
        secondary: null,
        ...over,
    };
}

// -----------------------------------------------------------------------------
// The table.
// -----------------------------------------------------------------------------

const planner = policy('planner', {
    // apra-fleet-3swo.5.3: migrated -- the planner ladder no longer exists
    // inline in runner.js; dispatchRole executes this row.
    migrated: true,
    ladderAnchor: 'plannerPrompt,',
    member: roleMember('planner'),
    agentType: 'planner',
    model: fixedTier('planner'),
    schema: null,
    resumeArg: roundSessionResume('planner'),
    bracket: bracketed(false, true),
    timeouts: budgets('DISPATCH_TIMEOUT_S', 'DISPATCH_TIMEOUT_S'),
    maxTurns: turns('PLANNER_MAX_TURNS', 1, 500),
    watchdog: watchdog(['Plan (interactive)']),
    kbInjection: 'wrapper',
    retry: retry({
        attempts: 5,
        backoffMs: [0, 5000, 15000, 30000, 60000],
        authSelfHeal: true,
        abortOnNonRetryable: true,
        skipRedispatchOnPostDispatchSyncFailure: true,
        skipPreDispatchSyncOnNoMutation: true,
        maxTurnsResume: true,
        resumeAttempts: 1,
        turnEscalation: 'double',
    }),
    // The planner is the ONLY role whose exhausted ladder is fatal: there is
    // no sprint without a plan, so it rethrows rather than synthesizing one.
    degrade: degrade({ kind: 'fatal', abortsSprint: true }),
    preDispatch: [],
    postResult: ['invalidate-beads-cache'],
});
planner.secondary = secondary(planner, 'planner', 'max-turns-resume', {
    ladderAnchor: 'Continue your planning pass exactly where you left off',
    maxTurns: turns('PLANNER_MAX_TURNS', 2, 500),
    watchdog: watchdog(['Plan (resume, max_turns=', { expr: 'PLANNER_MAX_TURNS * 2' }, ')']),
    resumeArg: SAME_SESSION_RESUME,
    preDispatch: ['kill-stale-session'],
});

const planReviewer = policy('plan-reviewer', {
    // apra-fleet-3swo.5.3: migrated -- dispatchRole executes this row.
    migrated: true,
    ladderAnchor: 'priorRoundVerdicts: priorPlanRoundVerdicts',
    member: roleMember('plan-reviewer'),
    agentType: 'plan-reviewer',
    model: fixedTier('plan-reviewer'),
    schema: 'planReviewerVerdict',
    resumeArg: null,
    bracket: bracketed(false, null),
    timeouts: budgets('DISPATCH_TIMEOUT_S', 'DISPATCH_TIMEOUT_S'),
    maxTurns: turns('PLAN_REVIEWER_MAX_TURNS', 1, 500),
    kbInjection: 'wrapper',
    retry: retry({
        attempts: 2,
        authSelfHeal: true,
        maxTurnsResume: true,
        resumeAttempts: 1,
        turnEscalation: 'double',
    }),
    degrade: degrade({
        kind: 'synthesized-verdict',
        synthesized: { verdict: 'CHANGES_NEEDED' },
        marker: 'dispatchFailed',
        paths: 2,
        neverSynthesizes: ['APPROVED'],
    }),
});
planReviewer.secondary = secondary(planReviewer, 'plan-reviewer', 'max-turns-resume', {
    ladderAnchor: 'Continue your plan review exactly where you left off',
    maxTurns: turns('PLAN_REVIEWER_MAX_TURNS', 2, 500),
    resumeArg: SAME_SESSION_RESUME,
    preDispatch: ['kill-stale-session'],
});

const scopedReplanPlanner = policy('scoped-replan-planner', {
    ladderAnchor: "label: 'Scoped Replan Plan (interactive)'",
    member: roleMember('planner'),
    agentType: 'planner',
    model: fixedTier('planner'),
    schema: null,
    bracket: bracketed(false, true),
    timeouts: budgets('DISPATCH_TIMEOUT_S', 'DISPATCH_TIMEOUT_S'),
    maxTurns: turns('SCOPED_REPLAN_PLANNER_MAX_TURNS', 1, 500),
    watchdog: watchdog(['Scoped Replan Plan (interactive)']),
    kbInjection: 'wrapper',
    // A single bounded attempt: no retry ladder and no resume of its own.
    retry: retry({ attempts: 1, authSelfHeal: true }),
    degrade: degrade({ kind: 'defer-to-next-cycle', rethrowsUnrecognisedErrors: false }),
    postResult: ['invalidate-beads-cache'],
});

const scopedReplanPlanReviewer = policy('scoped-replan-plan-reviewer', {
    ladderAnchor: "label: 'Scoped Replan Review'",
    member: roleMember('plan-reviewer'),
    agentType: 'plan-reviewer',
    model: fixedTier('plan-reviewer'),
    schema: 'planReviewerVerdict',
    bracket: bracketed(false, null),
    timeouts: budgets('DISPATCH_TIMEOUT_S', 'DISPATCH_TIMEOUT_S'),
    maxTurns: turns('SCOPED_REPLAN_REVIEWER_MAX_TURNS', 1, 500),
    kbInjection: 'wrapper',
    retry: retry({ attempts: 1, authSelfHeal: true }),
    degrade: degrade({ kind: 'non-approval', rethrowsUnrecognisedErrors: false }),
});

const streakAssignment = policy('streak-assignment', {
    ladderAnchor: "label: 'Streak Assignment',",
    // Borrows the planner MEMBER for model-tier routing only, and carries no
    // agentType: it has no persona of its own, and activating the planner
    // persona on this narrow grouping task makes the model go exploring.
    member: roleMember('planner'),
    agentType: null,
    model: fixedTier('streakAssignment'),
    schema: 'streakAssignment',
    // The one dispatch outside any git-sync bracket: pure compute, no repo access.
    bracket: NO_BRACKET,
    timeouts: NO_BUDGETS,
    maxTurns: null,
    kbInjection: 'none',
    retry: retry({ attempts: 1, authSelfHeal: true, semanticRepairReAsks: 1 }),
    degrade: degrade({
        kind: 'fallback-value',
        synthesized: { grouping: 'one-bead-per-streak' },
    }),
    postResult: ['select-streaks-validate'],
});
streakAssignment.secondary = secondary(streakAssignment, 'streak-assignment', 'semantic-repair-re-ask', {
    ladderAnchor: "label: 'Streak Assignment (semantic repair)'",
});

const doer = policy('doer', {
    ladderAnchor: 'doerPrompt,',
    member: runtimeMember('doerMember'),
    agentType: 'doer',
    // The ONE role dispatched at a per-bead declared tier rather than a fixed one.
    model: perBeadTier('doerModel'),
    schema: 'doerReport',
    resumeArg: WORKLIST_RESUME,
    bracket: bracketed(true, true),
    timeouts: budgets('DISPATCH_TIMEOUT_S', 'DISPATCH_TIMEOUT_S'),
    maxTurns: turns('BASE_DOER_MAX_TURNS', 1, 500),
    kbInjection: 'prompt-builder',
    retry: retry({
        attempts: 2,
        authSelfHeal: true,
        abortOnNonRetryable: true,
        skipRedispatchOnPostDispatchSyncFailure: true,
        resumeOntoRemoteTipOnRetry: true,
        maxTurnsResume: true,
        resumeAttempts: 2,
        turnEscalation: 'double',
    }),
    degrade: degrade({
        kind: 'per-bead-attribution',
        // The streak error is re-thrown AFTER attribution so the parallel
        // runner isolates this streak; it never ends the sprint.
        rethrowsUnrecognisedErrors: false,
    }),
    preDispatch: ['claim-beads-batched'],
    postResult: ['verify-streak-closed', 'kb-apply'],
});
const doerResume = secondary(doer, 'doer-resume', 'max-turns-resume', {
    ladderAnchor: 'Continue exactly where you left off from this same session',
    // No tier: the streak was already priced on the dispatch this continues.
    model: INHERITED_TIER,
    // The escalating ladder computes the budget per resume attempt.
    maxTurns: runtimeTurns('maxTurns'),
    resumeArg: SAME_SESSION_RESUME,
    // A turn-exhausted streak whose beads are ALL closed already is a success
    // and gets no resume dispatch at all, so the check runs BEFORE the kill.
    preDispatch: ['verify-streak-closed', 'kill-stale-session'],
});
doer.secondary = doerResume;

const reviewer = policy('reviewer', {
    ladderAnchor: 'acceptanceCriteriaJson,',
    member: poolHeadMember('reviewer', 'reviewerPool[0]'),
    agentType: 'reviewer',
    model: fixedTier('reviewer'),
    schema: 'reviewerVerdict',
    resumeArg: roundSessionResume('reviewer'),
    bracket: bracketed(false, null),
    timeouts: budgets('DISPATCH_TIMEOUT_S', 'DISPATCH_TIMEOUT_S'),
    maxTurns: turns('BASE_REVIEWER_MAX_TURNS', 1, 500),
    kbInjection: 'prompt-builder',
    retry: retry({
        attempts: 2,
        authSelfHeal: true,
        maxTurnsResume: true,
        resumeAttempts: 1,
        turnEscalation: 'double',
    }),
    degrade: degrade({
        kind: 'synthesized-verdict',
        synthesized: { verdict: 'CHANGES_NEEDED' },
        marker: 'dispatchFailed',
        paths: 2,
        neverSynthesizes: ['APPROVED'],
    }),
    postResult: ['reviewer-contract-guard', 'kb-apply', 'clear-round-session'],
});
reviewer.secondary = secondary(reviewer, 'reviewer', 'max-turns-resume', {
    ladderAnchor: 'Continue your review exactly where you left off',
    maxTurns: turns('BASE_REVIEWER_MAX_TURNS', 2, 500),
    resumeArg: SAME_SESSION_RESUME,
    preDispatch: ['kill-stale-session'],
});

const finalReview = policy('final-review', {
    ladderAnchor: 'buildFinalVerdictPrompt({',
    // Final Review has no role member of its own: it is the reviewer role,
    // dispatching the reviewer persona over the whole sprint.
    member: roleMember('reviewer'),
    agentType: 'reviewer',
    model: fixedTier('reviewer'),
    schema: 'finalVerdict',
    bracket: bracketed(false, null),
    timeouts: budgets('DISPATCH_TIMEOUT_S', 'DISPATCH_TIMEOUT_S'),
    maxTurns: turns('FINAL_REVIEW_MAX_TURNS', 1, 500),
    kbInjection: 'prompt-builder',
    retry: retry({
        attempts: 2,
        authSelfHeal: true,
        // A healed attempt already produced a verdict; running the generic
        // retry as well would fire a second full review and discard it.
        authSelfHealShortCircuits: true,
        // An auth/trust failure that could NOT be healed ends the ladder
        // instead of burning the retry on the identical wall.
        abortOnNonRetryable: true,
        maxTurnsResume: true,
        resumeAttempts: 1,
        turnEscalation: 'double',
    }),
    degrade: degrade({
        kind: 'synthesized-verdict',
        synthesized: { verdict: 'FAIL' },
        paths: 4,
        neverSynthesizes: ['PASS'],
    }),
    postResult: ['kb-apply'],
});
finalReview.secondary = secondary(finalReview, 'final-review', 'max-turns-resume', {
    ladderAnchor: 'Continue your final review exactly where you left off',
    maxTurns: turns('FINAL_REVIEW_MAX_TURNS', 2, 500),
    resumeArg: SAME_SESSION_RESUME,
    preDispatch: ['kill-stale-session'],
});

const deployer = policy('deployer', {
    ladderAnchor: 'deployerPrompt,',
    member: roleMember('deployer'),
    agentType: 'deployer',
    model: fixedTier('deployer'),
    schema: 'deployerReport',
    bracket: bracketed(false, null),
    timeouts: budgets('DISPATCH_TIMEOUT_S', 'DISPATCH_TIMEOUT_S'),
    maxTurns: turns('DEPLOYER_MAX_TURNS', 1, 500),
    kbInjection: 'wrapper',
    retry: retry({
        attempts: 1,
        authSelfHeal: true,
        maxTurnsResume: true,
        resumeAttempts: 1,
        turnEscalation: 'double',
    }),
    degrade: degrade({
        kind: 'synthesized-report',
        synthesized: { deployed: false },
        paths: 2,
        neverSynthesizes: ['deployed: true'],
    }),
    // The deploy runbook gates on foreign reservations, so the prompt must
    // carry the sprint's OWN reservation id or the gate self-blocks.
    preDispatch: ['sprint-self-id-in-prompt'],
});
deployer.secondary = secondary(deployer, 'deployer', 'max-turns-resume', {
    ladderAnchor: 'Continue the deploy exactly where you left off',
    maxTurns: turns('DEPLOYER_MAX_TURNS', 2, 500),
    resumeArg: SAME_SESSION_RESUME,
    preDispatch: ['kill-stale-session'],
});

const integTestRunner = policy('integ-test-runner', {
    ladderAnchor: 'featurePrompt,',
    member: roleMember('integ-test-runner'),
    agentType: 'integ-test-runner',
    model: fixedTier('integ-test-runner'),
    schema: 'integReport',
    bracket: bracketed(false, true),
    // Shorter INACTIVITY timer, longer HARD elapsed ceiling: a hung runner
    // still dies on silence, while an active long pass is never killed.
    timeouts: budgets('DISPATCH_TIMEOUT_S', 'INTEG_MAX_TOTAL_S'),
    maxTurns: turns('INTEG_TEST_MAX_TURNS', 1, 500),
    kbInjection: 'wrapper',
    retry: retry({
        attempts: 1,
        authSelfHeal: true,
        maxTurnsResume: true,
        resumeAttempts: 1,
        turnEscalation: 'double',
        infraResumeAttempts: 1,
    }),
    // An infrastructure failure produced no test evidence, so it must never be
    // recorded as a test FAILURE.
    degrade: degrade({ kind: 'inconclusive', marker: 'integInfraInconclusive' }),
});
integTestRunner.secondary = secondary(integTestRunner, 'integ-test-runner', 'max-turns-resume', {
    ladderAnchor: 'Continue the integration test run exactly where you left off',
    maxTurns: turns('INTEG_TEST_MAX_TURNS', 2, 500),
    resumeArg: SAME_SESSION_RESUME,
    preDispatch: ['kill-stale-session'],
});

const regressionTestRunner = policy('regression-test-runner', {
    ladderAnchor: 'regressionPrompt,',
    member: roleMember('regression-test-runner'),
    agentType: 'regression-test-runner',
    model: fixedTier('regression-test-runner'),
    schema: 'regressionReport',
    bracket: bracketed(false, true),
    timeouts: budgets('DISPATCH_TIMEOUT_S', 'REGRESSION_TEST_MAX_TOTAL_S'),
    maxTurns: turns('REGRESSION_TEST_MAX_TURNS', 1, 500),
    kbInjection: 'wrapper',
    retry: retry({
        attempts: 1,
        // The phase never re-dispatches, and it says so explicitly: a
        // post-dispatch sync failure is classified into its own degrade
        // summary (the carry-over beads it filed may be local-only) rather
        // than re-running the pass.
        skipRedispatchOnPostDispatchSyncFailure: true,
        maxTurnsResume: true,
        resumeAttempts: 1,
        turnEscalation: 'double',
    }),
    // The only load-bearing catch-all in the table: this phase is
    // informational, and a failure here must never turn a green sprint into a
    // terminal ABORTED record that skips Harvest and Publish. Cancellation and
    // budget exhaustion are RUN-level signals, not failures of this phase, so
    // they still propagate.
    degrade: degrade({
        kind: 'catch-all',
        rethrowsUnrecognisedErrors: false,
        rethrowsRunControlSignals: ['CancelledError', 'BudgetExceededError'],
    }),
});
regressionTestRunner.secondary = secondary(regressionTestRunner, 'regression-test-runner', 'max-turns-resume', {
    ladderAnchor: 'Continue the regression pass exactly where you left off',
    maxTurns: turns('REGRESSION_TEST_MAX_TURNS', 2, 500),
    resumeArg: SAME_SESSION_RESUME,
    preDispatch: ['kill-stale-session'],
});

const harvester = policy('harvester', {
    ladderAnchor: 'harvesterPrompt,',
    member: roleMember('harvester'),
    agentType: 'harvester',
    model: fixedTier('harvester'),
    schema: 'harvesterReport',
    // Writes docs AND defers low-priority beads, so it pushes both.
    bracket: bracketed(true, true),
    timeouts: budgets('DISPATCH_TIMEOUT_S', 'DISPATCH_TIMEOUT_S'),
    maxTurns: turns('HARVESTER_MAX_TURNS', 1, 500),
    kbInjection: 'wrapper',
    retry: retry({
        attempts: 1,
        authSelfHeal: true,
        maxTurnsResume: true,
        resumeAttempts: 1,
        turnEscalation: 'double',
    }),
    degrade: degrade({ kind: 'proceed-without-report' }),
    postResult: ['kb-apply'],
});
harvester.secondary = secondary(harvester, 'harvester', 'max-turns-resume', {
    ladderAnchor: 'Continue your harvest exactly where you left off',
    maxTurns: turns('HARVESTER_MAX_TURNS', 2, 500),
    resumeArg: SAME_SESSION_RESUME,
    preDispatch: ['kill-stale-session'],
});

/**
 * The policy table, keyed by role name.
 *
 * `doer-resume` is registered as a role of its own because it is the one
 * resume dispatch that shares nothing but its member with the dispatch it
 * continues: its model tier is inherited rather than declared, and its turn
 * budget is a run-time value from the escalating resume ladder. It is the SAME
 * frozen object as ROLE_POLICIES.doer.secondary; every other ladder's resume
 * is reachable as <role>.secondary.
 */
export const ROLE_POLICIES = freezeDeep({
    planner,
    'plan-reviewer': planReviewer,
    'scoped-replan-planner': scopedReplanPlanner,
    'scoped-replan-plan-reviewer': scopedReplanPlanReviewer,
    'streak-assignment': streakAssignment,
    doer,
    'doer-resume': doerResume,
    reviewer,
    'final-review': finalReview,
    deployer,
    'integ-test-runner': integTestRunner,
    'regression-test-runner': regressionTestRunner,
    harvester,
});

/** Every role name in the table, in table order. */
export const ROLE_NAMES = Object.freeze(Object.keys(ROLE_POLICIES));

/** The policy for `role`, or throws naming the roles that do exist. */
export function policyFor(role) {
    const found = ROLE_POLICIES[role];
    if (!found) {
        throw new Error(`role-policies: no policy for role '${role}' (known roles: ${ROLE_NAMES.join(', ')})`);
    }
    return found;
}

/**
 * Every DISPATCH the table describes: each role's main dispatch plus its
 * secondary, de-duplicated (doer-resume is reachable both as a role and as
 * the doer's secondary).
 */
export function allDispatchPolicies() {
    const seen = new Set();
    const out = [];
    for (const name of ROLE_NAMES) {
        const entry = ROLE_POLICIES[name];
        for (const dispatch of [entry, entry.secondary]) {
            if (!dispatch || seen.has(dispatch)) continue;
            seen.add(dispatch);
            out.push(dispatch);
        }
    }
    return out;
}

/** True when this role's dispatches push CODE (not just beads). */
export function pushesCode(role) {
    return policyFor(role).bracket.pushCode === true;
}

/**
 * Role names this table marks `migrated: true` -- i.e. roles whose dispatch
 * has moved off its inline runner.js agent() ladder onto the dispatchRole
 * engine. Empty today (apra-fleet-3swo.5.8 lands this field and
 * fleet-sprint/inline-ladder-guard.mjs, the guard that consumes it, ahead of
 * either migration bead actually flipping a role to true).
 */
export function migratedRoleNames() {
    return ROLE_NAMES.filter((name) => ROLE_POLICIES[name].migrated === true);
}
