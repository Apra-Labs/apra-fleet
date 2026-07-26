// Fixture for apra-fleet-workflow-viewer-lifecycle.test.mjs (apra-fleet-unw.10).
// A trivial, fast-succeeding script: dispatches one agent() call and returns.
// Used to assert that WorkflowEngine.executeFile() emits an 'end' event
// (status: 'success') that the dashboard viewer picks up, instead of the
// dashboard staying in a perpetual "LIVE" state forever.
export async function main(context) {
    const { agent } = context;
    const result = await agent('hello', { member_name: 'fleet-dev' });
    return { result };
}
