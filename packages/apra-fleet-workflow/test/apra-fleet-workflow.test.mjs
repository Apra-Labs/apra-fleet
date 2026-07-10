import { test, describe } from 'node:test';
import assert from 'node:assert';
import { FleetWorkflow } from '../lib/apra-fleet-workflow/index.mjs';

describe('FleetWorkflow', () => {
    test('pipeline() executes stages sequentially per item', async () => {
        const wf = new FleetWorkflow({});
        const items = [10, 20];

        // Stage 1: Add 1 to item
        const stage1 = async (prev, original, idx) => {
            assert.strictEqual(prev, original); // first stage prevResult is the item
            return prev + 1;
        };

        // Stage 2: Multiply by original item
        const stage2 = async (prev, original, idx) => {
            return prev * original;
        };

        const result = await wf.pipeline(items, stage1, stage2);

        // (10 + 1) * 10 = 110
        // (20 + 1) * 20 = 420
        assert.deepStrictEqual(result, [110, 420]);
    });

    test('parallel() acts as a barrier and handles errors', async () => {
        const wf = new FleetWorkflow({});
        
        const thunk1 = async () => 'success 1';
        const thunk2 = async () => { throw new Error('fail'); };
        const thunk3 = async () => 'success 3';

        const result = await wf.parallel([thunk1, thunk2, thunk3]);

        assert.deepStrictEqual(result, ['success 1', null, 'success 3']);
    });

    test('createContext() returns the correct globals', () => {
        const wf = new FleetWorkflow({}, { custom: 'arg' });
        const ctx = wf.createContext();

        assert.strictEqual(typeof ctx.agent, 'function');
        assert.strictEqual(typeof ctx.pipeline, 'function');
        assert.strictEqual(typeof ctx.parallel, 'function');
        assert.strictEqual(typeof ctx.log, 'function');
        assert.strictEqual(typeof ctx.phase, 'function');
        assert.strictEqual(typeof ctx.workflow, 'function');
        
        assert.deepStrictEqual(ctx.args, { custom: 'arg' });
        
        assert.strictEqual(typeof ctx.budget.spent, 'function');
        assert.strictEqual(typeof ctx.budget.remaining, 'function');
        assert.strictEqual(ctx.budget.total, null);
        assert.strictEqual(ctx.budget.remaining(), Infinity);
        assert.strictEqual(ctx.budget.spent(), 0);
    });
});
