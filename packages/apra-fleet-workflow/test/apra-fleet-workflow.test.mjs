import { test, describe } from 'node:test';
import assert from 'node:assert';
import { FleetWorkflow } from '../src/workflow/index.mjs';

// NOTE: sequential()/parallel() used to accept a variadic list of per-stage
// processors (sequential) or an array of thunks (parallel). That contract was
// replaced by the current single-processor signature
// `sequential(items, processor, opts)` / `parallel(items, processor, opts)`
// (see src/workflow/index.mjs). sequential() now rejects extra positional
// arguments loudly (TypeError) instead of silently dropping them, and the
// documented multi-stage form lives on as `pipeline(items, ...stages)`
// (apra-fleet-unw.6, findings F7/F8).

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

    test('without continueOnError, the rethrown error carries partialResults for items completed before the failure', async () => {
        const wf = new FleetWorkflow({});

        await assert.rejects(
            () => wf.sequential([1, 2, 3], async (item) => {
                if (item === 2) {
                    throw new Error('boom');
                }
                return item * 10;
            }),
            (err) => {
                assert.match(err.message, /boom/);
                assert.deepStrictEqual(err.partialResults, [10]);
                return true;
            }
        );
    });

    test('(F7) sequential(items, fn1, fn2) -- the old multi-stage form -- throws a TypeError instead of silently dropping fn2', async () => {
        const wf = new FleetWorkflow({});
        const stage1Calls = [];
        const stage2Calls = [];

        const stage1 = async (item) => { stage1Calls.push(item); return item; };
        const stage2 = async (item) => { stage2Calls.push(item); return item; };

        await assert.rejects(
            () => wf.sequential([1, 2, 3], stage1, stage2),
            TypeError
        );
        // The stray 4th positional argument must be rejected before any
        // processing happens -- neither stage should have been invoked.
        assert.deepStrictEqual(stage1Calls, []);
        assert.deepStrictEqual(stage2Calls, []);
    });

    test('sequential(items, notAFunction) throws a TypeError', async () => {
        const wf = new FleetWorkflow({});
        await assert.rejects(() => wf.sequential([1, 2], 'not-a-function'), TypeError);
    });

    test('sequential(items, fn, notAPlainObject) throws a TypeError', async () => {
        const wf = new FleetWorkflow({});
        await assert.rejects(() => wf.sequential([1, 2], async (i) => i, ['not', 'an', 'object']), TypeError);
        await assert.rejects(() => wf.sequential([1, 2], async (i) => i, 'nope'), TypeError);
    });

    test('sequential() with more than 3 arguments throws a TypeError even when trailing args are innocuous', async () => {
        const wf = new FleetWorkflow({});
        await assert.rejects(() => wf.sequential([1, 2], async (i) => i, {}, {}), TypeError);
    });
});

describe('FleetWorkflow.pipeline()', () => {
    test('runs every stage in order for each item, piping each stage output into the next stage input', async () => {
        const wf = new FleetWorkflow({});
        const callOrder = [];

        const stage1 = async (item) => { callOrder.push(`stage1:${item}`); return item + 1; };
        const stage2 = async (item) => { callOrder.push(`stage2:${item}`); return item * 2; };
        const stage3 = async (item) => { callOrder.push(`stage3:${item}`); return `final:${item}`; };

        const result = await wf.pipeline([1, 2], stage1, stage2, stage3);

        assert.deepStrictEqual(result, ['final:4', 'final:6']);
        assert.deepStrictEqual(callOrder, [
            'stage1:1', 'stage2:2', 'stage3:4',
            'stage1:2', 'stage2:3', 'stage3:6'
        ]);
    });

    test('validates that every stage argument is a function', async () => {
        const wf = new FleetWorkflow({});
        await assert.rejects(
            () => wf.pipeline([1, 2], async (i) => i, 'not-a-function'),
            TypeError
        );
    });

    test('requires at least one stage function', async () => {
        const wf = new FleetWorkflow({});
        await assert.rejects(() => wf.pipeline([1, 2]), TypeError);
    });

    test('without continueOnError, rethrows on the first failure with partialResults attached', async () => {
        const wf = new FleetWorkflow({});
        await assert.rejects(
            () => wf.pipeline([1, 2, 3],
                async (item) => item,
                async (item) => { if (item === 2) throw new Error('stage2 boom'); return item * 10; }
            ),
            (err) => {
                assert.match(err.message, /stage2 boom/);
                assert.deepStrictEqual(err.partialResults, [10]);
                return true;
            }
        );
    });

    test('with continueOnError:true, substitutes null for a failed item and continues', async () => {
        const wf = new FleetWorkflow({});
        const result = await wf.pipeline([1, 2, 3],
            async (item) => item,
            async (item) => { if (item === 2) throw new Error('boom'); return item * 10; },
            { continueOnError: true }
        );
        assert.deepStrictEqual(result, [10, null, 30]);
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
        assert.strictEqual(typeof ctx.pipeline, 'function');
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
