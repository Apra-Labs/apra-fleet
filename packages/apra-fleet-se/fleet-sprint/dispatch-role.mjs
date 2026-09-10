import { policyFor } from './role-policies.mjs';
import {
    isNonRetryableDispatchError,
    isAuthDispatchError,
    isPostDispatchSyncFailure,
    isInfraDispatchFailure,
} from './errors.mjs';
import { AgentOutputError, AgentDispatchError, FleetTransportError, WorkflowError } from '@apralabs/apra-fleet-workflow';

// =============================================================================
// apra-fleet-3swo.5.3 -- dispatchRole(ctx, roleName, opts): the ONE dispatch
// engine that executes a role's ladder from fleet-sprint/role-policies.mjs's
// data table, replacing the hand-written agent() ladders runner.js used to
// spell out once per role.
//
// WHAT MOVED HERE: for every role role-policies.mjs marks `migrated: true`,
// this module owns the whole ladder -- the agent() dispatch itself, the
// withGitSync(...) bracket around it, the withDispatchWatchdog(...) race, the
// max_turns-exhaustion resume, the bounded retry ladder (backoff, LLM-auth
// self-heal, non-retryable abort, post-dispatch-sync-failure abort), the
// bounded semantic-repair re-ask, and the degrade that decides what the
// caller gets back once the attempts are spent. runner.js keeps only what is
// genuinely NOT policy: the prompt text, the presentation labels, the runtime
// bindings a policy names, and what the caller does with the outcome.
//
// WHY IT IS NOT A PASS-THROUGH: a dispatchRole that merely wrapped the
// original inline ladders would leave every behavioural axis duplicated per
// role, which is the condition role-policies.mjs was built to remove. There
// is exactly ONE agent() call site in this file, ONE withGitSync(...) bracket
// call and ONE withDispatchWatchdog(...) race; every per-role difference
// between them is read out of the policy row rather than written out again.
// fleet-sprint/inline-ladder-guard.mjs enforces the other half of that: a
// migrated role that still has an inline agent() ladder anywhere in the
// guarded-module set is a violation.
//
// EVERYTHING RUNNER-SIDE IS INJECTED, NEVER IMPORTED (same discipline as
// git-sync.mjs): agent(), withGitSync(), withDispatchWatchdog(), the member
// resolver, the session guard, the auth self-heal hook, the model-tier map,
// the budget map and the sprint's log() all arrive through `ctx`. This module
// deliberately never imports runner.js back -- runner.js imports it, so
// importing runner here would be a module cycle.
//
// TURN BASES live here rather than in runner.js because the dispatch that
// consumes them lives here. They keep their original runner.js NAMES
// (PLANNER_MAX_TURNS, ...) because role-policies.mjs records each policy's
// turn budget symbolically, by the name of the constant that supplies it --
// test/role-policies-table.test.mjs re-derives `maxTurns.value` by looking
// that name up in real source, so renaming one here would break that proof
// rather than silently drift.
// =============================================================================

// -----------------------------------------------------------------------------
// Turn bases. One per migrated ladder, named exactly as role-policies.mjs's
// `maxTurns.base` records them.
// -----------------------------------------------------------------------------

/** Planner turn base: it builds the whole epic DAG, so it gets a doer-sized budget. */
const PLANNER_MAX_TURNS = 500;
/** Plan-reviewer turn base: reviewer-sized, like every other review dispatch. */
const PLAN_REVIEWER_MAX_TURNS = 500;
/** Scoped replan planner turn base. */
const SCOPED_REPLAN_PLANNER_MAX_TURNS = 500;
/** Scoped replan plan-reviewer turn base. */
const SCOPED_REPLAN_REVIEWER_MAX_TURNS = 500;

/**
 * Every turn-base constant a policy's `maxTurns.base` may name, keyed by that
 * name. A policy naming a base absent from this map is a table/engine
 * mismatch and throws at dispatch time rather than silently dispatching with
 * no turn budget at all.
 */
export const TURN_BASES = Object.freeze({
    PLANNER_MAX_TURNS,
    PLAN_REVIEWER_MAX_TURNS,
    SCOPED_REPLAN_PLANNER_MAX_TURNS,
    SCOPED_REPLAN_REVIEWER_MAX_TURNS,
});

/**
 * The ladder's real timed backoff sleeps exist purely for production
 * busy-lock resilience; a hermetic mock run has no busy-lock to wait out, so
 * the harness sets this flag to exercise the full ladder LOGIC with zero
 * wall-clock. The delay values and the "waiting Ns" log line are unchanged
 * either way, so observable behaviour matches. Same env var the planner's
 * inline ladder read before this migration.
 */
function instantRetryBackoff() {
    return process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF === '1';
}

// -----------------------------------------------------------------------------
// Policy -> runtime resolution. Each function turns ONE policy field into the
// value the dispatch actually needs, and throws (rather than defaulting) when
// the table names something the engine cannot resolve.
// -----------------------------------------------------------------------------

