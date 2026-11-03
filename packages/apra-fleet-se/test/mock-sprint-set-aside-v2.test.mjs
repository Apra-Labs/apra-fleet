// =============================================================================
// End-to-end mock sprints for BLOCKED set-aside v2:
//   (a) the Sprint 2 shape -- an [impl] and its [test] task in one lane, both
//       below the goal, with another lane serialised behind the [test] task
//       by cross-lane edges carrying fileConflicts: the impl runs before the
//       test, nothing is set aside, and the serialised lane runs;
//   (b) the same shape without fileConflicts (an old plan): same outcome
//       when nothing is BLOCKED (lane order still applies);
//   (c)/(d) the lane's [test] task is genuinely BLOCKED after its impl
//       closed: with fileConflicts the serialised lane is released and runs;
//       without them (an old plan) it is set aside with the test, as before;
//   (e) a [test] task reported BLOCKED while its impl lane-mate is still open
//       waits, and runs once the impl closes;
//   (f) the same, reported BLOCKED again after the impl closed: set aside.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { buildSprintPrBody } from '../fleet-sprint/pr-body.mjs';
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
const doerDispatches = (run) => run.dispatched.filter((d) => d.agent === 'doer');
const doerOrder = (run) => doerDispatches(run).flatMap((d) => assignedIds(d.prompt));
const timesDispatched = (run, id) => doerDispatches(run).filter((d) => assignedIds(d.prompt).includes(id)).length;
const report = (obj) => ({ content: [{ text: JSON.stringify(obj) }] });
const approve = async () => report({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] });
const setAsideLogged = (logs) => logs.some((m) => m.includes('Doer BLOCKED set-aside'));
const ENV_NOTES = 'Environment: the installer test host is unreachable from this member.';

const T = {
    impl: 'Task: installer impl',
    test: 'Task: [test] installer',
    b1: 'Task: other lane one',
    b2: 'Task: other lane two',
    b3: 'Task: other lane three',
};
const SPECS = [
    { title: T.impl, priority: 'P3' },
    { title: T.test, priority: 'P3' },
    { title: T.b1, priority: 'P2' },
    { title: T.b2, priority: 'P2' },
    { title: T.b3, priority: 'P2' },
];

// Lane install-a = [impl (5), test (6)]; lane install-b = [b1, b2, b3], each
// blocked by install-a's LAST task (planner file serialisation), optionally
// marked with fileConflicts.
const wireSprint2 = (withFileConflicts) => async ({ runCmd: rc, tempDir: td, tasks }) => {
    const id = (title) => tasks.find((x) => x.title === title).id;
    await rc(`bd update ${id(T.impl)} --set-metadata streak=install-a --set-metadata streakOrder=5`, td);
    await rc(`bd update ${id(T.test)} --set-metadata streak=install-a --set-metadata streakOrder=6`, td);
    const lane = [T.b1, T.b2, T.b3];
    for (let i = 0; i < lane.length; i++) {
        await rc(`bd update ${id(lane[i])} --set-metadata streak=install-b --set-metadata streakOrder=${i + 1}`, td);
        await rc(`bd dep add ${id(lane[i])} ${id(T.test)}`, td);
        if (withFileConflicts) {
            // \" quoting survives both cmd.exe and POSIX sh as one argument.
            await rc(`bd update ${id(lane[i])} --set-metadata "fileConflicts={\\"${id(T.test)}\\":[\\"src/install.ts\\"]}"`, td);
        }
    }
};

// A realistic doer: works its beads in the given order; the [test] task is
// BLOCKED while its impl is still open (the impl is not there to test) and,
// when `testAlwaysBlocked`, BLOCKED on the environment regardless.
const sprint2Doer = ({ testAlwaysBlocked = false } = {}) => async ({ opts, runCmd: rc, tempDir: td }) => {
    const ids = assignedIds(opts.prompt);
    const list = JSON.parse((await rc('bd list --all --json', td)).stdout || '[]');
    const byTitle = (title) => list.find((b) => b.title === title);
    const closed = [];
    for (const x of ids) {
        const b = list.find((y) => y.id === x);
        if (b && b.title === T.test) {
            const implOpen = byTitle(T.impl).status !== 'closed' && !closed.includes(byTitle(T.impl).id);
            if (implOpen || testAlwaysBlocked) {
                return report({
                    status: 'BLOCKED', closedIds: closed, blockedIds: [x],
                    notes: implOpen ? 'Blocked: the implementation under test is not there yet.' : ENV_NOTES,
                });
            }
        }
        await rc(`bd close ${x}`, td);
        closed.push(x);
    }
    return report({ status: 'VERIFY', closedIds: closed, notes: 'Done.' });
};

