export const meta = { name: 'test-edge-command-fail' };

export async function main(context) {
    const { command, phase } = context;

    phase('Test Edge Case: Command failure');
    
    // We execute a completely non-existent binary to force the command dispatcher to fail
    const result = await command('some_non_existent_binary_12345 --flag', {
        member_name: 'fleet-dev'
    });

    return { status: 'success' };
}
