// =============================================================================
// Mock sprints: a [test] bead held behind an [impl] lane-mate that can never
// close in this run is counted as stuck, and the run ends in cycle 1 naming
// that lane-mate and why -- not after STALL_CYCLE_LIMIT stale cycles with a
// generic stall that names no hold reason.
//
//   (a) the [impl] (streak S, order 1) is deferred by plan-cap exhaustion;
//       its in-goal [test] lane-mate (order 2) is held by lane order;
//   (b) the [impl] is publish blocked by a permission-scope push failure;
//       its [test] lane-mate is held behind it (lane order plus a 'blocks'
//       edge, so the two are never dispatched in one streak).
//
// Both include an independent ready bead that a doer closes: a deferred
// [impl] plus its [test] ALONE leaves nothing dispatchable after the
// deferral, which ends the run with SprintPlanRejectedError instead. With
// work closed this run the stall is a carry-over: the run exits to
// Finalization with the held [test] carried over and a FAIL verdict.
//
// Reverting the set-aside.mjs / runner.js change that counts a bead held
// behind a deferred or publish-blocked lane-mate as stuck makes (a) fail:
// stuckBehindSetAside only knew doer-BLOCKED set-asides and
// throwIfSetAsideStall returned early with none, so the held [test] was
// never stuck, no carry-over fired at Cycle 1 evaluation and the run went
// on into cycle 2 ((b) then ends in the generic 2-stale-cycle
// StalledSprintError naming no hold reason).
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { PostDispatchSyncError } from '../fleet-sprint/errors.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';

const resetSyncMemo = () => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
};
const assignedIds = (prompt) => {
    const match = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const report = (obj) => ({ content: [{ text: JSON.stringify(obj) }] });
const approve = async () => report({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] });
const carried = (run) => Object.fromEntries((run.result && run.result.carryOver ? run.result.carryOver : []).map((e) => [e.id, e.reason]));
const doerAssigned = (run) => run.dispatched.filter((d) => d.agent === 'doer').flatMap((d) => assignedIds(d.prompt));

const T = {
    impl: 'Task: widget impl',
    test: 'Task: [test] widget',
    other: 'Task: independent lane work',
};
const SPECS = [{ title: T.impl }, { title: T.test }, { title: T.other }];

const wireLanes = ({ blocksEdge }) => async ({ runCmd: rc, tempDir: td, tasks }) => {
    const id = (title) => tasks.find((x) => x.title === title).id;
    await rc(`bd update ${id(T.impl)} --set-metadata streak=lane-s --set-metadata streakOrder=1`, td);
    await rc(`bd update ${id(T.test)} --set-metadata streak=lane-s --set-metadata streakOrder=2`, td);
    await rc(`bd update ${id(T.other)} --set-metadata streak=lane-l2 --set-metadata streakOrder=1`, td);
    if (blocksEdge) await rc(`bd dep add ${id(T.test)} ${id(T.impl)}`, td);
};

const assertEndsInCycle1WithCarryOver = (run, { implId, testId, otherId, why }) => {
    assert.ok(!run.error, `no abort expected (work closed this run): ${run.error && run.error.message}`);
    assert.equal(run.result.exitReason, 'set-aside-carry-over', JSON.stringify(run.result));
    assert.equal(run.result.verdict, 'FAIL', JSON.stringify(run.result));
    assert.equal(run.finalBeadsById.get(otherId).status, 'closed', 'the independent lane closes');
    assert.ok(!doerAssigned(run).includes(testId), 'the held [test] bead is never dispatched');
    // Ended in cycle 1: the carry-over exit fired at Cycle 1 evaluation, and
    // no cycle 2 ever started.
    assert.ok(run.logs.some((m) => m.startsWith('Cycle 1: Carried over (Cycle 1 evaluation)')),
        `expected the carry-over exit at Cycle 1 evaluation: ${JSON.stringify(run.logs.filter((m) => m.includes('Carried over')))}`);
    assert.ok(!run.logs.some((m) => /Cycle 2 evaluation/.test(m)), 'no second cycle may run');
    assert.ok(!run.logs.some((m) => m.includes('consecutive cycle(s) made no new high-water-mark progress')), 'no generic stale-cycle stall');
    const reasons = carried(run);
    assert.ok(reasons[testId], `the held [test] bead is carried over: ${JSON.stringify(reasons)}`);
    assert.ok(reasons[testId].includes(`${implId} (${why}`), `the [test] reason names ${implId} and why: ${reasons[testId]}`);
};

