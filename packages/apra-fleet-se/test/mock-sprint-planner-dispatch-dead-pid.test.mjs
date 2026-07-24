import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-eft.28.2: verifies the fix from apra-fleet-eft.28.1 (commits
// 8b28b757 + f4720eb2), which stops execute_prompt's [interactive] dispatch
// path from silently reusing a persistent MCP/elicitation session whose
// underlying member claude process has already died. That fix is unit-tested
// directly against execute_prompt in tests/execute-prompt-interactive.test.ts
// ("dead interactive session detection (apra-fleet-eft.28.1)"), which proves
// a dead-PID dispatch resolves fast with a structured
// `{ isError: true, reason: 'dispatch_failed' }` payload instead of hanging
// for up to the full timeout_s (observed up to 3600s in apra-fleet-eft.28).
//
// This test exercises the NEXT layer up -- the auto-sprint orchestrator
// (runner.js) that actually issues the Planner dispatch apra-fleet-eft.28
// hung on. `plannerHandler` simulates exactly the fixed execute_prompt
// return value (the fleet-level dispatch failure a dead PID now produces).
// apra-fleet-workflow's agent() wrapper converts that structured isError
// payload into a thrown AgentDispatchError (packages/apra-fleet-workflow/src
// /workflow/index.mjs); runner.js's Planner retry loop
// (PLANNER_DISPATCH_RETRY_DELAYS_MS) then exhausts its retries and
// re-throws, which propagates as a typed WorkflowError all the way to
// main()'s catch (auto-sprint/runner.js `isTypedAbortError` branch), which
// BOTH logs the failure (context.log(), captured here via the 'log' event)
// AND persists it to the sprint state file (context.publishState('terminal',
// ...), captured here via the FleetWorkflow 'state' event) -- matching
// apra-fleet-eft.28.1's "written to the fleet server log AND persisted to
// the sprint state" done-criteria, this time proven at the orchestrator
// dispatch site the original bug actually hung at, not just inside
// execute_prompt itself.
//
// Pre-fix (dead PID silently reused, execute_prompt hangs for the full
// timeout_s / up to 3600s per attempt): this scenario would never resolve
// within any sane test budget -- there would be nothing to assert on. This
// test only became expressible once apra-fleet-eft.28.1 made a dead-PID
// dispatch resolve/reject promptly.
test('mock sprint: Planner dispatch failure from a dead-PID interactive session (dispatch_failed) surfaces a terminal error -- logged AND persisted to sprint state -- instead of hanging', { timeout: 180000 }, async () => {
    await withScenarioMarkers('plannerdeadpid', async () => {
        console.log('Running mock sprint scenario (Planner dispatch always fails with a dead-PID-style dispatch_failed response)...');
        const startedAt = Date.now();
        const plannerResumeFlags = [];
        const scenario = await runDevelopLoopScenario('plannerdeadpid', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Planner dead-PID dispatch-failure scenario work' }],
            maxCycles: 1,
            plannerHandler: async ({ opts }) => {
                plannerResumeFlags.push(opts.resume === true);
                return {
                    content: [{ text: 'simulated dead-PID interactive session -- fleet-level dispatch failure, not an LLM response' }],
                    structuredContent: { isError: true, reason: 'dispatch_failed' },
                };
            },
        });
        const elapsedMs = Date.now() - startedAt;

        // The dispatch settles (rejects) at all -- the defining symptom of
        // apra-fleet-eft.28 was that it NEVER did, so `scenario.error` being
        // populated (rather than the harness call itself hanging until an
        // external kill) is the core regression check.
        check(scenario.error, 'Expected the sprint to abort with a surfaced terminal error, not run to a normal result');

        // Bounded, not silent-until-killed: runner.js's own Planner retry
        // backoff (PLANNER_DISPATCH_RETRY_DELAYS_MS = [0, 5000, 15000,
        // 30000, 60000], ~110s total across 5 attempts) is itself a FINITE,
        // deterministic ceiling -- nowhere near the multi-minutes-with-
        // zero-output silence apra-fleet-eft.28 observed, and nowhere near
        // a single dispatch's up-to-3600s timeout_s.
        //
        // apra-fleet-eft.60.1: this used to assert `elapsedMs < 150000` (only
        // ~40s of headroom above the ~110s fixed backoff). That was the exact
        // same brittle-margin shape eft.54.1 already found and fixed for this
        // file's structurally-identical sibling, mock-sprint-planner-dispatch-
        // attempt1-clean-fail-attempt2-dead-session.test.mjs (eft.50.2): under
        // real bd (APRA_FLEET_BD_MOCK=off), per-attempt real git/dolt
        // sync-bracket overhead plus one-time scenario setup pushed observed
        // elapsed time to 155499ms -- past 150000ms even with every retry's
        // pre-dispatch G-pull/D-pull and post-dispatch G-push/D-push already
        // short-circuited (see withGitSync's skipPreDispatchSync /
        // isNoMutationDispatchFailure short-circuits, apra-fleet-eft.54.1).
        // Anchor to this test's own documented file timeout instead of a
        // hand-tuned figure sitting close above the fixed backoff -- same fix
        // eft.50.2 already applies, for the same reason: it keeps the
        // meaningful discrimination (a fast typed-failure abort, ~110-160s,
        // versus a hung or watchdog-bounded run, which would blow the file
        // timeout anyway) while eliminating the flake.
        const FAST_ABORT_CEILING_MS = 180000; // the test's own file timeout
        check(
            elapsedMs < FAST_ABORT_CEILING_MS,
            `Expected the sprint to abort on its own via fast typed failures (~110s backoff + setup, well under the ${FAST_ABORT_CEILING_MS}ms file timeout) -- not a watchdog-bounded or hung run -- took ${elapsedMs}ms`
        );

        // (a) written to the fleet server log: runner.js logs each failed
        // Planner attempt as it retries, and "Retries exhausted." once the
        // backoff is spent.
        check(
            scenario.logs.some((m) => m.includes('Planner dispatch threw')),
            `Expected a "Planner dispatch threw" log line, logs: ${JSON.stringify(scenario.logs)}`
        );
        check(
            scenario.logs.some((m) => m.includes('Retries exhausted')),
            `Expected the retries-exhausted log line, logs: ${JSON.stringify(scenario.logs)}`
        );

        // (b) persisted to the sprint state file: main()'s typed-abort catch
        // publishState('terminal', ...)s the failure -- surfaced here via
        // the FleetWorkflow 'state' event apra-fleet-eft.28.2 added
        // capture for.
        const terminalStates = scenario.states.filter((s) => s.namespace === 'terminal');
        check(
            terminalStates.length > 0,
            `Expected at least one 'terminal' sprint-state publish, states: ${JSON.stringify(scenario.states)}`
        );
        check(
            terminalStates.some((s) => s.data && s.data.verdict === 'ABORTED'),
            `Expected the terminal state to record verdict ABORTED, states: ${JSON.stringify(terminalStates)}`
        );
        check(
            terminalStates.some((s) => s.data && typeof s.data.message === 'string' && /dispatch_failed/.test(s.data.message)),
            `Expected the persisted terminal state to carry the dispatch_failed marker, states: ${JSON.stringify(terminalStates)}`
        );

        // No code path reuses a dead PID's persistent session: the retry
        // loop's own reason check (only 'max_turns_exhausted' resumes the
        // same session; 'dispatch_failed' does not) means every one of the
        // 5 retry attempts is a fresh, non-resumed dispatch -- never a
        // `resume: true` continuation of a session that (per the simulated
        // dead-PID scenario) can never answer.
        const plannerDispatches = scenario.dispatched.filter((d) => d.agent === 'planner');
        check(plannerDispatches.length > 0, 'Expected at least one Planner dispatch to have been attempted');
        check(
            plannerResumeFlags.length > 0 && plannerResumeFlags.every((resumed) => resumed === false),
            `Expected every Planner dispatch attempt to be a fresh (non-resumed) dispatch, resume flags: ${JSON.stringify(plannerResumeFlags)}`
        );
    });
});
