import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { isNonRetryableDispatchError } from '../auto-sprint/errors.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// Stabilization Issue 43 (smoke-test rehearsal): an authentication failure is
// DETERMINISTIC -- the member's credential state does not change between
// attempts, so retrying the identical dispatch can never succeed. Observed
// live before this fix: the Planner retry loop
// (PLANNER_DISPATCH_RETRY_DELAYS_MS, 5 attempts) retried a dispatch whose
// error message literally began "Authentication failed", and with the
// interactive dispatch path burning its full --dispatch-timeout-s per
// attempt on an unauthenticated-but-alive member session, 5 x 15min = 75
// wasted minutes for an error that was terminal at second zero.
//
// The fleet server already encodes this judgment (src/utils/prompt-errors.ts
// isRetryable() returns false for 'auth'); isNonRetryableDispatchError()
// mirrors it engine-side, and runner.js's Planner loop now aborts its
// retries immediately when it fires.
// =============================================================================

test('unit: isNonRetryableDispatchError matches auth/trust signatures and nothing else', () => {
    assert.equal(isNonRetryableDispatchError(new Error('[Workflow Error] Agent dispatch failed (nonzero_exit): Authentication failed on "toy-doer". Run /login to refresh your credentials.')), true);
    assert.equal(isNonRetryableDispatchError(new Error('Not logged in - Please run /login')), true);
    assert.equal(isNonRetryableDispatchError(new Error('Workspace not trusted on "m1": Claude ignored the composed permissions.allow entries')), true);
    assert.equal(isNonRetryableDispatchError(new Error('this workspace has not been trusted')), true);
    // Transient categories must stay retryable.
    assert.equal(isNonRetryableDispatchError(new Error('execute_prompt is already running for "toy-doer"')), false);
    assert.equal(isNonRetryableDispatchError(new Error('[Workflow Error] Agent dispatch failed (dispatch_failed): transport reset')), false);
    assert.equal(isNonRetryableDispatchError(new Error('503 internal server error')), false);
    assert.equal(isNonRetryableDispatchError(undefined), false);
    assert.equal(isNonRetryableDispatchError({}), false);
});

// apra-fleet-eft.54.2: regression pin, run under real bd
// (APRA_FLEET_BD_MOCK=off -- see scripts/run-tests.mjs's `real` mode / repro:
// `APRA_FLEET_BD_MOCK=off node --test test/mock-sprint-planner-auth-failure-
// no-retry.test.mjs`, or a full real-bd pass via
// scripts/run-integ-suites.mjs). Before apra-fleet-eft.54.1's shared
// withGitSync teardown short-circuit (skip the redundant post-dispatch
// G-push/D-push teardown -- and, on a subsequent retry, the redundant
// pre-dispatch G-pull/D-pull -- for a terminal no-mutation dispatch failure),
// this scenario's real-bd sync brackets around a single Planner attempt were
// enough overhead, layered under the harness's own scenario setup/teardown,
// to push the run past the node:test harness's own { timeout: 120000 } file
// limit -- the test would be KILLED by the harness before its own
// `elapsedMs < 60000` assertion ever got a chance to run or fail, i.e. this
// is not a normal assertion failure, it is a hang-to-timeout. Post-fix, only
// ONE Planner attempt is ever dispatched (auth failures are non-retryable --
// see isNonRetryableDispatchError below), so there is only one pre-dispatch
// sync bracket to begin with and no retry-driven teardown/re-sync overhead
// to skip; measured real-bd runs complete in ~25-30s, comfortably under both
// the test's own 60000ms fast-abort bound and the harness's 120000ms limit.
//
// apra-fleet-eft.54.4: the .54.2 pin above did not actually hold -- a
// residual real-bd hang on the terminal auth-abort path (fixed by .54.3's
// shared-harness sync-teardown short-circuit and .54.5's stable
// sync.remote pre-gate cache) kept this file dying at the node:test
// harness's own { timeout: 120000 } limit before its assertions ever ran.
// Re-verified green under real bd (APRA_FLEET_BD_MOCK=off) at the combined
// .54.3+.54.5 fix SHA: elapsedMs ~24.8s, all post-error assertions
// (plannerCalls===1, non-retryable log line, terminal-state persistence)
// reached and passing, no harness timeout.
test('mock sprint: Planner auth failure aborts the retry loop after ONE attempt instead of exhausting the backoff', { timeout: 120000 }, async () => {
    await withScenarioMarkers('plannerauthnoretry', async () => {
        console.log('Running mock sprint scenario (Planner dispatch always fails with an Authentication failed response)...');
        const startedAt = Date.now();
        let plannerCalls = 0;
        const scenario = await runDevelopLoopScenario('plannerauthnoretry', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Planner auth-failure no-retry scenario work' }],
            maxCycles: 1,
            plannerHandler: async () => {
                plannerCalls += 1;
                return {
                    content: [{ text: 'Authentication failed on "local". Run /login to refresh your credentials, then run provision_llm_auth to deploy them to this agent.' }],
                    structuredContent: { isError: true, reason: 'nonzero_exit' },
                };
            },
        });
        const elapsedMs = Date.now() - startedAt;

        // The sprint aborts with a surfaced terminal error...
        check(scenario.error, 'Expected the sprint to abort with a surfaced terminal error, not run to a normal result');

        // ...after exactly ONE Planner attempt: no retry can fix an auth
        // failure, so the backoff ladder (which alone waits ~110s across its
        // 5 attempts) must never be entered.
        assert.equal(plannerCalls, 1, `Expected exactly 1 Planner attempt (auth failures are non-retryable), got ${plannerCalls}`);

        // Fast: well under even the FIRST backoff delay tier's cumulative
        // wait (5s + 15s = 20s to reach attempt 3). Generous 60s bound for
        // slow CI hosts.
        check(elapsedMs < 60000, `Expected an immediate abort (single attempt), took ${elapsedMs}ms`);

        // The abort is logged with the non-retryable classification and its
        // remediation hint, so an operator reading the run log knows this is
        // a provisioning problem, not flakiness.
        check(
            scenario.logs.some((m) => m.includes('non-retryable') && m.includes('Authentication failed')),
            `Expected a non-retryable classification log line, logs: ${JSON.stringify(scenario.logs)}`
        );
        check(
            !scenario.logs.some((m) => m.includes('waiting') && m.includes('before retry attempt')),
            `Expected NO retry-backoff wait lines for an auth failure, logs: ${JSON.stringify(scenario.logs)}`
        );

        // And the failure is persisted to sprint state as terminal, same
        // typed-abort plumbing as every other planner dispatch failure
        // (apra-fleet-eft.28.2).
        const terminalStates = scenario.states.filter((s) => s.namespace === 'terminal');
        check(terminalStates.length > 0, `Expected at least one 'terminal' sprint-state publish, states: ${JSON.stringify(scenario.states)}`);
        check(
            terminalStates.some((s) => s.data && typeof s.data.message === 'string' && /Authentication failed/.test(s.data.message)),
            `Expected the persisted terminal state to carry the auth-failure message, states: ${JSON.stringify(terminalStates)}`
        );
    });
});
