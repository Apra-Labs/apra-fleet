import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isTypedAbortError, isNoMutationDispatchFailure } from '../fleet-sprint/runner.js';
import {
    StalledSprintError,
    SprintPlanRejectedError,
    ReviewerContractViolationError,
    GitSyncError,
    DoltSyncError,
    DoltDivergedError,
    PostDispatchSyncError,
} from '../fleet-sprint/errors.mjs';
import {
    AgentOutputError,
    AgentDispatchError,
    FleetTransportError,
    CommandError,
    BudgetExceededError,
    CancelledError,
} from '@apralabs/apra-fleet-workflow';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-9ta.7 -- the error-classification contract as a single table.
//
// apra-fleet-9ta.1/9ta.2 rewrote isTypedAbortError()/isNoMutationDispatchFailure()
// into curated, per-class predicates (see typed-abort-classification.test.mjs,
// which is that predicate's own enumerated truth table, deliberately written
// as individual asserts rather than a loop). THIS file is the safety net
// apra-fleet-647.1's VCSModule taxonomy will be rebuilt on: a genuinely
// table-driven encoding of the same contract (so a future class added to the
// taxonomy is a one-line row here, not a hand-written test), PLUS at least 3
// end-to-end routing assertions -- via the mock sprint harness -- proving the
// OBSERVABLE behavior each predicate combination actually drives inside
// main()/withGitSync: an abort record (verdict: 'ABORTED' terminal state +
// finalizeAbort's push/PR path), an immediate rethrow with NO terminal-history
// side effects, and the post-dispatch sync teardown either running or being
// skipped.
// =============================================================================

// Row shape: { label, build, isAbort, isNoMutation }
// - `isAbort` is the expected isTypedAbortError() result.
// - `isNoMutation` is the expected isNoMutationDispatchFailure() result.
const ROWS = [
    {
        label: 'StalledSprintError',
        build: () => new StalledSprintError('no progress'),
        isAbort: true,
        isNoMutation: false,
    },
    {
        label: 'SprintPlanRejectedError',
        build: () => new SprintPlanRejectedError('plan rejected'),
        isAbort: true,
        isNoMutation: false,
    },
    {
        label: 'ReviewerContractViolationError',
        build: () => new ReviewerContractViolationError('reviewer broke contract'),
        isAbort: true,
        isNoMutation: false,
    },
    {
        label: 'BudgetExceededError',
        build: () => new BudgetExceededError('spend ceiling blown'),
        isAbort: true,
        isNoMutation: true,
    },
    {
        label: 'CancelledError',
        build: () => new CancelledError('stopped'),
        isAbort: false,
        isNoMutation: false,
    },
    {
        label: 'pre-sprint validation Error (plain Error, stable message prefix)',
        build: () => new Error("Pre-sprint validation failed: No ready beads found for scope 'x'."),
        isAbort: true,
        isNoMutation: false,
    },
    {
        label: 'AgentOutputError',
        build: () => new AgentOutputError('schema repair exhausted'),
        isAbort: false,
        isNoMutation: false,
    },
    {
        label: 'AgentDispatchError, reason dispatch_failed (a dead session -- the prompt never landed)',
        build: () => new AgentDispatchError('dead session', { details: { reason: 'dispatch_failed' } }),
        isAbort: false,
        isNoMutation: true,
    },
    {
        label: 'AgentDispatchError, reason watchdog_timeout (the prompt WAS delivered; only the result was lost)',
        build: () => new AgentDispatchError('timed out (watchdog)', { details: { reason: 'watchdog_timeout' } }),
        isAbort: false,
        isNoMutation: false,
    },
    {
        label: 'AgentDispatchError, reason max_turns_exhausted (the agent ran and may have committed work)',
        build: () => new AgentDispatchError('out of turns', { details: { reason: 'max_turns_exhausted' } }),
        isAbort: false,
        isNoMutation: false,
    },
    {
        label: 'FleetTransportError',
        build: () => new FleetTransportError('transport down'),
        isAbort: false,
        isNoMutation: true,
    },
    {
        label: 'CommandError',
        build: () => new CommandError('bd list exited 1'),
        isAbort: false,
        isNoMutation: false,
    },
    {
        label: 'GitSyncError (transient sync failure, not a sprint abort)',
        build: () => new GitSyncError('push failed'),
        isAbort: false,
        isNoMutation: false,
    },
    {
        label: 'DoltSyncError (transient sync failure, not a sprint abort)',
        build: () => new DoltSyncError('dolt push failed'),
        isAbort: false,
        isNoMutation: false,
    },
    {
        label: 'DoltDivergedError, bare (a pre-dispatch D-pull divergence)',
        build: () => new DoltDivergedError('D-pull diverged', { member: 'alice', doltOutput: 'conflict', operation: 'pull' }),
        isAbort: true,
        isNoMutation: false,
    },
    {
        label: 'DoltDivergedError wrapped one level down inside a PostDispatchSyncError (the live D-push shape)',
        build: () => new PostDispatchSyncError('post-dispatch sync failed', {
            member: 'bob',
            cause: new DoltDivergedError('D-push still rejected after reconcile', { member: 'bob', doltOutput: 'updates were rejected', operation: 'push' }),
        }),
        isAbort: true,
        isNoMutation: false,
    },
    {
        label: 'PostDispatchSyncError with NO divergence anywhere in its cause chain',
        build: () => new PostDispatchSyncError('post-dispatch sync failed', { cause: new Error('credentials missing') }),
        isAbort: false,
        isNoMutation: false,
    },
];

