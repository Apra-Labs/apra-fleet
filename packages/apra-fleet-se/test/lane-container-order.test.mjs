import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    containerIdsOf, lowerOrderLaneMates, unmetPrerequisites, partitionReadyByGoal, laneOf,
    lanedContainers, newIgnoredContainerLaneLogs, formatIgnoredContainerLaneLog,
} from '../fleet-sprint/beads-scope.mjs';
import { holdBackByLaneOrder } from '../fleet-sprint/worklists.mjs';
import { classifyBlockedReport } from '../fleet-sprint/set-aside.mjs';

// =============================================================================
// Lane order never holds a bead behind a CONTAINER (a bead that is the parent
// of another in-scope bead): a container can only close after its children.
//
// The logged deadlock shape: two sibling containers A and B laned at
// streakOrder 0, their children A.1 (order 1), B.1 (order 1) and A.2
// (order 2) in the same lane. Develop held every child by lane order behind A
// and B, which could never close first, until the stall net ended the run.
//
// Checked: on main (before the shared lowerOrderLaneMates helper) the first
// test below fails -- holdBackByLaneOrder holds all three children. It also
// fails with an ANCESTOR-only exclusion: A is excluded for A.1, but B is not
// A.1's ancestor, so A.1 is still held on B (the last test in this file pins
// that B is not an ancestor of A.1, so that variant cannot pass).
// =============================================================================

const S = 'lane-s';
const laned = (id, order, extra = {}) => ({
    id, status: 'open', priority: 1, issue_type: 'task', dependencies: [],
    metadata: { streak: S, streakOrder: order }, ...extra,
});

function containerScope() {
    return [
        laned('epic.A', 0, { parent: 'epic', issue_type: 'feature' }),
        laned('epic.B', 0, { parent: 'epic', issue_type: 'feature' }),
        laned('epic.A.1', 1, { parent: 'epic.A' }),
        laned('epic.B.1', 1, { parent: 'epic.B' }),
        laned('epic.A.2', 2, { parent: 'epic.A' }),
        { id: 'epic', status: 'open', priority: 1, issue_type: 'epic', dependencies: [] },
    ];
}
const CHILDREN = ['epic.A.1', 'epic.B.1', 'epic.A.2'];
const ready = (scope) => scope.filter((b) => CHILDREN.includes(b.id));

describe('holdBackByLaneOrder: containers never hold their lane', () => {
    test('two sibling laned containers at order 0 -> all three children dispatchable, nothing held', () => {
        const scope = containerScope();
        const out = holdBackByLaneOrder(ready(scope), scope);
        assert.deepEqual(out.held, []);
        assert.deepEqual(out.dispatchable.map((b) => b.id), CHILDREN);
    });

    test('a non-container open lane-mate at a lower order still holds the later bead and is named in held[].on', () => {
        const scope = [
            laned('t1', 1),
            laned('t2', 2),
            laned('c', 0), laned('c.1', 3, { parent: 'c' }),
        ];
        // t1 is open but not in this round's ready set: t2 must wait on it.
        const out = holdBackByLaneOrder([scope[1], scope[3]], scope);
        assert.deepEqual(out.dispatchable.map((b) => b.id), []);
        assert.deepEqual(out.held, [{ id: 't2', on: ['t1'] }, { id: 'c.1', on: ['t1', 't2'] }]);
    });
});

describe('unmetPrerequisites / partitionReadyByGoal: a container is no lane-mate prerequisite', () => {
    test('unmetPrerequisites never reports a container; it still reports a real lower-order child', () => {
        const scope = containerScope();
        const byId = new Map(scope.map((b) => [b.id, b]));
        assert.deepEqual(unmetPrerequisites(byId.get('epic.A.1'), { scopeBeads: scope }).inScope, []);
        assert.deepEqual(unmetPrerequisites(byId.get('epic.B.1'), { scopeBeads: scope }).inScope, []);
        // A.2's open lower-order lane-mates are A.1 and B.1 (leaves), never A or B.
        assert.deepEqual(unmetPrerequisites(byId.get('epic.A.2'), { scopeBeads: scope }).inScope, ['epic.A.1', 'epic.B.1']);
    });

    test('partitionReadyByGoal does not walk to a container through lane order', () => {
        // A below-goal container would only be KEPT if something treated it as
        // a prerequisite of in-goal work; with lane order it no longer is.
        const scope = containerScope().map((b) => (b.id === 'epic.B' ? { ...b, priority: 3 } : b));
        const belowReady = { ...scope.find((b) => b.id === 'epic.B') };
        const out = partitionReadyByGoal([...ready(scope), belowReady], scope, 'P1/P2');
        assert.deepEqual(out.dispatchable.map((b) => b.id), CHILDREN);
        assert.deepEqual(out.excluded.map((e) => e.id), ['epic.B']);
    });

    test('control: a below-goal NON-container lower-order lane-mate is still kept as a prerequisite', () => {
        const scope = [laned('low', 0, { priority: 3 }), laned('high', 1)];
        const out = partitionReadyByGoal(scope, scope, 'P1/P2');
        assert.deepEqual(out.dispatchable.map((b) => b.id).sort(), ['high', 'low']);
        assert.deepEqual(out.excluded, []);
    });
});