/**
 * The member a dispatch routes to, resolved from `policy.member`:
 *   'role'      -- ctx.getMemberForRole(member.role)
 *   'pool-head' -- bindings[member.binding], a runner-local pool head
 *   'runtime'   -- bindings[member.binding], a runner-local binding
 *
 * @param {object} ctx
 * @param {{kind:string, role?:string, binding?:string}} member
 * @param {Record<string, any>} bindings
 * @returns {string}
 */
export function resolveMember(ctx, member, bindings = {}) {
    if (member && member.kind === 'role') return ctx.getMemberForRole(member.role);
    if (member && (member.kind === 'pool-head' || member.kind === 'runtime')) {
        const value = bindings[member.binding];
        if (value === undefined) {
            throw new Error(
                `dispatch-role: member binding '${member.binding}' was not supplied in opts.bindings -- a ` +
                `'${member.kind}'-kind member is a runner-local value the engine cannot resolve on its own.`
            );
        }
        return value;
    }
    throw new Error(`dispatch-role: unresolvable member kind ${JSON.stringify(member && member.kind)}.`);
}

/**
 * The model tier a dispatch is priced at, resolved from `policy.model`:
 *   'fixed'     -- ctx.fixedRoleTier[model.key]
 *   'per-bead'  -- bindings[model.binding] (the doer's declared tier)
 *   'inherited' -- undefined: a resume of an already-priced dispatch passes
 *                  no tier of its own.
 */
export function resolveModelTier(ctx, model, bindings = {}) {
    if (!model) return undefined;
    if (model.kind === 'fixed') return ctx.fixedRoleTier[model.key];
    if (model.kind === 'per-bead') return bindings[model.binding];
    if (model.kind === 'inherited') return undefined;
    throw new Error(`dispatch-role: unresolvable model kind ${JSON.stringify(model.kind)}.`);
}

/**
 * A budget (`timeouts.timeoutS` / `timeouts.maxTotalS`) resolved from its
 * SYMBOLIC name against ctx.budgets. null means "pass nothing and take the
 * transport default", which is a policy value in its own right (streak
 * assignment), not a missing one.
 */
export function resolveBudget(ctx, name) {
    if (name === null || name === undefined) return undefined;
    const value = ctx.budgets ? ctx.budgets[name] : undefined;
    if (value === undefined) {
        throw new Error(`dispatch-role: policy names budget '${name}', which ctx.budgets does not supply.`);
    }
    return value;
}

/**
 * The turn budget a dispatch passes, resolved from `policy.maxTurns`:
 *   null       -- no max_turns at all (the transport default)
 *   'constant' -- TURN_BASES[base] * multiplier
 *   'runtime'  -- bindings[binding], computed per resume attempt
 */
export function resolveMaxTurns(maxTurns, bindings = {}) {
    if (!maxTurns) return undefined;
    if (maxTurns.kind === 'runtime') return bindings[maxTurns.binding];
    return turnBaseValue(maxTurns.base) * maxTurns.multiplier;
}

function turnBaseValue(name) {
    const base = TURN_BASES[name];
    if (typeof base !== 'number') {
        throw new Error(
            `dispatch-role: policy names turn base '${name}', which is not one of TURN_BASES ` +
            `(${Object.keys(TURN_BASES).join(', ')}).`
        );
    }
    return base;
}

/**
 * The same-session resume argument, resolved from `policy.resumeArg`:
 *   null            -- absent
 *   'same-session'  -- true (an in-dispatch continuation of the session just run)
 *   'round-session' -- opts.resumeArg, the runner's per-round session lookup
 *   'worklist'      -- opts.resumeArg, the doer's per-worklist resume argument
 */
export function resolveResumeArg(resumeArg, opts) {
    if (!resumeArg) return undefined;
    if (resumeArg.kind === 'same-session') return true;
    return opts.resumeArg;
}

/**
 * A watchdog label, rebuilt from `policy.watchdog.label`'s segment list: a
 * plain string segment is literal text, an `{ expr }` segment is a runner
 * expression. The only expressions the table uses are turn-base arithmetic
 * (`PLANNER_MAX_TURNS * 2`), evaluated against TURN_BASES, so the watchdog's
 * kill-path identity stays owned by the policy table rather than passed in
 * as an opaque caller string.
 */
export function resolveWatchdogLabel(segments, bindings = {}) {
    return segments
        .map((segment) => {
            if (typeof segment === 'string') return segment;
            return String(evalLabelExpr(segment.expr, bindings));
        })
        .join('');
}

