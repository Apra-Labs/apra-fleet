import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    nextLastBuildFailing, formatRedBuildIntegSkipReason, redBuildIntegSkipEntry,
    applyRedBuildIntegSkipVerdictGate, formatRedBuildIntegSkipVerdictReason,
} from '../fleet-sprint/red-build-integ-gate.mjs';
import { runFinalReviewPhase } from '../fleet-sprint/phases/final-review.mjs';
import { runReviewPhase } from '../fleet-sprint/phases/review.mjs';
import { runReReviewPhase } from '../fleet-sprint/phases/re-review.mjs';

// =============================================================================
// The run-scoped, sticky `lastBuildFailing` flag the runner gates the
// Integration Test dispatch on. The end-to-end behaviour (integ not
// dispatched, the skip logged and recorded, the bead left open) is pinned by
// mock-sprint-integ-after-red-review.test.mjs; this file pins the pure rule and
// that both review phases actually return the flag (the review boundary used
// to keep only `verdict.verdict`).
// =============================================================================

describe('nextLastBuildFailing', () => {
    test('a review reporting buildFailing:true sets the flag', () => {
        assert.equal(nextLastBuildFailing(false, { verdict: 'CHANGES_NEEDED', buildFailing: true }), true);
    });
    test('a later review reporting it not true clears the flag', () => {
        assert.equal(nextLastBuildFailing(true, { verdict: 'APPROVED' }), false);
        assert.equal(nextLastBuildFailing(true, { verdict: 'CHANGES_NEEDED', buildFailing: false }), false);
    });
    test('no review (no verdict) leaves the flag unchanged', () => {
        assert.equal(nextLastBuildFailing(true, undefined), true);
        assert.equal(nextLastBuildFailing(false, null), false);
    });
    test('a degraded round (dispatchFailed, engine-fabricated verdict) carries no build evidence and leaves the flag unchanged', () => {
        assert.equal(nextLastBuildFailing(true, { verdict: 'CHANGES_NEEDED', reopenIds: [], newTasks: [], dispatchFailed: true }), true);
        assert.equal(nextLastBuildFailing(false, { verdict: 'CHANGES_NEEDED', buildFailing: true, dispatchFailed: true }), false);
    });
});

describe('red-build integ skip record', () => {
    test('the integFailures entry names the cycle and the reason, with no bugs filed', () => {
        const e = redBuildIntegSkipEntry(4);
        assert.equal(e.cycle, 4);
        assert.deepEqual(e.bugsFiled, []);
        assert.equal(e.redBuildSkip, true);
        assert.equal(e.notes, formatRedBuildIntegSkipReason(4));
        assert.match(e.notes, /^Skipping Integration Test Phase C4: the last review reported the build\/tests failing/);
    });
});

// ---------------------------------------------------------------------------
// Both review phases return the flag. A tiny in-memory store stands in for bd.
// ---------------------------------------------------------------------------

const SCOPE = [
    { id: 'epic', priority: 1, status: 'open', issue_type: 'epic' },
    { id: 'task-a', priority: 1, status: 'closed', parent: 'epic', issue_type: 'task' },
];

function phaseState(verdict, overrides = {}) {
    const store = SCOPE.map((b) => ({ ...b }));
    const command = async (cmd) => {
        const m = /^bd update (\S+) --status=open/.exec(cmd);
        if (m) {
            const b = store.find((x) => x.id === m[1]);
            if (b) b.status = 'open';
        }
        return cmd.startsWith('bd show') ? '[]' : '';
    };
    return {
        phase: () => {}, log: () => {}, command,
        cycle: 2, validated: { goal: 'P1/P2' }, targetIssues: ['epic'], backlogMember: 'orch',
        gitSync: { syncBeadsAfter: async () => {} },
        replanIds: new Set(), replannedThisCycle: new Set(), perBeadFeedback: new Map(), rejectedNewTasks: [],
        devRounds: 1,
        streakOutcomes: [{ beadIds: ['task-a'], outcome: 'success', closedIds: ['task-a'] }],
        readyTitleById: new Map(),
        lastReviewVerdict: undefined, reviewedThisCycle: false, pendingRejectedNewTasks: [],
        dispatchReview: async () => verdict,
        bdListScoped: async () => store.map((b) => ({ ...b })),
        goalMax: 'P2',
        workedOnIds: new Set(['task-a']),
        recordReopen: () => {},
        childIdAllocator: null, sprintMutexId: 's1',
        computeChildFloor: async () => 0,
        createChildBeadWithAllocatedId: async () => ({ childId: 'epic.1' }),
        trackRejectedNewTaskForResurfacing: (list) => list,
        clearResubmittedNewTask: (list) => list,
        ...overrides,
    };
}

const RED = { verdict: 'CHANGES_NEEDED', buildFailing: true, notes: 'npm test fails', reopenIds: ['task-a'], newTasks: [] };
const GREEN = { verdict: 'APPROVED', notes: 'green', reopenIds: [], newTasks: [] };

