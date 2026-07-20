import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StalledSprintError, ReviewerContractViolationError } from '../auto-sprint/errors.mjs';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-unw2.6 (N8) regression 2: CHANGES_NEEDED with empty
// reopenIds AND empty newTasks (a schema-legal but self-contradictory
// verdict -- nothing for the orchestrator to act on) must never
// silently accumulate toward stall-abort even after every bead in scope
// is already closed. It is retried once, then surfaced distinctly as a
// ReviewerContractViolationError -- never misreported as
// StalledSprintError (a finished sprint must not read as "stalled").
// =============================================================================
test('mock sprint: a self-contradictory CHANGES_NEEDED verdict surfaces as a distinct contract-violation error', async () => {
    await withScenarioMarkers('contractviolation (reviewer contract violation)', async () => {
        console.log('Running mock sprint scenario (reviewer contract violation: CHANGES_NEEDED with empty reopenIds/newTasks)...');
        const contractViolation = await runDevelopLoopScenario('contractviolation', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Closes fine but reviewer contradicts itself' }],
            maxCycles: 3,
            // The doer does its job correctly and closes the bead; only the
            // REVIEWER contradicts itself on every round.
            reviewerHandler: async () => ({
                content: [{
                    text: JSON.stringify({
                        verdict: 'CHANGES_NEEDED',
                        notes: 'Contradictory: nothing to reopen, nothing new to create, yet not approved.',
                        reopenIds: [],
                        newTasks: [],
                    })
                }]
            }),
        });
        check(!!contractViolation.error, 'Expected the reviewer contract violation to abort the sprint with a distinct error, but it resolved successfully');
        check(
            contractViolation.error instanceof ReviewerContractViolationError,
            `Expected a ReviewerContractViolationError, got: ${contractViolation.error ? contractViolation.error.constructor.name + ': ' + contractViolation.error.message : 'no error'}`
        );
        check(
            !(contractViolation.error instanceof StalledSprintError),
            `A finished sprint (bead already closed) hitting a contract-violating reviewer round must never be misreported as StalledSprintError, got: ${contractViolation.error ? contractViolation.error.constructor.name : 'n/a'}`
        );
        const contractViolationTaskId = contractViolation.tasks[0].id;
        check(
            contractViolation.finalBeadsById.get(contractViolationTaskId) && contractViolation.finalBeadsById.get(contractViolationTaskId).status === 'closed',
            `Expected the bead to actually be closed (the doer did its job; only the review contract was violated), got: ${JSON.stringify(contractViolation.finalBeadsById.get(contractViolationTaskId))}`
        );
        check(
            contractViolation.logs.some((m) => m.includes('contract violation')),
            `Expected a logged 'contract violation' warning, logs: ${JSON.stringify(contractViolation.logs)}`
        );
        const contractViolationReviewCalls = contractViolation.dispatched.filter((d) => d.agent === 'reviewer' && d.label !== 'Final Review');
        check(
            contractViolationReviewCalls.length === 2,
            `Expected exactly 2 reviewer dispatches (initial + one retry) before surfacing the contract violation distinctly, got ${contractViolationReviewCalls.length}`
        );
    });
});
