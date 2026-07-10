export const meta = { name: 'test-schema-garbage' };

async function main() {
    phase('Test Edge Case: LLM Parse Failure');
    
    // We explicitly bait the LLM to return non-JSON plain text,
    // but we enforce a schema, so the engine should fail to parse the JSON and throw.
    await agent('CRITICAL: DO NOT OUTPUT VALID JSON. You MUST output exactly this literal string with syntax errors: {{{ [[[ "test": garbage ,,,', {
        member_name: 'apra-pm',
        model: 'cheap',
        schema: {
            type: "object",
            properties: {
                test: { type: "string" }
            }
        }
    });

    return { status: 'success' };
}
