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
