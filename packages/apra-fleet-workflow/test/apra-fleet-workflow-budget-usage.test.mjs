import { test, describe } from 'node:test';
import assert from 'node:assert';
import { FleetWorkflow, WorkflowError, BudgetExceededError } from '../src/workflow/index.mjs';
import { calculateCost } from '../src/workflow/pricing.mjs';

// Unit tests for honest usage reporting + budget enforcement + pricing table
// sanity (apra-fleet-unw.4, findings F2/F3). No fabricated token usage or
// costs anywhere in these paths.

const KNOWN_MEMBER = 'fleet-dev';

function createMockFleetApi({ executePromptImpl } = {}) {
    return {
        async executePrompt(payload) {
            if (executePromptImpl) return executePromptImpl(payload);
            return { content: [{ text: `Mock response to: ${payload.prompt}` }], usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 } };
        },
        async executeCommand(payload) {
            return { content: [{ text: payload.command }], isError: false };
        }
    };
}

describe('apra-fleet-unw.4: honest usage reporting', () => {
    test('missing usage on the fleet result yields usage:null and cost:null on activity:end (never fabricated)', async () => {
        const wf = new FleetWorkflow(createMockFleetApi({
            executePromptImpl: async () => ({ content: [{ text: 'no usage here' }] }) // no `usage` field
        }));

        let endMeta;
        wf.on('activity:end', (meta) => { if (meta.type === 'agent') endMeta = meta; });

        const result = await wf.agent('hello', { member_name: KNOWN_MEMBER, model: 'gpt-4o' });

        assert.strictEqual(result, 'no usage here');
        assert.strictEqual(endMeta.usage, null);
        assert.strictEqual(endMeta.cost, null);
    });

    test('usage missing total_tokens (malformed) also yields null usage/cost, not a random guess', async () => {
        const wf = new FleetWorkflow(createMockFleetApi({
            executePromptImpl: async () => ({ content: [{ text: 'ok' }], usage: { input_tokens: 10 } })
        }));

        let endMeta;
        wf.on('activity:end', (meta) => { if (meta.type === 'agent') endMeta = meta; });

        await wf.agent('hello', { member_name: KNOWN_MEMBER, model: 'gpt-4o' });

        assert.strictEqual(endMeta.usage, null);
        assert.strictEqual(endMeta.cost, null);
    });

    test('real usage from the fleet result propagates untouched, with a known numeric cost', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());

        let endMeta;
        wf.on('activity:end', (meta) => { if (meta.type === 'agent') endMeta = meta; });

        await wf.agent('hello', { member_name: KNOWN_MEMBER, model: 'gpt-4o' });

        assert.deepStrictEqual(endMeta.usage, { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 });
        assert.strictEqual(typeof endMeta.cost, 'number');
        assert.ok(endMeta.cost > 0);
    });
});

describe('apra-fleet-unw.4: budget debit and enforcement', () => {
    test('budget._spent accumulates across multiple agent() dispatches with known cost', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        assert.strictEqual(wf.budget.spent(), 0);

        await wf.agent('hello 1', { member_name: KNOWN_MEMBER, model: 'gpt-4o' });
        const afterFirst = wf.budget.spent();
        assert.ok(afterFirst > 0);

        await wf.agent('hello 2', { member_name: KNOWN_MEMBER, model: 'gpt-4o' });
        const afterSecond = wf.budget.spent();
        assert.ok(afterSecond > afterFirst);
    });

    test('unknown cost (missing usage) does not change budget._spent', async () => {
        const wf = new FleetWorkflow(createMockFleetApi({
            executePromptImpl: async () => ({ content: [{ text: 'no usage' }] })
        }));

        await wf.agent('hello', { member_name: KNOWN_MEMBER, model: 'gpt-4o' });
        assert.strictEqual(wf.budget.spent(), 0);
    });

    test('agent() throws BudgetExceededError (instanceof WorkflowError) once spent >= total', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        // gpt-4o: 1000 prompt tokens * $5/1M + 500 completion * $15/1M = 0.005 + 0.0075 = 0.0125 per call
        wf.budget.total = 0.02;

        await wf.agent('call 1', { member_name: KNOWN_MEMBER, model: 'gpt-4o' });
        assert.ok(wf.budget.spent() < wf.budget.total, 'first call should not yet exhaust the budget');

        await wf.agent('call 2', { member_name: KNOWN_MEMBER, model: 'gpt-4o' });
        assert.ok(wf.budget.spent() >= wf.budget.total, 'second call should exhaust the budget');

        await assert.rejects(
            () => wf.agent('call 3', { member_name: KNOWN_MEMBER, model: 'gpt-4o' }),
            (err) => {
                assert.ok(err instanceof BudgetExceededError);
                assert.ok(err instanceof WorkflowError);
                assert.strictEqual(err.code, 'BUDGET_EXCEEDED');
                return true;
            }
        );
    });

    test('agent() never dispatches to the fleet API once the budget is exhausted', async () => {
        let dispatchCount = 0;
        const wf = new FleetWorkflow(createMockFleetApi({
            executePromptImpl: async (payload) => {
                dispatchCount++;
                return { content: [{ text: 'ok' }], usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 } };
            }
        }));
        wf.budget.total = 0.01;
        wf.budget._spent = 0.01; // already exhausted

        await assert.rejects(() => wf.agent('hello', { member_name: KNOWN_MEMBER, model: 'gpt-4o' }), BudgetExceededError);
        assert.strictEqual(dispatchCount, 0);
    });

    test('with no budget.total configured, agent() dispatches without limit', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        assert.strictEqual(wf.budget.total, null);
        await wf.agent('hello', { member_name: KNOWN_MEMBER, model: 'gpt-4o' });
        assert.ok(wf.budget.spent() > 0);
    });
});

