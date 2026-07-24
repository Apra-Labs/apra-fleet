import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-02s.2: runner.js's combined-catch dispatch sites used to log every
// failure as "schema-repair exhausted" regardless of whether the underlying
// error was a genuine agent-dispatch failure (AgentDispatchError) or a
// persistent schema-repair exhaustion (AgentOutputError). The Reviewer catch
// site (one of the 6 fixed) now branches on the error type and logs each
// distinctly, while preserving the existing CHANGES_NEEDED fallback verdict
// either way.
// =============================================================================
// NOTE: a Reviewer dispatch failure always falls back to a hardcoded
// CHANGES_NEEDED verdict with empty reopenIds/newTasks (both the
// AgentDispatchError and AgentOutputError branches share that shape,
// unrelated to apra-fleet-02s.2's scope). Stabilization log Issue 9: those
// synthesized verdicts now carry `dispatchFailed: true` and DEGRADE the
// round (counting toward the bounded stall budget) instead of tripping the
// ReviewerContractViolationError guard -- that guard is reserved for a
// GENUINE schema-valid LLM verdict that self-contradicts twice (see
// mock-sprint-stall-contract-violation.test.mjs). These tests only verify
// the LOG WORDING is distinct per error type, which is 02s.2's actual
// scope.
test('mock sprint: Reviewer dispatch failure (AgentDispatchError) is logged distinctly from schema-repair exhaustion', async () => {
    await withScenarioMarkers('reviewerdispatcherr', async () => {
        console.log('Running mock sprint scenario (Reviewer dispatch fails with a structured isError response)...');
        const reviewerDispatchErr = await runDevelopLoopScenario('reviewerdispatcherr', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Reviewer dispatch-error scenario work' }],
            maxCycles: 1,
            reviewerHandler: async () => ({
                content: [{ text: 'simulated fleet-level dispatch failure, not an LLM response' }],
                structuredContent: { isError: true, reason: 'dispatch_failed' },
            }),
        });
        check(
            reviewerDispatchErr.logs.some((m) => m.includes('Reviewer: agent dispatch failed, treating round as CHANGES_NEEDED')),
            `Expected the distinct "agent dispatch failed" log line (not the schema-repair-exhausted wording), logs: ${JSON.stringify(reviewerDispatchErr.logs)}`
        );
        check(
            !reviewerDispatchErr.logs.some((m) => m.includes('Reviewer: schema-repair exhausted')),
            `Did NOT expect the schema-repair-exhausted wording for a genuine dispatch failure, logs: ${JSON.stringify(reviewerDispatchErr.logs)}`
        );
    });
});

test('mock sprint: Reviewer schema-repair exhaustion (AgentOutputError) still uses the original "schema-repair exhausted" wording', async () => {
    await withScenarioMarkers('reviewerschemaerr', async () => {
        console.log('Running mock sprint scenario (Reviewer persistently returns unparseable output)...');
        const reviewerSchemaErr = await runDevelopLoopScenario('reviewerschemaerr', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Reviewer schema-repair-exhaustion scenario work' }],
            maxCycles: 1,
            reviewerHandler: async () => ({
                content: [{ text: 'not valid JSON, simulating persistent schema-repair exhaustion' }],
            }),
        });
        check(
            reviewerSchemaErr.logs.some((m) => m.includes('Reviewer: schema-repair exhausted, treating round as CHANGES_NEEDED')),
            `Expected the original "schema-repair exhausted" wording for persistent invalid output, logs: ${JSON.stringify(reviewerSchemaErr.logs)}`
        );
        check(
            !reviewerSchemaErr.logs.some((m) => m.includes('Reviewer: agent dispatch failed')),
            `Did NOT expect the "agent dispatch failed" wording for a schema-repair exhaustion, logs: ${JSON.stringify(reviewerSchemaErr.logs)}`
        );
    });
});
