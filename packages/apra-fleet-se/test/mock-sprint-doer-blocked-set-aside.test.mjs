import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { openBlocksDependents } from '../fleet-sprint/beads-scope.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';

// =============================================================================
// A bead a doer reports BLOCKED (named per bead via the report's blockedIds)
// is set aside for the rest of the run together with every open bead that
// depends on it over 'blocks' edges (sprintState.doctorBlockedIds in
// phases/develop.mjs). Its higher-order lane-mates are NOT set aside but are
// held by lane order (lane order is a prerequisite), and count as stuck for
// the immediate stall. A report that leaves beads open WITHOUT status
// BLOCKED sets nothing aside.
// =============================================================================

const check = (cond, msg) => assert.ok(cond, msg);

const assignedIds = (opts) => {
    const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const approve = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});
const doerDispatches = (scenario) => scenario.dispatched.filter((d) => d.agent === 'doer');
const dispatchedIds = (d) => {
    const match = d.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const resetSyncMemo = () => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
};
const setAsideEntries = (logs) => {
    const out = {};
    for (const m of logs) {
        if (!m.includes('Doer BLOCKED set-aside')) continue;
        const json = m.slice(m.indexOf('Entries: ') + 'Entries: '.length);
        Object.assign(out, JSON.parse(json));
    }
    return out;
};

const LANE = ['Task: lane first', 'Task: lane second', 'Task: lane third'];
const DEPENDENT = 'Task: depends on first';
const DEPENDENT_2 = 'Task: depends on dependent';

// One 3-bead lane (all ready at once), plus a two-deep blocks chain hanging off
// the lane's first bead: DEPENDENT depends on LANE[0], DEPENDENT_2 on DEPENDENT.
const wireGraph = async ({ runCmd: rc, tempDir: td, tasks }) => {
    const id = (title) => tasks.find((x) => x.title === title).id;
    for (let i = 0; i < LANE.length; i++) {
        await rc(`bd update ${id(LANE[i])} --set-metadata streak=lane-x --set-metadata streakOrder=${i + 1}`, td);
    }
    await rc(`bd update ${id(DEPENDENT)} --set-metadata streak=lane-y --set-metadata streakOrder=1`, td);
    await rc(`bd update ${id(DEPENDENT_2)} --set-metadata streak=lane-y --set-metadata streakOrder=2`, td);
    await rc(`bd dep add ${id(DEPENDENT)} ${id(LANE[0])}`, td);
    await rc(`bd dep add ${id(DEPENDENT_2)} ${id(DEPENDENT)}`, td);
};
const specs = [...LANE, DEPENDENT, DEPENDENT_2].map((title) => ({ title }));

test('unit: openBlocksDependents walks blocks edges transitively, skips closed and parent-child', () => {
    const scope = [
        { id: 'a', status: 'open', dependencies: [{ depends_on_id: 'epic', type: 'parent-child' }] },
        { id: 'b', status: 'open', dependencies: [{ depends_on_id: 'a', type: 'blocks' }] },
        { id: 'c', status: 'open', dependencies: [{ depends_on_id: 'b', type: 'blocks' }] },
        { id: 'd', status: 'closed', dependencies: [{ depends_on_id: 'a', type: 'blocks' }] },
        { id: 'e', status: 'open', dependencies: [{ depends_on_id: 'd', type: 'blocks' }] },
        { id: 'f', status: 'open', dependencies: [{ depends_on_id: 'a', type: 'parent-child' }] },
        { id: 'g', status: 'open', dependencies: [] },
    ];
    const deps = openBlocksDependents(['a'], scope);
    assert.deepEqual([...deps.entries()].sort(), [['b', 'a'], ['c', 'a']]);
    assert.equal(openBlocksDependents(['g'], scope).size, 0);
    assert.equal(openBlocksDependents([], scope).size, 0);
});

