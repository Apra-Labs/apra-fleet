import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, MOCK_BRANCH_TIPS, MOCK_TIP_DRIFT } from './helpers/mock-sprint-harness.mjs';
import {
    cannotCloseThisRun, collectSetAsideEntries, VERIFY_NO_CHANGE_KIND,
} from '../fleet-sprint/set-aside.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';

// =============================================================================
// A doer streak that returns VERIFY but closed NONE of its beads (the engine's
// own read-back) is set aside after that one round (phases/develop.mjs
// recordDoerVerifyNoChange, kind VERIFY_NO_CHANGE_KIND on
// sprintState.doctorBlockedIds) instead of being re-dispatched every round:
// the streak's first still-open bead is set aside, its later lane-mates are
// held by lane order. A VERIFY streak that closed any of its beads keeps the
// existing left-open retry.
// =============================================================================

const resetSyncMemo = () => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
};
const report = (obj) => ({ content: [{ text: JSON.stringify(obj) }] });
const approve = async () => report({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] });
const assignedIds = (prompt) => {
    const match = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const doerDispatches = (scenario) => scenario.dispatched.filter((d) => d.agent === 'doer');
const noChangeEntries = (logs) => {
    const out = {};
    for (const m of logs) {
        if (!m.includes('Doer VERIFY-no-change set-aside')) continue;
        Object.assign(out, JSON.parse(m.slice(m.indexOf('Entry: ') + 'Entry: '.length)));
    }
    return out;
};
const setLane = async (rc, td, tasks, titles, lane) => {
    for (const [i, title] of titles.entries()) {
        const id = tasks.find((x) => x.title === title).id;
        await rc(`bd update ${id} --set-metadata streak=${lane} --set-metadata streakOrder=${i + 1}`, td);
    }
};

test('unit: a verify-no-change set-aside entry is reported as such', () => {
    const blocked = new Map([['x', { kind: VERIFY_NO_CHANGE_KIND, blockedBy: 'x', reason: 'returned VERIFY', cycle: 1, round: 2 }]]);
    assert.equal(cannotCloseThisRun({ doctorBlockedIds: blocked }).get('x'), 'set aside, doer returned VERIFY with no change');
    const entries = collectSetAsideEntries({ doctorBlockedIds: blocked });
    assert.deepEqual(entries.map((e) => [e.id, e.kind, e.cycle, e.round]), [['x', VERIFY_NO_CHANGE_KIND, 1, 2]]);
});

const LANE = ['Task: nv lane first', 'Task: nv lane second', 'Task: nv lane third'];

test('mock sprint: a lane streak returning VERIFY with nothing closed sets its first bead aside after one round; later lane-mates are held', async () => {
    resetSyncMemo();
    await withScenarioMarkers('doer verify no change lane', async () => {
        const scenario = await runDevelopLoopScenario('dvnc-lane', {
            members: ['local'],
            taskSpecs: LANE.map((title) => ({ title })),
            maxCycles: 2,
            beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => setLane(rc, td, tasks, LANE, 'lane-nv'),
            doerHandler: async () => report({ status: 'VERIFY', closedIds: [], notes: 'Nothing to code here.' }),
            reviewerHandler: approve,
        });
        const [a, b, c] = LANE.map((title) => scenario.tasks.find((t) => t.title === title).id);
        const doers = doerDispatches(scenario);
        assert.equal(doers.length, 1, `the streak is dispatched exactly once: ${JSON.stringify(doers.map((d) => assignedIds(d.prompt)))}`);
        assert.deepEqual(assignedIds(doers[0].prompt).slice().sort(), [a, b, c].sort());
        const entries = noChangeEntries(scenario.logs);
        assert.deepEqual(Object.keys(entries), [a], JSON.stringify(entries));
        assert.equal(entries[a].kind, VERIFY_NO_CHANGE_KIND);
        assert.ok(entries[a].reason.includes('returned VERIFY') && entries[a].reason.includes('Nothing to code here.'), entries[a].reason);
        assert.equal(entries[a].cycle, 1);
        assert.equal(entries[a].round, 1);
        // Nothing closed this run, so the set-aside ends in the immediate stall
        // (not after the remaining rounds/cycles), naming the set-aside bead.
        assert.ok(scenario.error && scenario.error.code === 'SPRINT_STALLED', `expected the set-aside stall, got: ${scenario.error ? scenario.error.message : 'no error'}`);
        assert.equal(scenario.error.details.cycle, 1);
        assert.deepEqual(scenario.error.setAside.map((x) => x.id), [a]);
        for (const id of [a, b, c]) assert.ok(scenario.error.blockerIds.includes(id), `blockerIds must name ${id}`);
    });
});

const PAIR = ['Task: nv pair first', 'Task: nv pair second'];

test('mock sprint: a VERIFY streak that closed one of its beads sets nothing aside and the open bead is retried', async () => {
    resetSyncMemo();
    await withScenarioMarkers('doer verify partial change', async () => {
        let calls = 0;
        const scenario = await runDevelopLoopScenario('dvnc-partial', {
            members: ['local'],
            taskSpecs: PAIR.map((title) => ({ title })),
            beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => setLane(rc, td, tasks, PAIR, 'lane-np'),
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts.prompt);
                calls++;
                const closable = calls === 1 ? ids.slice(0, 1) : ids;
                for (const id of closable) await rc(`bd close ${id}`, td);
                return report({ status: 'VERIFY', closedIds: closable, notes: 'ok' });
            },
            reviewerHandler: approve,
        });
        const second = scenario.tasks.find((t) => t.title === PAIR[1]).id;
        assert.ok(!scenario.logs.some((m) => m.includes('Doer VERIFY-no-change set-aside')), 'a streak that closed a bead must set nothing aside');
        assert.ok(doerDispatches(scenario).slice(1).some((d) => assignedIds(d.prompt).includes(second)), 'the open bead must be retried');
        assert.equal(scenario.finalBeadsById.get(second).status, 'closed');
        assert.ok(!scenario.error, `no stall expected: ${scenario.error ? scenario.error.message : ''}`);
    });
});

