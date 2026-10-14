import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { reviewScopeBeadIds } from '../fleet-sprint/phases/review.mjs';
import { PostDispatchSyncError } from '../fleet-sprint/errors.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// Review scope after a failed or BLOCKED streak. The round's Review covers
// every bead the ENGINE's read-back of the shared beads DB confirmed closed
// and published (reviewScopeBeadIds), including beads a failed streak closed
// before it stopped. Closes that were not published (permission-scope or any
// other post-dispatch sync failure) and closes only the doer claimed are out.
// =============================================================================

const reviewScopeIds = (d) => {
    const match = d.prompt.match(/Review the work just done for the following bead id\(s\):\s*(.+)\./);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const assignedIds = (opts) => {
    const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const approve = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});
const developReviews = (scenario) => scenario.dispatched.filter((d) => d.agent === 'reviewer' && d.label !== 'Final Review');

// Stamp one 3-bead lane so the three tasks form ONE streak.
const oneLane = (titles) => async ({ runCmd: rc, tempDir: td, tasks }) => {
    for (let i = 0; i < titles.length; i++) {
        const t = tasks.find((x) => x.title === titles[i]);
        await rc(`bd update ${t.id} --set-metadata streak=lane-x --set-metadata streakOrder=${i + 1}`, td);
    }
};

const resetSyncMemo = () => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
};

const TITLES = ['Task: scope first', 'Task: scope second', 'Task: scope third'];
const specs = TITLES.map((title) => ({ title }));

test('unit: reviewScopeBeadIds unions engine-verified closes, de-duplicates, skips unpublished', () => {
    assert.deepEqual(reviewScopeBeadIds([]), []);
    assert.deepEqual(reviewScopeBeadIds(undefined), []);
    assert.deepEqual(reviewScopeBeadIds([
        { beadIds: ['a', 'b', 'c'], outcome: 'failed', closedIds: ['a', 'b'], unclosedIds: ['c'] },
        { beadIds: ['b', 'd'], outcome: 'success', closedIds: ['b', 'd'], unclosedIds: [] },
        // a failed streak that verified nothing closed contributes nothing
        { beadIds: ['e'], outcome: 'failed', closedIds: [], unclosedIds: ['e'] },
        // unpublished closes are excluded
        { beadIds: ['f'], outcome: 'success', closedIds: ['f'], publishBlocked: true },
        { beadIds: ['g'], outcome: 'success', closedIds: ['g'], postDispatchSyncFailed: true },
        // beadIds alone (a doer claim, no read-back) never counts
        { beadIds: ['h'], outcome: 'success' },
    ]), ['a', 'b', 'd']);
});

test('mock sprint: a streak that closes 2 of 3 beads then returns BLOCKED reviews exactly those 2', async () => {
    resetSyncMemo();
    await withScenarioMarkers('review scope blocked streak', async () => {
        const scenario = await runDevelopLoopScenario('rs-blocked', {
            members: ['local'],
            taskSpecs: specs,
            beforeSprint: oneLane(TITLES),
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts);
                const list = JSON.parse((await rc('bd list --json', td)).stdout || '[]');
                const third = list.find((b) => b.title === TITLES[2]);
                const closable = ids.filter((id) => !third || id !== third.id);
                for (const id of closable) await rc(`bd close ${id}`, td);
                return { content: [{ text: JSON.stringify({ status: 'BLOCKED', closedIds: closable, notes: 'Blocked on the third bead.' }) }] };
            },
            reviewerHandler: approve,
        });
        check(!scenario.error, `Scenario should not abort: ${scenario.error ? scenario.error.message : ''}`);
        const id = (title) => scenario.tasks.find((t) => t.title === title).id;
        const reviews = developReviews(scenario);
        check(reviews.length >= 1, 'Expected a develop-round Review dispatch');
        const scope = reviewScopeIds(reviews[0]).slice().sort();
        assert.deepEqual(scope, [id(TITLES[0]), id(TITLES[1])].sort(), `round-1 review scope: ${JSON.stringify(scope)}`);
        check(!scope.includes(id(TITLES[2])), 'the still-open bead must not be reviewed');
    });
});

