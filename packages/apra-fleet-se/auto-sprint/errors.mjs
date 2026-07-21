// apra-fleet-unw.15 -- typed error(s) local to the auto-sprint runner.
//
// SprintPlanRejectedError is sprint-specific (it is only ever thrown by
// runner.js's Plan phase) so it lives here rather than in
// packages/apra-fleet-workflow/src/workflow/errors.mjs, which is the
// generic, package-wide error taxonomy for agent()/command() failures.
// It still extends WorkflowError so callers that only know about the
// generic taxonomy (e.g. a future top-level sprint-status classifier) can
// catch `WorkflowError` and still see this failure.

import { WorkflowError } from '@apralabs/apra-fleet-workflow';

/**
 * Thrown when a sprint's Plan phase exhausts its planning rounds (3, per
 * apra-fleet-unw.15) without the plan-reviewer returning an APPROVED
 * verdict. The sprint MUST NEVER proceed to Develop with an unapproved
 * plan -- this error is how that guarantee is enforced: it is not caught
 * anywhere in the Plan phase, so it unwinds runWithContext()'s promise and
 * fails the whole sprint run before any Doer dispatch occurs.
 *
 * @property {string|null} notes - the last plan-reviewer verdict's `notes`
 *   field (or a synthesized message if the reviewer never returned
 *   schema-valid output at all), carried through so a human/CI reading the
 *   failure knows exactly what was wrong with the plan.
 */
export class SprintPlanRejectedError extends WorkflowError {
    /**
     * @param {string} message
     * @param {{ notes?: string|null, cycle?: number, planningRounds?: number, details?: object, cause?: unknown }} [opts]
     */
    constructor(message, opts = {}) {
        const { notes = null, cycle, planningRounds, details, cause } = opts;
        super(message, {
            code: 'SPRINT_PLAN_REJECTED',
            details: { notes, cycle, planningRounds, ...details },
            cause,
        });
        this.notes = notes;
    }
}

/**
 * apra-fleet-unw.17 (A5) -- thrown when the sprint's cycle loop detects N
 * consecutive cycles (default 2, per the pm skill mandate cited in the
 * issue text) with zero net change in the closed-bead count for the
 * sprint's scope. Before this issue, a permanently blocked/orphaned
 * in_progress bead (or a develop/review loop that keeps reopening and
 * re-failing the same bead(s) without ever closing anything new) had no
 * escape hatch other than burning every remaining cycle up to
 * `max_cycles` -- this error aborts loudly and early instead, with the
 * per-cycle closed-count history attached so a human/CI reading the
 * failure can see exactly where progress stopped.
 *
 * Never caught inside runner.js's cycle loop -- it unwinds
 * `runWithContext()`'s promise and fails the whole sprint run, the same
 * way `SprintPlanRejectedError` does for an unapproved plan.
 *
 * @property {number} staleCycles - how many consecutive cycles showed zero progress
 * @property {number[]} closedCountHistory - closed-bead count in scope, per cycle, in order
 * @property {number} [highWaterClosedCount] - N9 (apra-fleet-unw2.7): the
 *   highest closed-bead count observed at any point this sprint (the
 *   high-water mark progress is measured against)
 * @property {string[]} [thrashIds] - N9: bead ids reopened more than the
 *   reopen-thrash threshold this sprint, i.e. the beads most likely
 *   responsible for a close/reopen oscillation stall
 */
export class StalledSprintError extends WorkflowError {
    /**
     * @param {string} message
     * @param {{ staleCycles?: number, closedCountHistory?: number[], highWaterClosedCount?: number, thrashIds?: string[], cycle?: number, details?: object, cause?: unknown }} [opts]
     */
    constructor(message, opts = {}) {
        const { staleCycles = null, closedCountHistory = [], highWaterClosedCount = null, thrashIds = [], cycle, details, cause } = opts;
        super(message, {
            code: 'SPRINT_STALLED',
            details: { staleCycles, closedCountHistory, highWaterClosedCount, thrashIds, cycle, ...details },
            cause,
        });
        this.staleCycles = staleCycles;
        this.closedCountHistory = closedCountHistory;
        this.highWaterClosedCount = highWaterClosedCount;
        this.thrashIds = thrashIds;
    }
}