function evalLabelExpr(expr, bindings) {
    if (Object.prototype.hasOwnProperty.call(bindings, expr)) return bindings[expr];
    const m = /^([A-Za-z_$][\w$]*)(?:\s*\*\s*(\d+))?$/.exec(String(expr).trim());
    if (m && Object.prototype.hasOwnProperty.call(TURN_BASES, m[1])) {
        return m[2] ? TURN_BASES[m[1]] * Number(m[2]) : TURN_BASES[m[1]];
    }
    throw new Error(
        `dispatch-role: watchdog label expression ${JSON.stringify(expr)} is neither a supplied binding nor ` +
        'turn-base arithmetic over TURN_BASES.'
    );
}

/**
 * The schema object a dispatch validates its output against. Policies record
 * a schema by NAME ('planReviewerVerdict'); ctx.schemas maps that name to the
 * real contracts.mjs schema, so this module never imports the contracts and a
 * policy naming an unknown schema fails loudly instead of dispatching
 * unvalidated.
 */
function resolveSchema(ctx, schemaName) {
    if (!schemaName) return undefined;
    const schema = ctx.schemas ? ctx.schemas[schemaName] : undefined;
    if (!schema) {
        throw new Error(`dispatch-role: policy names schema '${schemaName}', which ctx.schemas does not supply.`);
    }
    return schema;
}

// -----------------------------------------------------------------------------
// Degrade: what the caller gets back once a ladder's attempts are spent, per
// role-policies.mjs's DEGRADE_KINDS.
// -----------------------------------------------------------------------------

/** Every constructor NAME on an error's prototype chain, nearest first. */
function errorClassNames(err) {
    const names = [];
    for (let proto = err; proto; proto = Object.getPrototypeOf(proto)) {
        const name = proto.constructor && proto.constructor.name;
        if (name) names.push(name);
        if (name === 'Error') break;
    }
    return names;
}

/**
 * Classifies a ladder failure into one of role-policies.mjs's ERROR_CLASSES.
 * The first two are universal:
 *   'schema'   -- AgentOutputError: agent()'s own bounded schema-repair loop
 *                 was exhausted, so no schema-valid output ever arrived;
 *   'dispatch' -- AgentDispatchError/FleetTransportError: the dispatch channel
 *                 itself failed (a dropped transport is exactly as transient
 *                 and non-schema as a dispatch error -- neither may abort the
 *                 whole sprint);
 *   null       -- anything else, i.e. an unrecognised error class.
 *
 * The remaining three exist only for the roles whose POLICY asks for them,
 * which is what keeps them variances-as-data rather than engine branches:
 *   'infra'    -- `degrade.classifiesInfraFailures` (the integ runner): a
 *                 dispatch that produced no result envelope at all is not a
 *                 test verdict and must never be recorded as one.
 *   'dispatch' -- also any class named in `degrade.extraDispatchErrors` (the
 *                 per-round reviewer's own read-side sync-bracket failures).
 *   'sync'     -- `degrade.classifiesSyncFailures` (the regression phase):
 *                 the git/beads sync AROUND the dispatch failed, which for
 *                 the one phase whose whole job is mutating beads is a
 *                 routine outcome worth reporting distinctly.
 *   'unknown'  -- `degrade.classifiesUnrecognisedErrors` (the regression
 *                 catch-all): even an unrecognised class gets a degrade path
 *                 rather than aborting an informational phase.
 *
 * Called with no policy it behaves exactly as the two-class version did.
 *
 * @param {Error} err
 * @param {object} [policy] the ROLE_POLICIES row whose degrade is in force
 */
export function classifyLadderError(err, policy) {
    const degrade = policy ? policy.degrade : null;
    if (err instanceof AgentOutputError) return 'schema';
    // BEFORE the generic dispatch class: an infra failure IS an
    // AgentDispatchError, and the whole point of the class is telling the two
    // apart for the one role that must not conflate them.
    if (degrade && degrade.classifiesInfraFailures
        && err instanceof AgentDispatchError && isInfraDispatchFailure(err)) {
        return 'infra';
    }
    if (err instanceof AgentDispatchError || err instanceof FleetTransportError) return 'dispatch';
    if (degrade && degrade.extraDispatchErrors.length > 0) {
        const names = errorClassNames(err);
        if (degrade.extraDispatchErrors.some((name) => names.includes(name))) return 'dispatch';
    }
    if (degrade && degrade.classifiesSyncFailures
        && (isPostDispatchSyncFailure(err) || err instanceof WorkflowError)) {
        return 'sync';
    }
    if (degrade && degrade.classifiesUnrecognisedErrors) return 'unknown';
    return null;
}

/**
 * Thrown by the engine itself when a SCHEMA-VALID result is rejected by the
 * caller's own semantic validator under `retry.retryOnInvalidResult`. It is
 * never surfaced to the caller: the ladder either retries the attempt or
 * converts it through `opts.onResultRejected`.
 */
export class LadderResultRejectedError extends Error {
    constructor(reason) {
        super(`dispatch-role: the ladder's result was rejected by its own validator (${reason}).`);
        this.name = 'LadderResultRejectedError';
        this.reason = reason;
    }
}

