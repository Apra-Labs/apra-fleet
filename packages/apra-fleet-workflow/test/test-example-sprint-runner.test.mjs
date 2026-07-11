import { test, describe } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { FleetWorkflow } from '../src/workflow/index.mjs';
import { WorkflowEngine } from '../src/workflow/engine.mjs';

// Exercises the real examples/02-sprint-runner.js fixture end-to-end via
// WorkflowEngine against a mock fleetApi, asserting that all four Plan ->
// Develop -> Test -> Harvest stages actually run for every issue. This
// fixture used the old broken `sequential(items, ...stages)` multi-stage
// form (F7/F8, apra-fleet-unw.6) under which stages 2-4 silently never ran;
// it now uses `pipeline(items, ...stages)`.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_PATH = path.join(__dirname, '..', 'examples', '02-sprint-runner.js');

const KNOWN_MEMBERS = new Set(['apra-pm']);

/**
 * A mock fleetApi tailored to the prompts issued by
 * examples/02-sprint-runner.js's four pipeline stages, so a full run
 * completes successfully for every issue without needing a live LLM.
 */
function createMockFleetApi() {
    return {
        async executePrompt(payload) {
            const memberKey = payload.member_name || payload.member_id;
            if (!KNOWN_MEMBERS.has(memberKey)) {
                return { content: [{ text: `Member "${memberKey}" not found.` }] };
            }

            const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
            const prompt = payload.prompt || '';

            if (prompt.startsWith('Create a plan for issue')) {
                return { content: [{ text: JSON.stringify({ tasks: ['do the thing'], complexity: 'Low' }) }], usage };
            }
            if (prompt.startsWith('Develop code for')) {
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', notes: 'implemented' }) }], usage };
            }
            if (prompt.startsWith('Run tests for')) {
                return { content: [{ text: JSON.stringify({ passed: true, notes: 'all green' }) }], usage };
            }
            if (prompt.startsWith('Verify harvest success for')) {
                return { content: [{ text: JSON.stringify({ status: 'OK', notes: 'merged' }) }], usage };
            }

            return { content: [{ text: `Mock response to: ${prompt.slice(0, 60)}` }], usage };
        },

        async executeCommand(payload) {
            const memberKey = payload.member_name || payload.member_id;
            if (!KNOWN_MEMBERS.has(memberKey)) {
                return { content: [{ text: `Member "${memberKey}" not found.` }] };
            }
            return { content: [{ text: payload.command }], isError: false };
        }
    };
}

describe('examples/02-sprint-runner.js (pipeline-based multi-stage flow)', () => {
    test('runs the Plan, Develop, Test, and Harvest stages for every issue under a mock fleetApi', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const engine = new WorkflowEngine(wf);

        const seenPhaseLogs = [];
        wf.on('log', ({ msg }) => seenPhaseLogs.push(msg));

        const result = await engine.executeFile(EXAMPLE_PATH);

        assert.deepStrictEqual(result, { status: 'success', cyclesRun: 1 });

        // Default fixture issues are ['BD-1', 'BD-2']; assert every stage ran
        // for both, proving the pipeline() call chains all four stages
        // instead of silently only running the first (the old F7/F8 bug).
        for (const issueId of ['BD-1', 'BD-2']) {
            assert.ok(seenPhaseLogs.some((m) => m.includes(`[Plan Phase] Planning for issue: ${issueId}`)), `missing Plan log for ${issueId}`);
            assert.ok(seenPhaseLogs.some((m) => m.includes(`[Develop Phase] Developing for issue: ${issueId}`)), `missing Develop log for ${issueId}`);
            assert.ok(seenPhaseLogs.some((m) => m.includes(`[Test Phase] Testing issue: ${issueId}`)), `missing Test log for ${issueId}`);
            assert.ok(seenPhaseLogs.some((m) => m.includes(`[Harvest Phase] Harvesting issue: ${issueId}`)), `missing Harvest log for ${issueId}`);
        }
    });
});
