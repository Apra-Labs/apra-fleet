import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from '../helpers/mock-sprint-harness.mjs';
import { createMemberReservationClient } from '../../fleet-sprint/runner.js';
// The policy TABLE this scenario's budgets are derived from -- read, never
// re-implemented, so the test cannot drift from the row production executes.
import { policyFor } from '../../fleet-sprint/role-policies.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-eft.28.4: verifies the fix from apra-fleet-eft.28.3 (commits
// ef441d79 + c0873e1c), which adds withDispatchWatchdog() -- a client-side
// dispatch-timeout watchdog racing an in-flight dispatch promise against a
// local (dispatch_timeout_s + 30s grace) timer -- and wires it around BOTH
// the first/pre-plan interactive Planner dispatch and its resume path.
//
// mock-sprint-planner-dispatch-dead-pid.test.mjs (apra-fleet-eft.28.2) proved
// the orchestrator surfaces a bounded terminal error when the member's
// underlying claude PID is already DEAD (execute_prompt's own fast-fail
// rejects the dispatch promise almost immediately -- there is nothing for a
// TIMER to bound, the rejection is already prompt). apra-fleet-eft.28
// RECURRED anyway (integ cycle 6) because that only covers a dead PID: the
// live symptom was a member process that stayed ALIVE but produced ZERO
// further output after the prompt was delivered -- a frozen-but-alive
// interactive/elicitation session that no PID check can ever catch, and
// exactly the failure mode dispatch_timeout_s/withDispatchWatchdog exist to
// bound. This test exercises THAT case, at the same orchestrator layer
// eft.28.2 exercises the dead-PID case: `plannerHandler` returns a promise
// that NEVER settles (no dispatch_failed rejection, no resolution -- just
// silence), simulating the stalled/dead persistent session directly.
//
// Pre-fix (no client-side watchdog; only the server-side timeout_s/
// max_total_s, which the live recurrence proved cannot be trusted as the
// sole backstop for a silently-frozen session): this scenario's dispatch
// promise would never settle at all, so the sprint would hang forever with
// nothing to assert on before any bounded-time test could ever complete --
// this is the silent-hang behaviour apra-fleet-eft.28 recurred with. This
// test only became expressible once apra-fleet-eft.28.3 made a frozen-but-
// alive dispatch reject at a bounded, client-enforced budget instead.
//
// Why this test is genuinely slow (real time, not mocked): dispatch_timeout_s
// has a hard floor of 60s (validateArgs -- "must be an integer >= 60"), and
// the planner row's retry ladder (role-policies.mjs: attempts 5, backoffMs
// [0, 5000, 15000, 30000, 60000]) retries EVERY dispatch failure -- including
// a watchdog timeout, which is not special-cased -- so a plannerHandler that
// ALWAYS stalls exhausts all 5 attempts before the sprint aborts. Each
// attempt's watchdog budget is (the row's resolved watchdog budget + 30s
// grace) = 90s at the floor, and the harness runs with the zero-wait
// instant-backoff switch on, so this test's real, unavoidable floor is
// 5*90s = 450s with no backoff term at all. deriveStalledAbortFloorMs()
// below computes exactly that from the policy row rather than restating it
// as a constant, so neither number can go stale again. Fake timers
// (the technique dispatch-watchdog.test.mjs uses for direct, function-level
// withDispatchWatchdog() coverage) were tried here and rejected: this
// scenario's dispatch path also issues real `bd config get sync.remote
// --json` child-process calls (via withGitSync's dolt pre-attempt gate) on
// EVERY retry attempt, and Node's `child_process.exec()` never resolves at
// all once `node:test`'s `mock.timers` has replaced the global `setTimeout`
// it depends on internally -- confirmed by direct repro (a bare `bd init`
// exec() call hangs forever under `mock.timers.enable({ apis: ['setTimeout']
// })`). So this test pays the real derived floor rather than a mocked one;
// it is still a FINITE, deterministic bound -- the exact property
// apra-fleet-eft.28 recurred without -- just an expensive one to observe
// end-to-end. See mock-sprint-planner-dispatch-dead-pid.test.mjs
// (apra-fleet-eft.28.2) and dispatch-watchdog.test.mjs (apra-fleet-eft.28.3)
// for the two FAST, function/attempt-scoped counterparts to this test.
// =============================================================================

