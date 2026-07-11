import { test, describe } from 'node:test';
import assert from 'node:assert';
import { FleetWorkflow } from '../src/workflow/index.mjs';

// NOTE: sequential()/parallel() used to accept a variadic list of per-stage
// processors (sequential) or an array of thunks (parallel). That contract was
// replaced by the current single-processor signature
// `sequential(items, processor, opts)` / `parallel(items, processor, opts)`
// (see src/workflow/index.mjs). A future contract change (arity validation,
// pipeline()) is tracked separately in beads issue apra-fleet-unw.6 -- these
// tests assert the CURRENT implemented behavior only.

describe('FleetWorkflow.sequential()', () => {
    test('executes the processor for each item in order and returns results', async () => {
        const wf = new FleetWorkflow({});
        const items = [10, 20];
        const seenIndexes = [];

        const processor = async (item, idx, allItems) => {
            seenIndexes.push(idx);
            assert.strictEqual(allItems, items);
            return item + 1;
        };

        const result = await wf.sequential(items, processor);

        assert.deepStrictEqual(result, [11, 21]);
        assert.deepStrictEqual(seenIndexes, [0, 1]);
    });

    test('with continueOnError:true, substitutes null for a failed item and continues', async () => {
        const wf = new FleetWorkflow({});
        const items = [1, 2, 3];

        const result = await wf.sequential(items, async (item) => {
            if (item === 2) {
                throw new Error('Deliberate failure for item 2');
            }
            return item * 2;
        }, { continueOnError: true });

        assert.deepStrictEqual(result, [2, null, 6]);
    });

    test('without continueOnError, rethrows on the first failure', async () => {
        const wf = new FleetWorkflow({});

        await assert.rejects(
            () => wf.sequential([1, 2, 3], async (item) => {
                if (item === 2) {
                    throw new Error('boom');
                }
                return item;
            }),
            /boom/
        );
    });
});

describe('FleetWorkflow.parallel()', () => {
    test('runs the processor for each item concurrently and returns results in item order', async () => {
        const wf = new FleetWorkflow({});
        const items = ['a', 'b', 'c'];

        const result = await wf.parallel(items, async (item) => `done:${item}`);

        assert.deepStrictEqual(result, ['done:a', 'done:b', 'done:c']);
    });

    test('with continueOnError:true, substitutes null for failed items', async () => {
        const wf = new FleetWorkflow({});
        const items = ['success 1', 'fail', 'success 3'];

        const result = await wf.parallel(items, async (item) => {
            if (item === 'fail') {
                throw new Error('fail');
            }
            return item;
        }, { continueOnError: true });

        assert.deepStrictEqual(result, ['success 1', null, 'success 3']);
    });

    test('without continueOnError, rejects on the first failure', async () => {
        const wf = new FleetWorkflow({});

        await assert.rejects(
            () => wf.parallel(['ok', 'bad'], async (item) => {
                if (item === 'bad') {
                    throw new Error('bad');
                }
                return item;
            }),
            /bad/
        );
    });
});

describe('FleetWorkflow.transform()', () => {
    test('runs the provided function against the context and returns its result', async () => {
        const wf = new FleetWorkflow({});
        const result = await wf.transform('uppercase', (str) => str.toUpperCase(), 'apra');
        assert.strictEqual(result, 'APRA');
    });

    test('defaults to an identity function when none is provided', async () => {
        const wf = new FleetWorkflow({});
        const result = await wf.transform('identity', undefined, { a: 1 });
        assert.deepStrictEqual(result, { a: 1 });
    });
});

describe('FleetWorkflow.createContext()', () => {
    test('returns the correct globals for a workflow script', () => {
        const wf = new FleetWorkflow({}, { custom: 'arg' });
        const ctx = wf.createContext();

        assert.strictEqual(typeof ctx.agent, 'function');
        assert.strictEqual(typeof ctx.command, 'function');
        assert.strictEqual(typeof ctx.sequential, 'function');
        assert.strictEqual(typeof ctx.parallel, 'function');
        assert.strictEqual(typeof ctx.transform, 'function');
        assert.strictEqual(typeof ctx.nullTransform, 'function');
        assert.strictEqual(typeof ctx.log, 'function');
        assert.strictEqual(typeof ctx.phase, 'function');
        assert.strictEqual(typeof ctx.publishState, 'function');
        assert.strictEqual(typeof ctx.workflow, 'function');
        assert.strictEqual(typeof ctx.group, 'function');
        assert.strictEqual(typeof ctx.endGroup, 'function');

        assert.deepStrictEqual(ctx.args, { custom: 'arg' });

        assert.strictEqual(typeof ctx.budget.spent, 'function');
        assert.strictEqual(typeof ctx.budget.remaining, 'function');
        assert.strictEqual(ctx.budget.total, null);
        assert.strictEqual(ctx.budget.remaining(), Infinity);
        assert.strictEqual(ctx.budget.spent(), 0);
    });
});
