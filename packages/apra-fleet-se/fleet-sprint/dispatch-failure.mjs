// The dispatch-outcome classification surface for fleet-sprint
// (apra-fleet-3swo.6.15). Extracted out of runner.js; runner.js re-exports
// every symbol it previously exported from this region, so existing
// importers of fleet-sprint/runner.js resolve unchanged.
//
// This module owns:
//   - isTerminalSprintFailure: classifies whether a thrown error is a
//     terminal typed sprint failure (gates the terminal run-state record so
//     the supervisor watchdog can tell FINISHED-with-a-reason from CRASHED).
//   - isNoMutationDispatchFailure: classifies whether a thrown dispatch error
//     means the dispatch delivered no usable result and therefore produced no
//     code/beads mutation to publish (gates skipping the post-dispatch sync
//     teardown).
//   - withDispatchWatchdog: the client-side dispatch watchdog that races an
//     already-in-flight dispatch promise against a local timer.
//
// Kept DISTINCT from dispatch-role.mjs on purpose: dispatch-role.mjs is the
// dispatchRole engine that PERFORMS a dispatch; these three classify or bound
// the OUTCOME of one, and dispatchRole itself consumes them. Folding them into
// dispatch-role.mjs would make the engine import its own callers' policy.

import { AgentOutputError, AgentDispatchError, FleetTransportError, WorkflowError, BudgetExceededError, CancelledError } from '@apralabs/apra-fleet-workflow';
import { isTypedAbortError } from './abort.mjs';

// Deliberately BROADER than isTypedAbortError(): every terminal WorkflowError
// except a cooperative cancellation. The two predicates answer two different
// questions in main()'s catch and must not be collapsed:
//   - isTerminalSprintFailure() gates the terminal run-state record, which
//     exists so the supervisor watchdog can classify a run whose PID is gone as
//     FINISHED-with-a-reason rather than CRASHED. EVERY terminal typed failure
//     needs that, not just the aborts -- e.g. a Planner AgentDispatchError from
//     a dead interactive session must surface a reason, not look like a crash.
//   - isTypedAbortError() gates finalizeAbort()'s branch push + [ABORTED] PR,
//     which is only worth doing where there is a genuine sprint abort whose
//     partial work a human should look at.
// An untyped throw (a plain Error/TypeError -- i.e. a real bug) is deliberately
// NOT terminal here: it keeps flowing to the CLI's top-level catch with no
// record, so the watchdog still reports it as CRASHED.
export function isTerminalSprintFailure(err) {
    if (!err || err instanceof CancelledError) return false;
    return err instanceof WorkflowError || isTypedAbortError(err);
}

// AgentDispatchError reasons that mean the agent PROVABLY RAN before the
// dispatch failed, so its (possibly partial) code/beads work still has to be
// published and its teardown must run normally:
//   - 'max_turns_exhausted': the resumable partial-work case -- the agent hit
//     its turn ceiling after doing real work;
//   - 'watchdog_timeout': withDispatchWatchdog() fired locally on an
//     already-in-flight dispatch. The prompt was DELIVERED and the member is
//     alive-but-silent, so the turn may have run to completion (a stalled
//     planner can have created the whole DAG) with only the RESULT lost. The
//     watchdog abandons the dispatch promise, not the member's work.
const AGENT_RAN_DISPATCH_REASONS = new Set(['max_turns_exhausted', 'watchdog_timeout']);

// True when a thrown dispatch error means the dispatch delivered no usable
// result and therefore produced no code/beads mutation to publish: a failed
// agent dispatch (AgentDispatchError, minus the AGENT_RAN_DISPATCH_REASONS
// above), a dispatch-channel transport failure (FleetTransportError), or a
// PRE-dispatch typed sprint abort. The orchestrator's post-dispatch sync
// teardown is then wasted work and is skipped (see withGitSync).
//
// Deliberately EXCLUDED:
//   - AgentOutputError: the LLM RESPONDED and only its output was
//     empty/unparseable/schema-invalid. A schema-invalid response routinely
//     follows real committed work (the agent did the job, then botched the
//     report), so its teardown must run. This is the status quo -- the class
//     was never named here and, post-apra-fleet-9ta.1, isTypedAbortError() is
//     false for it -- pinned explicitly so a future edit cannot silently
//     re-sweep it in;
//   - every POST-dispatch typed abort. The predicate used to fold in the whole
//     of isTypedAbortError(), but only errors thrown from INSIDE withGitSync's
//     `dispatchFn` can ever reach it, and the curated abort set is dominated by
//     aborts the runner raises AFTER a dispatch already returned and mutated
//     beads (SprintPlanRejectedError, ReviewerContractViolationError,
//     StalledSprintError) or by divergences the SYNC brackets themselves throw
//     (GitDivergedError/DoltDivergedError), none of which are reachable here.
//     BudgetExceededError is the one genuinely pre-dispatch member: agent()/
//     command() throw it from inside the dispatch closure BEFORE any dispatch
//     is issued (packages/apra-fleet-workflow/src/workflow/errors.mjs), so it
//     alone provably mutated nothing.
export function isNoMutationDispatchFailure(err) {
    if (!err) return false;
    if (err instanceof AgentOutputError) return false;
    if (err instanceof AgentDispatchError && err.details && AGENT_RAN_DISPATCH_REASONS.has(err.details.reason)) {
        return false;
    }
    return err instanceof AgentDispatchError || err instanceof FleetTransportError || err instanceof BudgetExceededError;
}

