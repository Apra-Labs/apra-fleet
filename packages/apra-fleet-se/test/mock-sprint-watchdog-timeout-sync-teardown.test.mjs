import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-9ta.2: a watchdog_timeout dispatch failure must NOT skip
// withGitSync's post-dispatch sync teardown.
//
// isNoMutationDispatchFailure() used to answer TRUE for every
// AgentDispatchError except 'max_turns_exhausted', which swept in
// withDispatchWatchdog()'s own 'watchdog_timeout' rejection -- and a watchdog
// timeout is emphatically NOT a no-mutation failure. The watchdog fires on an
// ALREADY-IN-FLIGHT dispatch: the prompt was delivered, the member is
// alive-but-silent, and the planning turn may have run to completion and
// created the ENTIRE bead DAG. Only the RESULT was lost. Skipping the
// G-push/D-push teardown there strands that freshly-created DAG in the
// member's local clone, invisible to every later dispatch and to the
// orchestrator.
//
// This scenario drives the real runner.js Planner dispatch site (the one
// withDispatchWatchdog is actually wired around, fleet-sprint/runner.js
// dispatchPlannerOnce) and makes each attempt fail with EXACTLY the error
// shape the watchdog produces: agent() converts a
// `structuredContent: { isError: true, reason: 'watchdog_timeout' }` response
// into an `AgentDispatchError` carrying `details.reason === 'watchdog_timeout'`
// (packages/apra-fleet-workflow/src/workflow/index.mjs), byte-identical input
// to the predicate under test. Simulating the failure at the dispatch seam --
// rather than letting the real timer fire -- keeps this test in the FAST mock
// suite: dispatch_timeout_s has a hard floor of 60s and the Planner retry
// ladder runs 5 attempts, so a real-timer version costs ~560s (that is
// test/slow/mock-sprint-planner-dispatch-stalled-session.test.mjs, which
// covers the timer itself; the predicate's routing is what this file covers).
//
// Pre-fix, the run logs "[Sync] Skipping post-dispatch G-push/D-push ...
// (nothing to publish)" for every attempt and the planner's beads writes are
// never published. Post-fix the teardown runs on every attempt.
// =============================================================================
test('mock sprint: a watchdog_timeout Planner dispatch failure still runs the post-dispatch sync teardown, publishing the beads the stalled planner already created', { timeout: 180000 }, async () => {
    await withScenarioMarkers('plannerwatchdogsync', async () => {
        let plannerAttempts = 0;
        let createdBeadId = null;

        const scenario = await runDevelopLoopScenario('plannerwatchdogsync', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: watchdog-timeout sync-teardown scenario work' }],
            maxCycles: 1,
            plannerHandler: async ({ tempDir, runCmd }) => {
                plannerAttempts++;
                if (plannerAttempts === 1) {
                    // The work a stalled-but-alive planner may already have
                    // committed to its local beads clone before going silent.
                    // This is the state the teardown exists to publish.
                    const createRes = await runCmd(
                        'bd create -t task "Task: DAG bead created by the planner before it went silent" -d "Created by the planner turn that then stalled; the watchdog abandoned the dispatch promise, not this write." --silent',
                        tempDir,
                    );
                    createdBeadId = (createRes.stdout || '').trim();
                }
                return {
                    content: [{ text: 'simulated alive-but-silent member session -- the watchdog abandoned this dispatch' }],
                    structuredContent: { isError: true, reason: 'watchdog_timeout' },
                };
            },
        });

        check(plannerAttempts > 0, 'expected at least one Planner dispatch attempt');
        check(scenario.error, 'expected the sprint to abort once the Planner retry ladder is exhausted');
        check(
            createdBeadId,
            `expected the stalled planner to have created a real bead before the watchdog fired, got ${JSON.stringify(createdBeadId)}`,
        );

        // THE regression assertion: withGitSync must never short-circuit its
        // teardown on a watchdog_timeout. This exact log line is emitted only
        // by the isNoMutationDispatchFailure() branch.
        const skipLines = scenario.logs.filter((m) => m.includes('Skipping post-dispatch G-push/D-push'));
        check(
            skipLines.length === 0,
            `expected NO post-dispatch teardown skip after a watchdog_timeout (the planner may have created the whole DAG), got: ${JSON.stringify(skipLines)}`,
        );

        // The positive half: the teardown genuinely RAN, rather than merely
        // not being announced as skipped. The Planner bracket is dispatched
        // with pushBeads:true, so its teardown reaches doltPushAfter(), whose
        // pre-attempt sync.remote gate logs this line in the hermetic mock
        // (the scratch bd clone has no sync.remote configured).
        check(
            scenario.logs.some((m) => /\[Dolt\] D-push for member 'local'/.test(m)),
            `expected the post-dispatch D-push teardown to have run for the planner member, logs: ${JSON.stringify(scenario.logs)}`,
        );

        // ...and it ran for EVERY failed attempt, not just an incidental one.
        const dPushLines = scenario.logs.filter((m) => /\[Dolt\] D-push for member 'local'/.test(m));
        check(
            dPushLines.length >= plannerAttempts,
            `expected at least one post-dispatch D-push per watchdog-failed Planner attempt (${plannerAttempts}), saw ${dPushLines.length}`,
        );

        // The bead the stalled planner created is real, live state this run
        // must account for -- not a no-mutation dispatch whose bead DB can be
        // assumed untouched (mock-sprint-harness's own
        // isNoMutationTerminalDispatchError makes the same watchdog_timeout
        // exclusion, so this post-run read is not skipped).
        check(
            scenario.finalBeadsById.has(createdBeadId),
            `expected the planner-created bead ${createdBeadId} to be present in the post-run bead state, saw: ${JSON.stringify([...scenario.finalBeadsById.keys()])}`,
        );
    });
});