/**
 * Reproduces src/tools/member-reservation.ts's reserve/release semantics
 * (ownership check, "[OK]"/"[-]" prefixes) just enough to drive
 * createMemberReservationClient -- the SAME minimal fake shape
 * reservation-interop-e2e.test.mjs (apra-fleet-eft.26.3) uses for its
 * "reserved during the run, released in the catch branch" bracket. Duplicated
 * locally (small and self-contained) rather than imported, matching this
 * suite's existing convention of inlining small deterministic mocks (see
 * mockCmdResult in mock-sprint-harness.mjs) instead of adding cross-file
 * coupling between independent test suites.
 */
function createFakeFleetServer(memberNames) {
    const state = new Map(memberNames.map((n) => [n, null]));
    function reserve(name, sprintId) {
        const current = state.get(name) ?? null;
        if (current && current !== sprintId) {
            return `[-] Member "${name}" is already reserved by "${current}".`;
        }
        state.set(name, sprintId);
        return `[OK] Member "${name}" reserved for "${sprintId}".`;
    }
    function release(name, sprintId) {
        const current = state.get(name) ?? null;
        if (!current) return `[OK] Member "${name}" was not reserved. Nothing to release.`;
        if (current !== sprintId) {
            return `[-] Member "${name}" is reserved by "${current}", not "${sprintId}".`;
        }
        state.set(name, null);
        return `[OK] Member "${name}" reservation released.`;
    }
    async function callTool(toolName, args) {
        if (toolName !== 'member_reservation') throw new Error(`unexpected tool '${toolName}'`);
        const { member_name, action, sprint_id } = args;
        if (action === 'reserve') return reserve(member_name, sprint_id);
        if (action === 'release') return release(member_name, sprint_id);
        throw new Error(`unknown member_reservation action '${action}'`);
    }
    return { state, callTool };
}

// ---------------------------------------------------------------------------
// Per-dispatch budget derivation (apra-fleet-25yl.1.7)
// ---------------------------------------------------------------------------
// This test used to carry a hard-coded `REAL_TIME_CEILING_MS = 620000`
// justified by a "5*90s + 110s of retry backoff = ~560s" comment. BOTH halves
// of that constant were pre-sprint assumptions that no longer hold:
//
//   1. There is no longer a single global dispatch budget. A dispatch's
//      budgets come from its OWN role-policies row -- the planner row is
//      `budgets('DISPATCH_INACTIVITY_TIMEOUT_S', 'DISPATCH_TIMEOUT_S')`, and
//      runner.js derives DISPATCH_INACTIVITY_TIMEOUT_S per run as
//      `Math.min(1800, DISPATCH_TIMEOUT_S)`.
//   2. The 110s backoff term is unreachable here: mock-sprint-harness.mjs
//      sets APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF=1 for the whole scenario,
//      and dispatch-role.mjs skips the timed sleep under that switch (the
//      "waiting Ns" log line and the configured delay values are unchanged;
//      only the sleep is skipped). So the ladder's wall clock is watchdog
//      budgets ONLY.
//
// NOTE on which budget the client-side watchdog actually races: the
// acceptance criteria for this task speak of "the per-dispatch inactivity
// budget", but role-policies.mjs's resolveWatchdogTimeout() resolves an armed
// watchdog to `timeouts.maxTotalS ?? timeouts.timeoutS` -- i.e. the planner's
// watchdog races DISPATCH_TIMEOUT_S (the row's hard elapsed ceiling), not
// DISPATCH_INACTIVITY_TIMEOUT_S. At this scenario's 60s floor the two are the
// same number (min(1800, 60) === 60), which is exactly why a constant could
// hide the difference; they diverge for any run with DISPATCH_TIMEOUT_S >
// 1800. So the derivation below goes through the SAME resolution path
// production uses instead of naming either budget directly.
const DISPATCH_WATCHDOG_GRACE_S = 30; // dispatch-failure.mjs (module-private)
const INACTIVITY_CLAMP_S = 1800;      // runner.js: min(1800, DISPATCH_TIMEOUT_S)

/**
 * Resolves the planner row's symbolic budget names against THIS run's
 * dispatch_timeout_s, exactly as runner.js builds its budget bindings.
 */
function resolveBudgets(dispatchTimeoutS) {
    return {
        DISPATCH_TIMEOUT_S: dispatchTimeoutS,
        DISPATCH_INACTIVITY_TIMEOUT_S: Math.min(INACTIVITY_CLAMP_S, dispatchTimeoutS),
    };
}

