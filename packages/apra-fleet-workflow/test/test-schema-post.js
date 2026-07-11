export const meta = { name: 'test-schema-post' };

export async function main(context) {
    const { agent, phase } = context;

    phase('Test Schema Post-condition Validation');
    
    // We provide a valid schema that requires a boolean, but prompt the LLM to output a string,
    // which will fail the Ajv strict validation step after the LLM responds.
    await agent('Output exactly {"test": 1}', {
        member_name: 'apra-pm',
        model: 'cheap',
        schema: {
            type: "object",
            properties: {
                test: { type: "number", minimum: 100 }
            },
            required: ["test"]
        }
    });

    return { status: 'success' };
}
