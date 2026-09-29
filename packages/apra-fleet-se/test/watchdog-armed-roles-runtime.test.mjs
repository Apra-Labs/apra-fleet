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
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

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

/**
 * apra-fleet-i9ag.19.39: this file used to advance past two waits by
 * draining a FIXED number of real event-loop turns (`until()`'s bounded
 * `setImmediate` poll, and a flat `drainTurns(20)` before the "did not fire
 * early" check). A turn count is not an upper bound on "the thing I am
 * waiting for has happened": on a loaded host `until()` could exhaust its
 * budget before the engine reached the race (the judge's "0 !== 2"-shaped
 * flake on PR #561), and `drainTurns()` could either race a genuine log
 * arrival or -- worse -- pass vacuously by never giving a real early-fire a
 * chance to be observed. Both are replaced below by waiting on an OBSERVABLE
 * SIGNAL the production code itself produces (the watchdog wrapper being
 * invoked; its own [dispatch-watchdog] log line landing), following the
 * withCallSignal()/waitForCalls() precedent in
 * test/i9ag19-9-toolchain.test.mjs (read as a pattern here, not imported --
 * that file is a mutex resource owned by a different streak).
 */

/** The genuine global setTimeout, captured before this file's own
 *  mock.timers.enable() call ever runs, so a hang-guard built from it can
 *  never be faked by the same clock the code under test is racing against. */
const realSetTimeout = globalThis.setTimeout;

/** Real wall-clock ceiling for "the engine actually reached the watchdog
 *  race" -- never a fixed turn count -- scaled for host contention via
 *  scaledTimeout() so a loaded CI host is never misreported as hung. */
const REACHED_RACE_TIMEOUT_MS = scaledTimeout(5_000);

/** Races `promise` against a short REAL (never fake-clock) wall-clock guard.
 *  A healthy run always settles `promise` near-instantly; `ms` is never what
 *  a PASSING run waits on, only a bound on a genuinely hung one, so a real
 *  regression fails loudly with a message naming the real budget waited,
 *  instead of hanging the suite forever. */
function withRealTimeoutOrFail(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_resolve, reject) => {
            realSetTimeout(() => reject(new Error(
                `${label} -- a genuine hang is suspected: this did not happen within ${ms}ms of real wall-clock time.`
            )), ms);
        }),
    ]);
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

    // Resolves the instant the engine actually reaches the watchdog race --
    // an explicit deferred the wrapper settles synchronously inside the
    // call, never a fixed number of drained event-loop turns.
    let resolveReachedRace;
    const reachedRace = new Promise((resolve) => { resolveReachedRace = resolve; });
    ctx.withDispatchWatchdog = (dispatchPromise, options) => {
        watchdogCalls.push({ ...options });
        resolveReachedRace();
        // The production race, not the harness pass-through.
        return withDispatchWatchdog(dispatchPromise, options);
    };

    // Tracks the watchdog's own [dispatch-watchdog] log line landing as a
    // settled signal, so "did it fire early" is answered by the log's actual
    // arrival relative to the clock -- never by how many turns were drained
    // after a tick (which could make the negative half either race a real
    // early fire, or pass vacuously by never giving one a chance to land).
    let logged = false;
    let resolveLogged;
    const loggedSignal = new Promise((resolve) => { resolveLogged = resolve; });
    const originalLog = ctx.log;
    ctx.log = (message) => {
        originalLog(message);
        if (message.includes('[dispatch-watchdog]')) {
            logged = true;
            resolveLogged();
        }
    };

    const opts = { bindings: BINDINGS, ...ROLE_CALL_OPTS[role] };
    const settled = dispatchRole(ctx, role, opts).then(
        (outcome) => ({ outcome, thrown: null }),
        (thrown) => ({ outcome: null, thrown })
    );

    // Let the engine run until it has actually reached the race, driven by
    // the deferred above -- never by guessing a fixed number of microtask
    // ticks, which would race the engine's own pre-dispatch awaits. Raced
    // against a short REAL wall-clock guard so a genuine hang fails loudly,
    // naming the real budget it waited, instead of hanging the suite.
    await withRealTimeoutOrFail(
        reachedRace, REACHED_RACE_TIMEOUT_MS, `${role}: engine never reached the watchdog race`
    );

    const budgetMs = (expectedTimeoutS + GRACE_S) * 1000;
    mock.timers.tick(budgetMs - 1);
    // mock.timers.tick() runs any due callback SYNCHRONOUSLY within the call
    // itself (node:test's fake timers never defer a due callback to a later
    // turn), so `logged` is an exact, immediate answer to "has the
    // watchdog's own log line landed yet" -- no draining is needed, or able,
    // to make a callback that is not yet due appear sooner. This is what
    // makes the negative half fail if the grace period were removed: a
    // shorter production budget would fire the real timer before this tick,
    // and `logged` would already be true here.
    const firedEarly = logged;

    mock.timers.tick(1);
    await loggedSignal;
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
