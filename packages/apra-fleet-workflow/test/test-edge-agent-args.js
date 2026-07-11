export const meta = { name: 'test-edge-agent-args' };

export async function main(context) {
    const { agent, phase } = context;

    phase('Test Edge Case: Agent missing args');
    
    // Deliberately calling agent without a member_name or member_id
    // This should be rejected either by MCP schema validation or the API wrapper
    await agent('This should fail', {
        label: 'Should Fail'
    });

    return { status: 'success' };
}
