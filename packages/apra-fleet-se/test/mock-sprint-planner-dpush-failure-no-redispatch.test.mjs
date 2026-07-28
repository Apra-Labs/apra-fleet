import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { PostDispatchSyncError, isPostDispatchSyncFailure, DoltSyncError } from '../fleet-sprint/errors.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-6z8.3 (Symptom 2 of apra-fleet-6z8) -- withGitSync used to wrap the
// pre-dispatch pull, the LLM turn, AND the post-dispatch D-push as ONE bracket,
// with the teardown in a `finally`. doltPushGuarded's DoltSyncError therefore
// propagated out of the WHOLE bracket, and the Planner's
// PLANNER_DISPATCH_RETRY_DELAYS_MS ladder could only see "the bracket threw" --
// so it redispatched a brand-new Planner LLM turn even though the previous
// turn's beads writes were already safely committed in the member's local
// clone, purely because an unrelated push step failed.
//
// The fix: a completed dispatch whose post-step sync fails retries ONLY the
// sync step, and if that still fails surfaces a typed PostDispatchSyncError
// that every retry caller must answer WITHOUT redispatching.
// =============================================================================

test('unit: isPostDispatchSyncFailure identifies only a completed-dispatch sync failure', () => {
    const err = new PostDispatchSyncError('post-dispatch sync failed', {
        member: 'local',
        dispatchResult: { text: 'the planner already answered' },
        syncAttempts: 3,
        cause: new DoltSyncError('bd dolt push failed'),
    });
    assert.equal(isPostDispatchSyncFailure(err), true);
    assert.equal(err.code, 'POST_DISPATCH_SYNC_FAILED');
    assert.equal(err.member, 'local');
    assert.equal(err.syncAttempts, 3);
    // The completed turn's result is preserved on the error, not discarded.
    assert.deepEqual(err.dispatchResult, { text: 'the planner already answered' });

    // A plain dispatch/sync failure is NOT this classification -- those still
    // flow through their pre-existing retry paths untouched.
    assert.equal(isPostDispatchSyncFailure(new DoltSyncError('bd dolt push failed')), false);
    assert.equal(isPostDispatchSyncFailure(new Error('execute_prompt is already running for "local"')), false);
    assert.equal(isPostDispatchSyncFailure(undefined), false);
});

test('mock sprint: a D-push failure after a SUCCESSFUL Planner turn does not redispatch the Planner', { timeout: 180000 }, async () => {
    await withScenarioMarkers('plannerdpushfail', async () => {
        let plannerCalls = 0;
        const scenario = await runDevelopLoopScenario('plannerdpushfail', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: D-push-failure-after-successful-plan scenario work' }],
            maxCycles: 1,
            // Fail the post-dispatch D-push itself. The sync.remote pre-gate
            // probe is failed too so doltPushAfter cannot short-circuit to its
            // benign 'no-remote' skip (isMemberSyncRemoteConfigured fails safe
            // to "configured" on an unreadable probe) -- i.e. the push is
            // genuinely attempted and genuinely fails, exactly like the live
            // missing-VCS-credentials case.
            commandFailurePattern: /^bd config get sync\.remote|^bd dolt push\b/,
            plannerHandler: async () => {
                plannerCalls += 1;
                // A NORMAL, successful planning turn: the LLM did its job.
                return { content: [{ text: 'Planning complete -- the task DAG is created in beads.' }] };
            },
        });

        // THE acceptance criterion: the Planner LLM turn ran exactly ONCE. A
        // pure push failure must never buy a second concurrent planning session
        // over already-completed work.
        assert.equal(
            plannerCalls,
            1,
            `Expected exactly 1 Planner dispatch (a post-dispatch D-push failure must not redispatch the LLM turn), got ${plannerCalls}`
        );

        // The failure is surfaced as the typed, non-redispatchable error...
        check(scenario.error, 'Expected the sprint to surface the sync failure rather than silently swallowing it');
        check(
            isPostDispatchSyncFailure(scenario.error) || /POST_DISPATCH_SYNC_FAILED|post-dispatch sync/i.test(String(scenario.error.message)),
            `Expected a PostDispatchSyncError, got: ${scenario.error && scenario.error.message}`
        );

        // ...with the sync step (and ONLY the sync step) retried on its own,
        // and the ladder explicitly declining to re-dispatch.
        check(
            scenario.logs.some((m) => /retrying ONLY the sync step/i.test(m)),
            `Expected sync-only retry log lines, logs: ${JSON.stringify(scenario.logs)}`
        );
        check(
            scenario.logs.some((m) => /Not re-dispatching|WITHOUT re-dispatching/i.test(m)),
            `Expected an explicit no-redispatch log line, logs: ${JSON.stringify(scenario.logs)}`
        );
        check(
            !scenario.logs.some((m) => m.includes('before retry attempt')),
            `Expected NO Planner dispatch-retry backoff lines for a post-dispatch sync failure, logs: ${JSON.stringify(scenario.logs)}`
        );
    });
});
