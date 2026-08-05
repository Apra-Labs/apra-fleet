import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    computeLaneEffort,
    splitLaneByEffort,
    estimateTaskContextTokens,
    estimateLaneContextTokens,
    DEFAULT_EFFORT_THRESHOLD,
    DEFAULT_CONTEXT_CEILING,
    BYTES_PER_TOKEN,
} from '../fleet-sprint/runner.js';

// =============================================================================
// apra-fleet-eft.77.2 -- unit coverage for the predicted-context-size
// estimator (apra-fleet-eft.77.1), wired in behind the SAME splitLaneByEffort
// seam as the effort-point formula (apra-fleet-eft.76.1/76.7). Proves:
//   1. a lane whose predicted context exceeds DEFAULT_CONTEXT_CEILING splits
//      even though its effort-point total sits comfortably under
//      DEFAULT_EFFORT_THRESHOLD -- i.e. the context estimate, not the point
//      formula, drove the split decision when an estimate is computable for
//      every task in the lane;
//   2. when no estimate is computable (no file sizes, no telemetry) the
//      function falls back to the pre-existing effort-point formula and
//      reproduces the exact prior behavior (effort-point-split.test.mjs's
//      over-threshold scenario, unchanged).
// =============================================================================

const task = (id, size, model, files) => ({ id, size, model, ...(files ? { files } : {}) });

// -- estimateTaskContextTokens / estimateLaneContextTokens -------------------

test('estimateTaskContextTokens: null when neither file sizes nor telemetry are known for the task', () => {
    const t = task('a', 'S', 'cheap');
    assert.equal(estimateTaskContextTokens(t), null);
    assert.equal(estimateTaskContextTokens(t, { fileSizes: {}, telemetry: {} }), null);
});

test('estimateTaskContextTokens: sums named-file bytes (via BYTES_PER_TOKEN) plus the size:model telemetry bucket', () => {
    const t = task('a', 'S', 'cheap', ['a.js']);
    const fileSizes = { 'a.js': 4 * BYTES_PER_TOKEN };
    const telemetry = { 'S:cheap': 100 };
    assert.equal(estimateTaskContextTokens(t, { fileSizes, telemetry }), 4 + 100);
});

test('estimateLaneContextTokens: null if ANY task in the lane has no computable estimate', () => {
    const tasks = [task('a', 'S', 'cheap', ['a.js']), task('b', 'S', 'cheap')];
    const fileSizes = { 'a.js': 400 };
    // 'b' has no files and no telemetry bucket entry -> whole-lane estimate is null.
    assert.equal(estimateLaneContextTokens(tasks, { fileSizes }), null);
});

// -- splitLaneByEffort: oversized predicted-context lane splits where the
// point formula alone would not -----------------------------------------------

test('splitLaneByEffort: an oversized predicted-context lane splits even though its effort-point total is under threshold', () => {
    // Two cheap/S tasks: effort = (1+1) x 1 = 2, far under
    // DEFAULT_EFFORT_THRESHOLD (200) -- the point formula alone would never
    // split this lane.
    const tasks = [task('a', 'S', 'cheap'), task('b', 'S', 'cheap')];
    assert.ok(computeLaneEffort(tasks) <= DEFAULT_EFFORT_THRESHOLD, 'sanity: effort points are under threshold');

    // Sanity check: with no fileSizes/telemetry supplied, no estimate is
    // computable, so the fallback (effort-point) path applies and the lane
    // is NOT split.
    const noEstimateResult = splitLaneByEffort(tasks);
    assert.deepEqual(noEstimateResult.map((lane) => lane.map((t) => t.id)), [['a', 'b']]);

    // Historical telemetry (as would be recorded via `bd remember`) puts
    // each S:cheap task's predicted context comfortably over half the
    // ceiling, so the pair together exceeds DEFAULT_CONTEXT_CEILING
    // (150000) even though every task has a computable estimate.
    const telemetry = { 'S:cheap': 100000 };
    const result = splitLaneByEffort(tasks, { telemetry });
    const ids = result.map((lane) => lane.map((t) => t.id));
    assert.deepEqual(ids, [['a'], ['b']], `expected the context estimate to split the lane, got: ${JSON.stringify(ids)}`);

    // Each sub-lane's predicted context fits under the ceiling; the whole
    // (unsplit) lane would not have.
    for (const lane of result) {
        const est = estimateLaneContextTokens(lane, { telemetry });
        assert.ok(est <= DEFAULT_CONTEXT_CEILING, `sub-lane ${JSON.stringify(lane.map((t) => t.id))} should fit under the context ceiling`);
    }
    assert.ok(
        estimateLaneContextTokens(tasks, { telemetry }) > DEFAULT_CONTEXT_CEILING,
        'sanity: the whole unsplit lane exceeds the context ceiling',
    );

    // Lossless, order-preserving partition.
    assert.deepEqual(result.flat().map((t) => t.id), tasks.map((t) => t.id));
});

test('splitLaneByEffort: file-size-driven context estimates alone can also trigger a split under threshold', () => {
    const tasks = [task('a', 'S', 'cheap', ['big-a.txt']), task('b', 'S', 'cheap', ['big-b.txt'])];
    assert.ok(computeLaneEffort(tasks) <= DEFAULT_EFFORT_THRESHOLD, 'sanity: effort points are under threshold');

    const fileSizes = {
        'big-a.txt': 100000 * BYTES_PER_TOKEN,
        'big-b.txt': 100000 * BYTES_PER_TOKEN,
    };
    const result = splitLaneByEffort(tasks, { fileSizes });
    assert.deepEqual(result.map((lane) => lane.map((t) => t.id)), [['a'], ['b']]);
});

// -- splitLaneByEffort: no-estimate case falls back to the point formula,
// matching prior (effort-point-split.test.mjs) behavior exactly -------------

test('splitLaneByEffort: with no fileSizes/telemetry, the fallback path reproduces the pre-existing effort-point split exactly', () => {
    // Identical scenario/expectation to effort-point-split.test.mjs's
    // "an over-threshold premium lane splits at a blocks-boundary" case --
    // proving the context-estimate seam did not change fallback behavior.
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

    for (const lane of result) {
        assert.ok(computeLaneEffort(lane) <= DEFAULT_EFFORT_THRESHOLD, `sub-lane ${JSON.stringify(lane.map((t) => t.id))} should fit under threshold`);
    }
    assert.deepEqual(result.flat().map((t) => t.id), tasks.map((t) => t.id));
});

test('splitLaneByEffort: a partial estimate (only some tasks have files/telemetry) also falls back to the point formula', () => {
    // 'a' has a file-size estimate but 'b' has neither files nor a telemetry
    // bucket entry -- estimateLaneContextTokens is null for the whole lane,
    // so the split decision must fall back to computeLaneEffort rather than
    // silently treating 'b' as zero-cost.
    const tasks = [task('a', 'S', 'cheap', ['a.js']), task('b', 'S', 'cheap')];
    const fileSizes = { 'a.js': 100000 * BYTES_PER_TOKEN };
    assert.equal(estimateLaneContextTokens(tasks, { fileSizes }), null);

    const result = splitLaneByEffort(tasks, { fileSizes });
    // effort = (1+1) x 1 = 2 <= 200 -> fallback path does not split.
    assert.deepEqual(result.map((lane) => lane.map((t) => t.id)), [['a', 'b']]);
});
