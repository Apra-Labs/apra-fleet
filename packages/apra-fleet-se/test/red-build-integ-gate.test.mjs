import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    nextLastBuildFailing, formatRedBuildIntegSkipReason, redBuildIntegSkipEntry,
} from '../fleet-sprint/red-build-integ-gate.mjs';
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
