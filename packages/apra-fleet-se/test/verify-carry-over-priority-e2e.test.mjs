import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runFinalReviewPhase } from '../fleet-sprint/phases/final-review.mjs';
import { markBounceCapDeferral } from '../fleet-sprint/verify-carry-over.mjs';

// =============================================================================
// End to end through the real runFinalReviewPhase: with a P1 goal, a P3 verify
// bead the engine deferred at the verify bounce cap is named in the verdict
// notes and the sprint stays PASS; a P1 one forces FAIL.
//
// ASCII only.
// =============================================================================

function finalReviewState({ carriedId, carriedPriority }) {
    const logs = [];
    const deferredVerifyIds = new Map();
    markBounceCapDeferral(deferredVerifyIds, carriedId, 'kept failing Integration Test verification');
    const kbWork = {
        promotionCandidates: async () => [], demotionCandidates: async () => [],
        apply: async () => ({}), commitRound: async () => ({}), warnPending: () => {}, seal: () => {},
    };
    const dispatchCtx = {
        agent: async () => ({ verdict: 'PASS', notes: 'Looks good.' }),
        log: (line) => logs.push(String(line)),
        getMemberForRole: () => 'reviewer-member',
        memberSessionGuard: { killIfAlive: async () => {} },
        onLlmAuthFailure: async () => ({ healed: false }),
        onUsageLimit: async () => {},
        fixedRoleTier: () => undefined,
        budgets: { DISPATCH_INACTIVITY_TIMEOUT_S: 60, DISPATCH_TIMEOUT_S: 600, FINAL_REVIEW_MAX_TURNS: 120 },
        schemas: { finalVerdict: { type: 'object' } },
        isNoMutationDispatchFailure: () => false,
        invalidateAllBeadsCache: () => {},
        withGitSync: async (member, pushCode, invoke) => invoke(),
        withDispatchWatchdog: async (inFlight) => inFlight,
        steps: { 'kb-apply': async () => ({}) },
    };
    const state = {
        phase: () => {}, log: (line) => logs.push(String(line)), command: async () => ({ ok: true, output: '' }),
        dispatchCtx, args: {},
        validated: { baseBranch: 'main', branch: 'feat/thing', goal: 'P1' },
        targetIssues: ['BD-1'], backlogMember: 'backlog-member', finalCycleLabel: 3, sprintState: {},
        gitSync: { syncBeadsBefore: async () => {}, pushBeadsAfter: async () => {} },
        deployFailures: [], integFailures: [], rejectedNewTasks: [], verifyEverIds: new Set([carriedId]),
        deferredVerifyIds, needsEvidenceVerifyIds: new Map(),
        redBuildIntegSkip: null,
        // The at-goal not-done read (--priority-max=goalMax) returns only a bead
        // whose priority is at/above the goal.
        bdListScoped: async (q) => (String(q).includes('--priority-max=') && carriedPriority <= 1
            ? [{ id: carriedId, priority: carriedPriority, status: 'deferred' }] : []),
        decomposedParentIds: async () => new Set(), goalMax: 1,
        NOT_DONE_STATUSES: 'open,in_progress',
        kbPriming: { knowledgeOf: () => undefined }, kbInjection: null, kbSprintContext: {}, kbWork,
        getMemberForRole: () => 'reviewer-member',
        childIdAllocator: null, sprintMutexId: 'sprint-1', resolveSettleShell: async () => undefined,
        computeChildFloor: async () => 0, createChildBeadWithAllocatedId: async () => ({}),
        sanitizePrText: (s) => String(s || ''),
        reviewMergeBaseFor: async () => 'abcdef0123456789abcdef0123456789abcdef01',
    };
    return { state, logs };
}

describe('Final Review: verify carry-over is gated on goal priority', () => {
    test('P1 goal + a P3 bounce-capped verify bead: verdict PASS and the bead is named in the notes', async () => {
        const { state } = finalReviewState({ carriedId: 'BD-9', carriedPriority: 3 });
        const { finalVerdictResult } = await runFinalReviewPhase(state);
        assert.equal(finalVerdictResult.verdict, 'PASS');
        assert.match(finalVerdictResult.notes, /BD-9/);
        assert.match(finalVerdictResult.notes, /deferred-bounce-cap/);
    });

    test('P1 goal + a P1 bounce-capped verify bead: verdict FAIL', async () => {
        const { state } = finalReviewState({ carriedId: 'BD-9', carriedPriority: 1 });
        const { finalVerdictResult } = await runFinalReviewPhase(state);
        assert.equal(finalVerdictResult.verdict, 'FAIL');
        assert.match(finalVerdictResult.notes, /BD-9/);
    });
});
