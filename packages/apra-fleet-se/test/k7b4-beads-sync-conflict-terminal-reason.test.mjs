import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    findDoltDivergedCause,
    resolveTerminalReason,
    captureDoltConflictDump,
} from '../fleet-sprint/runner.js';
import { DoltDivergedError, PostDispatchSyncError, DoltSyncError, StalledSprintError } from '../fleet-sprint/errors.mjs';

// =============================================================================
// apra-fleet-k7b.4 -- unit tests for classifying an unmergeable Dolt conflict
// as its own terminal state (BEADS_SYNC_CONFLICT), not the generic wrapper/
// UNKNOWN bucket, and for the best-effort conflict-diagnostics carry-forward.
// See main()'s typed-abort catch (runner.js) for the production wiring --
// the apra-fleet-k7b.8 integration test covers that end to end; this suite
// is scoped to the pure classifier/extractor functions themselves.
// =============================================================================

describe('apra-fleet-k7b.4: findDoltDivergedCause()', () => {
    test('finds a bare DoltDivergedError (a pre-dispatch D-pull divergence, no wrapper)', () => {
        const err = new DoltDivergedError('D-pull diverged', { member: 'alice', doltOutput: 'raw dolt output', operation: 'pull' });
        const found = findDoltDivergedCause(err);
        assert.equal(found, err);
    });

    test('unwraps a DoltDivergedError wrapped one level down inside a PostDispatchSyncError (the live apra-fleet-bnb D-push incident shape)', () => {
        const diverged = new DoltDivergedError('D-push still rejected after reconcile', { member: 'bob', doltOutput: 'updates were rejected', operation: 'push' });
        const wrapped = new PostDispatchSyncError('post-dispatch sync failed', { member: 'bob', cause: diverged });
        const found = findDoltDivergedCause(wrapped);
        assert.equal(found, diverged);
    });

    test('returns null for an error with no DoltDivergedError anywhere in its cause chain', () => {
        assert.equal(findDoltDivergedCause(new DoltSyncError('transient failure')), null);
        assert.equal(findDoltDivergedCause(new PostDispatchSyncError('wraps something else', { cause: new Error('boom') })), null);
        assert.equal(findDoltDivergedCause(new Error('plain error')), null);
        assert.equal(findDoltDivergedCause(null), null);
        assert.equal(findDoltDivergedCause(undefined), null);
    });

    test('never loops forever on a pathological circular cause', () => {
        const a = new Error('a');
        const b = new Error('b');
        a.cause = b;
        b.cause = a; // circular
        assert.doesNotThrow(() => findDoltDivergedCause(a));
        assert.equal(findDoltDivergedCause(a), null);
    });
});

describe('apra-fleet-k7b.4: resolveTerminalReason()', () => {
    test('a bare DOLT_DIVERGED error resolves to BEADS_SYNC_CONFLICT, not its own DOLT_DIVERGED code', () => {
        const err = new DoltDivergedError('diverged', { member: 'alice', doltOutput: 'conflict', operation: 'pull' });
        assert.equal(resolveTerminalReason(err), 'BEADS_SYNC_CONFLICT');
    });

    test('a POST_DISPATCH_SYNC_FAILED wrapping a DOLT_DIVERGED cause resolves to BEADS_SYNC_CONFLICT, not the generic wrapper code', () => {
        const diverged = new DoltDivergedError('D-push still rejected', { member: 'bob', doltOutput: 'updates were rejected', operation: 'push' });
        const wrapped = new PostDispatchSyncError('post-dispatch sync failed', { member: 'bob', cause: diverged });
        assert.equal(wrapped.code, 'POST_DISPATCH_SYNC_FAILED');
        assert.equal(resolveTerminalReason(wrapped), 'BEADS_SYNC_CONFLICT');
    });

    test('a POST_DISPATCH_SYNC_FAILED wrapping a NON-diverged cause keeps today\'s behavior (its own code)', () => {
        const wrapped = new PostDispatchSyncError('post-dispatch sync failed', { member: 'bob', cause: new Error('credentials missing') });
        assert.equal(resolveTerminalReason(wrapped), 'POST_DISPATCH_SYNC_FAILED');
    });

    test('every other typed error keeps the pre-k7b.4 err.code || err.name behavior unchanged', () => {
        assert.equal(resolveTerminalReason(new StalledSprintError('stalled')), 'SPRINT_STALLED');
        const named = new TypeError('bad args');
        named.code = undefined;
        assert.equal(resolveTerminalReason(named), 'TypeError');
    });

    test('falls back to UNKNOWN_ABORT for a nullish/codeless/nameless error', () => {
        assert.equal(resolveTerminalReason(null), 'UNKNOWN_ABORT');
        assert.equal(resolveTerminalReason(undefined), 'UNKNOWN_ABORT');
    });
});

describe('apra-fleet-k7b.4: captureDoltConflictDump()', () => {
    test('extracts member/operation/doltOutput verbatim from a bare DoltDivergedError', () => {
        const err = new DoltDivergedError('diverged', { member: 'alice', doltOutput: 'raw dolt conflict output here', operation: 'push' });
        assert.deepEqual(captureDoltConflictDump(err), { member: 'alice', operation: 'push', doltOutput: 'raw dolt conflict output here' });
    });

    test('extracts from the unwrapped DoltDivergedError cause inside a PostDispatchSyncError', () => {
        const diverged = new DoltDivergedError('D-push still rejected after reconcile', { member: 'carol', doltOutput: 'still rejected: [rejected] main -> main (non-fast-forward)', operation: 'push' });
        const wrapped = new PostDispatchSyncError('post-dispatch sync failed', { member: 'carol', cause: diverged });
        assert.deepEqual(captureDoltConflictDump(wrapped), { member: 'carol', operation: 'push', doltOutput: 'still rejected: [rejected] main -> main (non-fast-forward)' });
    });

    test('returns null (never throws) for a non-diverged error', () => {
        assert.equal(captureDoltConflictDump(new DoltSyncError('transient')), null);
        assert.equal(captureDoltConflictDump(new Error('plain')), null);
        assert.equal(captureDoltConflictDump(null), null);
    });
});
