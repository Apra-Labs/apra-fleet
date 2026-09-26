// Fixture for apra-fleet-workflow-viewer-lifecycle.test.mjs (apra-fleet-unw.10).
// Dispatches a single agent() call that the test's mock fleetApi never
// resolves on its own -- it only settles (rejecting) when the run's
// AbortSignal fires. Used to prove that FleetWorkflow.requestStop()
// (triggered by the viewer's cooperative /stop handler) actually rejects an
// in-flight dispatch, rather than the workflow just hanging forever or the
// whole process getting killed via process.exit().
export async function main(context) {
    const { agent } = context;
    const result = await agent('long running task', { member_name: 'fleet-dev' });
    return { result };
}
