import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDispatchError } from '@apralabs/apra-fleet-workflow';
import { dispatchRole } from '../fleet-sprint/dispatch-role.mjs';
import { withDispatchWatchdog } from '../fleet-sprint/dispatch-failure.mjs';
import { ROLE_POLICIES, ROLE_NAMES, policyFor } from '../fleet-sprint/role-policies.mjs';
import {
    createRecordingCtx, ROLE_CALL_OPTS, BINDINGS,
    DISPATCH_TIMEOUT_S, INTEG_MAX_TOTAL_S, REGRESSION_TEST_MAX_TOTAL_S,
} from './helpers/dispatch-role-harness.mjs';

/**
 * Maps a policy row's resolved `watchdog.timeoutS` SYMBOLIC NAME to the
 * harness's numeric stand-in for it, so each role's expectation below is
 * driven by what the table itself names, not a value this file re-guesses
 * (apra-fleet-3swo.7.12 Final Review reopen: integ-test-runner and
 * regression-test-runner resolve to their own HARD elapsed ceiling --
 * INTEG_MAX_TOTAL_S / REGRESSION_TEST_MAX_TOTAL_S -- not the shared
 * DISPATCH_TIMEOUT_S inactivity budget every role used to be pinned to here).
 */
const BUDGET_BY_NAME = { DISPATCH_TIMEOUT_S, INTEG_MAX_TOTAL_S, REGRESSION_TEST_MAX_TOTAL_S };

// =============================================================================
// apra-fleet-3swo.7.12 criterion 5: a role that this pass changed from
// DISARMED to ARMED must get the SAME watchdog semantics the already-armed
// planner dispatches have -- demonstrated by driving the role to a real
// timeout through the real engine, not asserted in prose.
//
// The other watchdog suites stop short of this. role-policies-table.test.mjs
// and the dispatch pins assert the watchdog is ARMED (timeoutS/member/label
// reach the seam), and dispatch-watchdog.test.mjs drives withDispatchWatchdog
// directly but role-agnostically, with a hand-supplied member and label. What
// neither shows is a NEWLY-ARMED ROLE actually being raced: the engine reading
// that role's own row, resolving that role's own budget and member, and the
// await terminating instead of hanging.
//
// So this file wires the REAL withDispatchWatchdog into the recording ctx (the
// shared harness stubs it out to a pass-through, which is right for the pins
// but would make a timeout test vacuous) and hands the engine a dispatch
// promise that NEVER settles -- the frozen-but-alive member session these
// roles were armed for. Timers are faked so the (timeout + 30s grace) budget
// is advanced deterministically rather than actually slept through.
// =============================================================================

/** Roles armed by this pass: the planner family was already armed before it. */
const PLANNER_FAMILY = new Set(['planner', 'scoped-replan-planner']);
const NEWLY_ARMED_ROLES = ROLE_NAMES.filter(
    (role) => ROLE_POLICIES[role].watchdog.armed && !PLANNER_FAMILY.has(role)
);

const GRACE_S = 30; // DISPATCH_WATCHDOG_GRACE_S, private to dispatch-failure.mjs

/** One real event-loop turn, taken with setImmediate so the FAKE setTimeout
 *  clock does not move. */
const turn = () => new Promise((resolve) => setImmediate(resolve));

/** A bounded number of real turns, to flush whatever the engine has queued. */
async function drainTurns(n = 20) {
    for (let i = 0; i < n; i += 1) await turn();
}

/** Waits (in real turns, never fake time) until `pred` holds. */
async function until(pred, label, maxTurns = 1000) {
    for (let i = 0; i < maxTurns; i += 1) {
        if (pred()) return;
        await turn();
    }
    throw new Error(`timed out waiting for: ${label}`);
}

/**
 * Drives one role's main dispatch against a never-settling agent promise, with
 * the REAL watchdog in place, and returns everything observable about the race.
 * `expectedTimeoutS` is THIS role's own resolved budget (not necessarily
 * DISPATCH_TIMEOUT_S) -- see BUDGET_BY_NAME above.
 */
async function raceRoleToWatchdogTimeout(role, expectedTimeoutS) {
    let underlyingSettled = false;
    const neverSettles = () => new Promise(() => {}).finally(() => { underlyingSettled = true; });

    const { ctx, rec } = createRecordingCtx({ responses: [neverSettles] });
    const watchdogCalls = [];
    ctx.withDispatchWatchdog = (dispatchPromise, options) => {
        watchdogCalls.push({ ...options });
        // The production race, not the harness pass-through.
        return withDispatchWatchdog(dispatchPromise, options);
    };

    const opts = { bindings: BINDINGS, ...ROLE_CALL_OPTS[role] };
    const settled = dispatchRole(ctx, role, opts).then(
        (outcome) => ({ outcome, thrown: null }),
        (thrown) => ({ outcome: null, thrown })
    );

    // Let the engine run until it has actually reached the race. setImmediate
    // is NOT among the faked APIs, so this drains real turns without moving
    // the fake clock -- guessing a fixed number of microtask ticks instead
    // would race the engine's own pre-dispatch awaits.
    await until(() => watchdogCalls.length > 0, `${role}: engine never reached the watchdog race`);

    const budgetMs = (expectedTimeoutS + GRACE_S) * 1000;
    mock.timers.tick(budgetMs - 1);
    await drainTurns();
    const firedEarly = rec.logs.some((l) => l.includes('[dispatch-watchdog]'));

    mock.timers.tick(1);
    const result = await settled;

    return { ...result, rec, watchdogCalls, firedEarly, underlyingSettled };
}

