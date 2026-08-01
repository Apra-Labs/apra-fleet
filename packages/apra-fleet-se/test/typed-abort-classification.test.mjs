import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isTypedAbortError, isTerminalSprintFailure, isNoMutationDispatchFailure } from '../fleet-sprint/runner.js';
import {
    SprintPlanRejectedError,
    StalledSprintError,
    ReviewerContractViolationError,
    GitDivergedError,
    GitSyncError,
    DoltDivergedError,
    DoltSyncError,
    PostDispatchSyncError,
    SprintLockHeldError,
} from '../fleet-sprint/errors.mjs';
import {
    AgentOutputError,
    AgentDispatchError,
    FleetTransportError,
    CommandError,
    BudgetExceededError,
    CancelledError,
} from '@apralabs/apra-fleet-workflow';

// apra-fleet-9ta.1: isTypedAbortError() used to return true for ANY
// WorkflowError subclass, which swept every routine sync/dispatch failure into
// main()'s typed-abort path and reported it as `verdict: 'ABORTED'`. It is now
// a curated class list. This file is that predicate's own truth table, written
// as one explicit assertion per class (deliberately NOT a loop over an array)
// so the enumerated membership is readable straight off the file. The broader
// per-caller routing table is apra-fleet-9ta.7's, not this file's.

describe('apra-fleet-9ta.1: isTypedAbortError() -- TRUE for the curated abort set', () => {
    test('StalledSprintError -- the runner throws it itself', () => {
        assert.equal(isTypedAbortError(new StalledSprintError('no progress')), true);
    });

    test('SprintPlanRejectedError', () => {
        assert.equal(isTypedAbortError(new SprintPlanRejectedError('plan rejected')), true);
    });

    test('ReviewerContractViolationError', () => {
        assert.equal(isTypedAbortError(new ReviewerContractViolationError('reviewer broke contract')), true);
    });

    test('BudgetExceededError -- thrown by the workflow package on the runner behalf', () => {
        assert.equal(isTypedAbortError(new BudgetExceededError('spend ceiling blown')), true);
    });

    test('GitDivergedError -- the single-writer invariant is violated, no phase can recover', () => {
        assert.equal(isTypedAbortError(new GitDivergedError('branch diverged from origin')), true);
    });

    test('DoltDivergedError, bare (a pre-dispatch D-pull divergence)', () => {
        const err = new DoltDivergedError('D-pull diverged', { member: 'alice', doltOutput: 'conflict', operation: 'pull' });
        assert.equal(isTypedAbortError(err), true);
    });

    test('DoltDivergedError wrapped one level down inside a PostDispatchSyncError (the live D-push shape)', () => {
        const diverged = new DoltDivergedError('D-push still rejected after reconcile', {
            member: 'bob', doltOutput: 'updates were rejected', operation: 'push',
        });
        assert.equal(isTypedAbortError(new PostDispatchSyncError('post-dispatch sync failed', { member: 'bob', cause: diverged })), true);
    });

    test('a plain Error carrying the stable pre-sprint validation prefix', () => {
        assert.equal(isTypedAbortError(new Error("Pre-sprint validation failed: No ready beads found for scope 'x'.")), true);
    });
});

describe('apra-fleet-9ta.1: isTypedAbortError() -- FALSE for every other class', () => {
    test('AgentOutputError', () => {
        assert.equal(isTypedAbortError(new AgentOutputError('schema repair exhausted')), false);
    });

    test('AgentDispatchError', () => {
        assert.equal(isTypedAbortError(new AgentDispatchError('dispatch failed')), false);
    });

    test('AgentDispatchError with reason max_turns_exhausted', () => {
        assert.equal(isTypedAbortError(new AgentDispatchError('out of turns', { details: { reason: 'max_turns_exhausted' } })), false);
    });

    test('FleetTransportError', () => {
        assert.equal(isTypedAbortError(new FleetTransportError('transport down')), false);
    });

    test('CommandError', () => {
        assert.equal(isTypedAbortError(new CommandError('bd list exited 1')), false);
    });

    test('GitSyncError -- a transient sync failure, not a sprint abort', () => {
        assert.equal(isTypedAbortError(new GitSyncError('push failed')), false);
    });

    test('DoltSyncError -- a transient sync failure, not a sprint abort', () => {
        assert.equal(isTypedAbortError(new DoltSyncError('dolt push failed')), false);
    });

    test('PostDispatchSyncError with NO divergence anywhere in its cause chain', () => {
        assert.equal(isTypedAbortError(new PostDispatchSyncError('post-dispatch sync failed', { cause: new Error('credentials missing') })), false);
    });

    test('PostDispatchSyncError with no cause at all', () => {
        assert.equal(isTypedAbortError(new PostDispatchSyncError('post-dispatch sync failed')), false);
    });

    test('SprintLockHeldError -- structurally unreachable (thrown before main() try block), and never an abort of OUR sprint', () => {
        assert.equal(isTypedAbortError(new SprintLockHeldError('lock held', { branch: 'b', members: ['local'], existingPid: 1 })), false);
    });

    test('CancelledError -- a requested shutdown keeps its own cancelled status path', () => {
        assert.equal(isTypedAbortError(new CancelledError('stopped')), false);
    });

    test('a plain Error with no pre-sprint validation prefix', () => {
        assert.equal(isTypedAbortError(new Error('boom')), false);
    });

    test('null / undefined', () => {
        assert.equal(isTypedAbortError(null), false);
        assert.equal(isTypedAbortError(undefined), false);
    });
});

