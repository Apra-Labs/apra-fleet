// A reviewer CHANGES_NEEDED whose every reopenId the goal-scope guard skipped
// as below goal -- with no in-goal newTask, no failing build and no pending
// NEEDS-DECISION -- counts as APPROVED for the sprint's exit decision
// (beads-transitions.mjs belowGoalOnlyReopenIds). Both review phases (per-round
// Review and Cycle Evaluation's Re-Review) report the skipped ids and log
// them; anything in-goal keeps the exit blocked as before. The end-to-end exit
// is pinned by mock-sprint-needs-external-evidence.test.mjs (c).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { belowGoalOnlyReopenIds, applyGuardedReopens } from '../fleet-sprint/beads-transitions.mjs';
import { runReviewPhase } from '../fleet-sprint/phases/review.mjs';
import { runReReviewPhase } from '../fleet-sprint/phases/re-review.mjs';

const CN = (extra = {}) => ({ verdict: 'CHANGES_NEEDED', notes: 'n', reopenIds: ['low'], newTasks: [], ...extra });

describe('belowGoalOnlyReopenIds (pure)', () => {
    test('every reopenId skipped below goal, nothing else -> the skipped ids', () => {
        assert.deepEqual(belowGoalOnlyReopenIds({ verdict: CN(), skippedBelowGoalIds: ['low'], reopenedCount: 0, inGoalNewTaskCount: 0 }), ['low']);
    });
    test('an APPROVED verdict, or CHANGES_NEEDED with no reopenIds -> null', () => {
        assert.equal(belowGoalOnlyReopenIds({ verdict: { verdict: 'APPROVED', reopenIds: [] }, skippedBelowGoalIds: [], reopenedCount: 0, inGoalNewTaskCount: 0 }), null);
        assert.equal(belowGoalOnlyReopenIds({ verdict: CN({ reopenIds: [] }), skippedBelowGoalIds: [], reopenedCount: 0, inGoalNewTaskCount: 0 }), null);
    });
    test('a surviving reopen, a reopenId skipped for another reason, an in-goal newTask, buildFailing or a pending decision -> null', () => {
        const base = { verdict: CN(), skippedBelowGoalIds: ['low'], reopenedCount: 0, inGoalNewTaskCount: 0, pendingDecisionCount: 0 };
        assert.equal(belowGoalOnlyReopenIds({ ...base, reopenedCount: 1 }), null);
        assert.equal(belowGoalOnlyReopenIds({ ...base, verdict: CN({ reopenIds: ['low', 'bad-id'] }) }), null);
        assert.equal(belowGoalOnlyReopenIds({ ...base, inGoalNewTaskCount: 1 }), null);
        assert.equal(belowGoalOnlyReopenIds({ ...base, verdict: CN({ buildFailing: true }) }), null);
        assert.equal(belowGoalOnlyReopenIds({ ...base, pendingDecisionCount: 1 }), null);
    });
});

test('applyGuardedReopens reports each below-goal skip through onSkippedBelowGoal', async () => {
    const skipped = [];
    const applied = await applyGuardedReopens({
        entries: ['low', 'task-a'],
        bdListScoped: async () => [{ id: 'low', priority: 3, status: 'closed' }, { id: 'task-a', priority: 1, status: 'closed' }],
        goalMax: 'P2', goal: 'P1/P2', logPrefix: 'x', log: () => {}, command: async () => '', member: 'm',
        buildReopenCommand: ({ id }) => ({ cmd: `bd update ${id} --status=open`, label: 'l' }),
        onSkippedBelowGoal: ({ id }) => skipped.push(id),
    });
    assert.deepEqual(applied, ['task-a']);
    assert.deepEqual(skipped, ['low']);
});

// ---------------------------------------------------------------------------
// Both review phases, against a tiny in-memory bd store. 'low' is a P3 bead
// this sprint never worked on (below the P1/P2 goal); 'task-a' is in-goal.
// ---------------------------------------------------------------------------

const SCOPE = [
    { id: 'epic', priority: 1, status: 'open', issue_type: 'epic' },
    { id: 'task-a', priority: 1, status: 'closed', parent: 'epic', issue_type: 'task' },
    { id: 'low', priority: 3, status: 'closed', parent: 'epic', issue_type: 'task' },
];

