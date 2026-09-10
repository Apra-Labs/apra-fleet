// Shared BEHAVIOURAL harness for the dispatchRole engine
// (fleet-sprint/dispatch-role.mjs, apra-fleet-3swo.5.3).
//
// WHY THIS EXISTS -- and why it is not "a table compared to a table":
// before the dispatchRole migration, a planning ladder's facts (which member
// it routes to, whether it is bracketed, its turn budget, how many attempts
// it makes, what it degrades to) were only knowable by SCANNING runner.js's
// source text, because each ladder was a closure over per-run state inside
// one enormous function with no seam to call. ./dispatch-pin-scanner.mjs
// exists for exactly that, and it stays the right tool for every ladder still
// living inline in runner.js.
//
// Once a ladder moves onto the engine, source scanning stops being able to
// answer those questions AT ALL: the engine's retry loop is `for (let attempt
// = 1; attempt <= attempts; attempt++)`, so "how many attempts does the
// planner make?" is no longer a textual property of any source region -- a
// regex over dispatch-role.mjs would report the same answer for every role.
// The honest replacement is not a weaker scan, it is a STRONGER one: RUN the
// real engine, with the real frozen ROLE_POLICIES row, against a recording
// ctx, and observe what it actually does. Every fact the old textual pins
// asserted is then re-derived from real executed source (dispatch-role.mjs +
// role-policies.mjs) rather than from source text -- and a pin can now catch
// a behavioural regression a text scan never could (e.g. a policy field that
// is read but never applied).
//
// NOTHING IS STUBBED THAT MATTERS: dispatchRole takes every runner-side
// primitive through `ctx` by design (see dispatch-role.mjs's header), so this
// harness supplies recording implementations of exactly those primitives and
// runs the engine's OWN control flow unmodified. The values it feeds in are
// the real ones wherever a real one exists: FIXED_ROLE_TIER is read out of
// runner.js's own source rather than re-typed here, and the schemas are the
// real contracts.mjs objects.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentOutputError, AgentDispatchError, FleetTransportError, CancelledError, BudgetExceededError } from '@apralabs/apra-fleet-workflow';

import { objectLiteralFor, objectEntries } from './dispatch-pin-scanner.mjs';
import {
    planReviewerVerdict,
    streakAssignment,
    reviewerVerdict,
    doerReport,
    deployerReport,
    integReport,
    finalVerdict,
    regressionReport,
    harvesterReport,
} from '../../fleet-sprint/contracts.mjs';
import { isNoMutationDispatchFailure } from '../../fleet-sprint/runner.js';
import { PostDispatchSyncError, GitSyncError, DoltSyncError, GitDivergedError } from '../../fleet-sprint/errors.mjs';
import { ROLE_POLICIES } from '../../fleet-sprint/role-policies.mjs';
import { dispatchRole, TURN_BASES } from '../../fleet-sprint/dispatch-role.mjs';

export { TURN_BASES };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLEET_SPRINT_DIR = path.join(__dirname, '..', '..', 'fleet-sprint');

// The engine's timed backoff sleeps exist for production busy-lock
// resilience only; the documented hermetic-mock flag makes the ladder run its
// full LOGIC (and emit its unchanged "waiting Ns" log lines, which is how
// this harness re-derives retry.backoffMs) with zero wall-clock.
process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF = '1';

/**
 * FIXED_ROLE_TIER, read out of runner.js's REAL source rather than re-typed
 * as a duplicate literal -- so a pin asserting "the planner dispatches at
 * FIXED_ROLE_TIER.planner" is still tied to the runner constant, exactly as
 * the pre-migration textual pin was.
 */