for (const withFileConflicts of [true, false]) {
    const tag = withFileConflicts ? 'sav2-sprint2-fc' : 'sav2-sprint2-old';
    test(`(${withFileConflicts ? 'a' : 'b'}) Sprint 2 shape ${withFileConflicts ? 'with' : 'WITHOUT'} fileConflicts: the impl runs before its [test] lane-mate, nothing is set aside, the serialised lane runs`, async () => {
        resetSyncMemo();
        await withScenarioMarkers(`set-aside v2 sprint2 ${withFileConflicts ? 'fc' : 'old'}`, async () => {
            const run = await runDevelopLoopScenario(tag, {
                members: ['local'],
                taskSpecs: SPECS,
                maxCycles: 2,
                beforeSprint: wireSprint2(withFileConflicts),
                doerHandler: sprint2Doer(),
                reviewerHandler: approve,
            });
            const id = (title) => run.tasks.find((t) => t.title === title).id;
            const order = doerOrder(run);
            assert.ok(order.includes(id(T.impl)), `the impl must be dispatched: ${JSON.stringify(order)}`);
            assert.ok(order.indexOf(id(T.impl)) < order.indexOf(id(T.test)), `impl before test: ${JSON.stringify(order)}`);
            assert.ok(!setAsideLogged(run.logs), 'nothing may be set aside');
            for (const t of Object.values(T)) {
                assert.equal(run.finalBeadsById.get(id(t)).status, 'closed', `${t} must close`);
            }
            assert.ok(!run.error, `no error expected: ${run.error ? run.error.message : ''}`);
        });
    });
}

test('(c) the [test] task genuinely BLOCKED with fileConflicts: only it is set aside; the serialised lane is released and runs', async () => {
    resetSyncMemo();
    await withScenarioMarkers('set-aside v2 genuine block fc', async () => {
        const run = await runDevelopLoopScenario('sav2-genuine-fc', {
            members: ['local'],
            taskSpecs: SPECS,
            maxCycles: 2,
            beforeSprint: wireSprint2(true),
            doerHandler: sprint2Doer({ testAlwaysBlocked: true }),
            reviewerHandler: approve,
        });
        const id = (title) => run.tasks.find((t) => t.title === title).id;
        const tst = id(T.test);
        for (const t of [T.b1, T.b2, T.b3, T.impl]) {
            assert.equal(run.finalBeadsById.get(id(t)).status, 'closed', `${t} must close`);
        }
        assert.equal(timesDispatched(run, tst), 1, 'the BLOCKED test task is dispatched once');
        assert.ok(run.logs.some((m) => /Develop dispatch: RELEASED /.test(m)), 'the release must be logged');
        assert.ok(run.error && run.error.code === 'SPRINT_STALLED', `expected the set-aside stall, got: ${run.error ? run.error.message : 'no error'}`);
        assert.deepEqual(run.error.blockerIds, [tst]);
        assert.ok(run.error.blockerReasons[tst].includes(ENV_NOTES), run.error.blockerReasons[tst]);
        assert.equal(run.error.setAside.length, 1);
    });
});

test('(d) the [test] task genuinely BLOCKED in an old plan without fileConflicts: it and its blocks dependents are set aside, as before', async () => {
    resetSyncMemo();
    await withScenarioMarkers('set-aside v2 genuine block old', async () => {
        const run = await runDevelopLoopScenario('sav2-genuine-old', {
            members: ['local'],
            taskSpecs: SPECS,
            maxCycles: 2,
            beforeSprint: wireSprint2(false),
            doerHandler: sprint2Doer({ testAlwaysBlocked: true }),
            reviewerHandler: approve,
        });
        const id = (title) => run.tasks.find((t) => t.title === title).id;
        const [tst, b1, b2, b3] = [T.test, T.b1, T.b2, T.b3].map(id);
        assert.equal(run.finalBeadsById.get(id(T.impl)).status, 'closed');
        for (const b of [b1, b2, b3]) assert.equal(timesDispatched(run, b), 0, `${b} must not be dispatched`);
        assert.ok(run.error && run.error.code === 'SPRINT_STALLED', `expected the set-aside stall, got: ${run.error ? run.error.message : 'no error'}`);
        assert.deepEqual(run.error.blockerIds.slice().sort(), [tst, b1, b2, b3].sort());
        for (const b of [b1, b2, b3]) assert.ok(run.error.blockerReasons[b].includes(tst), run.error.blockerReasons[b]);
    });
});

// --- Wait, then run / then set aside ---------------------------------------

const PAIR = { impl: 'Task: feature impl', test: 'Task: [test] feature' };

const wirePair = async ({ runCmd: rc, tempDir: td, tasks }) => {
    const id = (title) => tasks.find((x) => x.title === title).id;
    await rc(`bd update ${id(PAIR.impl)} --set-metadata streak=lane-f --set-metadata streakOrder=1`, td);
    await rc(`bd update ${id(PAIR.test)} --set-metadata streak=lane-f --set-metadata streakOrder=2`, td);
};

