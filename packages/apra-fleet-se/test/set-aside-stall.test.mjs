// Unit coverage for fleet-sprint/set-aside.mjs: the immediate set-aside stall
// decision and the "Set aside this run" report section in the PR body and
// the sprint analysis document.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    collectSetAsideEntries, evaluateSetAsideStall, formatSetAsideItems, formatSetAsideStallMessage,
    DEPLOY_SET_ASIDE_ID,
} from '../fleet-sprint/set-aside.mjs';
import { buildSprintPrBody } from '../fleet-sprint/pr-body.mjs';
import { buildAnalysisText } from '../fleet-sprint/sprint-report.mjs';
import { StalledSprintError } from '../fleet-sprint/errors.mjs';

const blockedMap = () => new Map([
    ['b-dep', { kind: 'dependent', blockedBy: 'b-1', reason: "depends (via blocks edges) on doer-BLOCKED bead 'b-1'", cycle: 1, round: 1 }],
    ['b-1', { kind: 'blocked', blockedBy: 'b-1', reason: "doer on member 'm1' reported BLOCKED on streak [b-1]: toolchain missing", cycle: 1, round: 1 }],
    ['b-2', { kind: 'blocked', blockedBy: 'b-2', reason: "doer on member 'm1' reported BLOCKED on streak [b-2]", cycle: 1, round: 2 }],
]);
const deploy = { reason: 'deployer stopped at the deploy.md Permissions check before running any deploy command', notes: 'Missing Bash(docker:*)', cycle: 1 };

test('every open bead set aside -> stall naming each set-aside bead with its reason', () => {
    const stall = evaluateSetAsideStall({ openIds: ['b-1', 'b-dep', 'b-2'], doctorBlockedIds: blockedMap() });
    assert.ok(stall);
    assert.deepEqual(stall.blockerIds, ['b-1', 'b-dep', 'b-2'], 'blocked bead first, then its dependent, then later rounds');
    assert.match(stall.blockerReasons['b-1'], /toolchain missing \(first seen C1 R1\)/);
    assert.match(stall.blockerReasons['b-dep'], /'b-1'.*first seen C1 R1/);
    assert.match(stall.blockerReasons['b-2'], /first seen C1 R2/);
    const msg = formatSetAsideStallMessage(stall, { where: 'Cycle 1 evaluation', scope: '--parent e' });
    for (const id of stall.blockerIds) assert.ok(msg.includes(id), msg);
});

test('one open bead not set aside -> no stall', () => {
    assert.equal(evaluateSetAsideStall({ openIds: ['b-1', 'free'], doctorBlockedIds: blockedMap() }), null);
});

test('nothing open -> no stall (completion is not a stall), even with deploy set aside', () => {
    assert.equal(evaluateSetAsideStall({ openIds: [], doctorBlockedIds: blockedMap(), deploySetAside: deploy }), null);
});

test('no set-aside at all -> no stall (behaviour unchanged without BLOCKED)', () => {
    assert.equal(evaluateSetAsideStall({ openIds: ['x'] }), null);
    assert.equal(evaluateSetAsideStall({ openIds: [], integBoundIds: ['epic'] }), null, 'IntegTest-bound alone is not set aside');
});

test('deploy set aside + only IntegTest-bound beads left -> stall with the deploy reason in blockerIds', () => {
    const stall = evaluateSetAsideStall({ openIds: ['leaf'], integBoundIds: ['epic'], verifyBlockedIds: ['leaf'], deploySetAside: deploy });
    assert.ok(stall);
    assert.deepEqual(stall.blockerIds, ['epic', 'leaf', DEPLOY_SET_ASIDE_ID]);
    assert.match(stall.blockerReasons.deploy, /Permissions check.*Missing Bash\(docker:\*\).*first seen C1/);
    assert.match(stall.blockerReasons.epic, /Integration Test/);
    // Without the deploy set aside, IntegTest-bound beads can still close.
    assert.equal(evaluateSetAsideStall({ openIds: ['leaf'], integBoundIds: ['epic'], verifyBlockedIds: ['leaf'] }), null);
    // A leaf that is not IntegTest-bound keeps the run going.
    assert.equal(evaluateSetAsideStall({ openIds: ['leaf', 'other'], integBoundIds: ['epic'], verifyBlockedIds: ['leaf'], deploySetAside: deploy }), null);
});

test('StalledSprintError carries blockerReasons and setAside; defaults keep the old shape', () => {
    const err = new StalledSprintError('x', { blockerIds: ['a'], blockerReasons: { a: 'r' }, setAside: [{ id: 'a' }], cycle: 1 });
    assert.deepEqual(err.blockerReasons, { a: 'r' });
    assert.deepEqual(err.details.setAside, [{ id: 'a' }]);
    const plain = new StalledSprintError('y', { blockerIds: ['b'] });
    assert.deepEqual(plain.blockerIds, ['b']);
    assert.deepEqual(plain.setAside, []);
});

test('PR body: "Set aside this run" lists bead, reason and first seen; absent when nothing was set aside', () => {
    const entries = collectSetAsideEntries({ doctorBlockedIds: blockedMap(), deploySetAside: deploy });
    assert.deepEqual(entries.map((e) => e.id), ['b-1', 'b-dep', 'b-2', 'deploy']);
    const body = buildSprintPrBody({ verdict: 'ABORTED', branch: 'feat/x', notes: 'n', setAside: entries });
    assert.match(body, /### Set aside this run/);
    assert.match(body, /- b-1: doer on member 'm1' reported BLOCKED on streak \[b-1\]: toolchain missing \(first seen C1 R1\)/);
    assert.match(body, /- deploy: deployer stopped at the deploy\.md Permissions check.*\(first seen C1\)/);
    const plain = buildSprintPrBody({ verdict: 'PASS', branch: 'feat/x', notes: 'n' });
    assert.doesNotMatch(plain, /Set aside this run/);
    assert.equal(buildSprintPrBody({ verdict: 'PASS', branch: 'feat/x', notes: 'n', setAside: [], now: new Date(0) }),
        buildSprintPrBody({ verdict: 'PASS', branch: 'feat/x', notes: 'n', now: new Date(0) }), 'empty set-aside renders byte-identically');
    assert.deepEqual(formatSetAsideItems([]), []);
});

test('sprint analysis: "Set aside this run" section present only when something was set aside', () => {
    const base = {
        targetIssues: ['e'], branch: 'b', baseBranch: 'main', cyclesRun: 1,
        closedCountHistory: [1], highWaterClosedCount: 1,
        deployFailures: [], integFailures: [], rejectedNewTasks: [],
        finalVerdictResult: { verdict: 'FAIL', notes: '' }, finalClosedCount: 1, finalOpenAtGoalCount: 1,
    };
    const withAside = buildAnalysisText({ ...base, setAside: collectSetAsideEntries({ doctorBlockedIds: blockedMap() }) });
    assert.match(withAside, /## Set aside this run\n\n- b-1: .*\(first seen C1 R1\)/);
    assert.doesNotMatch(buildAnalysisText(base), /Set aside this run/);
});