/**
 * apra-fleet-unw2.6 (N8) -- thrown when the reviewer persistently returns a
 * self-contradictory verdict: `CHANGES_NEEDED` with BOTH `reopenIds` and
 * `newTasks` empty. That combination is schema-legal but semantically
 * meaningless -- `CHANGES_NEEDED` asserts more work is required, yet the
 * verdict names nothing to reopen and proposes no new follow-up work, so
 * there is nothing for the orchestrator to act on. Left unhandled, this
 * "verdict" can never resolve to APPROVED and never produces a reopened/new
 * bead either, so a cycle loop that keeps hitting it makes no closed-bead
 * progress -- which apra-fleet-unw.17's stall-abort bookkeeping cannot tell
 * apart from genuine no-progress, and can misreport an otherwise-finished
 * sprint (every bead already closed) as `StalledSprintError`.
 *
 * The cycle loop retries the review dispatch exactly once when this
 * contradiction is first seen (the reviewer may have been dispatched with
 * stale/incomplete context); if the SAME contradiction repeats on the
 * retry, this error is thrown instead of letting the round silently
 * accumulate toward stall-abort. Never caught inside runner.js's cycle
 * loop -- it unwinds `runWithContext()`'s promise and fails the whole
 * sprint run, the same way `StalledSprintError`/`SprintPlanRejectedError` do.
 *
 * @property {number} cycle - the outer sprint cycle the violation occurred in
 * @property {string|null} notes - the reviewer's own `notes` field from the
 *   contradictory verdict, carried through for a human/CI reading the failure
 */
export class ReviewerContractViolationError extends WorkflowError {
    /**
     * @param {string} message
     * @param {{ cycle?: number, notes?: string|null, details?: object, cause?: unknown }} [opts]
     */
    constructor(message, opts = {}) {
        const { cycle, notes = null, details, cause } = opts;
        super(message, {
            code: 'REVIEWER_CONTRACT_VIOLATION',
            details: { cycle, notes, ...details },
            cause,
        });
        this.cycle = cycle;
        this.notes = notes;
    }
}

/**
 * apra-fleet-eft.8.1 (Plan Part 3.1/3.3, risk 2) -- thrown when an
 * orchestrator-bracketed git sync (G-pull / G-push) discovers that a member
 * has DIVERGED from the shared sprint branch: a `git merge --ff-only` that
 * could not fast-forward, an unmerged/conflicted `git pull --rebase`, or a
 * `git push` still rejected as non-fast-forward AFTER the single bounded
 * pull-rebase retry.
 *
 * Divergence is the hard, non-retryable failure class in the single-writer
 * token-passing model: because the writer pushes and the next reader pulls,
 * every intra-sprint merge is fast-forward BY CONSTRUCTION, so a non-FF state
 * means the invariant is already broken. It MUST NEVER be auto-resolved or
 * retried blindly -- the whole point of a distinct typed error (vs a generic
 * CommandError) is that the classifier can tell "diverged -> abort" apart from
 * "transient -> retry" and route the two differently.
 *
 * @property {string|null} member - the member whose checkout diverged
 * @property {string|null} gitOutput - the raw git stderr/stdout that proved divergence
 * @property {string|null} operation - which bracket step diverged
 *   ('pull' | 'push' | 'push-rebase')
 */
export class GitDivergedError extends WorkflowError {
    /**
     * @param {string} message
     * @param {{ member?: string|null, gitOutput?: string|null, operation?: string|null, details?: object, cause?: unknown }} [opts]
     */
    constructor(message, opts = {}) {
        const { member = null, gitOutput = null, operation = null, details, cause } = opts;
        super(message, {
            code: 'GIT_DIVERGED',
            details: { member, gitOutput, operation, ...details },
            cause,
        });
        this.member = member;
        this.gitOutput = gitOutput;
        this.operation = operation;
    }
}

/**
 * apra-fleet-eft.8.1 -- thrown when an orchestrator-bracketed git sync
 * (G-pull / G-push) fails for a reason that is NOT divergence and that
 * SURVIVED the bounded transient-retry budget: a transient class failure
 * (network unreachable, an index/ref lock) that kept failing after its
 * allowed retries, or an unclassifiable git failure that must not be retried
 * blindly.
 *
 * This is the counterpart to {@link GitDivergedError}: both extend
 * WorkflowError and both carry the member and raw git output, but they are
 * deliberately distinct types so a caller/test can assert the two failure
 * classifications (transient-retry-exhausted vs diverged-abort) SEPARATELY,
 * which is the crux of risk 2 in the plan.
 *
 * @property {string|null} member - the member whose sync failed
 * @property {string|null} gitOutput - the raw git stderr/stdout of the failure
 */
export class GitSyncError extends WorkflowError {
    /**
     * @param {string} message
     * @param {{ member?: string|null, gitOutput?: string|null, details?: object, cause?: unknown }} [opts]
     */
    constructor(message, opts = {}) {
        const { member = null, gitOutput = null, details, cause } = opts;
        super(message, {
            code: 'GIT_SYNC_FAILED',
            details: { member, gitOutput, ...details },
            cause,
        });
        this.member = member;
        this.gitOutput = gitOutput;
    }
}

