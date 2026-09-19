import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    computeLaneEffort,
    SIZE_POINTS,
    MODEL_WEIGHT,
    DEFAULT_EFFORT_THRESHOLD,
} from '../fleet-sprint/runner.js';

// Unit coverage for the planner.md effort-point formula:
// effort = (sum of size points) x (max model weight in the lane).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const readPrompt = (name) => fs.readFileSync(path.join(PACKAGE_ROOT, 'apra-pm/agents', name), 'utf8');

const task = (id, size, model) => ({ id, size, model });

test('constants match the planner.md-documented values', () => {
    assert.deepEqual(SIZE_POINTS, { S: 1, M: 2, L: 4 });
    assert.deepEqual(MODEL_WEIGHT, { cheap: 1, standard: 10, premium: 20 });
    assert.equal(DEFAULT_EFFORT_THRESHOLD, 200);
});

// planner.md and plan-reviewer.md state the LANE SIZING PARAMETER defaults as
// prose (no shared runtime channel exists yet for the prompt-only batching
// rollout -- see .fleet/sprint-proposals/planner-review-batching-proposal.md
// section 6.1). This pins the three numbers so the two prompts, and the
// runtime effort-threshold constant, cannot silently drift apart.
test('planner.md and plan-reviewer.md state identical laneMaxTasks/laneMaxEffort/laneTargetEffort defaults', () => {
    const planner = readPrompt('planner.md');
    const planReviewer = readPrompt('plan-reviewer.md');

    assert.ok(planner.includes('`laneMaxTasks` (default `6`)'), 'planner.md must state laneMaxTasks default 6');
    assert.ok(planner.includes('`laneMaxEffort` (default `200`)'), 'planner.md must state laneMaxEffort default 200');
    assert.ok(planner.includes('`laneTargetEffort` (default `60`)'), 'planner.md must state laneTargetEffort default 60');

    assert.ok(
        planReviewer.includes('laneMaxTasks=6') && planReviewer.includes('laneMaxEffort=200') && planReviewer.includes('laneTargetEffort=60'),
        'plan-reviewer.md must state the same laneMaxTasks/laneMaxEffort/laneTargetEffort defaults as planner.md',
    );

    // laneMaxEffort is the same knob as the existing runtime effort threshold
    // (the prompt-only rollout does not add a separate runtime constant).
    assert.equal(DEFAULT_EFFORT_THRESHOLD, 200, 'laneMaxEffort default (200) must match DEFAULT_EFFORT_THRESHOLD');
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
