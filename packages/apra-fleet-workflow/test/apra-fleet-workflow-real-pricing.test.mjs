import { test, describe } from 'node:test';
import assert from 'node:assert';
import { FleetWorkflow } from '../src/workflow/index.mjs';

// apra-fleet-dv5.6: real per-member pricing (get_member_model_pricing),
// preferred over pricing.mjs's tier-band fallback, with graceful
// degradation when the tool is unavailable/errors/returns no pricing.

const KNOWN_MEMBER = 'fleet-dev';
const USAGE = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };

function createMockFleetApi({ executePromptImpl, getMemberModelPricingImpl } = {}) {
    return {
        async executePrompt(payload) {
            if (executePromptImpl) return executePromptImpl(payload);
            return { content: [{ text: `Mock response to: ${payload.prompt}` }], usage: USAGE };
        },
        async executeCommand(payload) {
            return { content: [{ text: payload.command }], isError: false };
        },
        async getMemberModelPricing(args) {
            if (getMemberModelPricingImpl) return getMemberModelPricingImpl(args);
            throw new Error('getMemberModelPricing not implemented for this mock');
        }
    };
}

function jsonToolResult(obj) {
    return { content: [{ text: JSON.stringify(obj) }] };
}

describe('apra-fleet-dv5.6: real per-member pricing preferred over tier-band fallback', () => {
    test('a member with real pricing for the dispatched tier is priced at that real rate, not the pricing.mjs fallback rate', async () => {
        const wf = new FleetWorkflow(createMockFleetApi({
            getMemberModelPricingImpl: async () => jsonToolResult({
                member_id: KNOWN_MEMBER,
                pricing: { cheap: null, standard: null, premium: { model: 'claude-sonnet-4.6', promptPrice: 100, completionPrice: 200 } }
            })
        }));

        let endMeta;
        wf.on('activity:end', (meta) => { if (meta.type === 'agent') endMeta = meta; });

        await wf.agent('hello', { member_name: KNOWN_MEMBER, model: 'premium' });

        // Real rate: 1000/1e6 * 100 + 500/1e6 * 200 = 0.1 + 0.1 = 0.2
        // (pricing.mjs's 'premium' fallback row would give 0.015 + 0.0375 = 0.0525 -- must NOT match that.)
        assert.strictEqual(endMeta.cost, 0.2);
        assert.strictEqual(wf.budget.pricingSummary().real, 1);
        assert.strictEqual(wf.budget.pricingSummary().fallback, 0);
    });

    test('a member whose real-pricing entry for the dispatched tier is null falls back to the pricing.mjs tier-band estimate', async () => {
        const wf = new FleetWorkflow(createMockFleetApi({
            getMemberModelPricingImpl: async () => jsonToolResult({
                member_id: KNOWN_MEMBER,
                pricing: { cheap: null, standard: null, premium: null }
            })
        }));

        let endMeta;
        wf.on('activity:end', (meta) => { if (meta.type === 'agent') endMeta = meta; });

        await wf.agent('hello', { member_name: KNOWN_MEMBER, model: 'premium' });

        // pricing.mjs 'premium' fallback row: 1000/1e6*15 + 500/1e6*75 = 0.015 + 0.0375 = 0.0525
        assert.strictEqual(endMeta.cost, 0.0525);
        assert.strictEqual(wf.budget.pricingSummary().real, 0);
        assert.strictEqual(wf.budget.pricingSummary().fallback, 1);
    });

    test('a fleet server without the get_member_model_pricing tool (callTool throws) degrades to identical fallback totals, does not throw, does not abort the dispatch', async () => {
        const wf = new FleetWorkflow(createMockFleetApi({
            getMemberModelPricingImpl: async () => { throw new Error('Unknown tool: get_member_model_pricing'); }
        }));

        let endMeta;
        wf.on('activity:end', (meta) => { if (meta.type === 'agent') endMeta = meta; });

        const result = await wf.agent('hello', { member_name: KNOWN_MEMBER, model: 'premium' });

        assert.strictEqual(result, 'Mock response to: hello');
        assert.strictEqual(endMeta.cost, 0.0525);
        assert.strictEqual(wf.budget.pricingSummary().fallback, 1);
    });

    test('a "member not found" error response (not a thrown exception) also degrades gracefully to the fallback', async () => {
        const wf = new FleetWorkflow(createMockFleetApi({
            getMemberModelPricingImpl: async () => jsonToolResult({ error: 'Member not found: nope' })
        }));

        await wf.agent('hello', { member_name: KNOWN_MEMBER, model: 'standard' });
        assert.strictEqual(wf.budget.pricingSummary().fallback, 1);
    });

    test('a literal (non-tier-keyword) opts.model always uses the pricing.mjs concrete-model table, never calls get_member_model_pricing', async () => {
        let pricingCalls = 0;
        const wf = new FleetWorkflow(createMockFleetApi({
            getMemberModelPricingImpl: async () => { pricingCalls++; return jsonToolResult({ pricing: {} }); }
        }));

        await wf.agent('hello', { member_name: KNOWN_MEMBER, model: 'opus' });

        assert.strictEqual(pricingCalls, 0, 'a literal model id should never trigger a get_member_model_pricing lookup');
        assert.strictEqual(wf.budget.pricingSummary().fallback, 1);
    });

    test('get_member_model_pricing is called at most once per member across multiple dispatches (cached for the run)', async () => {
        let pricingCalls = 0;
        const wf = new FleetWorkflow(createMockFleetApi({
            getMemberModelPricingImpl: async () => {
                pricingCalls++;
                return jsonToolResult({ pricing: { cheap: null, standard: { model: 'sonnet', promptPrice: 3, completionPrice: 15 }, premium: null } });
            }
        }));

        await wf.agent('call 1', { member_name: KNOWN_MEMBER, model: 'standard' });
        await wf.agent('call 2', { member_name: KNOWN_MEMBER, model: 'standard' });
        await wf.agent('call 3', { member_name: KNOWN_MEMBER, model: 'standard' });

        assert.strictEqual(pricingCalls, 1);
        assert.strictEqual(wf.budget.pricingSummary().real, 3);
    });

    test('a mixed run (one member with real pricing, one without) attributes each dispatch to the correct source', async () => {
        const wf = new FleetWorkflow(createMockFleetApi({
            getMemberModelPricingImpl: async ({ member_name }) => {
                if (member_name === 'priced-member') {
                    return jsonToolResult({ pricing: { cheap: null, standard: { model: 'x', promptPrice: 1, completionPrice: 1 }, premium: null } });
                }
                throw new Error('no pricing for this member');
            }
        }));

        await wf.agent('call 1', { member_name: 'priced-member', model: 'standard' });
        await wf.agent('call 2', { member_name: 'unpriced-member', model: 'standard' });

        const summary = wf.budget.pricingSummary();
        assert.strictEqual(summary.real, 1);
        assert.strictEqual(summary.fallback, 1);
    });
});
