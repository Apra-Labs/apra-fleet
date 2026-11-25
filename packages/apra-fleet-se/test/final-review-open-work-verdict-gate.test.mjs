import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFinalReviewPhase } from '../fleet-sprint/phases/final-review.mjs';
import { applyOpenWorkVerdictGate } from '../fleet-sprint/set-aside.mjs';

// The Final Review open-work gate: the engine, not the reviewer, decides that
// a sprint with an open at/above-goal bead or an unclosed verify-routed bead
// cannot PASS. Unit cases for the pure helper, plus the REAL
// runFinalReviewPhase driven with a stub reviewer that returns PASS.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REVIEWER = 'reviewer-member';

/**
 * Everything runFinalReviewPhase needs, with the dispatch replaced by a spy
 * that records the prompt and returns a PASS verdict carrying no newTasks and
 * no reopenIds -- so the phase's bead-mutation tail is a no-op and the test
 * stays about the KB candidate wiring.
 */
function harness({ verdict = { verdict: 'PASS', notes: 'All good.' }, openAtGoal = [], closed = [], verifyEverIds = new Set() } = {}) {
    const prompts = [];
        const logs = [];
    const noop = async () => ({ ok: true, output: '' });

    const kbWork = {
        promotionCandidates: async () => [],
        demotionCandidates: async () => [],
        apply: async () => ({}),
        commitRound: async () => ({}),
        warnPending: () => {},
        seal: () => {},
    };

    const dispatchCtx = {
        // runSprintCycle's `agent` wrapper resolves to the schema-parsed
        // result object, not a raw MCP envelope -- dispatchRole passes it
        // straight through as outcome.value.
        agent: async (prompt) => {
            prompts.push(prompt);
            return { ...verdict };
        },
        log: (line) => logs.push(String(line)),
        getMemberForRole: () => REVIEWER,
        memberSessionGuard: { killIfAlive: async () => {} },
        onLlmAuthFailure: async () => ({ healed: false }),
        onUsageLimit: async () => {},
        fixedRoleTier: () => undefined,
        budgets: {
            DISPATCH_INACTIVITY_TIMEOUT_S: 60,
            DISPATCH_TIMEOUT_S: 600,
            FINAL_REVIEW_MAX_TURNS: 120,
        },
        schemas: { finalVerdict: { type: 'object' } },
        isNoMutationDispatchFailure: () => false,
        invalidateAllBeadsCache: () => {},
        withGitSync: async (member, pushCode, invoke) => invoke(),
        withDispatchWatchdog: async (inFlight) => inFlight,
        steps: { 'kb-apply': async () => ({}) },
    };

    const state = {
        phase: () => {},
        log: (line) => logs.push(String(line)),
        command: noop,
        dispatchCtx,
        args: {},
        validated: { baseBranch: 'main', branch: 'feat/thing', goal: 'P1' },
        targetIssues: ['BD-1'],
        backlogMember: 'backlog-member',
        finalCycleLabel: 1,
        sprintState: {},
        gitSync: {
            syncBeadsBefore: async () => {},
            pushBeadsAfter: async () => {},
        },
        deployFailures: [],
        integFailures: [],
        rejectedNewTasks: [],
        verifyEverIds,
        bdListScoped: async (q) => (q.includes('--status=closed') ? closed : openAtGoal),
        decomposedParentIds: async () => new Set(),
        goalMax: 2,
        NOT_DONE_STATUSES: 'open,in_progress',
        kbPriming: { knowledgeOf: () => undefined },
        kbInjection: null,
        kbSprintContext: {},
        kbWork,
        getMemberForRole: () => REVIEWER,
        childIdAllocator: null,
        sprintMutexId: 'sprint-1',
        resolveSettleShell: async () => undefined,
        computeChildFloor: async () => 0,
        createChildBeadWithAllocatedId: async () => ({}),
        sanitizePrText: (s) => String(s || ''),
        // The review diff base the engine resolves on the reviewer member.
        reviewMergeBaseFor: async () => 'abcdef0123456789abcdef0123456789abcdef01',
    };

    return { state, prompts, logs };
}


