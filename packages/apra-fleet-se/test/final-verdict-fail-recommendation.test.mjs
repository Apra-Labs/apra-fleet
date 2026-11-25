import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runFinalReviewPhase } from '../fleet-sprint/phases/final-review.mjs';
import { validateVerdict } from '../fleet-sprint/contracts.mjs';
import { finalVerdict } from '../fleet-sprint/contracts.mjs';
import { buildSprintPrBody, normalizeRecommendationForVerdict } from '../fleet-sprint/pr-body.mjs';

// =============================================================================
// FAIL never renders Recommendation merge. End to end: the real runFinalReviewPhase and the real PR body builder, with
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


async function run(llm, extra = {}) {
    const { state, logs } = finalReviewState(llm);
    Object.assign(state, extra);
    const { finalVerdictResult } = await runFinalReviewPhase(state);
    const { body } = buildSprintPrBody({
        verdict: finalVerdictResult.verdict, goal: 'P1', branch: 'feat/thing', baseBranch: 'main',
        notes: finalVerdictResult.notes,
        mergeAssessment: finalVerdictResult.merge_assessment,
        mergeAssessmentIncomplete: finalVerdictResult.merge_assessment_incomplete,
    });
    return { finalVerdictResult, body, logs };
}

describe('a FAIL sprint never carries Recommendation: merge', () => {
    test('LLM FAIL + merge -> do_not_merge in the PR body, verdict unchanged', async () => {
        const { finalVerdictResult, body, logs } = await run({ verdict: 'FAIL', notes: 'Broken.', merge_assessment: { ...FULL, recommendation: 'merge' } });
        assert.equal(finalVerdictResult.verdict, 'FAIL');
        assert.equal(finalVerdictResult.merge_assessment.recommendation, 'do_not_merge');
        assert.ok(body.includes('do_not_merge'), body);
        assert.ok(!/Recommendation:\**\s*`?merge`?(\s|$)/.test(body), body);
        assert.ok(logs.some((l) => /normalised/.test(l)), logs.join('\n'));
    });

    test('LLM PASS + merge, deploy-failure gate forces FAIL -> do_not_merge', async () => {
        const { finalVerdictResult, body } = await run(
            { verdict: 'PASS', notes: 'Fine.', merge_assessment: { ...FULL, recommendation: 'merge' } },
            { lastDeployFailure: { cycle: 3, notes: 'port in use' } },
        );
        assert.equal(finalVerdictResult.verdict, 'FAIL');
        assert.equal(finalVerdictResult.merge_assessment.recommendation, 'do_not_merge');
        assert.ok(body.includes('do_not_merge'), body);
    });

    test('PASS + merge is unchanged', async () => {
        const { finalVerdictResult } = await run({ verdict: 'PASS', notes: 'Fine.', merge_assessment: { ...FULL, recommendation: 'merge' } });
        assert.equal(finalVerdictResult.verdict, 'PASS');
        assert.equal(finalVerdictResult.merge_assessment.recommendation, 'merge');
    });

    test('FAIL + merge_after_proof is left as is; verdict value identical before and after', () => {
        const before = { verdict: 'FAIL', notes: 'x', merge_assessment: { ...FULL, recommendation: 'merge_after_proof' } };
        const same = normalizeRecommendationForVerdict(before);
        assert.equal(same.changed, false);
        const merge = { ...before, merge_assessment: { ...FULL, recommendation: 'merge' } };
        const out = normalizeRecommendationForVerdict(merge);
        assert.equal(out.changed, true);
        assert.equal(out.result.verdict, merge.verdict);
        assert.equal(merge.merge_assessment.recommendation, 'merge');
    });
});