test('(a) a [test] bead held behind a plan-cap-deferred [impl] lane-mate ends in cycle 1 naming the deferred impl', async () => {
    resetSyncMemo();
    await withScenarioMarkers('lane-mate cannot close: plan-cap deferred impl', async () => {
        const run = await runDevelopLoopScenario('lmcc-deferred', {
            members: ['local'],
            taskSpecs: SPECS,
            maxCycles: 3,
            beforeSprint: wireLanes({ blocksEdge: false }),
            // Every plan-review round is CHANGES_NEEDED naming ONLY the impl,
            // so plan-cap exhaustion defers it and Develop goes on.
            planReviewerHandler: async ({ tempDir, runCmd, epicBead }) => {
                const list = JSON.parse((await runCmd(`bd list --parent ${epicBead.id} --json`, tempDir)).stdout || '[]');
                const byTitle = (t) => list.find((b) => b.title === t).id;
                return report({
                    verdict: 'CHANGES_NEEDED',
                    notes: `${byTitle(T.impl)} has acceptance criteria that cannot be verified -- rewrite them.`,
                    taskAssignments: Object.values(T).map((t) => ({ id: byTitle(t), bucket: 'S', model: 'standard' })),
                });
            },
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts.prompt);
                for (const x of ids) await rc(`bd close ${x}`, td);
                return report({ status: 'VERIFY', closedIds: ids, notes: 'Done.' });
            },
            reviewerHandler: approve,
        });
        const id = (title) => run.tasks.find((t) => t.title === title).id;
        assert.equal(run.finalBeadsById.get(id(T.impl)).status, 'deferred', 'the impl is plan-cap deferred');
        assertEndsInCycle1WithCarryOver(run, { implId: id(T.impl), testId: id(T.test), otherId: id(T.other), why: 'deferred' });
    });
});

test('(b) a [test] bead held behind a publish-blocked [impl] lane-mate ends in cycle 1 naming the publish-blocked impl', async () => {
    resetSyncMemo();
    await withScenarioMarkers('lane-mate cannot close: publish-blocked impl', async () => {
        let implId = null;
        const run = await runDevelopLoopScenario('lmcc-publish-blocked', {
            members: ['local'],
            taskSpecs: SPECS,
            maxCycles: 3,
            beforeSprint: async (ctx) => {
                await wireLanes({ blocksEdge: true })(ctx);
                implId = ctx.tasks.find((x) => x.title === T.impl).id;
            },
            // Closes every assigned bead except the impl; a streak carrying
            // the impl then fails its post-dispatch push on a permission
            // scope, so the impl is publish blocked for the rest of the run.
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts.prompt);
                const closed = [];
                for (const x of ids) {
                    if (x === implId) continue;
                    await rc(`bd close ${x}`, td);
                    closed.push(x);
                }
                if (ids.includes(implId)) {
                    throw new PostDispatchSyncError('post-dispatch sync failed', {
                        member: 'local', cause: new Error("[Sync] permission-scope git failure for member 'local' (G-push): refused"),
                    });
                }
                return report({ status: 'VERIFY', closedIds: closed, notes: 'Done.' });
            },
            reviewerHandler: approve,
        });
        const id = (title) => run.tasks.find((t) => t.title === title).id;
        assert.notEqual(run.finalBeadsById.get(id(T.impl)).status, 'closed', 'the impl stays open (publish blocked)');
        assert.ok(run.logs.some((m) => m.includes('PUBLISH BLOCKED') || m.includes('permission-scope')), 'the publish block is logged');
        assertEndsInCycle1WithCarryOver(run, {
            implId: id(T.impl), testId: id(T.test), otherId: id(T.other), why: 'publish blocked by a permission-scope push failure',
        });
        assert.match(carried(run)[id(T.impl)] || '', /publish blocked by a permission-scope push failure/, 'the impl itself is carried over as publish blocked');
    });
});