export const FIXED_ROLE_TIER = Object.freeze(Object.fromEntries(
    [...objectEntries(objectLiteralFor(
        fs.readFileSync(path.join(FLEET_SPRINT_DIR, 'runner.js'), 'utf8'),
        'FIXED_ROLE_TIER',
    ))].map(([k, v]) => [k, v.replace(/^['"]|['"]$/g, '')]),
));

/**
 * A stand-in numeric value for the symbolic budget name role-policies.mjs
 * records ('DISPATCH_TIMEOUT_S'). The NUMBER is irrelevant and deliberately
 * not 900/5400/whatever the CLI default happens to be -- it comes from the
 * validated CLI args at run time. What a pin asserts is that the engine
 * resolves the budget the policy NAMES, so a distinctive sentinel makes a
 * mis-resolution (or a hard-coded fallback) impossible to miss.
 */
export const DISPATCH_TIMEOUT_S = 4242;

/** The real schema objects, keyed by the name role-policies.mjs records. */
export const SCHEMAS = Object.freeze({
    planReviewerVerdict,
    streakAssignment,
    reviewerVerdict,
    doerReport,
    deployerReport,
    integReport,
    finalVerdict,
    regressionReport,
    harvesterReport,
});

/**
 * The runner-local values a 'pool-head'/'runtime' member (or a 'per-bead'
 * model tier, or a 'runtime' turn budget) names by BINDING. Only the
 * execution side has any: the reviewer routes to its pool head and the doer
 * to the member its worklist was assigned to, neither of which the engine can
 * resolve on its own -- which is exactly the fact the member-routing pins
 * assert. Distinctive sentinels, so a mis-resolution cannot be mistaken for a
 * plausible member name.
 */
export const BINDINGS = Object.freeze({
    'reviewerPool[0]': 'member:reviewer-pool-head',
    doerMember: 'member:doer-3',
    doerModel: 'premium',
    maxTurns: 1000,
});

/** An AgentDispatchError whose details.reason marks the turn budget spent. */
export function turnExhaustionError(message = 'max turns spent') {
    return new AgentDispatchError(message, { details: { reason: 'max_turns_exhausted' } });
}

/** An LLM-credential dispatch failure (self-healable, and non-retryable). */
export function authError(message = 'authentication failed for member') {
    return new AgentDispatchError(message, { details: { reason: 'auth' } });
}

/** A workspace-trust failure: non-retryable, and NOT self-healable. */
export function trustError(message = 'workspace not trusted') {
    return new AgentDispatchError(message, { details: { reason: 'workspace_not_trusted' } });
}

/** A plain transient dispatch failure (the busy-lock case the ladders retry). */
export function busyError(message = 'execute_prompt is already running for bob') {
    return new AgentDispatchError(message, { details: { reason: 'busy' } });
}

/** Schema-repair exhaustion: agent()'s own bounded repair loop gave up. */
export function schemaError(message = 'no schema-valid output after repair') {
    return new AgentOutputError(message);
}

/** A dropped transport, which every ladder treats exactly like a dispatch failure. */
export function transportError(message = 'connection dropped') {
    return new FleetTransportError(message);
}

/** The dispatch RAN; only its post-dispatch sync failed. */
export function postDispatchSyncError(message = 'post-dispatch sync failed') {
    return new PostDispatchSyncError(message, { member: 'bob' });
}

/**
 * An INFRASTRUCTURE dispatch failure: the member CLI never delivered a result
 * envelope, so no verdict of any kind was produced. 'empty_response' is one
 * of errors.mjs's real INFRA_DISPATCH_REASONS, so isInfraDispatchFailure()
 * classifies this exactly as production would.
 */
export function infraError(message = 'member produced no result envelope') {
    return new AgentDispatchError(message, { details: { reason: 'empty_response' } });
}

/** The read-side git sync bracket around a dispatch failed (not a divergence). */
export function gitSyncError(message = 'git pull failed') {
    return new GitSyncError(message, { member: 'bob', operation: 'pull' });
}

/** The read-side beads sync bracket around a dispatch failed (not a divergence). */
export function doltSyncError(message = 'dolt pull failed') {
    return new DoltSyncError(message, { member: 'bob', operation: 'pull' });
}

/**
 * A REAL branch divergence: a WorkflowError like the sync errors above, but a
 * branch-integrity problem rather than a blip. The per-round reviewer must
 * still propagate it; the regression catch-all must still swallow it.
 */
export function divergedError(message = 'branch diverged from its remote') {
    return new GitDivergedError(message, { member: 'bob', branch: 'feat/x' });
}

/** The operator/supervisor cancelled the run: a RUN-level control signal. */
export function cancelledError(message = 'run cancelled') {
    return new CancelledError(message);
}

/** The sprint's hard spend ceiling is blown: a RUN-level control signal. */
export function budgetError(message = 'sprint budget exceeded') {
    return new BudgetExceededError(message);
}

/**
 * Builds a recording ctx plus the timeline it records.
 *
 * `responses` is consumed one entry per agent() call: an Error is thrown, a
 * function is called with the recorded dispatch and its result used, anything
 * else is returned as the dispatch's value. Once it is exhausted every
 * further call yields `defaultResponse`.
 *
 * @param {object} [options]
 * @returns {{ctx: object, rec: object}}
 */
export function createRecordingCtx(options = {}) {
    const {
        responses = [],
        defaultResponse = 'dispatch ok',
        members = {},
        healed = false,
        noMutation = isNoMutationDispatchFailure,
        budgets = { DISPATCH_TIMEOUT_S },
        steps = {},
        // The policy table the engine reads its row from. Left undefined the
        // engine uses the real frozen ROLE_POLICIES; a test that is proving a
        // variance is field-driven passes a spliced copy here.
        policies = undefined,
    } = options;

    const rec = {
        /** One entry per real agent() call the engine made. */
        dispatches: [],
        /** Every ctx.log() line, in order. */
        logs: [],
        /** Ordered timeline of every observable side effect. */
        events: [],
        /** Members whose stale session the engine killed. */
        kills: [],
        /** Every onLlmAuthFailure({member,label,error}) the engine performed. */
        authHeals: [],
        /** How many times the engine dropped the orchestrator's beads cache. */
        invalidations: 0,
        /**
         * Every ctx.steps hook the engine really invoked, in order, with the
         * arguments it was handed. This is what lets a pin assert that a
         * policy's recorded preDispatch/postResult/degrade step is a step the
         * engine PERFORMS rather than merely a string in the table.
         */
        steps: [],
    };

    const queue = [...responses];
    let bracketFrame = null;

    const ctx = {
        ...(policies ? { policies } : {}),
        agent: async (prompt, opts) => {
            const entry = {
                prompt,
                options: { ...opts },
                member: opts.member_name,
                bracket: bracketFrame ? { ...bracketFrame } : null,
                watchdog: null,
            };
            rec.dispatches.push(entry);
            rec.events.push({ type: 'dispatch', entry });
            const next = queue.length > 0 ? queue.shift() : defaultResponse;
            const value = typeof next === 'function' ? await next(entry) : next;
            if (value instanceof Error) throw value;
            return value;
        },
        withGitSync: async (member, pushCode, dispatchFn, bracketOptions) => {
            const previous = bracketFrame;
            bracketFrame = { member, pushCode, options: { ...(bracketOptions || {}) } };
            rec.events.push({ type: 'bracket-open', member, pushCode, options: { ...(bracketOptions || {}) } });
            try {
                return await dispatchFn();
            } finally {
                bracketFrame = previous;
            }
        },
        withDispatchWatchdog: (dispatchPromise, watchdogOptions) => {
            // The engine evaluates `agent(...)` FIRST and passes the pending
            // promise in here, so the dispatch this watchdog races is always
            // the most recently recorded one.
            const last = rec.dispatches[rec.dispatches.length - 1];
            const armed = {
                timeoutS: watchdogOptions.timeoutS,
                member: watchdogOptions.member,
                label: watchdogOptions.label,
                hasLog: typeof watchdogOptions.log === 'function',
            };
            if (last) last.watchdog = armed;
            rec.events.push({ type: 'watchdog', armed });
            return dispatchPromise;
        },
        log: (message) => {
            rec.logs.push(message);
            rec.events.push({ type: 'log', message });
        },
        getMemberForRole: (role) => members[role] ?? `member:${role}`,
        memberSessionGuard: {
            killIfAlive: async (member) => {
                rec.kills.push(member);
                rec.events.push({ type: 'kill', member });
            },
        },
        onLlmAuthFailure: async ({ member, label, error }) => {
            rec.authHeals.push({ member, label, error });
            rec.events.push({ type: 'auth-heal', member, label, error });
            return healed;
        },
        fixedRoleTier: FIXED_ROLE_TIER,
        budgets,
        schemas: SCHEMAS,
        isNoMutationDispatchFailure: noMutation,
        invalidateAllBeadsCache: () => {
            rec.invalidations++;
            rec.events.push({ type: 'invalidate-beads-cache' });
        },
        // Every step name the engine asks for is answered by a RECORDING hook,
        // so a policy that names a step the runner has not wired yet fails on
        // the runner side (where ctx.steps is a real object) rather than here.
        // An explicit `steps` override wins, which is how a test drives a step
        // that must actually DO something (the doer's closed-streak
        // short-circuit) rather than merely be observed.
        steps: new Proxy({}, {
            has: () => true,
            get: (_target, step) => {
                if (typeof step !== 'string') return undefined;
                if (Object.prototype.hasOwnProperty.call(steps, step)) {
                    return async (args) => {
                        rec.steps.push({ step, ...args });
                        rec.events.push({ type: 'step', step });
                        return steps[step](args);
                    };
                }
                return async (args) => {
                    rec.steps.push({ step, ...args });
                    rec.events.push({ type: 'step', step });
                };
            },
        }),
    };
    return { ctx, rec };
}

/**
 * The per-call `opts` a planning role needs from its runner call site, filled
 * in with harness placeholders. A test overrides only what it is asserting
 * on; nothing here is policy (see role-policies.mjs's "deliberately out of
 * scope" note on labels and prompts).
 */
export const ROLE_CALL_OPTS = Object.freeze({
    planner: {
        prompt: 'PLANNER PROMPT',
        resumePrompt: 'PLANNER RESUME PROMPT',
        roleLabel: 'Planner',
        resumeArg: 'session-abc',
        resumeLabel: 'Plan (resume, max_turns=1000)',
    },
    'plan-reviewer': {
        prompt: 'PLAN REVIEW PROMPT',
        resumePrompt: 'PLAN REVIEW RESUME PROMPT',
        roleLabel: 'Plan Reviewer',
        resumeLabel: 'Plan Review (resume, max_turns=1000)',
        // Distinct SENTINELS rather than a copy of runner.js's real notes
        // text: what a pin needs to prove is that the engine routes the right
        // note-builder per error CLASS (degrade.paths === 2 means schema-repair
        // exhaustion and a dispatch/transport failure are told apart), and a
        // sentinel proves that without duplicating a production string that
        // would then have two places to drift.
        synthesizedNotes: {
            schema: (err) => `HARNESS-SCHEMA-CLASS: ${err.message}`,
            dispatch: (err) => `HARNESS-DISPATCH-CLASS: ${err.message}`,
        },
    },
    'scoped-replan-planner': {
        prompt: 'SCOPED REPLAN PLANNER PROMPT',
        roleLabel: 'Scoped Replan Plan',
        label: 'Scoped Replan Plan (interactive)',
    },
    'scoped-replan-plan-reviewer': {
        prompt: 'SCOPED REPLAN REVIEW PROMPT',
        roleLabel: 'Scoped Replan Review',
        label: 'Scoped Replan Review',
    },
    'streak-assignment': {
        prompt: 'STREAK ASSIGNMENT PROMPT',
        roleLabel: 'Streak Assignment',
        label: 'Streak Assignment',
        repairLabel: 'Streak Assignment (semantic repair)',
        repairPrompt: (reason) => `STREAK ASSIGNMENT PROMPT\n\nYour previous answer was REJECTED: ${reason}.`,
    },
});

/** The five planning roles this migration bead moved onto the engine. */
export const MIGRATED_PLANNING_ROLES = Object.freeze([
    'planner',
    'plan-reviewer',
    'scoped-replan-planner',
    'scoped-replan-plan-reviewer',
    'streak-assignment',
]);

/**
 * The two sentinel candidate values the semantic-repair drivers below use.
 * REJECTED is what `streakValidate` refuses; anything else it accepts, so a
 * re-ask that really re-dispatches lands on ACCEPTED and a ladder that
 * silently skipped the re-ask stays on REJECTED.
 */
export const REJECTED_CANDIDATE = 'REJECTED CANDIDATE';
export const ACCEPTED_CANDIDATE = 'ACCEPTED CANDIDATE';

/**
 * Stand-in for the runner's selectStreaks()-backed semantic validation: the
 * `postResult: ['select-streaks-validate']` step the streak-assignment policy
 * records. `result` is what the engine hands back as `outcome.validation`,
 * mirroring selectStreaks' real {streaks, usedFallback, reason} shape.
 */
export function streakValidate(candidate) {
    const ok = candidate !== REJECTED_CANDIDATE && candidate !== null && candidate !== undefined;
    return {
        ok,
        reason: ok ? null : 'ids did not cover the ready set',
        result: { streaks: ok ? [['bead-1']] : [['bead-1'], ['bead-2']], usedFallback: !ok, reason: ok ? null : 'ids did not cover the ready set' },
    };
}

/**
 * Runs the REAL engine so that `role`'s dispatch of `kind` actually happens,
 * and returns the recorded timeline plus the dispatch itself.
 *
 * Each dispatch KIND needs its own driver, because the kind IS the condition
 * that produces it: a 'max-turns-resume' only happens after turn exhaustion,
 * a 'semantic-repair-re-ask' only after a candidate fails validation. That is
 * itself part of what these pins assert -- a ladder that resumed on any error,
 * or re-asked unconditionally, would not land here.
 *
 * @param {string} role a key of ROLE_POLICIES
 * @param {'main'|'max-turns-resume'|'semantic-repair-re-ask'} kind
 */
export async function driveEngineDispatch(role, kind, options = {}) {
    // BINDINGS is supplied to EVERY role, not only the ones that name a
    // binding: an unused binding is inert, while a missing one makes the
    // engine throw rather than silently dispatching to the wrong member.
    const opts = { bindings: BINDINGS, ...ROLE_CALL_OPTS[role], ...(options.opts || {}) };
    if (ROLE_POLICIES[role].postResult.includes('select-streaks-validate') && !opts.validate) {
        opts.validate = streakValidate;
    }
    let { responses } = options;
    if (!responses) {
        if (kind === 'max-turns-resume') responses = [turnExhaustionError()];
        else if (kind === 'semantic-repair-re-ask') responses = [REJECTED_CANDIDATE, ACCEPTED_CANDIDATE];
        else responses = [];
    }
    const { ctx, rec } = createRecordingCtx({ responses, ...(options.ctx || {}) });
    const outcome = await dispatchRole(ctx, role, opts);
    const index = kind === 'main' ? 0 : 1;
    return { ctx, rec, outcome, opts, dispatch: rec.dispatches[index] };
}

/**
 * Rebuilds a policy watchdog label from its segment list the way the engine
 * does -- literal string segments verbatim, an `{ expr }` segment evaluated
 * as turn-base arithmetic over the engine's own TURN_BASES.
 */
export function watchdogLabelOf(segments) {
    if (!segments) return null;
    return segments
        .map((segment) => {
            if (typeof segment === 'string') return segment;
            const m = /^([A-Za-z_$][\w$]*)(?:\s*\*\s*(\d+))?$/.exec(String(segment.expr).trim());
            if (!m || typeof TURN_BASES[m[1]] !== 'number') {
                throw new Error(`watchdogLabelOf: ${JSON.stringify(segment.expr)} is not turn-base arithmetic.`);
            }
            return String(m[2] ? TURN_BASES[m[1]] * Number(m[2]) : TURN_BASES[m[1]]);
        })
        .join('');
}