describe('classifyBlockedReport: never WAITs on a container', () => {
    test('a child reported BLOCKED whose only open lower-order lane-mate is its container is set aside, not WAIT', () => {
        const scope = [laned('c', 0), laned('c.1', 1, { parent: 'c' })];
        const out = classifyBlockedReport({ blockedIds: ['c.1'], scopeBeads: scope });
        assert.deepEqual(out.wait, []);
        assert.deepEqual(out.setAside.map((s) => s.id), ['c.1']);
    });

    test('control: an open non-container lower-order lane-mate still makes it WAIT on that mate', () => {
        const scope = [laned('t0', 0), laned('t1', 1)];
        const out = classifyBlockedReport({ blockedIds: ['t1'], scopeBeads: scope });
        assert.deepEqual(out.wait, [{ id: 't1', on: ['t0'] }]);
    });
});

describe('lowerOrderLaneMates / containerIdsOf', () => {
    test('containerIdsOf is keyed on the parent edge, not issue_type', () => {
        const scope = [
            { id: 'p', issue_type: 'task', status: 'open' },
            { id: 'p.1', parent: 'p', status: 'closed' },
            { id: 'f', issue_type: 'feature', status: 'open' },
            { id: 'x', parent: 'outside-scope', status: 'open' },
        ];
        assert.deepEqual([...containerIdsOf(scope)].sort(), ['p']);
    });

    test('an ancestor-only exclusion cannot fix the logged shape: B is not an ancestor of A.1 but is a lower-order open lane-mate', () => {
        const scope = containerScope();
        const byId = new Map(scope.map((b) => [b.id, b]));
        const ancestors = new Set();
        for (let cur = byId.get('epic.A.1'); cur && cur.parent; cur = byId.get(cur.parent)) ancestors.add(cur.parent);
        assert.ok(!ancestors.has('epic.B'));
        assert.ok(laneOf(byId.get('epic.B')).order < laneOf(byId.get('epic.A.1')).order);
        assert.deepEqual(lowerOrderLaneMates(byId.get('epic.A.1'), scope), [], 'the container-aware helper excludes B too');
    });
});

describe('ignored container lane metadata is logged once per container per run', () => {
    test('two laned containers -> exactly one line per container, naming it and its streak, across repeated cycles', () => {
        const logged = new Set();
        const lines = [];
        // Three "cycles" over the same run: the scope is re-read each time and
        // the containers' statuses move on, but each is logged only once.
        lines.push(...newIgnoredContainerLaneLogs(containerScope(), logged));
        lines.push(...newIgnoredContainerLaneLogs(containerScope(), logged));
        const later = containerScope().map((b) => (b.id === 'epic.A.1' ? { ...b, status: 'closed' } : b));
        lines.push(...newIgnoredContainerLaneLogs(later, logged));
        assert.equal(lines.length, 2, JSON.stringify(lines));
        assert.deepEqual(lines, [
            formatIgnoredContainerLaneLog({ id: 'epic.A', streak: S }),
            formatIgnoredContainerLaneLog({ id: 'epic.B', streak: S }),
        ]);
        assert.match(lines[0], /epic\.A carries lane metadata \(streak lane-s\) but is a container/);
        assert.match(lines[0], /its lane position is ignored, because it can only close after its children/);
        assert.match(lines[1], /^Lane order: epic\.B /);
    });

    test('a scope with no laned container logs nothing (an unlaned container and laned leaves only)', () => {
        const scope = [
            { id: 'epic', status: 'open', dependencies: [] },
            laned('epic.1', 0, { parent: 'epic' }),
            laned('epic.2', 1, { parent: 'epic' }),
        ];
        assert.deepEqual(lanedContainers(scope), []);
        const logged = new Set();
        assert.deepEqual(newIgnoredContainerLaneLogs(scope, logged), []);
        assert.equal(logged.size, 0);
    });
});
