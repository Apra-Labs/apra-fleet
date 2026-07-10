export const meta = { name: 'test-edge-missing-member' };

async function main() {
    phase('Test Edge Case: Missing Member Graceful Handling');
    
    // We explicitly target a member name that does not exist in the fleet
    // The MCP server should reject the JSON-RPC call.
    // The workflow engine should catch it and gracefully return null.
    
    const cmdResult = await command('echo "test"', { member_name: 'some_missing_member_404' });
    console.log("CMD RESULT:", cmdResult);
    if (cmdResult !== null) {
        throw new Error(`Command on missing member should return null, but got: ${cmdResult}`);
    }

    const agentResult = await agent('Say hello', { member_name: 'some_missing_member_404' });
    if (agentResult !== null) {
        throw new Error('Agent prompt on missing member should return null');
    }

    return { status: 'success' };
}
