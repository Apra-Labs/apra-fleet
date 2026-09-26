export const meta = { name: 'test-edge-sequential' };

export async function main(context) {
    const { sequential, log, phase } = context;

    phase('Test Edge Case: Sequential Stage Failure');
    
    const items = [1, 2, 3];
    // NOTE: sequential(items, processor, opts) takes a single processor and an
    // options object (see src/workflow/index.mjs). Passing a lazily-evaluated
    // "transform(...)" call as the 3rd (opts) argument -- as this fixture used
    // to -- passes a Promise instead of { continueOnError: true }, so
    // opts.continueOnError is never truthy and the failure below is rethrown
    // immediately, before the results array (and the assertion) is ever
    // reached. Use the actual opts shape instead.
    const results = await sequential(
        items,
        async (num) => {
            if (num === 2) {
                throw new Error("Deliberate failure for item 2");
            }
            return num * 2;
        },
        { continueOnError: true }
    );

    log(`Sequential returned: ${JSON.stringify(results)}`);

    // We expect [ 2, null, 6 ]
    if (results[1] !== null) {
        throw new Error("Expected item 2 to be null after failing");
    }

    return { status: 'success' };
}
