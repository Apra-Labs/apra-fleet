import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanReviewDispatchFailedError } from '../fleet-sprint/errors.mjs';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// Runs in its own file (own process) so it can replay the same bd recording
// as plan-reviewer-dispatch-failure.test.mjs's all-rounds scenario: the bd
// command sequence is identical, only the dispatch failure SHAPE differs.
// A dispatch that fails at the fleet TRANSPORT (the MCP server returned the
// tool handler's thrown error as {content, isError:true} -- e.g. an SSH channel
// to a remote member that could not be opened) is not model output: it must be
// classified as a dispatch failure, never fed to schema repair, and the
// terminal sprint failure must name the member and the transport error.
test('mock sprint: plan-reviewer SSH transport failure (MCP isError) issues zero schema-repair dispatches and the failure names member + transport error', async () => {
    await withScenarioMarkers('plan-reviewer SSH transport failure is not schema output', async () => {
        const SSH_FAILURE = '(SSH) Channel open failure: open failed';
        let planReviewerCalls = 0;
        const sc = await runDevelopLoopScenario('prdispatchfail', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: plan-reviewer all-rounds dispatch-failure scenario work' }],
            maxCycles: 1,
            planReviewerHandler: async () => {
                planReviewerCalls++;
                return { content: [{ type: 'text', text: SSH_FAILURE }], isError: true };
            },
        });

        check(sc.error instanceof PlanReviewDispatchFailedError,
            `Expected PlanReviewDispatchFailedError, got: ${sc.error ? sc.error.constructor.name + ': ' + sc.error.message : 'no error'}`);
        // 3 rounds x 2 ladder attempts; any schema repair would add re-asks on top.
        check(planReviewerCalls === 6, `Expected exactly 6 plan-reviewer dispatches (no schema-repair re-asks), got ${planReviewerCalls}`);
        check(!sc.logs.some((m) => m.includes('Schema-invalid output') || m.includes('schema-repair exhausted')),
            `Expected no schema-repair log lines, logs: ${JSON.stringify(sc.logs.filter((m) => /schema/i.test(m)))}`);
        check(sc.logs.some((m) => m.includes('agent dispatch failed') && m.includes('transport_failure')),
            'Expected the ladder to classify the failure as a dispatch (transport) failure');
        check(/member '[^']+'/.test(sc.error.message) && sc.error.message.includes(SSH_FAILURE),
            `Expected the sprint failure message to name the member and the transport error, got: ${sc.error.message}`);
    });
});