// First dispatch: the doer leaves the impl unfinished (not blocked, not
// named) and reports the [test] task BLOCKED because the impl is missing.
// Later dispatches: the impl closes; the test closes, or -- when
// `blockAgain` -- is BLOCKED again on the environment.
const pairDoer = ({ blockAgain }) => {
    let calls = 0;
    return async ({ opts, runCmd: rc, tempDir: td }) => {
        calls++;
        const ids = assignedIds(opts.prompt);
        const list = JSON.parse((await rc('bd list --all --json', td)).stdout || '[]');
        const title = (x) => (list.find((b) => b.id === x) || {}).title;
        if (calls === 1) {
            const tst = ids.find((x) => title(x) === PAIR.test);
            return report({ status: 'BLOCKED', closedIds: [], blockedIds: [tst], notes: 'Blocked: the implementation is not there yet.' });
        }
        const closed = [];
        for (const x of ids) {
            if (title(x) === PAIR.test && blockAgain) {
                return report({ status: 'BLOCKED', closedIds: closed, blockedIds: [x], notes: ENV_NOTES });
            }
            await rc(`bd close ${x}`, td);
            closed.push(x);
        }
        return report({ status: 'VERIFY', closedIds: closed, notes: 'Done.' });
    };
};

test('(e) a [test] task reported BLOCKED while its impl lane-mate is open waits, then runs after the impl closes', async () => {
    resetSyncMemo();
    await withScenarioMarkers('set-aside v2 wait then run', async () => {
        const run = await runDevelopLoopScenario('sav2-wait-run', {
            members: ['local'],
            taskSpecs: Object.values(PAIR).map((title) => ({ title })),
            maxCycles: 2,
            beforeSprint: wirePair,
            doerHandler: pairDoer({ blockAgain: false }),
            reviewerHandler: approve,
        });
        const id = (title) => run.tasks.find((t) => t.title === title).id;
        const [impl, tst] = [PAIR.impl, PAIR.test].map(id);
        const doers = doerDispatches(run).map((d) => assignedIds(d.prompt));
        assert.deepEqual(doers[0], [impl, tst], 'round 1 dispatches the lane in order');
        assert.deepEqual(doers[1], [impl], `the waiting test task is not dispatched with its open impl: ${JSON.stringify(doers)}`);
        assert.deepEqual(doers[2], [tst], `the test task runs after the impl closed: ${JSON.stringify(doers)}`);
        assert.ok(run.logs.some((m) => m.includes(`Doer BLOCKED wait C1 R1: bead '${tst}' waiting on ${impl}`)), 'the wait must be logged');
        assert.ok(!setAsideLogged(run.logs), 'nothing may be set aside');
        for (const x of [impl, tst]) assert.equal(run.finalBeadsById.get(x).status, 'closed');
        assert.ok(!run.error, `no error expected: ${run.error ? run.error.message : ''}`);
    });
});

test('(f) a waiting [test] task reported BLOCKED again after its impl closed is set aside (one extra dispatch at most)', async () => {
    resetSyncMemo();
    await withScenarioMarkers('set-aside v2 wait then set aside', async () => {
        const run = await runDevelopLoopScenario('sav2-wait-aside', {
            members: ['local'],
            taskSpecs: Object.values(PAIR).map((title) => ({ title })),
            maxCycles: 2,
            beforeSprint: wirePair,
            doerHandler: pairDoer({ blockAgain: true }),
            reviewerHandler: approve,
        });
        const id = (title) => run.tasks.find((t) => t.title === title).id;
        const [impl, tst] = [PAIR.impl, PAIR.test].map(id);
        assert.equal(timesDispatched(run, tst), 2, 'the test task gets exactly one extra dispatch');
        assert.equal(run.finalBeadsById.get(impl).status, 'closed');
        assert.ok(run.error && run.error.code === 'SPRINT_STALLED', `expected the set-aside stall, got: ${run.error ? run.error.message : 'no error'}`);
        assert.deepEqual(run.error.blockerIds, [tst]);
        assert.match(run.error.blockerReasons[tst], new RegExp(`BLOCKED again after waiting on ${impl}`));
        // The [ABORTED] PR body: the test task under "Set aside this run",
        // and the earlier wait on its own line.
        const body = buildSprintPrBody({ verdict: 'ABORTED', branch: run.branch, notes: run.error.message, setAside: run.error.setAside, waited: run.error.waited });
        assert.match(body, new RegExp(`### Set aside this run\\n\\n- ${tst}: `));
        assert.ok(body.includes(`Waited this run: ${tst} on ${impl}`), body);
    });
});
