import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    computeLaneEffort,
    SIZE_POINTS,
    MODEL_WEIGHT,
    DEFAULT_EFFORT_THRESHOLD,
} from '../fleet-sprint/runner.js';

// Unit coverage for the planner.md effort-point formula:
// effort = (sum of size points) x (max model weight in the lane).

const task = (id, size, model) => ({ id, size, model });

test('constants match the planner.md-documented values', () => {
    assert.deepEqual(SIZE_POINTS, { S: 1, M: 2, L: 4 });
    assert.deepEqual(MODEL_WEIGHT, { cheap: 1, standard: 10, premium: 20 });
    assert.equal(DEFAULT_EFFORT_THRESHOLD, 200);
});

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
