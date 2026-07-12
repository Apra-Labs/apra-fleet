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