function phaseState(verdict, overrides = {}) {
    const store = SCOPE.map((b) => ({ ...b }));
    const logs = [];
    const created = [];
    const command = async (cmd) => {
        const m = /^bd update (\S+) --status=open/.exec(cmd);
        if (m) {
            const b = store.find((x) => x.id === m[1]);
            if (b) b.status = 'open';
        }
        return cmd.startsWith('bd show') ? '[]' : '';
    };
    const state = {
        phase: () => {}, log: (l) => logs.push(l), command,
        cycle: 2, validated: { goal: 'P1/P2' }, targetIssues: ['epic'], backlogMember: 'orch',
        gitSync: { syncBeadsAfter: async () => {} },
        sprintState: {},
        replanIds: new Set(), replannedThisCycle: new Set(), perBeadFeedback: new Map(), rejectedNewTasks: [],
        devRounds: 1,
        streakOutcomes: [{ beadIds: ['task-a'], outcome: 'success', closedIds: ['task-a'] }],
        readyTitleById: new Map(),
        lastReviewVerdict: undefined, reviewedThisCycle: false, pendingRejectedNewTasks: [],
        lastBuildFailing: false,
        dispatchReview: async () => verdict,
        bdListScoped: async () => store.map((b) => ({ ...b })),
        goalMax: 'P2',
        workedOnIds: new Set(['task-a']),
        recordReopen: () => {},
        childIdAllocator: null, sprintMutexId: 's1',
        computeChildFloor: async () => 0,
        createChildBeadWithAllocatedId: async (o) => { created.push(o.title); return { childId: `epic.${created.length}` }; },
        trackRejectedNewTaskForResurfacing: (list) => list,
        clearResubmittedNewTask: (list) => list,
        ...overrides,
    };
    return { state, logs, created };
}

const IN_GOAL_TASK = { title: 'Fix the in-goal gap', description: 'The in-goal gap the reviewer found.', priority: 'P1' };

for (const [name, run] of [['Review', runReviewPhase], ['Re-Review', runReReviewPhase]]) {
    describe(`${name}: CHANGES_NEEDED with only below-goal reopenIds`, () => {
        test('only below-goal skipped reopen ids -> effective APPROVED for exit; skipped ids logged', async () => {
            const { state, logs } = phaseState(CN());
            const out = await run(state);
            assert.equal(out.lastReviewVerdict, 'CHANGES_NEEDED');
            assert.deepEqual(out.belowGoalOnlySkippedIds, ['low']);
            assert.ok(logs.some((l) => /treated as APPROVED for the exit decision/.test(l) && l.includes('low')), logs.join('\n'));
        });
        test('an in-goal reopen keeps the exit blocked', async () => {
            const { state } = phaseState(CN({ reopenIds: ['low', 'task-a'] }));
            const out = await run(state);
            assert.equal(out.belowGoalOnlySkippedIds, null);
        });
        test('an in-goal newTask keeps the exit blocked', async () => {
            const { state, created } = phaseState(CN({ newTasks: [IN_GOAL_TASK] }));
            const out = await run(state);
            assert.equal(created.length, 1, 'the in-goal newTask was created');
            assert.equal(out.belowGoalOnlySkippedIds, null);
        });
        test('buildFailing:true keeps the exit blocked', async () => {
            const { state } = phaseState(CN({ buildFailing: true }));
            const out = await run(state);
            assert.equal(out.belowGoalOnlySkippedIds, null);
        });
        test('a pending NEEDS-DECISION keeps the exit blocked', async () => {
            const { state } = phaseState(CN(), {
                sprintState: { pendingDecisions: new Map([['task-a', { decisionId: 'd-1', question: 'q' }]]) },
            });
            const out = await run(state);
            assert.equal(out.belowGoalOnlySkippedIds, null);
        });
        test('an APPROVED verdict returns null (nothing to carry over)', async () => {
            const { state } = phaseState({ verdict: 'APPROVED', notes: 'ok', reopenIds: [], newTasks: [] });
            const out = await run(state);
            assert.equal(out.belowGoalOnlySkippedIds, null);
        });
    });
}

test('Review: an empty-scope round returns the passed-in value unchanged', async () => {
    const { state } = phaseState(CN(), { streakOutcomes: [], belowGoalOnlySkippedIds: ['low'] });
    const out = await runReviewPhase(state);
    assert.deepEqual(out.belowGoalOnlySkippedIds, ['low']);
});
