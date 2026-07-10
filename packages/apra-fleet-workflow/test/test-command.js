export const meta = { name: 'test-command' };

async function main() {
    phase('Test Command');
    
    // Testing command execution with substitutions
    const result = await command('echo "Hello {{name}} from {{location}}!"', {
        member_name: 'fleet-dev',
        substitutions: {
            name: 'Apra User',
            location: 'Workflow Engine'
        }
    });

    log(`Command output: ${result}`);

    phase('Test Schema Prompting');
    const jsonResult = await agent('Give me a JSON object with a test parameter', {
        member_name: 'apra-pm',
        schema: {
            type: "object",
            properties: {
                test: { type: "string" }
            },
            required: ["test"]
        }
    });

    log(`Agent structured output: ${JSON.stringify(jsonResult)}`);

    phase('Test Pipeline with Transform');
    const processed = await pipeline(
        ['apra', 'fleet'],
        async (item) => `Input word: ${item}`,
        transform((str) => str.toUpperCase() + ' (TRANSFORMED)'),
        async (item) => `Final Result -> ${item}`
    );
    
    log(`Pipeline transform result: ${JSON.stringify(processed)}`);

    return { status: 'success' };
}
