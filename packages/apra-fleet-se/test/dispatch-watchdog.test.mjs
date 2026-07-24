import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { withDispatchWatchdog } from '../auto-sprint/runner.js';
import { AgentDispatchError } from '@apralabs/apra-fleet-workflow';

// =============================================================================
// apra-fleet-eft.28.3 -- direct unit coverage for withDispatchWatchdog()
// (auto-sprint/runner.js), the client-side dispatch-timeout watchdog that
// wraps the FIRST/pre-plan [interactive] Planner execute_prompt dispatch.
//
// eft.28 RECURRED (integ cycle 6) because a frozen-but-alive persistent
// MCP/elicitation session produced NO progress -- state.json updatedAt froze
// for 2m15s+ with the process still alive and zero further log lines, and no
// watchdog fired. The prior dead-PID coverage
// (mock-sprint-planner-dispatch-dead-pid.test.mjs) only exercises the
// execute_prompt fast-fail path where the dispatch itself rejects promptly;
// it does NOT exercise the case this task exists to bound: a dispatch promise
// that simply never settles. These tests lock in exactly that behaviour by
// racing withDispatchWatchdog() against a never-settling promise.
//
// Timers are faked (node:test mock.timers) so the (timeoutS + 30s grace)
// budget can be advanced deterministically without the test actually sleeping
// for the real wall-clock budget.
// =============================================================================

test('withDispatchWatchdog: a never-settling dispatch is rejected with a typed AgentDispatchError(reason: watchdog_timeout) once the budget elapses, and a log line is written', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const logs = [];
        // A dispatch promise that NEVER settles -- the frozen-but-alive
        // persistent-session symptom eft.28 recurred on.
        const neverSettles = new Promise(() => {});

        const timeoutS = 10;
        const graceS = 30; // DISPATCH_WATCHDOG_GRACE_S (private constant in runner.js)

        const raced = withDispatchWatchdog(neverSettles, {
            timeoutS,
            member: 'stalled-planner',
            label: 'interactive Plan dispatch',
            log: (msg) => logs.push(msg),
        });

        // Attach the rejection assertion BEFORE advancing timers so the
        // rejection is observed (never left as an unhandled rejection).
        const settled = assert.rejects(
            raced,
            (err) => {
                assert.ok(err instanceof AgentDispatchError, 'rejects with a typed AgentDispatchError');
                assert.equal(err.code, 'AGENT_DISPATCH_FAILED');
                assert.equal(err.details?.reason, 'watchdog_timeout', 'reason is watchdog_timeout');
                assert.equal(err.details?.member, 'stalled-planner');
                assert.equal(err.details?.timeoutS, timeoutS);
                assert.equal(err.details?.graceS, graceS);
                return true;
            },
        );

        // Just BEFORE the full budget: the watchdog must not have fired yet.
        mock.timers.tick((timeoutS + graceS) * 1000 - 1);
        assert.equal(logs.length, 0, 'no watchdog log/rejection before the budget elapses');

        // Cross the budget: the watchdog fires.
        mock.timers.tick(1);
        await settled;

        assert.equal(logs.length, 1, 'exactly one watchdog log line is written when the timeout fires');
        assert.match(logs[0], /\[dispatch-watchdog\]/);
        assert.match(logs[0], /stalled-planner/);
        assert.match(logs[0], /interactive Plan dispatch/);
    } finally {
        mock.timers.reset();
    }
});

test('withDispatchWatchdog: a dispatch that settles within budget passes through unchanged and never logs a timeout', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const logs = [];
        const sentinel = { ok: true, plan: 'approved' };
        const settlesFast = Promise.resolve(sentinel);

        const result = await withDispatchWatchdog(settlesFast, {
            timeoutS: 10,
            member: 'live-planner',
            label: 'interactive Plan dispatch',
            log: (msg) => logs.push(msg),
        });

        assert.strictEqual(result, sentinel, 'the resolved value passes through unchanged');

        // Advancing past the budget after settlement must not fire the watchdog
        // (its timer was cleared by the race .finally()).
        mock.timers.tick((10 + 30) * 1000 + 1000);
        assert.equal(logs.length, 0, 'no watchdog log line for a dispatch that settled in time');
    } finally {
        mock.timers.reset();
    }
});

test('withDispatchWatchdog: a dispatch that rejects on its own within budget surfaces that original rejection, not a watchdog timeout', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const logs = [];
        const original = new Error('real dispatch failure');
        const rejectsFast = Promise.reject(original);

        await assert.rejects(
            withDispatchWatchdog(rejectsFast, {
                timeoutS: 10,
                member: 'failing-planner',
                label: 'interactive Plan dispatch',
                log: (msg) => logs.push(msg),
            }),
            (err) => {
                assert.strictEqual(err, original, 'the original rejection propagates unchanged');
                return true;
            },
        );

        mock.timers.tick((10 + 30) * 1000 + 1000);
        assert.equal(logs.length, 0, 'a real early rejection does not trigger the watchdog log');
    } finally {
        mock.timers.reset();
    }
});