test('the newly-armed roles were actually armed (sanity: this file would be vacuous otherwise)', () => {
    assert.ok(
        NEWLY_ARMED_ROLES.length > 0,
        'no role outside the planner family arms a watchdog -- criterion 5 has nothing to demonstrate.'
    );
    // Discovered from the table, never hardcoded, so a later re-audit that
    // disarms one of these does not leave a stale expectation behind here.
    for (const role of NEWLY_ARMED_ROLES) {
        assert.ok(policyFor(role).watchdog.armed);
        assert.strictEqual(policyFor(role).watchdog.member, 'dispatch');
    }
});

for (const role of NEWLY_ARMED_ROLES) {
    // The role's OWN resolved ceiling (apra-fleet-3swo.7.12 Final Review
    // reopen) -- deliberately derived INDEPENDENTLY from this row's own
    // `timeouts` (maxTotalS when set, else timeoutS), never read off
    // `watchdog.timeoutS` itself: reading the value being tested back out of
    // the same object under test would make this assertion self-fulfilling
    // and unable to catch a broken resolution (falsified: reading
    // `watchdog.timeoutS` here passed even with resolveWatchdogTimeout()
    // reverted to the hard-coded pre-fix constructor, because it just
    // compared the defective value to itself). Still discovered from the
    // table, never hardcoded, so a later re-audit that changes a role's
    // ceiling does not leave this file asserting a stale expectation.
    const rowTimeouts = policyFor(role).timeouts;
    const expectedTimeoutName = rowTimeouts.maxTotalS ?? rowTimeouts.timeoutS;
    const expectedTimeoutS = BUDGET_BY_NAME[expectedTimeoutName];

    test(`${role}: a frozen-but-alive dispatch is aborted by the watchdog with reason watchdog_timeout`, async () => {
        assert.ok(
            typeof expectedTimeoutS === 'number',
            `${role}: watchdog.timeoutS names '${expectedTimeoutName}', which BUDGET_BY_NAME does not cover -- ` +
            'add it there rather than silently asserting NaN.'
        );
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            const { thrown, outcome, rec, watchdogCalls, firedEarly, underlyingSettled } =
                await raceRoleToWatchdogTimeout(role, expectedTimeoutS);

            // 1. The race really happened, through this role's own row, using
            //    ITS OWN resolved ceiling -- not necessarily DISPATCH_TIMEOUT_S
            //    (integ-test-runner/regression-test-runner resolve to their
            //    longer HARD elapsed ceiling; deployer's two budgets are equal
            //    so it still resolves to DISPATCH_TIMEOUT_S).
            assert.strictEqual(watchdogCalls.length, 1, `${role}: expected exactly one watchdog race.`);
            assert.strictEqual(
                watchdogCalls[0].timeoutS,
                expectedTimeoutS,
                `${role}: the watchdog must use the role's own resolved elapsed-ceiling budget (${expectedTimeoutName}), ` +
                'not the shared inactivity budget.'
            );
            assert.strictEqual(
                watchdogCalls[0].member,
                rec.dispatches[0].member,
                `${role}: the watchdog must name the member its dispatch routed to, so the kill path targets the ` +
                'right session.'
            );

            // 2. The grace period is applied ON TOP of the configured timeout:
            //    nothing fires one millisecond before timeout + grace.
            assert.strictEqual(
                firedEarly,
                false,
                `${role}: the watchdog fired before (${expectedTimeoutS}s + ${GRACE_S}s grace) elapsed.`
            );

            // 3. It fired, with the same typed failure the planner's does.
            const watchdogLogs = rec.logs.filter((l) => l.includes('[dispatch-watchdog]'));
            assert.strictEqual(watchdogLogs.length, 1, `${role}: expected one [dispatch-watchdog] log line.`);
            assert.match(
                watchdogLogs[0],
                new RegExp(`produced no result within ${expectedTimeoutS}s \\(\\+${GRACE_S}s grace\\)`),
                `${role}: the log must state both the budget and the grace it was given.`
            );

            // 4. The await TERMINATED. That is the whole point: before this
            //    role was armed, a never-settling dispatch left the
            //    orchestrator alive-but-silent with no client-side ceiling.
            //    Whether it surfaces as a throw or as this role's recorded
            //    degrade outcome is the role's own degrade policy; either way
            //    the sprint is no longer hanging.
            assert.ok(
                thrown !== undefined,
                `${role}: dispatchRole never settled -- the watchdog did not bound the dispatch.`
            );
            if (thrown) {
                assert.ok(thrown instanceof AgentDispatchError, `${role}: watchdog failures stay typed.`);
                assert.strictEqual(thrown.details?.reason, 'watchdog_timeout');
                assert.strictEqual(thrown.details?.graceS, GRACE_S);
                assert.strictEqual(thrown.details?.timeoutS, expectedTimeoutS);
            } else {
                assert.strictEqual(
                    policyFor(role).degrade.abortsSprint,
                    false,
                    `${role}: only a non-aborting degrade policy may swallow the watchdog failure.`
                );
                assert.ok(outcome, `${role}: a degraded watchdog timeout must still return an outcome.`);
                assert.strictEqual(outcome.ok, false, `${role}: a watchdog timeout is never a success.`);
            }

            // 5. It ABANDONS THE DISPATCH PROMISE, not the member's work: the
            //    underlying agent() promise is simply dropped, still pending.
            //    Nothing in the race cancels or aborts the member's session.
            assert.strictEqual(
                underlyingSettled,
                false,
                `${role}: the watchdog must abandon the dispatch promise, never settle/cancel the member's own work.`
            );
            assert.strictEqual(
                rec.dispatches[0].options.signal,
                undefined,
                `${role}: no abort signal is handed to the member -- the watchdog is a client-side ceiling only.`
            );
        } finally {
            mock.timers.reset();
        }
    });
}
