import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { buildCostAnalysis } from '../fleet-sprint/sprint-report.mjs';

// The sprint cost block (dashboard / sprint summary / PR body) renders the
// workflow budget's tracked spend. A cache-heavy dispatch's prompt-cache
// tokens (cache_read_input_tokens / cache_creation_input_tokens, billed
// separately from input_tokens) must be in that figure -- otherwise the
// report shows a fraction of real spend.

const CACHE_USAGE = {
    input_tokens: 1_000,
    output_tokens: 500,
    cache_read_input_tokens: 200_000,
    cache_creation_input_tokens: 10_000,
    total_tokens: 1_500,
};

function mockApi() {
    return {
        async executePrompt() {
            return { content: [{ text: 'ok' }], structuredContent: { response: 'ok', usage: CACHE_USAGE } };
        },
        async executeCommand(payload) {
            return { content: [{ text: payload.command }], isError: false };
        },
        async getMemberModelPricing() {
            // An older server / unpriced member: exercises the fallback path.
            throw new Error('Unknown tool: get_member_model_pricing');
        },
    };
}

test('sprint cost report renders cache-inclusive tracked spend', async () => {
    const wf = new FleetWorkflow(mockApi());
    await wf.agent('one', { member_name: 'fleet-dev', model: 'premium' });
    await wf.agent('two', { member_name: 'fleet-dev', model: 'premium' });
    wf.budget.total = 5;

    const text = buildCostAnalysis(wf.budget);
    // Hand-computed per dispatch, premium fallback ($/1M: prompt 15,
    // completion 75, cache read 1.5, cache write 18.75):
    //   0.015 + 0.0375 + 0.3 + 0.1875 = 0.54; two dispatches = 1.08.
    // The pre-fix input+output-only figure was 2 * 0.0525 = 0.105.
    assert.match(text, /Tracked spend \(priced dispatches only\): \$1\.0800\./);
    assert.match(text, /Remaining budget: \$3\.9200\./);
    assert.doesNotMatch(text, /\$0\.1050/);
});