test('mock sprint: a BLOCKED bead and its dependent chain are set aside; its later lane-mates are held by lane order, not set aside', async () => {
    resetSyncMemo();
    await withScenarioMarkers('doer blocked set-aside', async () => {
        let blockedId = null;
        const scenario = await runDevelopLoopScenario('dbsa-blocked', {
            members: ['local'],
            taskSpecs: specs,
            maxCycles: 2,
            beforeSprint: wireGraph,
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts);
                const list = JSON.parse((await rc('bd list --json', td)).stdout || '[]');
                const first = list.find((b) => b.title === LANE[0]);
                if (first && ids.includes(first.id)) {
                    // Blocked on the lane's first bead; stops without reaching the
                    // other two (same-lane stop rule).
                    blockedId = first.id;
                    return { content: [{ text: JSON.stringify({ status: 'BLOCKED', closedIds: [], blockedIds: [first.id], notes: 'Blocked: needs live evidence.' }) }] };
                }
                for (const id of ids) await rc(`bd close ${id}`, td);
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Done.' }) }] };
            },
            reviewerHandler: approve,
        });
        const id = (title) => scenario.tasks.find((t) => t.title === title).id;
        const [a, b, c] = LANE.map(id);
        const d = id(DEPENDENT);
        const e = id(DEPENDENT_2);
        check(blockedId === a, 'the doer must have been dispatched on the lane first bead');

        const doers = doerDispatches(scenario);
        assert.deepEqual(dispatchedIds(doers[0]).slice().sort(), [a, b, c].sort(), 'round 1 dispatches the whole lane');
        // Intentional v2 change: b and c come after the set-aside a in lane
        // order, so they are held, never re-dispatched in this run (before,
        // they came back the next round and closed).
        assert.equal(doers.length, 1, `only round 1 dispatches: ${JSON.stringify(doers.map(dispatchedIds))}`);
        for (const held of [b, c]) assert.notEqual(scenario.finalBeadsById.get(held).status, 'closed', `${held} must stay open`);
        check(
            scenario.logs.some((m) => m.includes('HELD by lane order') && m.includes(`${b} (after ${a})`)),
            'the lane-order hold must be logged',
        );

        const entries = setAsideEntries(scenario.logs);
        assert.deepEqual(Object.keys(entries).sort(), [a, d, e].sort(), `set-aside ids: ${JSON.stringify(entries)}`);
        assert.equal(entries[a].kind, 'blocked');
        assert.equal(entries[a].blockedBy, a);
        check(/reported BLOCKED/.test(entries[a].reason), `blocked reason: ${entries[a].reason}`);
        for (const dep of [d, e]) {
            assert.equal(entries[dep].kind, 'dependent');
            assert.equal(entries[dep].blockedBy, a);
            check(entries[dep].reason.includes(a), `a dependent's reason must name the blocked bead: ${entries[dep].reason}`);
        }
        for (const entry of Object.values(entries)) {
            assert.equal(entry.cycle, 1);
            assert.equal(entry.round, 1);
        }
        // Everything left open is set aside or held behind a set-aside bead,
        // so the run stalls at once in C1 instead of spending a second cycle.
        check(scenario.error, 'the run must end in a stall once only set-aside beads remain');
        assert.equal(scenario.error.code, 'SPRINT_STALLED');
        assert.equal(scenario.error.details.cycle, 1, 'the stall must be declared in C1');
        check(!scenario.logs.some((m) => /\bC2 R\d|Cycle 2\b/.test(m)), 'no second cycle may start');
        for (const setAside of [a, b, c, d, e]) {
            check(scenario.error.blockerIds.includes(setAside), `blockerIds must name ${setAside}: ${JSON.stringify(scenario.error.blockerIds)}`);
            check(scenario.error.blockerReasons[setAside], `blockerReasons must explain ${setAside}`);
        }
        for (const held of [b, c]) {
            check(scenario.error.blockerReasons[held].startsWith(`held on ${a}`), `held reason: ${scenario.error.blockerReasons[held]}`);
        }
        assert.deepEqual(scenario.error.setAside.map((x) => x.id).sort(), [a, d, e].sort(), 'held beads are not set aside');
    });
});

test('mock sprint: a report that leaves a bead open without BLOCKED sets nothing aside and the bead is retried', async () => {
    resetSyncMemo();
    await withScenarioMarkers('doer left-open no set-aside', async () => {
        const scenario = await runDevelopLoopScenario('dbsa-leftopen', {
            members: ['local'],
            taskSpecs: LANE.map((title) => ({ title })),
            beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => {
                for (let i = 0; i < LANE.length; i++) {
                    const t = tasks.find((x) => x.title === LANE[i]);
                    await rc(`bd update ${t.id} --set-metadata streak=lane-x --set-metadata streakOrder=${i + 1}`, td);
                }
            },
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts);
                const list = JSON.parse((await rc('bd list --json', td)).stdout || '[]');
                const third = list.find((b) => b.title === LANE[2]);
                const closable = ids.filter((x) => !third || x !== third.id);
                for (const x of closable) await rc(`bd close ${x}`, td);
                // Success-looking report that leaves the third bead open.
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: closable, notes: 'ok' }) }] };
            },
            reviewerHandler: approve,
        });
        const third = scenario.tasks.find((t) => t.title === LANE[2]).id;
        check(!scenario.logs.some((m) => m.includes('Doer BLOCKED set-aside')), 'nothing may be set aside without status BLOCKED');
        check(!scenario.logs.some((m) => m.includes('set aside after a doer BLOCKED report')), 'no set-aside exclusion without BLOCKED');
        const retried = doerDispatches(scenario).slice(1).some((dd) => dispatchedIds(dd).includes(third));
        check(retried, 'the left-open bead must be retried in a later round (current left-open retry unchanged)');
    });
});

