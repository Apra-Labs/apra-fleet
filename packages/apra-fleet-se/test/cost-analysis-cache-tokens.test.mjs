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
    // Hand-computed per dispatch, premium fallback = Opus 5.5 list price
    // ($/1M: prompt 4, completion 20, cache read 0.20, 1-hour cache write 8):
    //   0.004 + 0.01 + 0.04 + 0.08 = 0.134; two dispatches = 0.268.
    // The input+output-only figure would be 2 * 0.014 = 0.028.
    assert.match(text, /Tracked spend \(priced dispatches only\): \$0\.2680\./);
    assert.match(text, /Remaining budget: \$4\.7320\./);
    assert.doesNotMatch(text, /\$0\.0280/);
});

test('sprint cost report uses the provider-reported cost_usd as-is when the usage carries one', async () => {
    const api = mockApi();
    api.executePrompt = async () => ({ content: [{ text: 'ok' }], structuredContent: { response: 'ok', usage: { ...CACHE_USAGE, cost_usd: 0.1380048 } } });
    const wf = new FleetWorkflow(api);
    await wf.agent('one', { member_name: 'fleet-dev', model: 'premium' });
    assert.equal(wf.budget.spent(), 0.1380048);
    assert.deepEqual(wf.budget.pricingSummary(), { real: 1, fallback: 0 });
    assert.match(buildCostAnalysis(wf.budget), /Tracked spend \(priced dispatches only\): \$0\.1380\./);
});
