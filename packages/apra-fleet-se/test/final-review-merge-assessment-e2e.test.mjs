import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runFinalReviewPhase } from '../fleet-sprint/phases/final-review.mjs';
import { validateVerdict } from '../fleet-sprint/contracts.mjs';
import { finalVerdict } from '../fleet-sprint/contracts.mjs';
import { buildSprintPrBody } from '../fleet-sprint/pr-body.mjs';

// =============================================================================
// End to end: the real runFinalReviewPhase and the real PR body builder, with
// a reviewer reply whose merge_assessment is partial or misspelled. The fake
// agent enforces the REAL finalVerdict schema the way agent() does (a schema
// failure throws, which the engine would turn into repair and then a
// synthesized FAIL), so a schema that rejected the assessment fails these.
//
// ASCII only.
// =============================================================================

const FULL = Object.freeze({
    value: 'Operators see the recommendation first.',
    risk: 'Low.',
    default_path_changes: 'none',
    blast_radius: 'PR body.',
    upgrade_impact: 'none',
    proof: 'Unit tests.',
    recommendation: 'merge',
    reason: 'Tests pass.',
});

function finalReviewState(llm) {
    const logs = [];
    const kbWork = {
        promotionCandidates: async () => [], demotionCandidates: async () => [],
        apply: async () => ({}), commitRound: async () => ({}), warnPending: () => {}, seal: () => {},
    };
    const dispatchCtx = {
        agent: async () => {
            const r = validateVerdict('finalVerdict', llm);
            if (!r.valid) throw new Error(`schema repair exhausted: ${JSON.stringify(r.errors)}`);
            return JSON.parse(JSON.stringify(llm));
        },
        log: (line) => logs.push(String(line)),
        getMemberForRole: () => 'reviewer-member',
        memberSessionGuard: { killIfAlive: async () => {} },
        onLlmAuthFailure: async () => ({ healed: false }),
        onUsageLimit: async () => {},
        fixedRoleTier: () => undefined,
        budgets: { DISPATCH_INACTIVITY_TIMEOUT_S: 60, DISPATCH_TIMEOUT_S: 600, FINAL_REVIEW_MAX_TURNS: 120 },
        schemas: { finalVerdict },
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
        deployFailures: [], integFailures: [], rejectedNewTasks: [], verifyEverIds: new Set(),
        redBuildIntegSkip: null,
        bdListScoped: async () => [], decomposedParentIds: async () => new Set(), goalMax: 2,
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

async function runAndBuildBody(merge_assessment) {
    const { state } = finalReviewState({ verdict: 'PASS', notes: 'All good.', merge_assessment });
    const { finalVerdictResult } = await runFinalReviewPhase(state);
    const { body } = buildSprintPrBody({
        verdict: finalVerdictResult.verdict, goal: 'P1', branch: 'feat/thing', baseBranch: 'main',
        notes: finalVerdictResult.notes,
        mergeAssessment: finalVerdictResult.merge_assessment,
        mergeAssessmentIncomplete: finalVerdictResult.merge_assessment_incomplete,
    });
    return { finalVerdictResult, body };
}

describe('Final Review with a malformed merge_assessment keeps the verdict', () => {
    test('a 5-field assessment keeps PASS; the PR body shows the valid fields and names the missing ones', async () => {
        const { finalVerdictResult, body } = await runAndBuildBody({
            value: 'Operators see it first.', risk: 'Low.', proof: 'Tests.', recommendation: 'merge', reason: 'Good.',
        });
        assert.equal(finalVerdictResult.verdict, 'PASS');
        assert.ok(!/synthesized|repair/i.test(finalVerdictResult.notes), finalVerdictResult.notes);
        assert.ok(body.includes('**Value:** Operators see it first.'), body);
        assert.match(body, /assessment incomplete: default_path_changes, blast_radius, upgrade_impact/);
    });

    test('all fields but one misspelled key keep PASS; the PR body names the missing and the misspelled field', async () => {
        const { blast_radius, ...rest } = FULL;
        const { finalVerdictResult, body } = await runAndBuildBody({ ...rest, blast_radus: blast_radius });
        assert.equal(finalVerdictResult.verdict, 'PASS');
        assert.equal(finalVerdictResult.notes, 'All good.');
        assert.ok(body.includes('**Risk:** Low.'), body);
        assert.match(body, /assessment incomplete: blast_radius, blast_radus/);
    });

    test('a complete assessment renders with no incomplete note', async () => {
        const { finalVerdictResult, body } = await runAndBuildBody({ ...FULL });
        assert.equal(finalVerdictResult.verdict, 'PASS');
        assert.equal(finalVerdictResult.merge_assessment_incomplete, undefined);
        assert.ok(!body.includes('assessment incomplete'), body);
    });
});
