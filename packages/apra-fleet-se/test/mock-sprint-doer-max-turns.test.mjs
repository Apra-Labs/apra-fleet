import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-p4f.3: a doer streak that exhausts its turn limit (max_turns)
// deterministically exhausts again on an identical blind retry (same prompt,
// same max_turns) -- runner.js's doer-retry wrapper must NOT treat this the
// same as a generic transient dispatch failure. It now checks the
// AgentDispatchError's threaded reason (apra-fleet-p4f.1/p4f.2's server-side
// plumbing) and skips the identical retry, flagging the streak distinctly
// instead.
// =============================================================================
test('mock sprint: a max_turns-exhausted doer streak is flagged distinctly, not blindly retried', async () => {
    await withScenarioMarkers('doermaxturns', async () => {
        console.log('Running mock sprint scenario (doer streak dispatch reports max_turns_exhausted)...');
        const result = await runDevelopLoopScenario('doermaxturns', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: doer max_turns scenario work' }],
            maxCycles: 1,
            doerHandler: async () => ({
                content: [{ text: 'stopped after max turns, simulating a max_turns-exhausted doer dispatch' }],
                structuredContent: { isError: true, reason: 'max_turns_exhausted' },
            }),
        });

        check(
            result.logs.some((m) => m.includes('exhausted its turn limit (max_turns)') && m.includes('not retrying identically')),
            `Expected the distinct max_turns log line, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            !result.logs.some((m) => /Doer streak .* threw:.*Retrying once\.$/.test(m)),
            `Did NOT expect the generic blind-retry log line for a max_turns dispatch, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

test('mock sprint: a generic (non-max_turns) doer dispatch failure still gets the blind retry-once', async () => {
    await withScenarioMarkers('doergenericretry', async () => {
        console.log('Running mock sprint scenario (doer streak dispatch fails generically, then succeeds on retry)...');
        let calls = 0;
        const result = await runDevelopLoopScenario('doergenericretry', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: doer generic-retry scenario work' }],
            maxCycles: 1,
            doerHandler: async ({ opts }) => {
                calls++;
                if (calls === 1) {
                    return {
                        content: [{ text: 'transient dispatch failure, simulating a generic (non-max_turns) doer error' }],
                        structuredContent: { isError: true, reason: 'dispatch_failed' },
                    };
                }
                const beadIdMatch = opts.prompt.match(/apra-fleet-mock-sprint-\S+/);
                return {
                    content: [{
                        text: JSON.stringify({
                            status: 'VERIFY',
                            closedIds: beadIdMatch ? [beadIdMatch[0]] : [],
                            notes: 'Recovered on retry.',
                        }),
                    }],
                };
            },
        });

        check(
            result.logs.some((m) => /Doer streak .* threw:.*Retrying once\.$/.test(m)),
            `Expected the generic blind-retry log line for a non-max_turns dispatch failure, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            !result.logs.some((m) => m.includes('exhausted its turn limit (max_turns)')),
            `Did NOT expect the max_turns-specific log line for a generic dispatch failure, logs: ${JSON.stringify(result.logs)}`
        );
    });
});
