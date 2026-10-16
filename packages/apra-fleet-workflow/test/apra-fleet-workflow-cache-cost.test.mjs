import { test, describe } from 'node:test';
import assert from 'node:assert';
import { FleetWorkflow, BudgetExceededError } from '../src/workflow/index.mjs';
import { calculateCost, billedTokens } from '../src/workflow/pricing.mjs';

// Prompt-cache tokens (cache_read_input_tokens / cache_creation_input_tokens)
// are billed separately from input_tokens. The workflow budget must price
// them on both the real per-member-pricing path and the pricing.mjs fallback
// path, or a cache-heavy sprint reports a fraction of its real spend.

const MEMBER = 'fleet-dev';
// A cache-heavy dispatch: cache reads dwarf fresh input, as in a real sprint.
const CACHE_USAGE = {
    input_tokens: 1_000,
    output_tokens: 500,
    cache_read_input_tokens: 200_000,
    cache_creation_input_tokens: 10_000,
    total_tokens: 1_500,
};

function mockApi({ pricing } = {}) {
    return {
        async executePrompt(payload) {
            return { content: [{ text: `ok: ${payload.prompt}` }], structuredContent: { response: 'ok', usage: CACHE_USAGE } };
        },
        async executeCommand(payload) {
            return { content: [{ text: payload.command }], isError: false };
        },
        async getMemberModelPricing() {
            if (!pricing) throw new Error('Unknown tool: get_member_model_pricing');
            return { content: [{ text: JSON.stringify({ member_id: MEMBER, pricing }) }] };
        },
    };
}

const REAL_PRICING = {
    cheap: null,
    premium: null,
    standard: { model: 'sonnet', promptPrice: 3, completionPrice: 15, cacheReadPrice: 0.3, cacheWritePrice: 3.75 },
};

describe('workflow budget includes prompt-cache tokens', () => {
    test('real per-member pricing path: spent() rises by the cache-inclusive cost', async () => {
        const wf = new FleetWorkflow(mockApi({ pricing: REAL_PRICING }));
        await wf.agent('hello', { member_name: MEMBER, model: 'standard' });
        // Hand-computed ($/1M): input 1_000*3 = 0.003; output 500*15 = 0.0075;
        // cache read 200_000*0.3 = 0.06; cache write 10_000*3.75 = 0.0375.
        // Total 0.108 (the old input+output-only figure was 0.0105).
        assert.ok(Math.abs(wf.budget.spent() - 0.108) < 1e-12, `spent ${wf.budget.spent()}`);
        assert.strictEqual(wf.budget.pricingSummary().real, 1);
    });

    test('real pricing from an older server with no cache rates prices cache tokens at the prompt rate (never drops them)', async () => {
        const wf = new FleetWorkflow(mockApi({
            pricing: { cheap: null, premium: null, standard: { model: 'sonnet', promptPrice: 3, completionPrice: 15 } },
        }));
        await wf.agent('hello', { member_name: MEMBER, model: 'standard' });
        // 0.003 + 0.0075 + 200_000*3/1e6 (0.6) + 10_000*3/1e6 (0.03) = 0.6405
        assert.ok(Math.abs(wf.budget.spent() - 0.6405) < 1e-12, `spent ${wf.budget.spent()}`);
    });

    test('fallback pricing path: spent() rises by the cache-inclusive cost', async () => {
        const wf = new FleetWorkflow(mockApi());
        await wf.agent('hello', { member_name: MEMBER, model: 'premium' });
        // pricing.mjs 'premium' row = Opus 5.5 list price: prompt 4, completion
        // 20, cache read 0.20 (its own 0.05x), 1-hour cache write 8 ($/1M).
        // 1_000*4 = 0.004; 500*20 = 0.01; 200_000*0.2 = 0.04; 10_000*8 = 0.08.
        // Total 0.134 (the input+output-only figure would be 0.014).
        assert.ok(Math.abs(wf.budget.spent() - 0.134) < 1e-12, `spent ${wf.budget.spent()}`);
        assert.strictEqual(wf.budget.pricingSummary().fallback, 1);
    });

    test('a ceiling below the cache-inclusive cost but above the old input+output cost is enforced', async () => {
        const wf = new FleetWorkflow(mockApi());
        // Input+output-only figure per dispatch 0.014, cache-inclusive 0.134:
        // a 0.1 ceiling would not trip under input+output accounting until
        // the 8th dispatch.
        wf.budget.total = 0.1;
        await wf.agent('first', { member_name: MEMBER, model: 'premium' });
        await assert.rejects(
            () => wf.agent('second', { member_name: MEMBER, model: 'premium' }),
            (err) => err instanceof BudgetExceededError,
        );
    });

    test('a usage carrying the provider-reported cost_usd is charged exactly that, on either pricing path', async () => {
        for (const pricing of [REAL_PRICING, undefined]) {
            const api = mockApi({ pricing });
            api.executePrompt = async () => ({ content: [{ text: 'ok' }], structuredContent: { response: 'ok', usage: { ...CACHE_USAGE, cost_usd: 0.1380048 } } });
            const wf = new FleetWorkflow(api);
            await wf.agent('hello', { member_name: MEMBER, model: 'standard' });
            assert.strictEqual(wf.budget.spent(), 0.1380048);
            assert.deepStrictEqual(wf.budget.pricingSummary(), { real: 1, fallback: 0 });
        }
    });

    test('a non-Claude fallback row prices cache tokens at its plain prompt rate', () => {
        // gpt-4o: prompt 5, completion 15.
        const cost = calculateCost('gpt-4o', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 });
        assert.strictEqual(cost, 5);
    });

    test('a usage with only cache tokens is priced, not treated as empty', () => {
        // sonnet = Sonnet 5.5: cache read $0.20/1M.
        const cost = calculateCost('sonnet', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 });
        assert.ok(Math.abs(cost - 0.2) < 1e-12, `cost ${cost}`);
    });

    test('billedTokens counts total_tokens plus both cache counts', () => {
        assert.strictEqual(billedTokens(CACHE_USAGE), 1_500 + 200_000 + 10_000);
        assert.strictEqual(billedTokens({ input_tokens: 2, output_tokens: 3 }), 5);
        assert.strictEqual(billedTokens({ total_tokens: 42 }), 42);
        assert.strictEqual(billedTokens(null), 0);
    });
});
