import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    computeLaneEffort,
    splitLaneByEffort,
    SIZE_POINTS,
    MODEL_WEIGHT,
    DEFAULT_EFFORT_THRESHOLD,
} from '../fleet-sprint/runner.js';

// =============================================================================
// apra-fleet-eft.76.7 -- unit coverage for the planner.md "effort-point
// splitting math" (apra-fleet-eft.76.1): effort = (sum of size points) x
// (max model weight in the lane); a lane over the threshold constant
// (default 200) splits at a blocks-edge boundary (a contiguous
// prefix/suffix cut, never mid-lane); mutex-resource members are NEVER
// separated across the split, even when honoring that leaves a sub-lane
// over threshold.
// =============================================================================

const task = (id, size, model) => ({ id, size, model });

// -- SIZE_POINTS / MODEL_WEIGHT / DEFAULT_EFFORT_THRESHOLD constants --------

test('constants match the planner.md-documented values', () => {
    assert.deepEqual(SIZE_POINTS, { S: 1, M: 2, L: 4 });
    assert.deepEqual(MODEL_WEIGHT, { cheap: 1, standard: 10, premium: 20 });
    assert.equal(DEFAULT_EFFORT_THRESHOLD, 200);
});

// -- computeLaneEffort -------------------------------------------------------

test('computeLaneEffort: S+M+L at premium = (1+2+4) x 20 = 140', () => {
    const tasks = [task('a', 'S', 'premium'), task('b', 'M', 'premium'), task('c', 'L', 'premium')];
    assert.equal(computeLaneEffort(tasks), 140);
});

test('computeLaneEffort: uses the MAX model weight across the lane, not a sum of weights', () => {
    // Mixed tiers in one lane: weight is max(cheap=1, premium=20) = 20, not 1+20.
    const tasks = [task('a', 'S', 'cheap'), task('b', 'S', 'premium')];
    assert.equal(computeLaneEffort(tasks), (1 + 1) * 20);
});

test('computeLaneEffort: empty lane has zero effort', () => {
    assert.equal(computeLaneEffort([]), 0);
});

// -- splitLaneByEffort: no split needed --------------------------------------

test('splitLaneByEffort: a lane under threshold is returned as a single sub-lane, unsplit', () => {
    const tasks = [task('a', 'S', 'premium'), task('b', 'M', 'premium'), task('c', 'L', 'premium')];
    // effort = 140 <= 200 -> no split.
    const result = splitLaneByEffort(tasks);
    assert.deepEqual(result.map((lane) => lane.map((t) => t.id)), [['a', 'b', 'c']]);
});

// -- splitLaneByEffort: S+M+L(x3) premium lane over threshold splits at a
// blocks boundary (a contiguous prefix/suffix cut) ---------------------------

test('splitLaneByEffort: an over-threshold premium lane splits at a blocks-boundary into contiguous sub-lanes', () => {
    // S(1) + M(2) + L(4) + L(4) + L(4) = 15 size points at premium (x20):
    //   [S,M,L1]      -> effort 140  (<=200, adding L2 would tip to 220)
    //   [L2,L3]       -> effort 160  (<=200)
    const tasks = [
        task('s', 'S', 'premium'),
        task('m', 'M', 'premium'),
        task('l1', 'L', 'premium'),
        task('l2', 'L', 'premium'),
        task('l3', 'L', 'premium'),
    ];
    const result = splitLaneByEffort(tasks);
    const ids = result.map((lane) => lane.map((t) => t.id));
    assert.deepEqual(ids, [['s', 'm', 'l1'], ['l2', 'l3']]);

    // Every sub-lane fits under threshold in this (no-mutex) scenario.
    for (const lane of result) {
        assert.ok(computeLaneEffort(lane) <= DEFAULT_EFFORT_THRESHOLD, `sub-lane ${JSON.stringify(lane.map((t) => t.id))} should fit under threshold`);
    }

    // The split is a contiguous prefix/suffix partition: concatenating the
    // sub-lanes, in order, reproduces the original ordered task list exactly
    // -- never a reordered or arbitrary mid-lane cut.
    assert.deepEqual(result.flat().map((t) => t.id), tasks.map((t) => t.id));
});

// -- splitLaneByEffort: mutex-resource members are never separated, even at
// the cost of leaving a sub-lane over threshold (submodule-pointer scenario
// pinned, per planner.md and apra-fleet-eft.76's motivating incident: run 23
// C1 R1 split two beads bumping the same vendor submodule pointer into
// separate streaks -- a silent-overwrite hazard) -------------------------

test('splitLaneByEffort: mutex-resource members (e.g. the same submodule pointer) are never separated, even over threshold', () => {
    // Same 5-task lane as above, but 'l1' and 'l2' both bump the SAME
    // submodule pointer (the mutex resource pinned in apra-fleet-eft.76's
    // motivating incident) -- they must never land in different sub-lanes,
    // even though keeping them together pushes their sub-lane to 220 > 200.
    const tasks = [
        task('s', 'S', 'premium'),
        task('m', 'M', 'premium'),
        task('l1', 'L', 'premium'),
        task('l2', 'L', 'premium'),
        task('l3', 'L', 'premium'),
    ];
    const result = splitLaneByEffort(tasks, { mutexGroups: [['l1', 'l2']] });
    const ids = result.map((lane) => lane.map((t) => t.id));

    // l1 and l2 land in the SAME sub-lane...
    const laneOf = (id) => ids.findIndex((lane) => lane.includes(id));
    assert.equal(laneOf('l1'), laneOf('l2'), `mutex-paired 'l1'/'l2' must never be split across sub-lanes, got: ${JSON.stringify(ids)}`);

    // ...specifically [s, m, l1, l2] (contiguous prefix), THEN a split
    // before l3 (which shares no mutex group with l2).
    assert.deepEqual(ids, [['s', 'm', 'l1', 'l2'], ['l3']]);

    // The mutex-bearing sub-lane is genuinely OVER threshold (220 > 200) --
    // proving the split honored the mutex constraint rather than silently
    // finding some other cut that happened to stay under threshold.
    const mutexLane = result[0];
    assert.ok(computeLaneEffort(mutexLane) > DEFAULT_EFFORT_THRESHOLD, `expected the mutex-paired sub-lane to exceed threshold (${computeLaneEffort(mutexLane)} should be > ${DEFAULT_EFFORT_THRESHOLD})`);

    // Still a contiguous, order-preserving, lossless partition.
    assert.deepEqual(result.flat().map((t) => t.id), tasks.map((t) => t.id));
});

test('splitLaneByEffort: a custom threshold is honored', () => {
    const tasks = [task('a', 'S', 'cheap'), task('b', 'S', 'cheap'), task('c', 'S', 'cheap')];
    // effort per task at cheap = 1 point; with threshold=2, split after
    // every 2 tasks (no mutex pins).
    const result = splitLaneByEffort(tasks, { threshold: 2 });
    assert.deepEqual(result.map((lane) => lane.map((t) => t.id)), [['a', 'b'], ['c']]);
});

test('splitLaneByEffort: empty input returns an empty array', () => {
    assert.deepEqual(splitLaneByEffort([]), []);
});

test('splitLaneByEffort: a single oversized task is still returned alone (never dropped)', () => {
    const tasks = [task('solo', 'L', 'premium')];
    // effort = 4 x 20 = 80, under default threshold -- but even if it were
    // over, a lone task can never be split further.
    const result = splitLaneByEffort(tasks, { threshold: 1 });
    assert.deepEqual(result.map((lane) => lane.map((t) => t.id)), [['solo']]);
});
