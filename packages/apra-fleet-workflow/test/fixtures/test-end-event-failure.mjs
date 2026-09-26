// Fixture for apra-fleet-workflow-viewer-lifecycle.test.mjs (apra-fleet-unw.10).
// Dispatches to a member that the mock fleetApi doesn't know about, so
// agent() throws a typed MemberNotFoundError. Used to assert that
// WorkflowEngine.executeFile()'s 'end' event also fires on the
// failure/throw path (status: 'failed'), not just on success.
export async function main(context) {
    const { agent } = context;
    await agent('hello', { member_name: 'ghost-member' });
    return { unreachable: true };
}