/**
 * The value a degrade fabricates for one failed attempt, from
 * `policy.degrade`. Only 'synthesized-verdict' fabricates anything on the
 * planning side: 'fallback-value', 'defer-to-next-cycle' and 'non-approval'
 * all hand the caller `null` and let it apply its own deterministic fallback
 * (selectStreaks' one-bead-per-streak grouping; deferring the flagged beads
 * to the next cycle; treating the scoped round as not approved).
 *
 * `degrade.marker` is stamped on every synthesized value so a degraded result
 * is never mistaken for a genuine one, and `degrade.neverSynthesizes` is what
 * role-policies-table.test.mjs holds this shape to: no degrade path anywhere
 * may fabricate an approval.
 */
function synthesizeDegradedValue(policy, opts, err, errorClass) {
    const degrade = policy.degrade;
    // `degrade.classes` -- not the degrade KIND -- decides whether this
    // ladder fabricates anything for THIS error class. A ladder that
    // recognises a class but does not list it (streak assignment's
    // 'fallback-value', the scoped replan's 'defer-to-next-cycle') hands the
    // caller null on purpose.
    if (!degrade.synthesized || !degrade.classes.includes(errorClass)) return null;
    const notes = opts.synthesizedNotes && opts.synthesizedNotes[errorClass]
        ? opts.synthesizedNotes[errorClass](err)
        : `${opts.roleLabel || policy.role} dispatch failed: ${err.message}`;
    const value = { ...degrade.synthesized, [degrade.notesField]: notes };
    if (degrade.marker) value[degrade.marker] = true;
    return value;
}

/**
 * The DEGRADE_STEPS a policy runs on each attempt that degrades (as opposed
 * to `postResult`, which runs only after a SUCCESSFUL attempt). The one step
 * today is the per-round reviewer's 'clear-round-session': a failed round's
 * session must not be resumed by the next round, and a successful one must.
 */
async function runDegradeSteps(ctx, policy, err, errorClass) {
    for (const step of policy.degrade.steps) {
        const hook = ctx.steps && ctx.steps[step];
        if (typeof hook !== 'function') {
            throw new Error(`dispatch-role: policy names degrade step '${step}', which ctx.steps does not supply.`);
        }
        await hook({ policy, error: err, errorClass });
    }
}

// -----------------------------------------------------------------------------
// The engine.
// -----------------------------------------------------------------------------

/**
 * Runs `roleName`'s dispatch ladder exactly as role-policies.mjs describes it.
 *
 * @param {object} ctx runner-supplied primitives (see this file's header):
 *   agent, withGitSync, withDispatchWatchdog, log, getMemberForRole,
 *   memberSessionGuard, onLlmAuthFailure, fixedRoleTier, budgets, schemas,
 *   isNoMutationDispatchFailure, invalidateAllBeadsCache, steps.
 * @param {string} roleName a key of ROLE_POLICIES.
 * @param {object} opts per-call values the policy deliberately does not carry:
 *   prompt           -- the built prompt (required)
 *   resumePrompt     -- the prompt a 'max-turns-resume' secondary sends
 *   repairPrompt     -- (reason) => prompt, for a 'semantic-repair-re-ask'
 *   validate         -- (value) => { ok, reason, result }: the semantic
 *                       validation `postResult: ['select-streaks-validate']`
 *                       names. Its `result` comes back as `validation`.
 *   resumeArg        -- runtime value for a 'round-session'/'worklist' resumeArg
 *   onSessionId      -- session-id recorder
 *   bindings         -- runner-local values a policy names by binding
 *   roleLabel        -- human role name used in this engine's log lines
 *   label/resumeLabel/repairLabel -- presentation labels (NOT policy: see
 *                       role-policies.mjs's "deliberately out of scope" note)
 *   attemptOptions   -- ({ attempt, skipPreDispatchSync }) => extra withGitSync options
 *   afterAttempt     -- async (value) => void, run INSIDE the attempt's try so
 *                       a failure in it is classified by the same ladder
 *   synthesizedNotes -- { schema(err), dispatch(err), infra(err), sync(err),
 *                       unknown(err) } -- one note builder per ERROR_CLASS
 *                       this role's `degrade.classes` fabricates for
 *   onResultRejected -- (reason) => Error, the error a `retryOnInvalidResult`
 *                       ladder throws once its budget is spent on results its
 *                       own validator keeps rejecting
 * @returns {Promise<{ok:boolean, value:any, error:Error|null, degraded:boolean,
 *                    inconclusive:{reason:string,message:string}|null, validation:any}>}
 */
