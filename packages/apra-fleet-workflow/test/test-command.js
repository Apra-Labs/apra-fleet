export const meta = { name: 'test-command' };

export async function main(context) {
    const { agent, command, log, phase, sequential, transform } = context;

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

    // NOTE: sequential(items, processor, opts) takes a single processor, not a
    // variadic list of per-stage processors (that pre-rename multi-stage
    // contract is tracked separately in beads issue apra-fleet-unw.6). transform()
    // is a standalone activity with signature transform(label, func, context),
    // not a sequential "stage".
    phase('Test Sequential');
    const processed = await sequential(
        ['apra', 'fleet'],
        async (item) => `Processed: ${item}`
    );

    log(`Sequential result: ${JSON.stringify(processed)}`);

    phase('Test Transform');
    const transformed = await transform('uppercase', (str) => str.toUpperCase(), 'apra');

    log(`Transform result: ${transformed}`);

    return { status: 'success', command: result, agent: jsonResult, sequential: processed, transform: transformed };
}