test('mock sprint: a VERIFY that committed work but closed nothing is NOT set aside and keeps the left-open retry', async () => {
    resetSyncMemo();
    await withScenarioMarkers('doer verify committed no close', async () => {
        let calls = 0;
        const scenario = await runDevelopLoopScenario('dvnc-committed', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: nv committed' }],
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts.prompt);
                calls++;
                if (calls === 1) {
                    // Real work was committed on the branch, but the close never lands.
                    MOCK_BRANCH_TIPS.set(opts.member_name || '(none)', 'a'.repeat(40));
                    return report({ status: 'VERIFY', closedIds: [], notes: 'committed, close lost' });
                }
                for (const id of ids) await rc(`bd close ${id}`, td);
                return report({ status: 'VERIFY', closedIds: ids, notes: 'ok' });
            },
            reviewerHandler: approve,
        });
        MOCK_BRANCH_TIPS.clear();
        const id = scenario.tasks.find((t) => t.title === 'Task: nv committed').id;
        assert.ok(!scenario.logs.some((m) => m.includes('Doer VERIFY-no-change set-aside')), 'a VERIFY that committed must set nothing aside');
        assert.ok(doerDispatches(scenario).length >= 2, 'the open bead must be re-dispatched');
        assert.equal(scenario.finalBeadsById.get(id).status, 'closed');
    });
});

test('mock sprint: a no-change VERIFY is still set aside when another lane pushes (the member tip moves in the sync brackets)', async () => {
    resetSyncMemo();
    MOCK_TIP_DRIFT.on = true;
    MOCK_TIP_DRIFT.counters.clear();
    try {
        await withScenarioMarkers('doer verify no change tip drift', async () => {
            let calls = 0;
            const scenario = await runDevelopLoopScenario('dvnc-drift', {
                members: ['local'],
                taskSpecs: [{ title: 'Task: nv drift' }],
                maxCycles: 2,
                doerHandler: async () => {
                    calls++;
                    return report({ status: 'VERIFY', closedIds: [], notes: 'nothing to code' });
                },
                reviewerHandler: approve,
            });
            const id = scenario.tasks.find((t) => t.title === 'Task: nv drift').id;
            assert.ok(scenario.logs.some((m) => m.includes('Doer VERIFY-no-change set-aside') && m.includes(`'${id}'`)),
                `must be set aside: ${JSON.stringify(scenario.logs.filter((l) => /VERIFY|sync/i.test(l)))}`);
            assert.equal(calls, 1, 'dispatched to a doer exactly once');
        });
    } finally {
        MOCK_TIP_DRIFT.on = false;
        MOCK_TIP_DRIFT.counters.clear();
    }
});
