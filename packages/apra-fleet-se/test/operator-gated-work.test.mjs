import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allRemainingWorkOperatorGated, plannerBlockedDecisionRequest } from '../fleet-sprint/decisions.mjs';

const gate = (id, of) => ({ id, status: 'deferred', issue_type: 'decision', labels: ['human'], dependencies: [{ depends_on_id: of, type: 'discovered-from' }] });

test('only a task held by an open decision bead: all remaining work is operator-gated', () => {
    const scope = [{ id: 'e', status: 'open', dependencies: [] }, { id: 't1', status: 'open', parent: 'e', dependencies: [] }];
    const r = allRemainingWorkOperatorGated(scope, {}, [...scope, gate('d1', 't1')]);
    assert.equal(r.gated, true);
    assert.deepEqual(r.gateIds, ['d1']);
    assert.ok(r.heldIds.includes('t1') && r.heldIds.includes('e'));
});

test('a held task plus one ungated open task: not gated (planner runs as before)', () => {
    const scope = [{ id: 't1', status: 'open', dependencies: [] }, { id: 't2', status: 'open', dependencies: [] }];
    assert.equal(allRemainingWorkOperatorGated(scope, {}, [...scope, gate('d1', 't1')]).gated, false);
});

test('a task blocked only by a held task, and a sprintState set-aside, count as held', () => {
    const scope = [
        { id: 't1', status: 'open', dependencies: [] },
        { id: 't2', status: 'open', dependencies: [{ depends_on_id: 't1', type: 'blocks' }] },
        { id: 't3', status: 'open', dependencies: [] },
    ];
    const sprintState = { doctorBlockedIds: new Map([['t3', { kind: 'needs-decision', decisionId: 'd' }]]) };
    assert.equal(allRemainingWorkOperatorGated(scope, sprintState, [...scope, gate('d1', 't1')]).gated, true);
});

test('a closed decision bead gates nothing; empty or closed-only scope is not gated', () => {
    const scope = [{ id: 't1', status: 'open', dependencies: [] }];
    assert.equal(allRemainingWorkOperatorGated(scope, {}, [...scope, { ...gate('d1', 't1'), status: 'closed' }]).gated, false);
    assert.equal(allRemainingWorkOperatorGated([], {}, []).gated, false);
    assert.equal(allRemainingWorkOperatorGated([{ id: 't1', status: 'closed' }], {}, []).gated, false);
});

test('plannerBlockedDecisionRequest builds a valid request from the notes and the first target', () => {
    const r = plannerBlockedDecisionRequest({ status: 'BLOCKED', notes: ' Need the region. ' }, ['x-1', 'x-2']);
    assert.equal(r.ok, true);
    assert.equal(r.decision.beadId, 'x-1');
    assert.equal(r.decision.question, 'Need the region.');
    assert.ok(r.decision.options.length >= 2);
    assert.equal(plannerBlockedDecisionRequest({ notes: 'n' }, []).ok, false);
});
