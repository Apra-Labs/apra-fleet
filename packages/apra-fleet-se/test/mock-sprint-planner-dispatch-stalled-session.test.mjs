import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { createMemberReservationClient } from '../auto-sprint/runner.js';

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
// runSprintCycle's Planner retry loop (PLANNER_DISPATCH_RETRY_DELAYS_MS =
// [0, 5000, 15000, 30000, 60000]) retries EVERY dispatch failure -- including
// a watchdog timeout, which is not special-cased -- so a plannerHandler that
// ALWAYS stalls exhausts all 5 attempts before the sprint aborts. Each
// attempt's watchdog budget is (dispatch_timeout_s + 30s grace) = 90s at the
// floor, so this test's real, unavoidable floor is
// 5*90s + (0+5+15+30+60)s of retry backoff = 450s + 110s = ~560s. Fake timers
// (the technique dispatch-watchdog.test.mjs uses for direct, function-level
// withDispatchWatchdog() coverage) were tried here and rejected: this
// scenario's dispatch path also issues real `bd config get sync.remote
// --json` child-process calls (via withGitSync's dolt pre-attempt gate) on
// EVERY retry attempt, and Node's `child_process.exec()` never resolves at
// all once `node:test`'s `mock.timers` has replaced the global `setTimeout`
// it depends on internally -- confirmed by direct repro (a bare `bd init`
// exec() call hangs forever under `mock.timers.enable({ apis: ['setTimeout']
// })`). So this test pays the real ~560s ceiling rather than a mocked one;
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

// See the file-level comment above for why this ceiling is ~560s (not a
// smaller mocked figure) and a generous but still-bounded real-time test
// timeout.
const REAL_TIME_CEILING_MS = 620000;

test('mock sprint: interactive Planner dispatch against a stalled/dead member session (no progress, pre-plan) aborts with a terminal error within dispatch_timeout_s -- logged AND persisted -- releases the member reservation, and never hangs', { timeout: REAL_TIME_CEILING_MS + 30000 }, async () => {
    await withScenarioMarkers('plannerstalledsession', async () => {
        // "short dispatch_timeout_s" per this task's ask -- 60 is the lowest
        // value validateArgs accepts (must be an integer >= 60).
        const DISPATCH_TIMEOUT_S = 60;
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
        const startedAt = Date.now();

        const scenario = await runDevelopLoopScenario('plannerstalledsession', {
            members,
            taskSpecs: [{ title: 'Task: Planner stalled-session dispatch scenario work' }],
            maxCycles: 1,
            branchOverride: branch,
            dispatchTimeoutS: DISPATCH_TIMEOUT_S,
            plannerHandler: async () => {
                plannerDispatchCount++;
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

        // Bounded, not silent-until-killed: see the file-level comment for the
        // exact derivation of this ceiling (5 watchdog-bounded attempts +
        // fixed retry backoff). Nowhere near "hangs forever" (apra-fleet-eft.28
        // pre-fix) or the up-to-3600s default single-dispatch timeout_s.
        check(
            elapsedMs < REAL_TIME_CEILING_MS,
            `Expected the sprint to abort within the derived real-time ceiling (~560s), took ${elapsedMs}ms`
        );

        check(plannerDispatchCount >= 1, 'expected at least one interactive Planner dispatch attempt');

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
