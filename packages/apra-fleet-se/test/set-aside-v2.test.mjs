// Unit coverage for the BLOCKED set-aside v2 rules (fleet-sprint):
//   1. lane order is a prerequisite (goal filter closure + hold-back);
//   2. a BLOCKED report on a bead with an open in-sprint prerequisite waits;
//      a set-aside still spreads over every 'blocks' edge;
//   4. an out-of-scope prerequisite sets the bead aside, naming it;
//   5. stall accounting for waiting/held beads;
//   6. the "Waited this run" report line.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    partitionReadyByGoal, openBlocksDependents, unmetPrerequisites, laneOf,
} from '../fleet-sprint/beads-scope.mjs';
import { holdBackByLaneOrder } from '../fleet-sprint/worklists.mjs';
import {
    classifyBlockedReport, stuckBehindSetAside, evaluateSetAsideStall,
    collectWaitEntries, formatWaitedLine, collectSetAsideEntries,
} from '../fleet-sprint/set-aside.mjs';
import { buildSprintPrBody } from '../fleet-sprint/pr-body.mjs';
import { buildAnalysisText } from '../fleet-sprint/sprint-report.mjs';

const GOAL = 'P1/P2';
const blocks = (issueId, dependsOnId) => ({ issue_id: issueId, depends_on_id: dependsOnId, type: 'blocks' });
const bead = (id, { priority = 2, status = 'open', streak, order, deps = [] } = {}) => {
    const metadata = {};
    if (streak) metadata.streak = streak;
    if (order !== undefined) metadata.streakOrder = order;
    return { id, priority, status, metadata, dependencies: deps.map((d) => blocks(id, d)) };
};
const ids = (beads) => beads.map((b) => b.id).sort();

// The Sprint 2 shape: lane install-a ends with an impl task (P3, order 5) and
// its [test] task (P3, order 6); every task of lane install-b (P2) is blocked
// by install-a's last task to serialise the two lanes on shared files.
function sprint2() {
    const aEarlier = bead('a-4', { priority: 2, status: 'closed', streak: 'install-a', order: 4 });
    const impl = bead('a-impl', { priority: 3, streak: 'install-a', order: 5 });
    const tst = bead('a-test', { priority: 3, streak: 'install-a', order: 6 });
    const b1 = bead('b-1', { priority: 2, streak: 'install-b', order: 1, deps: ['a-test'] });
    const b2 = bead('b-2', { priority: 2, streak: 'install-b', order: 2, deps: ['a-test'] });
    const b3 = bead('b-3', { priority: 2, streak: 'install-b', order: 3, deps: ['a-test'] });
    return { scope: [aEarlier, impl, tst, b1, b2, b3], ready: [impl, tst] };
}