describe('review phases return lastBuildFailing', () => {
    test('Review: a red verdict returns true', async () => {
        const out = await runReviewPhase(phaseState(RED, { lastBuildFailing: false }));
        assert.equal(out.lastBuildFailing, true);
        assert.equal(out.lastReviewVerdict, 'CHANGES_NEEDED');
    });
    test('Review: a green verdict clears a prior true', async () => {
        const out = await runReviewPhase(phaseState(GREEN, { lastBuildFailing: true }));
        assert.equal(out.lastBuildFailing, false);
    });
    test('Review: an empty-scope round dispatches no review and returns the flag unchanged', async () => {
        let dispatched = 0;
        const out = await runReviewPhase(phaseState(GREEN, {
            lastBuildFailing: true,
            streakOutcomes: [],
            dispatchReview: async () => { dispatched++; return GREEN; },
        }));
        assert.equal(dispatched, 0);
        assert.equal(out.lastBuildFailing, true);
    });
    test('Re-Review: a red verdict returns true, a green one clears it', async () => {
        const red = await runReReviewPhase(phaseState(RED, { lastBuildFailing: false }));
        assert.equal(red.lastBuildFailing, true);
        const green = await runReReviewPhase(phaseState(GREEN, { lastBuildFailing: true }));
        assert.equal(green.lastBuildFailing, false);
    });
});

// ---------------------------------------------------------------------------
// Final Review: a run whose Integration Test was skipped for a red build, and
// never ran after a later green review, never publishes PASS.
// ---------------------------------------------------------------------------

describe('applyRedBuildIntegSkipVerdictGate', () => {
    test('no outstanding skip returns the verdict unchanged (same object)', () => {
        const v = { verdict: 'PASS', notes: 'ok' };
        assert.equal(applyRedBuildIntegSkipVerdictGate(v, null), v);
    });
    test('an LLM PASS with an outstanding skip becomes FAIL naming the skip, and says it was overridden', () => {
        const v = { verdict: 'PASS', notes: 'All good.', newTasks: [] };
        const out = applyRedBuildIntegSkipVerdictGate(v, { cycle: 3 });
        assert.equal(out.verdict, 'FAIL');
        assert.ok(out.notes.startsWith(formatRedBuildIntegSkipVerdictReason({ cycle: 3 })), out.notes);
        assert.match(out.notes, /Integration Test was skipped in C3 because the last review reported the build\/tests failing/);
        assert.match(out.notes, /overrode it to FAIL/);
        assert.match(out.notes, /All good\.$/);
        assert.deepEqual(out.newTasks, []);
        assert.equal(v.verdict, 'PASS', 'the dispatch result is never mutated');
    });
    test('an LLM FAIL stays FAIL, names the skip, and claims no override', () => {
        const out = applyRedBuildIntegSkipVerdictGate({ verdict: 'FAIL', notes: 'Red.' }, { cycle: 1 });
        assert.equal(out.verdict, 'FAIL');
        assert.match(out.notes, /skipped in C1/);
        assert.doesNotMatch(out.notes, /overrode/);
    });
});

/** The real runFinalReviewPhase against fakes; the dispatch returns `llm`. */
function finalReviewState({ llm, redBuildIntegSkip }) {
    const logs = [];
    const kbWork = {
        promotionCandidates: async () => [], demotionCandidates: async () => [],
        apply: async () => ({}), commitRound: async () => ({}), warnPending: () => {}, seal: () => {},
    };
    const dispatchCtx = {
        agent: async () => ({ ...llm }),
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
        deployFailures: [], integFailures: [], rejectedNewTasks: [], verifyEverIds: new Set(),
        redBuildIntegSkip,
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

describe('Final Review: red-build integ-skip verdict gate', () => {
    test('Final Review LLM PASS + a recorded red-build integ skip with no later green review -> FAIL, reason logged', async () => {
        const { state, logs } = finalReviewState({ llm: { verdict: 'PASS', notes: 'Rubber-stamp PASS.' }, redBuildIntegSkip: { cycle: 2 } });
        const { finalVerdictResult } = await runFinalReviewPhase(state);
        assert.equal(finalVerdictResult.verdict, 'FAIL');
        assert.match(finalVerdictResult.notes, /Integration Test was skipped in C2 because the last review reported the build\/tests failing/);
        const forced = logs.filter((l) => /sprint verdict forced to FAIL \(Final Review returned PASS\)/.test(l));
        assert.equal(forced.length, 1, `expected one override log line: ${JSON.stringify(logs)}`);
        assert.ok(forced[0].includes(formatRedBuildIntegSkipVerdictReason({ cycle: 2 })), forced[0]);
    });
    test('a red-build skip later cleared by a green review and an integ run (null at Final Review) -> verdict unchanged', async () => {
        const { state, logs } = finalReviewState({ llm: { verdict: 'PASS', notes: 'All good.' }, redBuildIntegSkip: null });
        const { finalVerdictResult } = await runFinalReviewPhase(state);
        assert.equal(finalVerdictResult.verdict, 'PASS');
        assert.equal(finalVerdictResult.notes, 'All good.');
        assert.ok(!logs.some((l) => /forced to FAIL/.test(l)), JSON.stringify(logs));
    });
});