describe('apra-fleet-9ta.7: error-classification routing table -- isTypedAbortError() x isNoMutationDispatchFailure() per class', () => {
    for (const row of ROWS) {
        test(`${row.label}: isTypedAbortError()=${row.isAbort}, isNoMutationDispatchFailure()=${row.isNoMutation}`, () => {
            const err = row.build();
            assert.equal(isTypedAbortError(err), row.isAbort, `isTypedAbortError() mismatch for ${row.label}`);
            assert.equal(isNoMutationDispatchFailure(err), row.isNoMutation, `isNoMutationDispatchFailure() mismatch for ${row.label}`);
        });
    }

    test('null / undefined: both predicates are false', () => {
        assert.equal(isTypedAbortError(null), false);
        assert.equal(isTypedAbortError(undefined), false);
        assert.equal(isNoMutationDispatchFailure(null), false);
        assert.equal(isNoMutationDispatchFailure(undefined), false);
    });
});

// =============================================================================
// End-to-end routing, via the mock sprint harness: the same classes above,
// but observed at the OUTPUT the runner actually produces for each routing
// bucket, not just the predicate return value.
// =============================================================================
describe('apra-fleet-9ta.7: end-to-end routing via the mock sprint harness', () => {
    // ---- (1) abort record: a typed abort writes a terminal verdict:'ABORTED' record ----
    test('a typed abort (SprintPlanRejectedError, an unapproved plan) writes a terminal verdict:ABORTED record', { timeout: 180000 }, async () => {
        await withScenarioMarkers('routingabortrecord', async () => {
            const scenario = await runDevelopLoopScenario('routingabortrecord', {
                members: ['local'],
                taskSpecs: [{ title: 'Task: 9ta.7 abort-record routing scenario work' }],
                maxCycles: 1,
                planReviewerHandler: async () => ({
                    content: [{ text: 'This can NOT be APPROVED: the DAG is still missing a documentation task.' }],
                }),
            });

            check(!!scenario.error, 'Expected the sprint to abort on an unapproved plan');
            check(
                scenario.error instanceof SprintPlanRejectedError,
                `Expected a SprintPlanRejectedError, got: ${scenario.error ? scenario.error.constructor.name : 'no error'}`,
            );
            check(isTypedAbortError(scenario.error), 'Expected this error to satisfy isTypedAbortError()');

            const terminalState = scenario.states.find((e) => e.namespace === 'terminal');
            check(!!terminalState, `Expected a publishState('terminal', ...) record, states: ${JSON.stringify(scenario.states)}`);
            check(
                terminalState && terminalState.data.verdict === 'ABORTED',
                `Expected the terminal record's verdict to be 'ABORTED', got: ${JSON.stringify(terminalState && terminalState.data)}`,
            );
        });
    });

    // ---- (2) rethrow: a non-terminal error (CancelledError) is rethrown with NO terminal-history side effect ----
    test('a cooperative cancellation (CancelledError) is rethrown immediately, with no terminal-history record', { timeout: 180000 }, async () => {
        await withScenarioMarkers('routingrethrow', async () => {
            const scenario = await runDevelopLoopScenario('routingrethrow', {
                members: ['local'],
                taskSpecs: [{ title: 'Task: 9ta.7 rethrow routing scenario work' }],
                maxCycles: 1,
                plannerHandler: async () => {
                    // A client-side AbortError shape (McpClient.request()
                    // reacting to the run's cooperative-cancellation signal):
                    // agent()'s catch (packages/apra-fleet-workflow/src/
                    // workflow/index.mjs) converts exactly this shape --
                    // error.code === 'ABORTED' -- into a typed CancelledError.
                    const err = new Error('simulated cooperative /stop');
                    err.code = 'ABORTED';
                    throw err;
                },
            });

            check(!!scenario.error, 'Expected the cancellation to surface as a rejected sprint run');
            check(
                scenario.error instanceof CancelledError,
                `Expected a CancelledError, got: ${scenario.error ? scenario.error.constructor.name : 'no error'}`,
            );
            check(isTypedAbortError(scenario.error) === false, 'CancelledError must NOT satisfy isTypedAbortError()');

            // main()'s catch: `if (!isTerminalSprintFailure(err)) { throw err; }`
            // -- CancelledError is explicitly excluded from isTerminalSprintFailure(),
            // so it is rethrown before finalizeAbort()/publishState('terminal', ...)
            // ever run. No terminal record must exist.
            const terminalState = scenario.states.find((e) => e.namespace === 'terminal');
            check(
                !terminalState,
                `Expected NO publishState('terminal', ...) record for a cooperative cancellation, states: ${JSON.stringify(scenario.states)}`,
            );
        });
    });

    // ---- (3) teardown-skip: isNoMutationDispatchFailure()===true skips the post-dispatch G-push/D-push teardown ----
    test('a no-mutation dispatch failure (dispatch_failed) SKIPS the post-dispatch G-push/D-push teardown', { timeout: 180000 }, async () => {
        await withScenarioMarkers('routingteardownskip', async () => {
            const scenario = await runDevelopLoopScenario('routingteardownskip', {
                members: ['local'],
                taskSpecs: [{ title: 'Task: 9ta.7 teardown-skip routing scenario work' }],
                maxCycles: 1,
                plannerHandler: async () => ({
                    content: [{ text: 'simulated dead-PID interactive session -- fleet-level dispatch failure, not an LLM response' }],
                    structuredContent: { isError: true, reason: 'dispatch_failed' },
                }),
            });

            check(!!scenario.error, 'Expected the sprint to abort once the Planner retry ladder is exhausted');
            check(
                isNoMutationDispatchFailure(scenario.error),
                `Expected the terminal error to satisfy isNoMutationDispatchFailure(), got: ${scenario.error ? scenario.error.constructor.name : 'no error'}`,
            );

            const skipLines = scenario.logs.filter((m) => m.includes('Skipping post-dispatch G-push/D-push'));
            check(
                skipLines.length > 0,
                `Expected the post-dispatch G-push/D-push teardown to be SKIPPED after a no-mutation dispatch failure, logs: ${JSON.stringify(scenario.logs)}`,
            );
        });
    });

    // ---- (4) teardown-run: isNoMutationDispatchFailure()===false still runs the post-dispatch teardown ----
    test('a dispatch failure the agent may have mutated beads under (watchdog_timeout) still RUNS the post-dispatch sync teardown', { timeout: 180000 }, async () => {
        await withScenarioMarkers('routingteardownrun', async () => {
            const scenario = await runDevelopLoopScenario('routingteardownrun', {
                members: ['local'],
                taskSpecs: [{ title: 'Task: 9ta.7 teardown-run routing scenario work' }],
                maxCycles: 1,
                plannerHandler: async () => ({
                    content: [{ text: 'simulated alive-but-silent member session -- the watchdog abandoned this dispatch' }],
                    structuredContent: { isError: true, reason: 'watchdog_timeout' },
                }),
            });

            check(!!scenario.error, 'Expected the sprint to abort once the Planner retry ladder is exhausted');
            check(
                isNoMutationDispatchFailure(scenario.error) === false,
                `Expected the terminal error NOT to satisfy isNoMutationDispatchFailure(), got: ${scenario.error ? scenario.error.constructor.name : 'no error'}`,
            );

            const skipLines = scenario.logs.filter((m) => m.includes('Skipping post-dispatch G-push/D-push'));
            check(
                skipLines.length === 0,
                `Expected NO post-dispatch teardown skip after a watchdog_timeout, logs: ${JSON.stringify(skipLines)}`,
            );
            check(
                scenario.logs.some((m) => /\[Dolt\] D-push for member 'local'/.test(m)),
                `Expected the post-dispatch D-push teardown to have actually run, logs: ${JSON.stringify(scenario.logs)}`,
            );
        });
    });
});