describe('rule 1: lane order is a prerequisite', () => {
    test('goal filter keeps the impl lane-mate of a below-goal [test] bead kept for serving in-goal work', () => {
        const { scope, ready } = sprint2();
        const { dispatchable, excluded } = partitionReadyByGoal(ready, scope, GOAL);
        assert.deepEqual(ids(dispatchable), ['a-impl', 'a-test']);
        assert.deepEqual(excluded, []);
    });

    test('goal filter lane closure is transitive and ignores closed lane-mates and other lanes', () => {
        const scope = [
            bead('p1', { priority: 1, deps: ['t3'] }),
            bead('t1', { priority: 3, streak: 'L', order: 1 }),
            bead('t2', { priority: 3, streak: 'L', order: 2 }),
            bead('t3', { priority: 3, streak: 'L', order: 3 }),
            bead('t0', { priority: 3, streak: 'L', order: 0, status: 'closed' }),
            bead('other', { priority: 3, streak: 'M', order: 1 }),
            bead('after', { priority: 3, streak: 'L', order: 4 }),
        ];
        const ready = scope.filter((b) => ['t1', 'other', 'after'].includes(b.id));
        const { dispatchable, excluded } = partitionReadyByGoal(ready, scope, GOAL);
        assert.deepEqual(ids(dispatchable), ['t1']);
        assert.deepEqual(excluded.map((e) => e.id).sort(), ['after', 'other']);
    });

    test('hold-back: a ready bead whose lower-order lane-mate is open and not ready is held', () => {
        const { scope } = sprint2();
        const tst = scope.find((b) => b.id === 'a-test');
        const r = holdBackByLaneOrder([tst], scope);
        assert.deepEqual(r.dispatchable, []);
        assert.deepEqual(r.held, [{ id: 'a-test', on: ['a-impl'] }]);
    });

    test('hold-back: lane-mates dispatched together in order, or a closed predecessor, are not held', () => {
        const { scope, ready } = sprint2();
        assert.deepEqual(ids(holdBackByLaneOrder(ready, scope).dispatchable), ['a-impl', 'a-test']);
        const closedImpl = scope.map((b) => (b.id === 'a-impl' ? { ...b, status: 'closed' } : b));
        const tst = closedImpl.find((b) => b.id === 'a-test');
        assert.deepEqual(holdBackByLaneOrder([tst], closedImpl).held, []);
    });

    test('hold-back runs to a fixpoint and ignores beads without a numeric streakOrder', () => {
        const scope = [
            bead('x1', { streak: 'L', order: 1, status: 'in_progress' }),
            bead('x2', { streak: 'L', order: 2 }),
            bead('x3', { streak: 'L', order: 3 }),
            bead('free', { streak: 'L' }),
            bead('plain'),
        ];
        const ready = scope.slice(1);
        const r = holdBackByLaneOrder(ready, scope);
        assert.deepEqual(ids(r.dispatchable), ['free', 'plain']);
        assert.deepEqual(r.held.map((h) => h.id).sort(), ['x2', 'x3']);
    });
});

describe('set-aside spreading and lane metadata', () => {
    test('a set-aside spreads over every blocks edge, transitively, as before', () => {
        const { scope } = sprint2();
        assert.deepEqual([...openBlocksDependents(['a-test'], scope).keys()].sort(), ['b-1', 'b-2', 'b-3']);
        const chain = [
            bead('root', { streak: 'A', order: 1 }),
            bead('real', { streak: 'C', order: 1, deps: ['root'] }),
            bead('real-2', { streak: 'C', order: 2, deps: ['real'] }),
        ];
        assert.deepEqual([...openBlocksDependents(['root'], chain).keys()].sort(), ['real', 'real-2']);
    });

    test('a blocks edge onto a lane-mate counts once among the unmet prerequisites', () => {
        const scope = [
            bead('s1', { streak: 'S', order: 1 }),
            bead('s2', { streak: 'S', order: 2, deps: ['s1'] }),
        ];
        assert.deepEqual(unmetPrerequisites(scope[1], { scopeBeads: scope }), { inScope: ['s1'], outOfScope: [] });
    });

    test('metadata given as a JSON string is read too', () => {
        const b = { id: 'x', metadata: JSON.stringify({ streak: 'L', streakOrder: '2' }) };
        assert.deepEqual(laneOf(b), { streak: 'L', order: 2 });
        assert.equal(laneOf({ id: 'z', metadata: { streak: 'L' } }), null);
    });
});