export async function dispatchRole(ctx, roleName, opts = {}) {
    // Destructured so this module's ONE dispatch reads `agent(` -- the literal
    // token dispatch-safety-guard.mjs and inline-ladder-guard.mjs scan for. A
    // `ctx.agent(` call would fall outside both guards' call-site regexes and
    // leave this file's only dispatch silently unguarded.
    const { agent } = ctx;
    // ctx.policies: the table this run reads its row from, defaulting to the
    // real frozen ROLE_POLICIES. It exists so a test can splice ONE field of
    // ONE row and observe the engine behave differently -- which is the only
    // way to prove a per-role variance (the integ INCONCLUSIVE record, the
    // regression catch-all, the final-review heal short-circuit, the
    // deployer's pre-dispatch prompt invariant) is really driven by POLICY
    // DATA rather than by a branch in this file that happens to agree with
    // the table. Production never passes it.
    const policy = ctx.policies ? policyFor(roleName, ctx.policies) : policyFor(roleName);
    const bindings = opts.bindings || {};
    const member = resolveMember(ctx, policy.member, bindings);
    const roleLabel = opts.roleLabel || policy.role;
    const retry = policy.retry;
    const backoffMs = retry.backoffMs;
    const attempts = retry.attempts;

    // --- ONE dispatch, however the policy shapes it ------------------------
    // Every per-dispatch difference (member, persona, tier, budgets, turn
    // budget, schema, resume argument) is resolved from the policy row rather
    // than written out again per role. member_name is spelled at the call site
    // itself, never folded into `options`, because dispatch-safety-guard.mjs
    // requires every agent() call site to name its member explicitly.
    const runDispatch = (dispatch, prompt, label, attemptOpts) => {
        const options = {
            agentType: dispatch.agentType ?? undefined,
            model: resolveModelTier(ctx, dispatch.model, bindings),
            timeout_s: resolveBudget(ctx, dispatch.timeouts.timeoutS),
            max_total_s: resolveBudget(ctx, dispatch.timeouts.maxTotalS),
            max_turns: resolveMaxTurns(dispatch.maxTurns, bindings),
            schema: resolveSchema(ctx, dispatch.schema),
            resume: resolveResumeArg(dispatch.resumeArg, opts),
            onSessionId: opts.onSessionId,
            label,
        };
        for (const key of Object.keys(options)) {
            if (options[key] === undefined) delete options[key];
        }
        const invoke = () => {
            const inFlight = agent(prompt, {
                ...options,
                member_name: member,
            });
            if (!dispatch.watchdog.armed) return inFlight;
            // Raced against a client-side watchdog so a frozen-but-alive
            // member session can never leave this await silently hanging past
            // its budget -- needed in ADDITION to, not instead of, the
            // server-side timeout_s/max_total_s above.
            return ctx.withDispatchWatchdog(inFlight, {
                timeoutS: resolveBudget(ctx, dispatch.watchdog.timeoutS),
                member,
                label: resolveWatchdogLabel(dispatch.watchdog.label, bindings),
                log: ctx.log,
            });
        };
        // `dispatch.bracket`, not `policy.bracket`: a secondary dispatch
        // inherits its main dispatch's bracket by spread today, but reading it
        // off the dispatch actually being run is what keeps that an inherited
        // DEFAULT rather than a hard-wired assumption the table cannot
        // override.
        if (!dispatch.bracket.wrapped) return invoke();
        return ctx.withGitSync(member, dispatch.bracket.pushCode === true, invoke, {
            pushBeads: dispatch.bracket.pushBeads === true,
            ...(attemptOpts || {}),
        });
    };

    // --- one ATTEMPT: the main dispatch, plus the resume it may need --------
    // TWO conditions reach the SAME secondary dispatch, and the policy says
    // which of them this ladder honours:
    //   retry.maxTurnsResume       -- the turn budget was spent. Universal.
    //   retry.infraResumeAttempts  -- the member CLI died mid-turn and lost
    //                                 its result envelope, so the run may have
    //                                 made real progress and merely failed to
    //                                 report it. The integ runner alone, and
    //                                 bounded at one recovery.
    const runAttempt = async (attemptOpts) => {
        const preShortCircuit = await runPreDispatchSteps(ctx, policy, member, opts);
        if (preShortCircuit) return preShortCircuit.value;
        try {
            return await runDispatch(policy, opts.prompt, opts.label, attemptOpts);
        } catch (err) {
            const secondary = policy.secondary;
            const isTurnExhaustion = err instanceof AgentDispatchError
                && err.details && err.details.reason === 'max_turns_exhausted';
            const isInfra = err instanceof AgentDispatchError && isInfraDispatchFailure(err);
            const resumesOnExhaustion = retry.maxTurnsResume && isTurnExhaustion;
            const resumesOnInfra = retry.infraResumeAttempts > 0 && isInfra && !isTurnExhaustion;
            if (!secondary || secondary.kind !== 'max-turns-resume' || (!resumesOnExhaustion && !resumesOnInfra)) {
                throw err;
            }
            if (resumesOnExhaustion) {
                ctx.log(
                    `${roleLabel} exhausted its turn limit (max_turns=${resolveMaxTurns(policy.maxTurns, bindings)}) -- ` +
                    `resuming the same session with max_turns=${resolveMaxTurns(secondary.maxTurns, bindings)}.`
                );
            } else {
                ctx.log(
                    `${roleLabel}: infrastructure dispatch failure ` +
                    `(${(err.details && err.details.reason) || 'unknown'}) -- the member produced no result envelope. ` +
                    'This is NOT a failure verdict; resuming the same session once to recover before recording anything.'
                );
            }
            // A resume follows an agent that DID run (max_turns_exhausted is a
            // resumable partial-work case, not a no-mutation failure), so it
            // always runs the full pre-dispatch sync -- no attemptOpts.
            const shortCircuit = await runPreDispatchSteps(ctx, secondary, member, opts);
            // A pre-dispatch step may find the work already DONE (the doer's
            // 'verify-streak-closed': a streak whose beads all closed before
            // the turn limit hit is a success that merely missed its VERIFY
            // checkpoint), in which case no resume dispatch is made at all.
            if (shortCircuit) return shortCircuit.value;
            return await runDispatch(secondary, opts.resumePrompt, opts.resumeLabel);
        }
    };

    let lastErr = null;
    let value;
    let ok = false;
    let degradedValue = null;
    let skipPreDispatchSyncNext = false;
    // Set once an auth self-heal succeeded under retry.authSelfHealShortCircuits:
    // the attempt it grants is the ladder's last, whatever it returns.
    let healRetryIsFinal = false;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (backoffMs && backoffMs[attempt - 1] > 0) {
            ctx.log(
                `${roleLabel} dispatch: waiting ${backoffMs[attempt - 1] / 1000}s before retry attempt ` +
                `${attempt}/${backoffMs.length}...`
            );
            if (!instantRetryBackoff()) {
                await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt - 1]));
            }
        }
        try {
            const attemptOpts = {
                ...(retry.skipPreDispatchSyncOnNoMutation ? { skipPreDispatchSync: skipPreDispatchSyncNext } : {}),
                ...(opts.attemptOptions ? opts.attemptOptions({ attempt }) : {}),
            };
            value = await runAttempt(attemptOpts);
            if (opts.afterAttempt) await opts.afterAttempt(value);
            await runPostResultSteps(ctx, policy, value, opts);
            // A ladder that declares retryOnInvalidResult spends a whole
            // attempt on a schema-valid answer its own validator rejects,
            // rather than handing the caller a result it has already judged
            // unusable. Thrown INSIDE the try so it lands in the same catch
            // that classifies a dispatch failure.
            if (retry.retryOnInvalidResult && opts.validate) {
                const check = opts.validate(value);
                if (!check.ok) throw new LadderResultRejectedError(check.reason);
            }
            ok = true;
            lastErr = null;
            degradedValue = null;
            break;
        } catch (err) {
            lastErr = err;

            // A rejected-but-schema-valid result is NOT a degrade: the
            // dispatch worked, its answer was unusable. Retry the whole
            // attempt inside the same budget, then hand the caller its own
            // error rather than a fabricated value.
            if (err instanceof LadderResultRejectedError) {
                if (attempt < attempts) {
                    ctx.log(
                        `${roleLabel}: result rejected (${err.reason}) -- re-running the dispatch ` +
                        `(attempt ${attempt + 1} of ${attempts}) before treating this as a distinct failure.`
                    );
                    continue;
                }
                throw opts.onResultRejected ? opts.onResultRejected(err.reason) : err;
            }

            // The turn ALREADY RAN and its output is committed on the member's
            // own clone -- only the post-dispatch sync failed, and withGitSync
            // already retried that step on its own. Re-dispatching would spawn
            // a second session for the same phase on top of completed work.
            if (retry.skipRedispatchOnPostDispatchSyncFailure && isPostDispatchSyncFailure(err)) {
                ctx.log(
                    `${roleLabel} dispatch COMPLETED but its post-dispatch sync failed: ${err.message} Aborting ` +
                    'retries WITHOUT re-dispatching -- the turn already ran and its writes are local; fix the sync ' +
                    'and re-run.'
                );
                break;
            }

            // Only a provably no-mutation dispatch failure leaves the workspace
            // unchanged, so only then may the next attempt skip its
            // pre-dispatch sync. Any other error re-arms it.
            if (retry.skipPreDispatchSyncOnNoMutation) {
                skipPreDispatchSyncNext = ctx.isNoMutationDispatchFailure(err);
            }

            // Auth/workspace-trust failures are deterministic -- no retry can
            // succeed -- so a ladder that declares abortOnNonRetryable ends
            // rather than burning its remaining attempts on the same wall.
            if (retry.abortOnNonRetryable && isNonRetryableDispatchError(err)) {
                // An LLM-auth failure (unlike workspace trust, which self-heal
                // cannot fix) gets one bounded self-heal attempt first.
                if (retry.authSelfHeal && isAuthDispatchError(err) && typeof ctx.onLlmAuthFailure === 'function') {
                    const healed = await ctx.onLlmAuthFailure({
                        member, label: `${roleLabel} dispatch`, error: err.message,
                    });
                    if (healed) {
                        ctx.log(`${roleLabel} dispatch: LLM auth self-heal succeeded -- retrying.`);
                        // retry.authSelfHealShortCircuits: the healed retry is
                        // this ladder's LAST word. A role whose dispatch is
                        // the single most expensive in the sprint (final
                        // review) must not fall through to the generic retry
                        // as well -- that fires a SECOND full review and
                        // silently discards the healed verdict, which for a
                        // PASS/FAIL gate can invert the sprint's outcome.
                        healRetryIsFinal = retry.authSelfHealShortCircuits;
                        continue;
                    }
                }
                ctx.log(
                    `${roleLabel} dispatch threw a non-retryable error (auth/trust): ${err.message}. Aborting ` +
                    "retries -- fix the member's credentials/trust and re-run."
                );
                break;
            }

            // A ladder that does NOT abort on a non-retryable error still
            // self-heals an unhealed LLM-auth failure, because the SAME member
            // is dispatched again later in the cycle and would otherwise walk
            // into the identical wall.
            if (!retry.abortOnNonRetryable && retry.authSelfHeal && isAuthDispatchError(err)
                && typeof ctx.onLlmAuthFailure === 'function') {
                await ctx.onLlmAuthFailure({ member, label: `${roleLabel} dispatch`, error: err.message });
            }

            // RUN-level control signals are not failures of this role at all,
            // so they keep propagating even through a catch-all that swallows
            // everything else: honouring a cancellation outranks finishing an
            // informational phase, and swallowing a blown spend ceiling would
            // let the run keep spending past a limit the operator set.
            if (policy.degrade.rethrowsRunControlSignals.length > 0) {
                const names = errorClassNames(err);
                if (policy.degrade.rethrowsRunControlSignals.some((name) => names.includes(name))) throw err;
            }

            const errorClass = classifyLadderError(err, policy);
            // An unrecognised error class still propagates rather than being
            // degraded silently -- except under a degrade that declares
            // otherwise, and except under 'fatal', whose whole contract is to
            // accumulate and rethrow after the ladder is spent.
            if (errorClass === null && policy.degrade.kind !== 'fatal'
                && policy.degrade.rethrowsUnrecognisedErrors) {
                throw err;
            }
            if (errorClass === 'schema') {
                ctx.log(`${roleLabel}: schema-repair exhausted, degrading (${policy.degrade.kind}): ${err.message}`);
            } else if (errorClass === 'dispatch') {
                ctx.log(`${roleLabel}: agent dispatch failed, degrading (${policy.degrade.kind}): ${err.message}`);
            } else if (errorClass === 'infra') {
                ctx.log(
                    `${roleLabel}: infrastructure dispatch failure persisted -- degrading ` +
                    `(${policy.degrade.kind}), NOT recording a failure verdict: ${err.message}`
                );
            } else if (errorClass === 'sync') {
                ctx.log(
                    `${roleLabel}: the git/beads sync around the dispatch FAILED (${err.name}: ${err.message}) -- ` +
                    `degrading (${policy.degrade.kind}). Anything this phase filed may still be local-only.`
                );
            } else if (errorClass === 'unknown') {
                ctx.log(
                    `${roleLabel}: unexpected error, degrading (${policy.degrade.kind}) -- this phase never aborts ` +
                    `the sprint: ${err && err.stack ? err.stack : err}`
                );
            }
            await runDegradeSteps(ctx, policy, err, errorClass);
            degradedValue = synthesizeDegradedValue(policy, opts, err, errorClass);
            const isLastAttempt = attempt === attempts || healRetryIsFinal;
            ctx.log(
                `${roleLabel} dispatch threw: ${err.message}.` +
                (isLastAttempt ? ' Retries exhausted.' : ` Retrying (attempt ${attempt + 1} of ${attempts}).`)
            );
            if (healRetryIsFinal) break;
        }
    }

    if (!ok) {
        // The one FATAL degrade in the table: there is no sprint without a
        // plan, so an exhausted planner ladder rethrows rather than
        // synthesizing one.
        if (policy.degrade.kind === 'fatal' && lastErr) throw lastErr;
        return {
            ok: false,
            value: degradedValue,
            error: lastErr,
            degraded: true,
            // An 'inconclusive' degrade whose terminal failure really was an
            // envelope-less infra fault reports WHY there is no verdict, so
            // the caller records "no evidence" instead of "the tests failed".
            // Driven by degrade.kind: any other kind reports null here, which
            // is what makes the INCONCLUSIVE variance policy data rather than
            // a branch the integ caller happens to take.
            inconclusive: inconclusiveOf(policy, lastErr),
            validation: opts.validate && !retry.retryOnInvalidResult
                ? opts.validate(degradedValue).result
                : null,
        };
    }

    // --- semantic-repair re-ask -------------------------------------------
    // ONE bounded attempt layered on top of agent()'s own schema-repair loop:
    // a candidate can be schema-valid yet semantically invalid, and dropping
    // it straight to the caller's deterministic fallback silently discards
    // real intent. Re-ask once with the exact validation failure; only then
    // let the caller fall back. Guarded, never looped.
    let validation = null;
    if (opts.validate) {
        let verdictOfCandidate = opts.validate(value);
        if (!verdictOfCandidate.ok && retry.semanticRepairReAsks > 0 && value) {
            ctx.log(
                `${roleLabel}: candidate rejected (${verdictOfCandidate.reason}) -- re-asking once with the ` +
                'validation failure before falling back.'
            );
            try {
                value = await runDispatch(policy.secondary, opts.repairPrompt(verdictOfCandidate.reason), opts.repairLabel);
                verdictOfCandidate = opts.validate(value);
            } catch (repairErr) {
                if (classifyLadderError(repairErr, policy) === null) throw repairErr;
                ctx.log(`${roleLabel} (semantic repair): dispatch failed (${repairErr.message}) -- falling back.`);
            }
        }
        validation = verdictOfCandidate.result;
    }

    return { ok: true, value, error: null, degraded: false, inconclusive: null, validation };
}

