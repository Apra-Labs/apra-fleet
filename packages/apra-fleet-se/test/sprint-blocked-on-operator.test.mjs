import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTerminalReason } from '../fleet-sprint/fatal-diagnostics.mjs';
import { SprintBlockedOnOperatorError, SprintPlanRejectedError } from '../fleet-sprint/errors.mjs';
import { isDeterministicTerminalReason, HISTORY_EVENTS } from '../src/supervisor/history.mjs';

describe('SprintBlockedOnOperatorError', () => {
    const err = new SprintBlockedOnOperatorError('Planning is blocked on an operator: which database?', {
        question: 'which database?', beadIds: ['b-1'], decisionBeadId: 'b-dec',
    });

    test('carries the question, held beads and decision bead (what the abort PR body prints)', () => {
        assert.equal(err.code, 'SPRINT_BLOCKED_ON_OPERATOR');
        assert.equal(err.question, 'which database?');
        assert.deepEqual(err.details, { question: 'which database?', beadIds: ['b-1'], decisionBeadId: 'b-dec' });
        assert.ok(err.message.includes('which database?'));
        assert.ok(!/plan.?reject/i.test(err.message));
    });

    test('terminal reason is BLOCKED_ON_OPERATOR, never SPRINT_PLAN_REJECTED', () => {
        assert.equal(resolveTerminalReason(err), 'BLOCKED_ON_OPERATOR');
        assert.equal(resolveTerminalReason(new SprintPlanRejectedError('x')), 'SPRINT_PLAN_REJECTED');
    });

    test('a relaunch of a root that ended this way is not gated', () => {
        assert.equal(isDeterministicTerminalReason({ event: HISTORY_EVENTS.FINISHED, terminalReason: resolveTerminalReason(err) }), false);
    });
});
