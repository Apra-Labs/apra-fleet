export const meta = { name: 'test-edge-pipeline' };

async function main() {
    phase('Test Edge Case: Pipeline Stage Failure');
    
    const items = [1, 2, 3];
    const results = await pipeline(
        items,
        async (num) => {
            if (num === 2) {
                throw new Error("Deliberate failure for item 2");
            }
            return num * 2;
        },
        transform(n => `Success: ${n}`)
    );

    log(`Pipeline returned: ${JSON.stringify(results)}`);
    
    // We expect [ "Success: 2", null, "Success: 6" ]
    if (results[1] !== null) {
        throw new Error("Expected item 2 to be null after failing");
    }

    return { status: 'success' };
}
