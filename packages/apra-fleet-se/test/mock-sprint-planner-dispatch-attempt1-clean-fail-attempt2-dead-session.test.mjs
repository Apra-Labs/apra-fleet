import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { bdMode, realSyncSpawnCount } from './helpers/bd-replay.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-eft.50.2: regression verification for bug apra-fleet-eft.50,
// pinning the fix in apra-fleet-eft.50.1 (commit 41cc5880, "re-arm dead
// interactive-session guard on every dispatch retry").
//
// mock-sprint-planner-dispatch-dead-pid.test.mjs (eft.28.2) proves EVERY
// retry attempt failing cleanly (dispatch_failed) resolves fast and
// terminally. mock-sprint-planner-dispatch-stalled-session.test.mjs (eft.28.4)
// proves EVERY retry attempt hanging is still bounded by the client-side
// dispatch watchdog. Neither covers the MIXED ordering apra-fleet-eft.50
// actually reproduced live: retry attempt 1/5 failed fast and cleanly (an
// AGENT_DISPATCH_FAILED-class failure, matching eft.48's auth-failure
// precondition), and it was specifically retry attempt 2/5 -- reusing the
// SAME persistent interactive session, now targeting a dead launch-time
// process -- that went completely silent for 6+ minutes with zero further
// log lines and a frozen sprint-state updatedAt. Per eft.50's own "Fix
// direction": "the liveness/eviction logic may only be wired to the very
// first dispatch attempt's session, not re-armed for each subsequent retry's
// fresh attempt" -- i.e. attempt 1 having already (cleanly) failed is a
// necessary PRECONDITION for the bug, not incidental to it.
//
// eft.50.1's actual fix (sessionRegistry.lastKnownPid(), the durable
// per-member launch-pid anchor that survives the unregister/reconnect churn
// between retry attempts) lives entirely on the MCP-server side, INSIDE
// execute_prompt/session-registry.ts -- a layer this mock-sprint harness
// intentionally treats as opaque (buildMockFleetApi's plannerHandler stands
// in for the whole server-side executePrompt() call). That means the exact
// server-internal mechanism eft.50.1 fixed is unit-tested directly against
// real code in tests/execute-prompt-interactive.test.ts's "dead interactive
// session detection across retries (apra-fleet-eft.50.1)" describe block
// (root package, vitest) -- see especially its "evicts and re-dispatches
// fresh a reused session whose live pid is undefined (lost on reconnect) but
// whose lastKnownPid points at a dead process" case, which is this same
// dead-session-on-reconnect shape.
//
// What THIS test adds at the orchestrator layer (apra-fleet-se's own suite,
// per this task's "Runs in the existing apra-fleet-se test suite" done
// criterion) is the ORDERING eft.46/eft.28's existing regression tests never
// exercised: attempt 1 must be a genuinely DISTINCT, already-settled clean
// failure -- not the very first thing this run does -- before attempt 2's
// dead-session case is even reached. `plannerHandler` below tracks attempt
// number explicitly and asserts on it, so a future regression that only
// re-arms the guard for the FIRST dispatch (attempt 1) and not subsequent
// retries would show up here as attempt 2 needing the ~90s client-side
// watchdog ceiling (or hanging past it) to resolve, instead of failing fast
// with its own typed error the same way attempt 1 did -- exactly the
// eft.50.1-fixed behavior this test pins.
// =============================================================================