describe('apra-fleet-unw.4: pricing table sanity', () => {
    test('calculateCost returns a known numeric price for a listed model', () => {
        const cost = calculateCost('gpt-4o', { input_tokens: 1000000, output_tokens: 1000000 });
        assert.strictEqual(cost, 5.00 + 15.00);
    });

    test('calculateCost returns null for an unknown/unlisted model instead of a default guess', () => {
        const cost = calculateCost('some-mystery-model-v9', { input_tokens: 1000, output_tokens: 1000 });
        assert.strictEqual(cost, null);
    });

    test('calculateCost returns null when usage is missing entirely', () => {
        assert.strictEqual(calculateCost('gpt-4o', null), null);
    });

    test('calculateCost returns null when model name is omitted', () => {
        assert.strictEqual(calculateCost(undefined, { input_tokens: 100, output_tokens: 100 }), null);
    });

    test('calculateCost returns null for an empty usage object (no input_tokens/output_tokens keys)', () => {
        assert.strictEqual(calculateCost('gpt-4o', {}), null);
    });
});

describe('apra-fleet-202.2: calculateCost reads real usage.input_tokens/output_tokens (regression guard for apra-fleet-202)', () => {
    // apra-fleet-202: the real usage shape from execute-prompt.ts
    // structuredContent is {input_tokens, output_tokens, total_tokens} -- NOT
    // {prompt_tokens, completion_tokens}. Before apra-fleet-202.1's fix,
    // calculateCost() read the wrong field names, so real usage objects
    // shaped like this always silently defaulted both token counts to 0 and
    // returned $0 (a valid-looking, non-null number) instead of the actual
    // priced cost or null. This test asserts a strictly positive number for
    // a known-priced model given ONLY the real field names -- it would have
    // failed (asserting 0 is not > 0) against the pre-fix
    // prompt_tokens/completion_tokens reads.
    test('calculateCost returns a positive cost for a known-priced model given real {input_tokens, output_tokens} usage', () => {
        const usage = { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 };
        const cost = calculateCost('gpt-4o', usage);
        assert.strictEqual(typeof cost, 'number');
        assert.ok(Number.isFinite(cost) && cost > 0, `Expected a positive finite cost, got ${cost}`);
        // Pin the exact value so a future regression back to
        // prompt_tokens/completion_tokens (which would silently yield 0) is
        // caught, not just "some positive number".
        const expected = (1000 / 1_000_000) * 5.00 + (500 / 1_000_000) * 15.00;
        assert.strictEqual(cost, expected);
    });

    test('calculateCost returns null for empty usage (no token fields present)', () => {
        assert.strictEqual(calculateCost('gpt-4o', {}), null);
        assert.strictEqual(calculateCost('gpt-4o', null), null);
        assert.strictEqual(calculateCost('gpt-4o', undefined), null);
    });

    test('calculateCost ignores legacy prompt_tokens/completion_tokens fields (only input_tokens/output_tokens are read)', () => {
        // A usage object shaped with the OLD (wrong) field names and no real
        // input_tokens/output_tokens must still be treated as empty usage
        // (null), proving the implementation no longer reads the legacy names.
        const legacyShapedUsage = { prompt_tokens: 1000, completion_tokens: 500 };
        assert.strictEqual(calculateCost('gpt-4o', legacyShapedUsage), null);
    });
});

describe('apra-fleet-unw2.8 (N10): fleet model pricing rows (fable/opus/sonnet/haiku)', () => {
    // Guards against the N10 regression: runner.js now passes these exact
    // strings as `opts.model` (from beads `--metadata '{"model": "<tier>"}'`
    // for doer dispatches, or from FIXED_ROLE_MODEL for the fixed roles --
    // see fleet-sprint/runner.js). If any of these rows is ever removed
    // (e.g. an over-eager pricing-table cleanup), every dispatch using that
    // model silently goes back to cost:null and budget._spent stops moving
    // for it, exactly the N10 finding this issue fixes.
    for (const model of ['fable', 'opus', 'sonnet', 'haiku']) {
        test(`calculateCost prices '${model}' as a known, positive, finite number`, () => {
            const cost = calculateCost(model, { input_tokens: 1_000_000, output_tokens: 1_000_000 });
            assert.strictEqual(typeof cost, 'number');
            assert.ok(Number.isFinite(cost) && cost > 0, `Expected a positive finite cost for '${model}', got ${cost}`);
        });
    }

    test('calculateCost matches a fleet model tier via substring, even inside a more specific real model id', () => {
        // Mirrors the flexible substring match the pricing table's own doc
        // comment describes: a longer, more specific model id that merely
        // CONTAINS one of the short fleet-tier keys should still price.
        const cost = calculateCost('claude-haiku-4.5-20260601', { input_tokens: 1000, output_tokens: 1000 });
        assert.strictEqual(typeof cost, 'number');
        assert.ok(cost > 0);
    });

    test('haiku is priced strictly cheaper than sonnet, which is priced strictly cheaper than opus, for identical usage', () => {
        const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
        const haikuCost = calculateCost('haiku', usage);
        const sonnetCost = calculateCost('sonnet', usage);
        const opusCost = calculateCost('opus', usage);
        assert.ok(haikuCost < sonnetCost, `Expected haiku (${haikuCost}) < sonnet (${sonnetCost})`);
        assert.ok(sonnetCost < opusCost, `Expected sonnet (${sonnetCost}) < opus (${opusCost})`);
    });
});
