import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { catchUpReviewBeadIds, recordReviewedScope } from '../fleet-sprint/phases/review.mjs';
import { createSprintState } from '../fleet-sprint/sprint-state.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// Catch-up review before Final Review. A doer streak that leaves its bead open
// at attribution is marked FAILED and contributes nothing to its round's
// review scope. When that bead's close lands on the shared beads DB later
// (a late D-push), the engine must review it before Final Review -- exactly
// once, never re-reviewing a bead a normal round already covered, and never
// pulling in a bead that was closed before the sprint started.
// =============================================================================

const reviewScopeIds = (d) => {
    const match = d.prompt.match(/Review the work just done for the following bead id\(s\):\s*(.+)\./);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const assignedIds = (opts) => {
    const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const approved = () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});

const resetSyncMemo = () => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
};

const GOOD = 'Task: catchup reviewed in round';
const LATE = 'Task: catchup closes late';
const PRE = 'Task: catchup closed before sprint';

test('unit: catchUpReviewBeadIds = dispatched AND closed AND not in the ledger', () => {
    assert.deepEqual(catchUpReviewBeadIds({}), []);
    assert.deepEqual(catchUpReviewBeadIds({
        workedOnIds: ['b', 'a', 'open', 'reviewed'],
        closedIds: ['a', 'b', 'reviewed', 'pre-sprint'],
        reviewedIds: ['reviewed'],
    }), ['a', 'b']);
});

test('unit: the ledger lives on sprint state and only grows', () => {
    const state = createSprintState();
    check(state.reviewedScopeIds instanceof Set, 'createSprintState must create the review-scope ledger');
    recordReviewedScope(state, ['x', 'y']);
    recordReviewedScope(state, ['y']);
    assert.deepEqual([...state.reviewedScopeIds], ['x', 'y']);
    const legacy = {};
    recordReviewedScope(legacy, ['z']);
    assert.deepEqual([...legacy.reviewedScopeIds], ['z']);
});

test('mock sprint: a FAILED-streak bead that closes later is reviewed once before Final Review', async () => {
    resetSyncMemo();
    await withScenarioMarkers('review scope late close catch-up', async () => {
        let lateClosed = false;
        const scenario = await runDevelopLoopScenario('rs-late-catchup', {
            members: ['local'],
            taskSpecs: [{ title: GOOD }, { title: LATE }, { title: PRE }],
            // A bead closed before the sprint started.
            beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => {
                const pre = tasks.find((t) => t.title === PRE);
                await rc(`bd close ${pre.id}`, td);
            },
            // The doer closes every assigned bead except the late one, which
            // stays open at attribution -- its streak is FAILED.
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts);
                const list = JSON.parse((await rc('bd list --json', td)).stdout || '[]');
                const late = list.find((b) => b.title === LATE);
                const closable = ids.filter((id) => !late || id !== late.id);
                for (const id of closable) await rc(`bd close ${id}`, td);
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Done.' }) }] };
            },
            // The late bead's close lands on the shared DB while the round's
            // review is running -- after attribution, outside any round scope.
            reviewerHandler: async ({ runCmd: rc, tempDir: td }) => {
                if (!lateClosed) {
                    lateClosed = true;
                    const list = JSON.parse((await rc('bd list --json', td)).stdout || '[]');
                    const late = list.find((b) => b.title === LATE);
                    if (late) await rc(`bd close ${late.id}`, td);
                }
                return approved();
            },
        });
        check(!scenario.error, `Scenario should not abort: ${scenario.error ? scenario.error.message : ''}`);
        const id = (title) => scenario.tasks.find((t) => t.title === title).id;
        check(lateClosed, 'the late close must have happened');
        check(
            scenario.logs.some((m) => m.includes('Doer streak attribution')),
            'develop must reach the streak attribution step',
        );

        const finalIdx = scenario.dispatched.findIndex((d) => d.agent === 'reviewer' && d.label === 'Final Review');
        check(finalIdx >= 0, 'Final Review must be dispatched');
        const roundReviews = scenario.dispatched
            .map((d, i) => ({ d, i }))
            .filter(({ d }) => d.agent === 'reviewer' && d.label !== 'Final Review');
        const covering = (beadId) => roundReviews.filter(({ d }) => reviewScopeIds(d).includes(beadId));

        // 1. The late-closing bead is in some non-Final review round's scope,
        //    dispatched before Final Review.
        const lateCover = covering(id(LATE));
        assert.equal(lateCover.length, 1, `late bead must be reviewed exactly once: ${JSON.stringify(roundReviews.map(({ d }) => reviewScopeIds(d)))}`);
        check(lateCover[0].i < finalIdx, 'the catch-up review must be dispatched before Final Review');
        assert.deepEqual(reviewScopeIds(lateCover[0].d), [id(LATE)], 'the catch-up round covers exactly the late bead');

        // 2. A bead reviewed in a normal round is not reviewed again.
        assert.equal(covering(id(GOOD)).length, 1, 'the round-reviewed bead must not be reviewed again by the catch-up');

        // 3. A bead closed before the sprint started is never pulled in.
        assert.equal(covering(id(PRE)).length, 0, 'a bead closed before the sprint must not be reviewed');
    });
});
