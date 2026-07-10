export const meta = { name: 'test-edge-command-fail' };

async function main() {
    phase('Test Edge Case: Command failure');
    
    // We execute a completely non-existent binary to force the command dispatcher to fail
    const result = await command('some_non_existent_binary_12345 --flag', {
        member_name: 'fleet-dev'
    });

    return { status: 'success' };
}
