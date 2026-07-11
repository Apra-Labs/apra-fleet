export const meta = { name: 'test-edge-missing-member' };

// NOTE: this fixture used to assert that agent()/command() gracefully
// returned `null` for a missing member. As of apra-fleet-unw.3, both
// functions instead throw a typed MemberNotFoundError (see
// src/workflow/errors.mjs) -- agent()/command() never return null for any
// failure path. The corresponding assertion now lives in
// test/apra-fleet-workflow-errors.test.mjs; this fixture is retained (and
// exercised by test-runner.test.mjs) to prove the thrown error propagates
// out of the WorkflowEngine.

export async function main(context) {
    const { command, phase } = context;

    phase('Test Edge Case: Missing Member Typed Error');

    // We explicitly target a member name that does not exist in the fleet.
    // The MCP server should reject the JSON-RPC call.
    // The workflow engine should surface this as a MemberNotFoundError.
    await command('echo "test"', { member_name: 'some_missing_member_404' });

    return { status: 'success' };
}