// main()'s terminal run-state record is gated on the BROADER
// isTerminalSprintFailure(), not on isTypedAbortError() -- the watchdog needs a
// reason for every terminal typed failure (else it reports CRASHED), while only
// a genuine abort earns finalizeAbort()'s push + [ABORTED] PR.
describe('apra-fleet-9ta.1: isTerminalSprintFailure() -- broader than the abort set', () => {
    test('true for a typed abort (StalledSprintError)', () => {
        assert.equal(isTerminalSprintFailure(new StalledSprintError('no progress')), true);
    });

    test('true for a dispatch-channel failure that is NOT an abort (AgentDispatchError, e.g. a dead interactive session)', () => {
        assert.equal(isTerminalSprintFailure(new AgentDispatchError('dispatch_failed')), true);
        assert.equal(isTypedAbortError(new AgentDispatchError('dispatch_failed')), false);
    });

    test('true for the sync classes that are no longer aborts', () => {
        assert.equal(isTerminalSprintFailure(new GitSyncError('push failed')), true);
        assert.equal(isTerminalSprintFailure(new DoltSyncError('dolt push failed')), true);
        assert.equal(isTerminalSprintFailure(new PostDispatchSyncError('sync failed', { cause: new Error('creds') })), true);
        assert.equal(isTerminalSprintFailure(new AgentOutputError('schema repair exhausted')), true);
        assert.equal(isTerminalSprintFailure(new CommandError('bd list exited 1')), true);
    });

    test('true for a pre-sprint validation failure (a plain Error, but a typed abort)', () => {
        assert.equal(isTerminalSprintFailure(new Error("Pre-sprint validation failed: No ready beads found for scope 'x'.")), true);
    });

    test('false for CancelledError -- a cooperative shutdown keeps its own path', () => {
        assert.equal(isTerminalSprintFailure(new CancelledError('stopped')), false);
    });

    test('false for an untyped Error/TypeError -- a real bug still reports CRASHED, unchanged', () => {
        assert.equal(isTerminalSprintFailure(new Error('boom')), false);
        assert.equal(isTerminalSprintFailure(new TypeError('x is not a function')), false);
    });

    test('false for null / undefined', () => {
        assert.equal(isTerminalSprintFailure(null), false);
        assert.equal(isTerminalSprintFailure(undefined), false);
    });
});

// The narrowing above also narrows isNoMutationDispatchFailure(), whose third
// disjunct is isTypedAbortError(). Pinned here only where the two predicates
// meet; the disjunct cleanup itself is apra-fleet-9ta.2's.
describe('apra-fleet-9ta.1: isNoMutationDispatchFailure() knock-on', () => {
    test('still true for the dispatch-channel failures it names directly', () => {
        assert.equal(isNoMutationDispatchFailure(new AgentDispatchError('dispatch failed')), true);
        assert.equal(isNoMutationDispatchFailure(new FleetTransportError('transport down')), true);
    });

    test('still false for max_turns_exhausted -- the agent ran and may have committed work', () => {
        assert.equal(isNoMutationDispatchFailure(new AgentDispatchError('out of turns', { details: { reason: 'max_turns_exhausted' } })), false);
    });

    test('now false for the sync classes, so their post-dispatch teardown is no longer skipped', () => {
        assert.equal(isNoMutationDispatchFailure(new GitSyncError('push failed')), false);
        assert.equal(isNoMutationDispatchFailure(new DoltSyncError('dolt push failed')), false);
        assert.equal(isNoMutationDispatchFailure(new PostDispatchSyncError('sync failed', { cause: new Error('creds') })), false);
    });
});