// --- Which open beads a BLOCKED report sets aside when blockedIds is not a
// non-empty list: only a single-bead dispatch falls back to "the one bead
// still open"; an explicit [] sets nothing aside; a bead the doer never
// named is never set aside.

const PAIR = ['Task: pair first', 'Task: pair second'];

test('mock sprint: 2-bead streak, doer closes the first as blocked and stops -- the unreached second bead is NOT set aside', async () => {
    resetSyncMemo();
    await withScenarioMarkers('doer blocked unnamed lane-mate', async () => {
        let firstDone = false;
        const scenario = await runDevelopLoopScenario('dbsa-unnamed', {
            members: ['local'],
            taskSpecs: PAIR.map((title) => ({ title })),
            beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => {
                for (let i = 0; i < PAIR.length; i++) {
                    const t = tasks.find((x) => x.title === PAIR[i]);
                    await rc(`bd update ${t.id} --set-metadata streak=lane-p --set-metadata streakOrder=${i + 1}`, td);
                }
            },
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts);
                if (!firstDone) {
                    // Closes the first bead with a blocked reason, then stops
                    // without reaching the second, and names no blockedIds
                    // (nothing was left open because of the block).
                    firstDone = true;
                    await rc(`bd close ${ids[0]}`, td);
                    return { content: [{ text: JSON.stringify({ status: 'BLOCKED', closedIds: [ids[0]], notes: 'blocked: missing secret DEPLOY_TOKEN' }) }] };
                }
                for (const id of ids) await rc(`bd close ${id}`, td);
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Done.' }) }] };
            },
            reviewerHandler: approve,
        });
        const second = scenario.tasks.find((t) => t.title === PAIR[1]).id;
        check(!scenario.logs.some((m) => m.includes('Doer BLOCKED set-aside')), 'the unnamed second bead must not be set aside');
        check(scenario.logs.some((m) => m.includes('no blockedIds naming which')), 'the no-blockedIds multi-bead path must be logged');
        const doers = doerDispatches(scenario);
        check(doers.slice(1).some((dd) => dispatchedIds(dd).includes(second)), `the second bead must be re-dispatched: ${JSON.stringify(doers.map(dispatchedIds))}`);
        assert.equal(scenario.finalBeadsById.get(second).status, 'closed');
        check(!scenario.error, `no stall expected: ${scenario.error ? scenario.error.message : ''}`);
    });
});

test('mock sprint: a BLOCKED report with an explicit empty blockedIds sets nothing aside', async () => {
    resetSyncMemo();
    await withScenarioMarkers('doer blocked empty blockedIds', async () => {
        let calls = 0;
        const scenario = await runDevelopLoopScenario('dbsa-empty', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: single empty' }],
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts);
                calls++;
                if (calls === 1) {
                    return { content: [{ text: JSON.stringify({ status: 'BLOCKED', closedIds: [], blockedIds: [], notes: 'Transient: retry.' }) }] };
                }
                for (const id of ids) await rc(`bd close ${id}`, td);
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Done.' }) }] };
            },
            reviewerHandler: approve,
        });
        const only = scenario.tasks[0].id;
        check(!scenario.logs.some((m) => m.includes('Doer BLOCKED set-aside')), 'an explicit [] must set nothing aside');
        check(scenario.logs.some((m) => m.includes('reported BLOCKED with an empty blockedIds')), 'the empty-blockedIds path must be logged');
        check(calls >= 2, `the bead must be re-dispatched, doer calls: ${calls}`);
        assert.equal(scenario.finalBeadsById.get(only).status, 'closed');
        check(!scenario.error, `no stall expected: ${scenario.error ? scenario.error.message : ''}`);
    });
});

test('mock sprint: a single-bead dispatch reported BLOCKED with blockedIds omitted sets that bead aside', async () => {
    resetSyncMemo();
    await withScenarioMarkers('doer blocked single omitted', async () => {
        const scenario = await runDevelopLoopScenario('dbsa-single', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: single omitted' }],
            doerHandler: async () => ({ content: [{ text: JSON.stringify({ status: 'BLOCKED', closedIds: [], notes: 'Missing toolchain.' }) }] }),
            reviewerHandler: approve,
        });
        const only = scenario.tasks[0].id;
        const entries = setAsideEntries(scenario.logs);
        assert.deepEqual(Object.keys(entries), [only], JSON.stringify(entries));
        assert.equal(entries[only].kind, 'blocked');
        assert.equal(doerDispatches(scenario).length, 1, 'the set-aside bead is dispatched exactly once');
        check(scenario.error && scenario.error.code === 'SPRINT_STALLED', `expected the set-aside stall, got: ${scenario.error ? scenario.error.message : 'no error'}`);
        assert.deepEqual(scenario.error.blockerIds, [only]);
    });
});