describe('rules 2 and 4: wait vs set-aside on a BLOCKED report', () => {
    const { scope } = sprint2();

    test('a [test] bead reported BLOCKED while its impl lane-mate is open waits on it', () => {
        const r = classifyBlockedReport({ blockedIds: ['a-test'], scopeBeads: scope });
        assert.deepEqual(r, { wait: [{ id: 'a-test', on: ['a-impl'] }], setAside: [] });
    });

    test('an open blocks dependency in scope makes the bead wait too', () => {
        const s = [bead('pre'), bead('x', { deps: ['pre'] })];
        assert.deepEqual(classifyBlockedReport({ blockedIds: ['x'], scopeBeads: s }).wait, [{ id: 'x', on: ['pre'] }]);
    });

    test('no open prerequisite: a genuine blocker, set aside', () => {
        const closedImpl = scope.map((b) => (b.id === 'a-impl' ? { ...b, status: 'closed' } : b));
        assert.deepEqual(classifyBlockedReport({ blockedIds: ['a-test'], scopeBeads: closedImpl }), { wait: [], setAside: [{ id: 'a-test', suffix: '' }] });
    });

    test('reported BLOCKED again after waiting: set aside, naming the earlier wait', () => {
        const closedImpl = scope.map((b) => (b.id === 'a-impl' ? { ...b, status: 'closed' } : b));
        const waitingIds = new Map([['a-test', { on: ['a-impl'], cycle: 1, round: 1 }]]);
        const r = classifyBlockedReport({ blockedIds: ['a-test'], scopeBeads: closedImpl, waitingIds });
        assert.equal(r.wait.length, 0);
        assert.equal(r.setAside[0].id, 'a-test');
        assert.match(r.setAside[0].suffix, /BLOCKED again after waiting on a-impl/);
    });

    test('an open prerequisite outside the sprint scope sets the bead aside, naming it', () => {
        const s = [bead('x', { deps: ['outside-1'] })];
        const all = [...s, bead('outside-1')];
        const r = classifyBlockedReport({ blockedIds: ['x'], scopeBeads: s, allBeads: all });
        assert.equal(r.wait.length, 0);
        assert.match(r.setAside[0].suffix, /outside this sprint's scope.*outside-1/);
        // A CLOSED out-of-scope dependency is no prerequisite at all.
        const allClosed = [...s, bead('outside-1', { status: 'closed' })];
        assert.deepEqual(classifyBlockedReport({ blockedIds: ['x'], scopeBeads: s, allBeads: allClosed }).setAside, [{ id: 'x', suffix: '' }]);
    });

    test('a bead already set aside is skipped', () => {
        const r = classifyBlockedReport({ blockedIds: ['a-test'], scopeBeads: scope, doctorBlockedIds: new Map([['a-test', {}]]) });
        assert.deepEqual(r, { wait: [], setAside: [] });
    });
});

describe('rule 5: stall accounting', () => {
    const setAside = (id) => new Map([[id, { kind: 'blocked', blockedBy: id, reason: 'r', cycle: 1, round: 1 }]]);

    test('a waiting bead whose prerequisite is set aside counts as stuck -> the run stalls', () => {
        const s = [bead('impl', { streak: 'L', order: 1 }), bead('test', { streak: 'L', order: 2 })];
        const blocked = setAside('impl');
        const stuck = stuckBehindSetAside({ scopeBeads: s, doctorBlockedIds: blocked, waitingIds: new Map([['test', { on: ['impl'] }]]) });
        assert.deepEqual([...stuck.keys()], ['test']);
        assert.match(stuck.get('test'), /waiting on impl/);
        const stall = evaluateSetAsideStall({ openIds: ['impl', 'test'], doctorBlockedIds: blocked, stuckIds: stuck });
        assert.ok(stall);
        assert.deepEqual(stall.blockerIds, ['impl', 'test']);
        assert.match(stall.blockerReasons.test, /waiting on impl/);
    });

    test('a waiting bead whose prerequisite can still close keeps the run going', () => {
        const s = [bead('impl', { streak: 'L', order: 1 }), bead('test', { streak: 'L', order: 2 }), bead('genuine')];
        const blocked = setAside('genuine');
        const stuck = stuckBehindSetAside({ scopeBeads: s, doctorBlockedIds: blocked, waitingIds: new Map([['test', { on: ['impl'] }]]) });
        assert.equal(stuck.size, 0);
        assert.equal(evaluateSetAsideStall({ openIds: ['impl', 'test', 'genuine'], doctorBlockedIds: blocked, stuckIds: stuck }), null);
        assert.equal(evaluateSetAsideStall({ openIds: ['test', 'genuine'], doctorBlockedIds: blocked, stuckIds: stuck }), null);
    });

    test('a waiting bead with an out-of-scope prerequisite is stuck', () => {
        const s = [bead('w', { deps: ['out'] })];
        const stuck = stuckBehindSetAside({
            scopeBeads: s, allBeads: [...s, bead('out')], doctorBlockedIds: setAside('other'), waitingIds: new Map([['w', { on: ['out'] }]]),
        });
        assert.match(stuck.get('w'), /outside this sprint's scope/);
    });

    test('a blocks dependent of a set-aside bead is covered by the set-aside spread, not by stuck accounting', () => {
        const s = [bead('root', { streak: 'A', order: 1 }), bead('dep', { streak: 'B', order: 1, deps: ['root'] })];
        const blocked = setAside('root');
        // The develop phase sets 'dep' aside with 'root' (openBlocksDependents);
        // stuck accounting reaches the same verdict from the graph alone.
        assert.deepEqual([...stuckBehindSetAside({ scopeBeads: s, doctorBlockedIds: blocked }).keys()], ['dep']);
    });

    test('lane successors held behind a set-aside bead are stuck, transitively', () => {
        const s = [bead('l1', { streak: 'L', order: 1 }), bead('l2', { streak: 'L', order: 2 }), bead('l3', { streak: 'L', order: 3 }), bead('dep', { deps: ['l3'] })];
        const stuck = stuckBehindSetAside({ scopeBeads: s, doctorBlockedIds: setAside('l1') });
        assert.deepEqual([...stuck.keys()].sort(), ['dep', 'l2', 'l3']);
        assert.match(stuck.get('l2'), /^held on l1/);
    });

    test('nothing set aside and nothing waiting -> nothing stuck', () => {
        assert.equal(stuckBehindSetAside({ scopeBeads: [bead('a')] }).size, 0);
    });
});

describe('rule 6: "Waited this run" report line', () => {
    const state = {
        waitingIds: new Map([['t-2', { on: ['i-2'], cycle: 1, round: 2 }], ['t-1', { on: ['i-1', 'i-0'], cycle: 1, round: 1 }]]),
        doctorBlockedIds: new Map([['g', { kind: 'blocked', blockedBy: 'g', reason: 'toolchain missing', cycle: 1, round: 1 }]]),
    };

    test('collected in first-seen order and formatted on one line; absent when nothing waited', () => {
        const entries = collectWaitEntries(state);
        assert.deepEqual(entries.map((e) => e.id), ['t-1', 't-2']);
        assert.equal(formatWaitedLine(entries), 'Waited this run: t-1 on i-1, i-0; t-2 on i-2');
        assert.equal(formatWaitedLine(collectWaitEntries({})), null);
    });

    test('PR body: one "Waited this run" line, waits never listed under "Set aside this run"', () => {
        const body = buildSprintPrBody({
            verdict: 'FAIL', branch: 'feat/x', notes: 'n',
            setAside: collectSetAsideEntries(state), waited: collectWaitEntries(state),
        });
        assert.match(body, /\nWaited this run: t-1 on i-1, i-0; t-2 on i-2\n/);
        const section = body.slice(body.indexOf('### Set aside this run'), body.indexOf('Waited this run'));
        assert.ok(section.includes('- g: toolchain missing'), section);
        assert.ok(!section.includes('t-1') && !section.includes('t-2'), section);
        const plain = buildSprintPrBody({ verdict: 'PASS', branch: 'feat/x', notes: 'n', now: new Date(0) });
        assert.equal(buildSprintPrBody({ verdict: 'PASS', branch: 'feat/x', notes: 'n', now: new Date(0), waited: [] }), plain);
    });

    test('sprint analysis: the "Waited this run" line follows the set-aside section; absent when nothing waited', () => {
        const base = {
            targetIssues: ['e'], branch: 'b', baseBranch: 'main', cyclesRun: 1,
            closedCountHistory: [1], highWaterClosedCount: 1,
            deployFailures: [], integFailures: [], rejectedNewTasks: [],
            finalVerdictResult: { verdict: 'PASS', notes: '' }, finalClosedCount: 1, finalOpenAtGoalCount: 0,
        };
        const text = buildAnalysisText({ ...base, setAside: collectSetAsideEntries(state), waited: collectWaitEntries(state) });
        assert.match(text, /## Set aside this run\n\n- g: [^\n]*\n\nWaited this run: t-1 on i-1, i-0; t-2 on i-2\n/);
        assert.doesNotMatch(buildAnalysisText(base), /Waited this run/);
    });
});