/**
 * The real-time floor this scenario CANNOT finish faster than, derived from
 * the planner policy row (attempts, backoff ladder, resolved watchdog budget)
 * plus this run's dispatch_timeout_s -- never from a literal. Every stalled
 * attempt burns its full watchdog budget (+ grace) before the ladder moves on,
 * and the backoff term is included only when the harness has NOT enabled the
 * zero-wait switch, so the formula stays true under either setting.
 *
 * `instantBackoff` is OBSERVED from inside the running scenario (see
 * plannerHandler below) rather than assumed: the harness sets
 * APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF for the duration of the scenario and
 * restores it in its finally, so reading process.env after the run would
 * always say "off" and inflate the floor by the ladder's 110s of backoff.
 */
function deriveStalledAbortFloorMs(dispatchTimeoutS, instantBackoff) {
    const policy = policyFor('planner');
    const budgets = resolveBudgets(dispatchTimeoutS);
    // resolveWatchdogTimeout() already collapsed `maxTotalS ?? timeoutS` into
    // watchdog.timeoutS when the table was built; read the resolved name.
    const watchdogBudgetS = budgets[policy.watchdog.timeoutS];
    assert.ok(policy.watchdog.armed, 'precondition: the planner row must arm a client-side watchdog');
    assert.equal(typeof watchdogBudgetS, 'number', `planner watchdog budget '${policy.watchdog.timeoutS}' did not resolve to a number`);
    const attempts = policy.retry.attempts;
    const perAttemptMs = (watchdogBudgetS + DISPATCH_WATCHDOG_GRACE_S) * 1000;
    const backoffMs = instantBackoff
        ? 0
        : (policy.retry.backoffMs || []).slice(0, attempts - 1).reduce((a, b) => a + b, 0);
    return {
        watchdogBudgetS,
        inactivityBudgetS: budgets[policy.timeouts.timeoutS],
        attempts,
        floorMs: attempts * perAttemptMs + backoffMs,
        // See JITTER_MS_PER_ATTEMPT above: the LOWER-bound tolerance, derived
        // from this same run's `attempts` rather than fixed at one literal
        // second.
        toleranceMs: attempts * JITTER_MS_PER_ATTEMPT,
    };
}

// Slack over the derived floor: one attempt's worth of budget, so the ceiling
// scales with the per-dispatch budget instead of being a fixed pre-sprint
// number. Wide enough to absorb real-bd setup and host jitter, narrow enough
// that a SIXTH attempt (or an unbounded hang) still blows it.
const CEILING_SLACK_FACTOR = 1.35;

// Per-attempt real-time jitter allowance for the LOWER-bound tolerance below
// (apra-fleet-25yl.9). The green run this scenario was authored against
// measured 450066.7ms against a 450000ms floor -- about 1066ms of headroom on
// a wall-clock assertion spanning 5 real setTimeout-driven watchdog fires.
// A bare `- 1000` literal does not scale: it silently shrinks (as a fraction
// of the floor) whenever `attempts` or `watchdogBudgetS` grow, and it does not
// grow when they do, so it can go red on nothing more than coarser host timer
// resolution or a watchdog firing exactly on its grace boundary instead of
// after it. Deriving it as `attempts * JITTER_MS_PER_ATTEMPT` instead ties it
// to the SAME term (`attempts`) the floor and ceiling already scale by, so all
// three bounds move together if the planner's retry ladder ever changes.
// 200ms/attempt keeps the derived tolerance at 1000ms for today's 5-attempt
// ladder (an intentional no-op on the currently-passing run) while staying two
// orders of magnitude below one whole skipped watchdog budget (perAttemptMs,
// >= 90000ms at the 60s floor) -- so a genuinely fast abort that skips an
// entire attempt's budget still fails the lower bound, per this task's ask.
const JITTER_MS_PER_ATTEMPT = 200;

// "short dispatch_timeout_s" per this task's ask -- 60 is the lowest value
// validateArgs accepts (must be an integer >= 60). Module scope because the
// node:test file-level timeout below is derived from it too.
const DISPATCH_TIMEOUT_S = 60;

// The node:test harness timeout is deliberately derived from the PESSIMISTIC
// branch (instantBackoff = false, i.e. the full retry ladder actually sleeps)
// so the in-test wall-clock assertion -- which uses the branch this run
// really took -- is what fails first on a regression, rather than node:test
// killing the run with no assertion to read.
const HARNESS_TIMEOUT_MS = Math.round(
    deriveStalledAbortFloorMs(DISPATCH_TIMEOUT_S, false).floorMs * CEILING_SLACK_FACTOR,
) + 30000;

