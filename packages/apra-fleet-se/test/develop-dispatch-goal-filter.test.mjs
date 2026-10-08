import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { partitionReadyByGoal, formatBelowGoalExclusionLog } from '../fleet-sprint/beads-scope.mjs';

// =============================================================================
// Develop dispatch excludes below-goal beads unless they serve in-goal work.
//
// Live failure this pins: a P3 streak was dispatched in round 1 of a P1/P2
// sprint, ahead of P1/P2 beads, because the develop loop's ready set had no
// goal filter at all -- priority only ORDERED streaks.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOAL = 'P1/P2';

// bd list --json dependency shape: the DEPENDENT bead lists what it depends on.
const blockedBy = (issueId, dependsOnId) => ({ issue_id: issueId, depends_on_id: dependsOnId, type: 'blocks' });
const childOf = (issueId, parentId) => ({ issue_id: issueId, depends_on_id: parentId, type: 'parent-child' });

function scenario() {
    const epic = { id: 'epic', priority: 1, status: 'open', issue_type: 'epic' };
    const p1 = { id: 'p1-task', priority: 1, status: 'open', parent: 'epic', dependencies: [childOf('p1-task', 'epic')] };
    const p1Blocked = {
        id: 'p1-blocked', priority: 1, status: 'open', parent: 'epic',
        dependencies: [childOf('p1-blocked', 'epic'), blockedBy('p1-blocked', 'p3-blocker')],
    };
    const p3Blocker = { id: 'p3-blocker', priority: 3, status: 'open', parent: 'epic', dependencies: [childOf('p3-blocker', 'epic')] };
    const p3Unrelated = { id: 'p3-unrelated', priority: 3, status: 'open', parent: 'epic', dependencies: [childOf('p3-unrelated', 'epic')] };
    const noPriority = { id: 'no-priority', status: 'open', parent: 'epic' };
    const scope = [epic, p1, p1Blocked, p3Blocker, p3Unrelated, noPriority];
    // bd --ready: p1-blocked is NOT ready (its blocker is open).
    const ready = [p1, p3Blocker, p3Unrelated, noPriority];
    return { scope, ready };
}

const ids = (beads) => beads.map((b) => b.id).sort();

describe('partitionReadyByGoal', () => {
    test('a ready P3 leaf with no blocks edge to in-goal work is excluded; the log names it as excluded below goal', () => {
        const { scope, ready } = scenario();
        const { dispatchable, excluded } = partitionReadyByGoal(ready, scope, GOAL);
        assert.ok(!ids(dispatchable).includes('p3-unrelated'));
        assert.deepEqual(excluded, [{ id: 'p3-unrelated', priority: 3 }]);
        const line = formatBelowGoalExclusionLog(excluded, GOAL);
        assert.match(line, /EXCLUDED p3-unrelated \(P3\)/);
        assert.match(line, /excluded as below goal, not dispatched/);
        assert.match(line, /P1\/P2/);
    });

    test('a ready P3 leaf that blocks an open P1 bead is dispatched', () => {
        const { scope, ready } = scenario();
        const { dispatchable } = partitionReadyByGoal(ready, scope, GOAL);
        assert.ok(ids(dispatchable).includes('p3-blocker'));
    });

    test('the blocks exemption is transitive: P3 -> P3 -> P1', () => {
        const scope = [
            { id: 'p1', priority: 1, status: 'open', dependencies: [blockedBy('p1', 'mid')] },
            { id: 'mid', priority: 3, status: 'open', dependencies: [blockedBy('mid', 'root')] },
            { id: 'root', priority: 3, status: 'open' },
        ];
        const { dispatchable } = partitionReadyByGoal([scope[2]], scope, GOAL);
        assert.deepEqual(ids(dispatchable), ['root']);
    });

    test('blocking only a CLOSED in-goal bead does not keep a P3 bead in', () => {
        const scope = [
            { id: 'p1-done', priority: 1, status: 'closed', dependencies: [blockedBy('p1-done', 'p3')] },
            { id: 'p3', priority: 3, status: 'open' },
        ];
        assert.deepEqual(partitionReadyByGoal([scope[1]], scope, GOAL).excluded, [{ id: 'p3', priority: 3 }]);
    });

    test("bd show's dependency_type shape is honoured too", () => {
        const scope = [
            { id: 'p2', priority: 2, status: 'open', dependencies: [{ id: 'p3', dependency_type: 'blocks' }] },
            { id: 'p3', priority: 3, status: 'open' },
        ];
        assert.deepEqual(ids(partitionReadyByGoal([scope[1]], scope, GOAL).dispatchable), ['p3']);
    });

    test('a below-goal bead the sprint already worked on (reviewer reopen under the worked-on exemption) is dispatched', () => {
        const { scope, ready } = scenario();
        const { dispatchable, excluded } = partitionReadyByGoal(ready, scope, GOAL, { workedOnIds: new Set(['p3-unrelated']) });
        assert.ok(ids(dispatchable).includes('p3-unrelated'));
        assert.deepEqual(excluded, []);
    });

    test('REGRESSION: a bead with no numeric priority is never excluded (partitionByGoalMembership semantics)', () => {
        const { scope, ready } = scenario();
        assert.ok(ids(partitionReadyByGoal(ready, scope, GOAL).dispatchable).includes('no-priority'));
        const odd = [{ id: 'nan', priority: Number.NaN, status: 'open' }, { id: 'str', priority: '3', status: 'open' }];
        assert.deepEqual(ids(partitionReadyByGoal(odd, odd, GOAL).dispatchable), ['nan', 'str']);
    });

    test('in-goal beads, including one exactly at the goal max, always pass', () => {
        const beads = [{ id: 'a', priority: 1, status: 'open' }, { id: 'b', priority: 2, status: 'open' }];
        assert.deepEqual(ids(partitionReadyByGoal(beads, beads, GOAL).dispatchable), ['a', 'b']);
        assert.deepEqual(ids(partitionReadyByGoal(beads, beads, 'P1').dispatchable), ['a'], 'a P1-only goal excludes P2');
    });
});

describe('runner.js develop loop uses the goal-filtered ready set', () => {
    const SRC = fs.readFileSync(path.join(__dirname, '../fleet-sprint/runner.js'), 'utf8');

    test('dispatchableReadyLeafBeads filters through partitionReadyByGoal with the worked-on set and logs exclusions', () => {
        const at = SRC.indexOf('async function dispatchableReadyLeafBeads()');
        assert.ok(at > 0);
        const body = SRC.slice(at, SRC.indexOf('\n    }\n', at));
        assert.match(body, /partitionReadyByGoal\(ready, scopeAll, validated\.goal, \{ workedOnIds: workedOnBeadIds \}\)/);
        assert.match(body, /log\(formatBelowGoalExclusionLog\(/);
        assert.ok(SRC.indexOf('const workedOnBeadIds = new Set();') < at, 'the worked-on set must be declared before the filter that reads it');
    });

    test('every develop-loop readiness read goes through the filter', () => {
        for (const site of [
            'let readyBeads = (await dispatchableReadyLeafBeads())',
            'readyBeads = (await dispatchableReadyLeafBeads())',
            'const currentReadyAll = (await dispatchableReadyLeafBeads())',
            'const stillOpen = await dispatchableReadyLeafBeads();',
        ]) {
            assert.ok(SRC.includes(site), `missing filtered read: ${site}`);
        }
        assert.ok(!/const (currentReadyAll|stillOpen) = \(?await readyLeafBeads\(\)/.test(SRC),
            'the round loop must not read the unfiltered ready set');
    });
});