test('mock sprint: Planner retry attempt 1 fails cleanly (dispatch_failed) as a distinct precondition, THEN attempt 2 (reusing a dead-session-reconnect) also fails fast with its own typed error -- never silently hangs, never needs the watchdog ceiling to resolve', { timeout: 180000 }, async () => {
    await withScenarioMarkers('planner502ordering', async () => {
        console.log('Running mock sprint scenario (Planner attempt 1 clean dispatch_failed, THEN attempt 2+ targets a dead-session reconnect and must also fail fast)...');
        const startedAt = Date.now();
        const plannerResumeFlags = [];
        let plannerAttempt = 0;

        const scenario = await runDevelopLoopScenario('planner502ordering', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Planner attempt-1-clean-fail-then-attempt-2-dead-session ordering scenario work' }],
            maxCycles: 1,
            plannerHandler: async ({ opts }) => {
                plannerAttempt += 1;
                plannerResumeFlags.push(opts.resume === true);

                if (plannerAttempt === 1) {
                    // Attempt 1/5: a genuinely distinct, already-settled clean
                    // failure -- fast, typed, fully logged -- matching eft.48's
                    // real precondition (an AGENT_DISPATCH_FAILED-class
                    // failure, e.g. a transient auth/transport error). This is
                    // NOT the dead-session case; it must resolve and be
                    // retried before attempt 2 is ever reached.
                    return {
                        content: [{ text: 'simulated attempt 1/5: clean AGENT_DISPATCH_FAILED-class failure (transient, non-session-related) -- matches the eft.48 precondition this ordering depends on' }],
                        structuredContent: { isError: true, reason: 'dispatch_failed' },
                    };
                }

                // Attempt 2/5 onward: the SAME persistent interactive session
                // reused from attempt 1 now targets a dead launch-time
                // process (the reconnect-loses-pid case eft.50.1 fixes
                // server-side via sessionRegistry.lastKnownPid). The fixed,
                // observable behavior at THIS dispatch boundary is that this
                // resolves with its OWN fast, typed dispatch_failed error --
                // exactly like attempt 1 -- rather than a promise that never
                // settles (the pre-fix symptom, which mock-sprint-planner-
                // dispatch-stalled-session.test.mjs already proves is merely
                // BOUNDED by the ~90s client-side watchdog, not fast). A
                // regression that only re-arms the dead-session guard for the
                // very first attempt would leave this case relying on that
                // slower watchdog ceiling (or hanging past it) instead.
                return {
                    content: [{ text: `simulated attempt ${plannerAttempt}/5: reused interactive session now targets a dead launch-time process -- fast eviction + typed dispatch failure, not a hang` }],
                    structuredContent: { isError: true, reason: 'dispatch_failed' },
                };
            },
        });
        const elapsedMs = Date.now() - startedAt;

        // The dispatch settles (rejects) at all -- the defining pre-fix
        // symptom (apra-fleet-eft.50, same family as eft.28) was that retry
        // attempt 2 NEVER did.
        check(scenario.error, 'Expected the sprint to abort with a surfaced terminal error, not run to a normal result');

        // Attempt 1 is a genuinely distinct precondition: both attempt 1 (the
        // clean, non-session failure) AND attempt 2+ (the dead-session
        // failure) must actually have been dispatched, in that order, and
        // every attempt through the retry ladder must have been exhausted
        // (dispatch_failed is retryable -- there is no reason for the loop to
        // stop early).
        check(plannerAttempt === 5, `Expected exactly 5 Planner dispatch attempts (the full retry ladder), got ${plannerAttempt}`);

        // Bounded, and specifically FAST -- nowhere near the ~90s-per-attempt
        // client-side watchdog ceiling mock-sprint-planner-dispatch-stalled-
        // session.test.mjs exercises for a genuinely stalled session (5
        // attempts x ~90s ~= 450s if every attempt hit it), and nowhere near
        // apra-fleet-eft.50's observed 6m+ (360s+) silent hang on retry attempt
        // 2 alone. Every attempt here fails via its own typed error, so the
        // real elapsed time is just the one-time real-bd scenario setup/read
        // overhead plus normal per-attempt dolt/bd work.
        //
        // apra-fleet-eft.60.3: the fixed PLANNER_DISPATCH_RETRY_DELAYS_MS
        // backoff (~110s total across the 5 attempts) used to dominate this
        // elapsed and sat right under the 180s file timeout, so on a slow CI
        // host the one-time real-bd overhead stacked on top of it could tip the
        // run over the timeout (observed 180003ms). That ~110s backoff only
        // models a real fleet member's execute_prompt busy-lock clearing; there
        // is no such lock in this in-process mock, so the mock-sprint harness
        // now opts the runner into a zero-wait backoff (see mock-sprint-
        // harness.mjs / runner.js APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF). The
        // runner still runs the FULL 5-attempt ladder and still logs each
        // "waiting Ns" line with the real configured delay (asserted below);
        // production keeps the real timed backoff and unchanged delay values.
        // The per-attempt real-bd D-pull is NOT the cost here either: it is
        // skipped on retries 2..N by withGitSync's skipPreDispatchSync
        // (eft.54.1) and cached per-clone under real bd by bd-replay's
        // realDoltSyncCache (eft.17.1 / eft.54.5).
        //
        // apra-fleet-eft.54.1: this bound stays anchored to the test's own
        // documented file timeout ({ timeout: 180000 } above), NOT a hand-tuned
        // ceiling -- it keeps the meaningful discrimination (a fast typed-
        // failure abort versus a watchdog-bounded ~450s or 6m+ hung run) while
        // eliminating the flake, since anything watchdog-bounded or hung is
        // comfortably above 180s (and the file timeout would fail the test
        // first regardless).
        const FAST_ABORT_CEILING_MS = 180000; // the test's own file timeout
        check(
            elapsedMs < FAST_ABORT_CEILING_MS,
            `Expected the sprint to abort on its own via fast typed failures (well under the ${FAST_ABORT_CEILING_MS}ms file timeout) -- not a watchdog-bounded (~450s) or 6m+ hung run -- took ${elapsedMs}ms`
        );

        // No code path resumes a dead session's persistent channel: every one
        // of the 5 attempts (attempt 1's clean failure included) is a fresh,
        // non-resumed dispatch.
        const plannerDispatches = scenario.dispatched.filter((d) => d.agent === 'planner');
        check(plannerDispatches.length > 0, 'Expected at least one Planner dispatch to have been attempted');
        check(
            plannerResumeFlags.length === 5 && plannerResumeFlags.every((resumed) => resumed === false),
            `Expected every Planner dispatch attempt (all 5) to be a fresh (non-resumed) dispatch, resume flags: ${JSON.stringify(plannerResumeFlags)}`
        );

        // (a) written to the fleet server log, continuously -- no frozen
        // silent gap between attempt 1's clean failure and the eventual
        // abort. Every attempt (1 through 5) logs its own "Planner dispatch
        // threw" line, and every retry (attempts 2-5) is preceded by its own
        // "waiting Ns before retry attempt" line -- i.e. the log itself
        // keeps advancing all the way through, unlike the pre-fix 6m+ run of
        // total silence starting partway into attempt 2.
        const threwLines = scenario.logs.filter((m) => m.includes('Planner dispatch threw'));
        check(
            threwLines.length === 5,
            `Expected one "Planner dispatch threw" log line per attempt (5 total), got ${threwLines.length}: ${JSON.stringify(scenario.logs)}`
        );
        const waitingLines = scenario.logs.filter((m) => /waiting \d+s before retry attempt/.test(m));
        check(
            waitingLines.length === 4,
            `Expected one "waiting Ns before retry attempt" log line between each of the 5 attempts (4 total), got ${waitingLines.length}: ${JSON.stringify(scenario.logs)}`
        );
        check(
            scenario.logs.some((m) => m.includes('Retries exhausted')),
            `Expected the retries-exhausted log line, logs: ${JSON.stringify(scenario.logs)}`
        );

        // The watchdog/timeout is NOT the mechanism that eventually rescues
        // this: a "[dispatch-watchdog]" log line only ever appears when its
        // own local (dispatch_timeout_s + 30s grace) timer actually fires on
        // a promise that never settled on its own -- exactly the pre-fix
        // symptom this ordering must NOT reproduce. Every attempt here
        // settles on its own, fast, via a typed dispatch_failed error, so
        // this line must never appear.
        check(
            scenario.logs.every((m) => !m.includes('[dispatch-watchdog]')),
            `Expected no "[dispatch-watchdog]" log line -- every attempt must fail fast on its own typed error, not rely on the watchdog ceiling: ${JSON.stringify(scenario.logs)}`
        );

        // (b) persisted to the sprint state file: main()'s typed-abort catch
        // publishState('terminal', ...)s the failure -- same plumbing
        // apra-fleet-eft.28.2 already proved flows through here.
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
            `Expected the persisted terminal state to carry the dispatch_failed marker (the attempt-2+ dead-session failure's own typed reason, not a watchdog-timeout marker), states: ${JSON.stringify(terminalStates)}`
        );

        // apra-fleet-eft.60.4: regression pin for eft.60.3's fix, at the
        // real-spawn level rather than just the elapsedMs budget above.
        // `commandLog` (asserted on elsewhere in this suite) only records
        // logical requests issued to executeCommand -- it cannot tell "issued
        // N times, served from the per-clone cache" apart from "actually
        // spawned N times". `realSyncSpawnCount` reads bd-replay.mjs's
        // real-mode dolt-sync cache directly, so it proves the CACHING
        // mechanism itself (not just this run's wall-clock) is what's keeping
        // this ladder fast: a regression that re-introduced a fresh real `bd
        // dolt pull` / sync-remote-probe spawn per Planner retry attempt
        // would inflate these counts (toward 5+, one per attempt, across the
        // orchestrator's own pre-sprint/pre-plan D-pulls too) even on a fast
        // host where elapsedMs alone might not catch it.
        //
        // Only meaningful under real bd (APRA_FLEET_BD_MOCK=off): in the
        // default replay mode, dolt-sync commands are synthesized directly in
        // runCmd() and never touch this cache at all (see bd-replay.mjs), so
        // both counts are trivially 0 there regardless of caching behavior.
        if (bdMode() === 'real') {
            // This scenario's beads clone (a bare `bd init` scratch dir, no
            // git origin) has no configured dolt sync.remote, so
            // isMemberSyncRemoteConfigured's pre-gate probe short-circuits
            // EVERY doltPullBefore() call in this run -- across the
            // orchestrator's own setup/pre-plan D-pulls AND all 5 Planner
            // retry attempts -- to a skip before the real 'bd dolt pull'
            // command is ever issued. So the real 'bd dolt pull' spawn itself
            // must fire zero times here; asserting "at most once" (rather
            // than "exactly zero") keeps this pin robust to a future harness
            // change that configures a sync.remote for this scenario, while
            // still catching the eft.60 regression (which would blow well
            // past 1 by re-spawning per attempt).
            const doltPullSpawns = realSyncSpawnCount(scenario.tempDir, /^bd\s+dolt\s+pull$/);
            check(
                doltPullSpawns <= 1,
                `Expected the real 'bd dolt pull' bracket to spawn at most once across the whole 5-attempt ladder (cached per clone, eft.17.1/eft.54.5), got ${doltPullSpawns} real spawn(s)`
            );

            // The cheap-but-still-real `bd config get sync.remote --json`
            // pre-gate probe every D-pull/D-push bracket consults (eft.54.5)
            // IS actually exercised many times over in this run (every
            // doltPullBefore call issues it, gate skip or not) -- so this
            // count is the more direct proof the cache is doing its job here.
            const syncRemoteProbeSpawns = realSyncSpawnCount(scenario.tempDir, /^bd\s+config\s+get\s+sync\.remote\b/);
            check(
                syncRemoteProbeSpawns <= 1,
                `Expected the 'bd config get sync.remote' pre-gate probe to spawn at most once across the whole scenario (cached per clone, eft.54.5), got ${syncRemoteProbeSpawns} real spawn(s) -- a regression here would mean re-introduced per-attempt Dolt overhead`
            );
        }
    });
});