test('mock sprint: interactive Planner dispatch against a stalled/dead member session (no progress, pre-plan) aborts with a terminal error within its per-dispatch watchdog budget -- logged AND persisted -- releases the member reservation, and never hangs', { timeout: HARNESS_TIMEOUT_MS }, async () => {
    await withScenarioMarkers('plannerstalledsession', async () => {
        const members = ['local'];
        const branch = 'auto-sprint/mock-plannerstalledsession';
        const sprintId = branch;

        // Mirrors bin/cli.mjs's reservation bracket (apra-fleet-eft.26.1):
        // reserve every member BEFORE the dispatch, so this test can prove the
        // reservation is actually HELD while the dispatch is stalled, not just
        // trivially absent throughout.
        const fleetServer = createFakeFleetServer(members);
        const reservation = createMemberReservationClient({
            callTool: fleetServer.callTool,
            members,
            sprintId,
            log: () => {},
        });
        await reservation.reserveAll();
        check(fleetServer.state.get('local') === sprintId, 'precondition: member is reserved before the stalled dispatch begins');

        let plannerDispatchCount = 0;
        // Observed from INSIDE the scenario (see deriveStalledAbortFloorMs):
        // the harness's zero-wait retry-backoff switch is scoped to the run
        // and restored in its finally, so it must be sampled while a dispatch
        // is actually in flight.
        let instantBackoffDuringRun = null;
        const startedAt = Date.now();

        const scenario = await runDevelopLoopScenario('plannerstalledsession', {
            members,
            taskSpecs: [{ title: 'Task: Planner stalled-session dispatch scenario work' }],
            maxCycles: 1,
            branchOverride: branch,
            dispatchTimeoutS: DISPATCH_TIMEOUT_S,
            plannerHandler: async () => {
                plannerDispatchCount++;
                if (instantBackoffDuringRun === null) {
                    instantBackoffDuringRun = process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF === '1';
                }
                // A frozen-but-alive persistent session: the dispatch promise
                // NEVER settles -- no dispatch_failed rejection (that's
                // eft.28.2's dead-PID case), no resolution -- just silence.
                // Exactly the eft.28 recurrence symptom (state.json frozen
                // for 2m15s+, zero further log lines, member process still
                // alive).
                return new Promise(() => {});
            },
        });

        const elapsedMs = Date.now() - startedAt;

        // The dispatch settles (rejects) at all -- the defining symptom of
        // apra-fleet-eft.28 was that it NEVER did. `runDevelopLoopScenario`
        // itself only returns once `engine.executeFile()` has settled one way
        // or the other, so simply reaching this line already proves the run
        // did not hang past a real, observed wall-clock ceiling.
        check(scenario.error, 'expected the sprint to abort with a surfaced terminal error, not run to a normal result');

        check(plannerDispatchCount >= 1, 'expected at least one interactive Planner dispatch attempt');
        check(
            typeof instantBackoffDuringRun === 'boolean',
            'expected to have sampled the harness retry-backoff mode during at least one dispatch'
        );

        // Bounded BY THE PER-DISPATCH BUDGET, not silent-until-killed, and not
        // measured against a pre-sprint constant: both bounds below come from
        // the planner policy row resolved against THIS run's dispatch_timeout_s
        // (see deriveStalledAbortFloorMs).
        const budget = deriveStalledAbortFloorMs(DISPATCH_TIMEOUT_S, instantBackoffDuringRun);
        const ceilingMs = Math.round(budget.floorMs * CEILING_SLACK_FACTOR);
        const budgetLabel =
            `${budget.attempts} attempts x (watchdog ${budget.watchdogBudgetS}s + ${DISPATCH_WATCHDOG_GRACE_S}s grace)` +
            `, inactivity budget ${budget.inactivityBudgetS}s, instantBackoff=${instantBackoffDuringRun}`;

        // LOWER bound -- the assertion that actually proves the abort was the
        // watchdog spending its per-dispatch budget on every attempt, rather
        // than some unrelated fast failure that would satisfy an upper bound
        // trivially. `budget.toleranceMs` (derived from `attempts`, see
        // JITTER_MS_PER_ATTEMPT above) absorbs real-host timer-resolution
        // jitter only -- it is orders of magnitude below one whole skipped
        // watchdog budget, so a genuinely fast abort still fails this check.
        check(
            elapsedMs >= budget.floorMs - budget.toleranceMs,
            `Expected the abort to take at least the derived per-dispatch budget floor ${budget.floorMs}ms minus ${budget.toleranceMs}ms jitter tolerance (${budgetLabel}), took ${elapsedMs}ms -- a faster abort means the watchdog did not spend its budget`
        );
        // UPPER bound -- nowhere near "hangs forever" (apra-fleet-eft.28
        // pre-fix) or the up-to-9000s default single-dispatch timeout_s. A
        // SIXTH attempt, or an unbounded hang, blows this.
        check(
            elapsedMs < ceilingMs,
            `Expected the sprint to abort within the derived per-dispatch ceiling ${ceilingMs}ms (${budgetLabel}), took ${elapsedMs}ms`
        );

        // (4) specifically exercises the pre-plan phase: the plan-reviewer
        // (which only ever runs AFTER a Planner response is returned) must
        // never have been dispatched -- this abort happened strictly before
        // any plan-approval commit.
        check(
            scenario.dispatched.every((d) => d.agent !== 'plan-reviewer'),
            `expected zero plan-reviewer dispatches (abort must occur pre-plan), dispatched agents: ${JSON.stringify(scenario.dispatched.map((d) => d.agent))}`
        );
        check(
            scenario.dispatched.some((d) => d.agent === 'planner'),
            'expected at least one planner dispatch to have been attempted'
        );

        // (a) written to the fleet server log: withDispatchWatchdog() logs a
        // "[dispatch-watchdog]" line (via context.log()) each time its local
        // timer fires, and runner.js's own retry loop separately logs each
        // failed attempt plus "Retries exhausted." once the backoff is spent.
        check(
            scenario.logs.some((m) => m.includes('[dispatch-watchdog]')),
            `expected a "[dispatch-watchdog]" timeout log line, logs: ${JSON.stringify(scenario.logs)}`
        );
        check(
            scenario.logs.some((m) => /stalled\/dead session/.test(m)),
            `expected the watchdog log line to name this as a stalled/dead session, logs: ${JSON.stringify(scenario.logs)}`
        );
        check(
            scenario.logs.some((m) => m.includes('Retries exhausted')),
            `expected the retries-exhausted log line, logs: ${JSON.stringify(scenario.logs)}`
        );
        // ...and the logged line must NAME the per-dispatch budget it actually
        // enforced, resolved from the policy row above -- not merely say
        // "timed out". This is what makes the log evidence budget-specific
        // rather than shape-only.
        check(
            scenario.logs.some((m) => m.includes(`within ${budget.watchdogBudgetS}s (+${DISPATCH_WATCHDOG_GRACE_S}s grace)`)),
            `expected the watchdog log line to name this dispatch's resolved budget "within ${budget.watchdogBudgetS}s (+${DISPATCH_WATCHDOG_GRACE_S}s grace)", logs: ${JSON.stringify(scenario.logs)}`
        );

        // (b) persisted to the sprint state file: main()'s typed-abort catch
        // publishState('terminal', ...)s the failure -- the SAME typed-error
        // plumbing apra-fleet-eft.28.2 already proved flows through here
        // (withDispatchWatchdog's own AgentDispatchError is a WorkflowError,
        // just like the dead-PID dispatch_failed case).
        const terminalStates = scenario.states.filter((s) => s.namespace === 'terminal');
        check(terminalStates.length > 0, `expected at least one 'terminal' sprint-state publish, states: ${JSON.stringify(scenario.states)}`);
        check(
            terminalStates.some((s) => s.data && s.data.verdict === 'ABORTED'),
            `expected the terminal state to record verdict ABORTED, states: ${JSON.stringify(terminalStates)}`
        );
        check(
            terminalStates.some((s) => s.data && typeof s.data.message === 'string' && /timed out \(watchdog\)/.test(s.data.message)),
            `expected the persisted terminal state to carry the watchdog-timeout marker, states: ${JSON.stringify(terminalStates)}`
        );
        // The persisted failure must also name the per-dispatch budget that
        // was enforced, for the same reason as the log assertion above.
        check(
            terminalStates.some((s) => s.data && typeof s.data.message === 'string'
                && s.data.message.includes(`within ${budget.watchdogBudgetS}s (+${DISPATCH_WATCHDOG_GRACE_S}s grace)`)),
            `expected the persisted terminal state to name this dispatch's resolved budget "within ${budget.watchdogBudgetS}s (+${DISPATCH_WATCHDOG_GRACE_S}s grace)", states: ${JSON.stringify(terminalStates)}`
        );

        // (3) the member reservation is released: mirrors bin/cli.mjs's
        // unconditional catch-block release (reservation-interop-e2e.test.mjs's
        // "stall-abort" bracket) firing on exactly this kind of caught,
        // typed-abort failure -- driven here by the SAME watchdog-timeout
        // AgentDispatchError this scenario actually produced (scenario.error),
        // not a synthetic reject().
        check(scenario.error instanceof Error, 'expected scenario.error to be the propagated abort error');
        await reservation.releaseAll();
        check(fleetServer.state.get('local') === null, 'expected the member reservation to be released once the stalled dispatch aborts');
    });
});
