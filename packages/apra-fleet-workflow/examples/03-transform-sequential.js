// examples/03-transform-Sequential.js
export const meta = {
    name: "Data Transform Sequential Example",
    description: "Demonstrates using transform() to parse strings into JSON and chain results into the next command step."
};

export async function main(context) {
    const { agent, command, log, phase, sequential, transform, nullTransform, args } = context;

    phase('Initialization');
    log('Starting Sequential with transform mapping...');

    const memberName = args.member_name || 'apra-pm';

    const items = [
        "Create a file named hello.txt with 'hello world'",
        "List the current directory contents"
    ];

    // Sequential mapping: 
    // 1. LLM Agent (Input: string instruction) -> Output: structured JSON
    // 2. Transform (Input: JSON) -> Output: Bash Command string
    // 3. Command (Input: string) -> Execution output
    
    await sequential(items, async (instruction, index) => {
        phase(`Processing Item ${index + 1}`);

        // Step 1: Agent string -> JSON
        const planJson = await agent(`Given this instruction: "${instruction}", write a single bash command to execute it. Do not include markdown codeblocks or quotes around it. Just return the raw string command inside a JSON object.`, {
            label: 'Plan Command',
            member_name: memberName,
            schema: {
                type: "object",
                properties: {
                    commandToRun: { type: "string" }
                },
                required: ["commandToRun"]
            }
        });

        // Step 2: Transform JSON -> String (Command for step 3)
        // Shows input=JSON, output=String. The transform() ensures this mapping is visible in the UI dashboard.
        const bashCmd = await transform('Extract Command String', (data) => {
            if (!data || !data.commandToRun) throw new Error("Invalid schema received from LLM");
            // If the command starts with 'echo', prefix it with a safety comment
            if (data.commandToRun.startsWith('echo')) {
                return `# Safely echoing\n${data.commandToRun}`;
            }
            return data.commandToRun;
        }, planJson);

        // Step 3: Execute Command string
        // The previous step's output is used to form the command directly.
        await command(bashCmd, {
            label: 'Execute Extracted Command',
            member_name: memberName
        });

        // Step 4: nullTransform (does nothing, returns null to break dependency chain)
        await transform('Cleanup / Reset', nullTransform, bashCmd);
    }, { continueOnError: true });

    phase('Complete');
    log('Transform Sequential finished.');
}