/**
 * apra-fleet-eft.9.1 (Plan Part 3.3) -- thrown when an orchestrator-bracketed
 * DOLT sync (D-pull / D-push of the shared beads database) discovers a
 * divergence that the fixed, mechanical conflict policy could NOT close: a
 * `bd dolt pull` that reports a data/merge conflict outside a push-loser's
 * reconcile, or a `bd dolt push` STILL rejected after the single bounded
 * pull-then-repush reconcile.
 *
 * This is the Dolt counterpart of {@link GitDivergedError}. The beads-sync
 * conflict policy is deliberately NOT per-conflict judgment: it is
 * first-successful-pusher-wins, with ours/theirs decided mechanically by which
 * clone is doing the resolving (the push loser reconciles by pulling the
 * winner's state, then re-pushes). A divergence that outlives that one bounded
 * reconcile is a hard, non-retryable failure -- surfacing it as a distinct
 * typed error lets callers/tests tell "diverged -> abort" apart from
 * "transient -> retry", exactly as the git brackets do.
 *
 * @property {string|null} member - the member whose beads clone diverged
 * @property {string|null} doltOutput - the raw `bd dolt` stderr/stdout that proved divergence
 * @property {string|null} operation - which bracket step diverged
 *   ('pull' | 'push' | 'push-reconcile')
 */
export class DoltDivergedError extends WorkflowError {
    /**
     * @param {string} message
     * @param {{ member?: string|null, doltOutput?: string|null, operation?: string|null, details?: object, cause?: unknown }} [opts]
     */
    constructor(message, opts = {}) {
        const { member = null, doltOutput = null, operation = null, details, cause } = opts;
        super(message, {
            code: 'DOLT_DIVERGED',
            details: { member, doltOutput, operation, ...details },
            cause,
        });
        this.member = member;
        this.doltOutput = doltOutput;
        this.operation = operation;
    }
}

/**
 * apra-fleet-eft.9.1 (Plan Part 3.3) -- thrown when an orchestrator-bracketed
 * DOLT sync (D-pull / D-push) fails for a reason that is NOT divergence and
 * that SURVIVED the bounded transient-retry budget: a transient-class failure
 * (network unreachable, a server/lock hiccup) that kept failing after its
 * allowed retries, or an unclassifiable `bd dolt` failure that must not be
 * retried blindly.
 *
 * The Dolt counterpart of {@link GitSyncError}: deliberately a distinct type
 * from {@link DoltDivergedError} so a caller/test can assert the two failure
 * classifications (transient-retry-exhausted vs diverged-abort) SEPARATELY.
 *
 * @property {string|null} member - the member whose beads sync failed
 * @property {string|null} doltOutput - the raw `bd dolt` stderr/stdout of the failure
 */
export class DoltSyncError extends WorkflowError {
    /**
     * @param {string} message
     * @param {{ member?: string|null, doltOutput?: string|null, details?: object, cause?: unknown }} [opts]
     */
    constructor(message, opts = {}) {
        const { member = null, doltOutput = null, details, cause } = opts;
        super(message, {
            code: 'DOLT_SYNC_FAILED',
            details: { member, doltOutput, ...details },
            cause,
        });
        this.member = member;
        this.doltOutput = doltOutput;
    }
}

// ---------------------------------------------------------------------------
// Non-retryable dispatch failures (stabilization Issue 43 / smoke rehearsal)
// ---------------------------------------------------------------------------
//
// An authentication or workspace-trust failure is deterministic: the member's
// credential/trust state does not change between attempts, so every retry
// burns a full dispatch budget to reproduce the identical failure (observed
// live: 5 planner retries x 15-minute interactive timeouts against an
// unauthenticated member = 75 wasted minutes for an error that was terminal
// at second zero). The fleet server already classifies these categories as
// non-retryable (src/utils/prompt-errors.ts isRetryable()); this mirrors
// that judgment on the engine side, keyed off the server's own error-message
// signatures since the message string is all that crosses the dispatch
// boundary today.
const NON_RETRYABLE_DISPATCH_RE = /authentication failed|not logged in|workspace not trusted|has not been trusted/i;

/**
 * True when a dispatch error can NEVER be fixed by retrying (auth /
 * workspace-trust failures). Callers must abort their retry loop and surface
 * the error immediately, with remediation left to the operator.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isNonRetryableDispatchError(err) {
    return NON_RETRYABLE_DISPATCH_RE.test(String(err?.message ?? ''));
}