// ---------------------------------------------------------------------------
// Client-side dispatch watchdog
// ---------------------------------------------------------------------------
//
// A member process can stay alive while producing no further output after a
// prompt is delivered -- a state no liveness check detects. `timeout_s` is
// threaded to execute_prompt on every dispatch, but server-side enforcement
// cannot be the only guard against an alive-but-silent orchestrator, so this
// adds a client-side backstop that depends on nothing the server does.
//
// withDispatchWatchdog() races an already-in-flight dispatch promise against a
// local timer of `timeoutS` plus this grace period, the grace existing so the
// server's own timeout gets first refusal at producing a clean error. If the
// dispatch has not settled by then, the race rejects with a typed
// AgentDispatchError (reason 'watchdog_timeout') rather than leaving the caller
// awaiting silently, and that typed error follows the same abort routing as
// every other typed dispatch failure here. Promise.race() attaches its own
// handler to the abandoned dispatch promise, so a late settlement after the
// watchdog fired is dropped rather than becoming an unhandled rejection.
const DISPATCH_WATCHDOG_GRACE_S = 30;

/**
 * @param {Promise<any>} dispatchPromise - an ALREADY-STARTED dispatch (e.g. an agent() call).
 * @param {{ timeoutS: number, member?: string, label?: string, log?: (msg: string) => void }} opts
 * @returns {Promise<any>}
 */
export function withDispatchWatchdog(dispatchPromise, opts = {}) {
    const { timeoutS, member = 'unknown', label = 'dispatch', log = () => {} } = opts;
    const budgetMs = (timeoutS + DISPATCH_WATCHDOG_GRACE_S) * 1000;
    let timer;
    const watchdogPromise = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            // "its configured watchdog budget", not a named field: this
            // budget is role-policies.mjs's resolved elapsed-ceiling value
            // (timeouts.maxTotalS when set and longer, else timeouts.timeoutS
            // -- see resolveWatchdogTimeout, apra-fleet-3swo.7.12 Final Review
            // reopen), so naming dispatch_timeout_s specifically here would be
            // wrong for a role like integ-test-runner whose watchdog resolves
            // to a different, longer budget.
            const message = `[dispatch-watchdog] ${label} to member '${member}' produced no result within ${timeoutS}s (+${DISPATCH_WATCHDOG_GRACE_S}s grace) -- treating this attempt as a stalled/dead session and aborting it (no code path may leave this orchestrator alive-but-silent past its configured watchdog budget).`;
            log(message);
            reject(new AgentDispatchError(
                `[Workflow Error] ${label} timed out (watchdog): no response from '${member}' within ${timeoutS}s (+${DISPATCH_WATCHDOG_GRACE_S}s grace).`,
                { details: { reason: 'watchdog_timeout', member, timeoutS, graceS: DISPATCH_WATCHDOG_GRACE_S } }
            ));
        }, budgetMs);
        // The timer is deliberately NOT unref'd. A never-settling dispatch can
        // leave this timer as the only work on the event loop; an unref'd timer
        // would then let the loop drain before it fires, so the abort would
        // never happen and the process would hang -- exactly what this watchdog
        // exists to prevent. Keeping it ref'd holds the loop open until the
        // abort fires; a dispatch that settles first is released by the
        // clearTimeout() below, so a fast dispatch never delays process exit.
    });
    return Promise.race([dispatchPromise, watchdogPromise]).finally(() => clearTimeout(timer));
}