/**
 * The "there is no verdict, and here is why" record an 'inconclusive' degrade
 * returns, or null for every other degrade kind (and for an inconclusive
 * ladder whose terminal failure was NOT an infra fault -- that one really did
 * fail, and says so).
 */
function inconclusiveOf(policy, lastErr) {
    if (policy.degrade.kind !== 'inconclusive' || !lastErr) return null;
    if (classifyLadderError(lastErr, policy) !== 'infra') return null;
    return {
        reason: (lastErr.details && lastErr.details.reason) ?? 'unknown',
        message: lastErr.message,
    };
}

/**
 * The `preDispatch` steps role-policies.mjs records for a dispatch. Only one
 * lands on the planning side today: 'kill-stale-session', the kill every
 * max_turns resume performs before resuming a session that may still be
 * alive. The remaining PRE_DISPATCH_STEPS belong to execution-side ladders
 * and arrive with their own migration; a step with no engine handler and no
 * ctx.steps hook throws rather than being silently skipped.
 */
async function runPreDispatchSteps(ctx, dispatch, member, opts = {}) {
    for (const step of dispatch.preDispatch) {
        if (step === 'kill-stale-session') {
            await ctx.memberSessionGuard.killIfAlive(member);
            continue;
        }
        const hook = ctx.steps && ctx.steps[step];
        if (typeof hook !== 'function') {
            throw new Error(`dispatch-role: policy names preDispatch step '${step}', which ctx.steps does not supply.`);
        }
        // A step is handed the dispatch's own PROMPT as well as its member,
        // because some pre-dispatch invariants are properties of the prompt
        // ('sprint-self-id-in-prompt': the deploy runbook's active-sprints
        // gate self-blocks unless the prompt states the sprint's OWN
        // reservation id, so the step verifies that rather than trusting it).
        const result = await hook({ member, dispatch, opts });
        // A step may report the work already DONE, in which case the dispatch
        // it precedes is skipped entirely and its value stands in.
        if (result && result.shortCircuit === true) return result;
    }
    return null;
}

/**
 * The `postResult` steps role-policies.mjs records. 'invalidate-beads-cache'
 * is the one every beads-mutating planning ladder carries: a dispatch that
 * mutated beads on its OWN clone is invisible to the orchestrator's cache
 * until it is dropped. 'select-streaks-validate' IS opts.validate, performed
 * by the semantic-repair path above, so it is a no-op here.
 */
async function runPostResultSteps(ctx, policy, value, opts = {}) {
    for (const step of policy.postResult) {
        if (step === 'select-streaks-validate') continue;
        if (step === 'invalidate-beads-cache') {
            ctx.invalidateAllBeadsCache();
            continue;
        }
        const hook = ctx.steps && ctx.steps[step];
        if (typeof hook !== 'function') {
            throw new Error(`dispatch-role: policy names postResult step '${step}', which ctx.steps does not supply.`);
        }
        // The RESULT is handed to the step: every remaining post-result step
        // is about what the dispatch actually returned ('kb-apply' applies the
        // report's KB work, 'verify-streak-closed' checks the closes it
        // claims), so a step that could not see the value could not do its job.
        await hook({ policy, value, opts });
    }
}
