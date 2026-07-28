import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// apra-fleet-eft.75.3 -- end-to-end verification of the apra-fleet-eft.75 fix,
// through the REAL runner.js call site rather than only the isolated
// createMemberSessionGuard unit tests (member-session-guard.test.mjs) or the
// standalone pidfile-lock tests (sprint-lock.test.mjs /
// sprint-lock-engine-wiring.test.mjs).
//
// Root incident: engine resume of a presumed-dead/timed-out session
// re-dispatched to the same member WITHOUT first confirming the prior
// attempt's process had actually exited -- both stayed alive concurrently
// for 50+ minutes.
//
// This test drives an actual doer max_turns-exhausted -> resume cycle
// through runSprintCycle()/main() (via WorkflowEngine.executeFile(), exactly
// as bin/cli.mjs invokes it in production) and injects a spy `args.callTool`
// -- the same known arg key bin/cli.mjs wires from its live
// `mcpClient.callTool` (apra-fleet-eft.75.1) -- to prove the REAL resume
// call site (runner.js's doer max-turns resume ladder, ~line 5649) calls
// `memberSessionGuard.killIfAlive(doerMember)` -- which calls the fleet's
// `stop_prompt` tool via callTool -- and that this call completes BEFORE the
// resume dispatch is fired, i.e. no two concurrent sessions.
// =============================================================================
test('mock sprint: a max_turns-exhausted doer streak resume calls the REAL pre-resume session guard (stop_prompt via callTool) before the resume dispatch fires', async () => {
    await withScenarioMarkers('doermaxturnsguard', async () => {
        console.log('Running mock sprint scenario (doer streak max_turns_exhausted -> resume, with a real callTool spy proving the pre-resume session guard fires first)...');
        const order = [];
        let doerCalls = 0;

        const result = await runDevelopLoopScenario('doermaxturnsguard', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: doer max_turns session-guard wiring scenario work' }],
            maxCycles: 1,
            callTool: async (name, args) => {
                order.push(`callTool:${name}:${args && args.member_name}`);
                return '[OK] killed stale process';
            },
            doerHandler: async ({ opts }) => {
                doerCalls += 1;
                if (doerCalls === 1) {
                    order.push('doer-dispatch-original');
                    return {
                        content: [{ text: 'stopped after max turns, simulating a max_turns-exhausted doer dispatch' }],
                        structuredContent: { isError: true, reason: 'max_turns_exhausted' },
                    };
                }
                order.push(`doer-dispatch-resume(resume=${opts.resume})`);
                return {
                    content: [{
                        text: JSON.stringify({ status: 'VERIFY', closedIds: [], notes: 'Completed on resume.' }),
                    }],
                };
            },
        });

        check(
            order.includes('callTool:stop_prompt:local'),
            `Expected the real pre-resume guard to call stop_prompt('local') via the injected callTool, order: ${JSON.stringify(order)}`
        );
        const stopIdx = order.indexOf('callTool:stop_prompt:local');
        const resumeIdx = order.findIndex((e) => e.startsWith('doer-dispatch-resume'));
        check(
            stopIdx !== -1 && resumeIdx !== -1 && stopIdx < resumeIdx,
            `Expected stop_prompt to fire BEFORE the resume dispatch (kill-before-second-session), order: ${JSON.stringify(order)}`
        );
        check(
            result.logs.some((m) => m.includes("pre-resume stop_prompt for 'local'") && m.includes('killed stale process')),
            `Expected the guard's own log line reporting the stop_prompt result, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

function check(cond, msg) {
    assert.ok(cond, msg);
}
