import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { reviewScopeBeadIds } from '../fleet-sprint/phases/review.mjs';

// =============================================================================
// The round's Review scope is built from the beads the engine VERIFIED closed
// (each streak outcome's `closedIds`), not from the streak's overall
// `outcome`. A streak that closed A and B and then stopped (BLOCKED, out of
// turns, crashed) on C is recorded as outcome 'failed' so C re-lanes -- but A
// and B are done, committed and closed in the shared beads DB, and must be
// reviewed against their acceptance criteria in the SAME round.
//
// The exclusions: an outcome flagged `publishBlocked` (a permission-scope
// post-dispatch sync failure) or `postDispatchSyncFailed` (any other
// post-dispatch sync failure -- a failed G-push skips the D-push). Their
// closes never reached the shared beads DB, so none of their beads may enter
// the review scope.
// =============================================================================

describe('reviewScopeBeadIds', () => {
    test('a partially closed failed streak contributes exactly its closed beads', () => {
        const scope = reviewScopeBeadIds([
            { beadIds: ['A', 'B', 'C'], outcome: 'failed', closedIds: ['A', 'B'], unclosedIds: ['C'] },
        ]);
        assert.deepStrictEqual([...scope].sort(), ['A', 'B']);
    });

    test('a fully closed streak is reviewed whatever its outcome label', () => {
        const scope = reviewScopeBeadIds([
            { beadIds: ['A'], outcome: 'success', closedIds: ['A'], unclosedIds: [] },
            { beadIds: ['B'], outcome: 'retried', closedIds: ['B'], unclosedIds: [] },
            { beadIds: ['C', 'D'], outcome: 'failed', closedIds: ['C', 'D'], unclosedIds: [], error: 'transport dropped after the work closed' },
        ]);
        assert.deepStrictEqual([...scope].sort(), ['A', 'B', 'C', 'D']);
    });

    test('a streak that closed nothing contributes nothing', () => {
        assert.deepStrictEqual(reviewScopeBeadIds([
            { beadIds: ['A', 'B'], outcome: 'failed', closedIds: [], unclosedIds: ['A', 'B'] },
        ]), []);
        assert.deepStrictEqual(reviewScopeBeadIds([]), []);
    });

    test('publishBlocked outcomes never enter the scope, even with closedIds', () => {
        const scope = reviewScopeBeadIds([
            { beadIds: ['A', 'B'], outcome: 'failed', closedIds: ['A'], unclosedIds: ['B'], publishBlocked: true },
            { beadIds: ['C'], outcome: 'success', closedIds: ['C'], unclosedIds: [], publishBlocked: true },
            { beadIds: ['D'], outcome: 'success', closedIds: ['D'], unclosedIds: [] },
        ]);
        assert.deepStrictEqual(scope, ['D']);
    });

    test('postDispatchSyncFailed outcomes never enter the scope, even with closedIds', () => {
        const scope = reviewScopeBeadIds([
            { beadIds: ['A', 'B'], outcome: 'failed', closedIds: ['A'], unclosedIds: ['B'], postDispatchSyncFailed: true },
            { beadIds: ['C'], outcome: 'success', closedIds: ['C'], unclosedIds: [], postDispatchSyncFailed: true },
            { beadIds: ['D'], outcome: 'failed', closedIds: ['D'], unclosedIds: ['E'] },
        ]);
        assert.deepStrictEqual(scope, ['D']);
    });

    test('ids are de-duplicated; an outcome without closedIds contributes nothing whatever its label', () => {
        const scope = reviewScopeBeadIds([
            { beadIds: ['A'], outcome: 'success', closedIds: ['A'] },
            { beadIds: ['A'], outcome: 'retried', closedIds: ['A'] },
            { beadIds: ['Z'], outcome: 'success' },
        ]);
        assert.deepStrictEqual(scope, ['A']);
    });
});