describe('applyOpenWorkVerdictGate (pure)', () => {
    test('neither list -> same reference, unchanged', () => {
        const v = { verdict: 'PASS', notes: 'fine' };
        assert.equal(applyOpenWorkVerdictGate(v, { openAtGoalIds: [], unclosedVerifyIds: [] }), v);
    });
    test('open at-goal ids force FAIL, are named, and keep prior notes', () => {
        const out = applyOpenWorkVerdictGate({ verdict: 'PASS', notes: 'looks good' }, { openAtGoalIds: ['X-1', 'X-2'] });
        assert.equal(out.verdict, 'FAIL');
        assert.match(out.notes, /X-1, X-2/);
        assert.match(out.notes, /engine overrode it to FAIL/);
        assert.match(out.notes, /looks good$/);
    });
    test('unclosed verify ids force FAIL and are named as verify-routed', () => {
        const out = applyOpenWorkVerdictGate({ verdict: 'PASS', notes: '' }, { unclosedVerifyIds: ['V-9'] });
        assert.equal(out.verdict, 'FAIL');
        assert.match(out.notes, /Verify-routed.*V-9/);
    });
    test('INCOMPLETE is downgraded to FAIL without the PASS-override sentence', () => {
        const out = applyOpenWorkVerdictGate({ verdict: 'INCOMPLETE', notes: 'n' }, { openAtGoalIds: ['X-1'] });
        assert.equal(out.verdict, 'FAIL');
        assert.doesNotMatch(out.notes, /returned PASS/);
    });
    test('ids already named by a sibling gate are not listed twice but still force FAIL', () => {
        const out = applyOpenWorkVerdictGate({ verdict: 'FAIL', notes: 'prior' }, { openAtGoalIds: ['X-1'], alreadyNamedIds: ['X-1'] });
        assert.equal(out.verdict, 'FAIL');
        assert.equal(out.notes, 'prior');
    });
});

describe('runFinalReviewPhase open-work gate', () => {
    test('PASS reviewer + open at-goal bead -> FAIL naming the id', async () => {
        const { state, logs } = harness({ openAtGoal: [{ id: 'OPEN-1' }] });
        const out = await runFinalReviewPhase(state);
        assert.equal(out.finalVerdictResult.verdict, 'FAIL');
        assert.match(out.finalVerdictResult.notes, /OPEN-1/);
        assert.match(out.finalVerdictResult.notes, /All good\./);
        assert.ok(logs.some((l) => /forced to FAIL/.test(l) && /OPEN-1/.test(l)));
    });
    test('PASS reviewer + unclosed verify-routed bead -> FAIL naming the id', async () => {
        const { state } = harness({ verifyEverIds: new Set(['VER-1', 'VER-2']), closed: [{ id: 'VER-2' }], openAtGoal: [{ id: 'VER-1' }] });
        state.decomposedParentIds = async () => new Set(['VER-1']);
        const out = await runFinalReviewPhase(state);
        assert.equal(out.finalVerdictResult.verdict, 'FAIL');
        assert.match(out.finalVerdictResult.notes, /VER-1/);
        assert.doesNotMatch(out.finalVerdictResult.notes, /VER-2/);
    });
    test('a verify-routed bead deferred during the run (decomposed parent, goal-satisfied exit) keeps PASS and is named as carry-over', async () => {
        const { state, logs } = harness({ verifyEverIds: new Set(['VER-D']), openAtGoal: [{ id: 'VER-D', status: 'deferred' }] });
        state.decomposedParentIds = async () => new Set(['VER-D']);
        state.deferredVerifyIds = new Map([['VER-D', 'deferred during the run']]);
        const out = await runFinalReviewPhase(state);
        assert.equal(out.finalVerdictResult.verdict, 'PASS');
        assert.match(out.finalVerdictResult.notes, /VER-D/);
        assert.match(out.finalVerdictResult.notes, /All good\./);
        assert.ok(!logs.some((l) => /forced to FAIL/.test(l)));
    });
    test('control: a verify-routed bead deferred by the verify bounce cap still forces FAIL', async () => {
        const { state } = harness({ verifyEverIds: new Set(['VER-B']), openAtGoal: [{ id: 'VER-B', status: 'deferred' }] });
        state.decomposedParentIds = async () => new Set(['VER-B']);
        state.deferredVerifyIds = new Map([['VER-B', { reason: 'bounce cap reached', bounceCap: true }]]);
        const out = await runFinalReviewPhase(state);
        assert.equal(out.finalVerdictResult.verdict, 'FAIL');
        assert.match(out.finalVerdictResult.notes, /VER-B/);
    });
    test('control: an unclosed verify bead below the goal priority (absent from the at-goal read) keeps PASS', async () => {
        const { state } = harness({ verifyEverIds: new Set(['VER-3']) });
        const out = await runFinalReviewPhase(state);
        assert.equal(out.finalVerdictResult.verdict, 'PASS');
    });
    test('control: neither condition keeps the reviewer PASS and notes', async () => {
        const { state } = harness({ verifyEverIds: new Set(['VER-2']), closed: [{ id: 'VER-2' }] });
        const out = await runFinalReviewPhase(state);
        assert.equal(out.finalVerdictResult.verdict, 'PASS');
        assert.equal(out.finalVerdictResult.notes, 'All good.');
    });
    test('publish-pr feeds the verdict and notes into the PR title/body (so the ids reach the PR)', () => {
        const src = fs.readFileSync(path.join(__dirname, '../fleet-sprint/phases/publish-pr.mjs'), 'utf8');
        assert.match(src, /verdict: finalVerdictLabel/);
        assert.match(src, /notes: finalVerdictResult\.notes/);
    });
});