test('mock sprint: a doer that claims a close the read-back does not confirm is not reviewed', async () => {
    resetSyncMemo();
    await withScenarioMarkers('review scope unconfirmed claim', async () => {
        const scenario = await runDevelopLoopScenario('rs-claim', {
            members: ['local'],
            taskSpecs: specs,
            beforeSprint: oneLane(TITLES),
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts);
                const list = JSON.parse((await rc('bd list --json', td)).stdout || '[]');
                const third = list.find((b) => b.title === TITLES[2]);
                for (const id of ids) if (!third || id !== third.id) await rc(`bd close ${id}`, td);
                // Claims EVERY bead closed, though the third stays open.
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'All done.' }) }] };
            },
            reviewerHandler: approve,
        });
        check(!scenario.error, `Scenario should not abort: ${scenario.error ? scenario.error.message : ''}`);
        const third = scenario.tasks.find((t) => t.title === TITLES[2]).id;
        const reviews = developReviews(scenario);
        check(reviews.length >= 1, 'Expected a develop-round Review dispatch');
        for (const r of reviews) check(!reviewScopeIds(r).includes(third), `unconfirmed claim leaked into review: ${JSON.stringify(reviewScopeIds(r))}`);
        assert.equal(reviewScopeIds(reviews[0]).length, 2);
    });
});

test('mock sprint: a dispatch error after every bead verified closed still reviews all beads', async () => {
    resetSyncMemo();
    await withScenarioMarkers('review scope error after closes', async () => {
        let calls = 0;
        const scenario = await runDevelopLoopScenario('rs-err-closed', {
            members: ['local'],
            taskSpecs: specs,
            beforeSprint: oneLane(TITLES),
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                calls += 1;
                const ids = assignedIds(opts);
                for (const id of ids) await rc(`bd close ${id}`, td);
                if (calls === 1) throw new Error('mock doer crash after closing every bead');
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'ok' }) }] };
            },
            reviewerHandler: approve,
        });
        check(!scenario.error, `Scenario should not abort: ${scenario.error ? scenario.error.message : ''}`);
        const ids = scenario.tasks.map((t) => t.id).sort();
        const reviews = developReviews(scenario);
        check(reviews.length >= 1, 'Expected a develop-round Review dispatch');
        assert.deepEqual(reviewScopeIds(reviews[0]).slice().sort(), ids);
    });
});

for (const [label, causeMessage] of [
    ['permission-scope sync failure', "[Sync] permission-scope git failure for member 'local' (G-push): refused"],
    ['generic post-dispatch sync failure', 'bd dolt push failed'],
]) {
    test(`mock sprint: closes behind a ${label} are not reviewed`, async () => {
        resetSyncMemo();
        await withScenarioMarkers(`review scope ${label}`, async () => {
            let calls = 0;
            const scenario = await runDevelopLoopScenario('rs-unpublished', {
                members: ['local'],
                taskSpecs: [{ title: 'Task: unpublished only' }],
                doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                    calls += 1;
                    const ids = assignedIds(opts);
                    for (const id of ids) await rc(`bd close ${id}`, td);
                    throw new PostDispatchSyncError('post-dispatch sync failed', {
                        member: 'local', cause: new Error(causeMessage),
                    });
                },
                reviewerHandler: approve,
            });
            check(calls >= 1, 'doer must have been dispatched');
            check(
                scenario.logs.some((m) => m.includes('Doer streak attribution') && m.includes('closed=[')),
                'develop must reach the streak attribution step',
            );
            const unpublished = scenario.tasks[0].id;
            for (const r of developReviews(scenario)) {
                check(!reviewScopeIds(r).includes(unpublished), `unpublished close leaked into review: ${JSON.stringify(reviewScopeIds(r))}`);
            }
        });
    });
}
