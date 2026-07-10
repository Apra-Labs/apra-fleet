export const meta = { 
    name: 'hello-world', 
    description: 'A simple hello world workflow demonstrating agent and command primitives' 
};

async function main() {
    phase('Hello World Setup');
    log('Starting the hello world workflow...');
    
    // Command example
    const cmdResult = await command('echo "Hello World from shell!"', {
        member_name: 'apra-pm'
    });
    log(`Command Output: ${cmdResult}`);
    
    phase('Agent Interaction');
    const agentResult = await agent('Say hello world and provide a short greeting.', {
        member_name: 'apra-pm',
        schema: {
            type: "object",
            properties: {
                greeting: { type: "string" },
                message: { type: "string" }
            },
            required: ["greeting", "message"]
        }
    });
    
    log(`Agent Response: ${JSON.stringify(agentResult, null, 2)}`);
    
    return { status: 'success', data: agentResult };
}
