// Fixture for apra-fleet-eft.37.6 boundary e2e test (acceptance 1, NEGATIVE
// case): a plain, non-se workflow script -- shaped like
// packages/apra-fleet-workflow/examples/01-hello-world.js -- that never
// mentions any auto-sprint domain concept (sprintId/verdict/prUrl/beads).
//
// Dispatches one command() with output long enough to get capped by
// command-output-cap.mjs (so the GENERIC GET /activities/:id/output
// "more..." route -- eft.38 -- has something real to serve for a workflow
// that has nothing to do with beads) and one agent() call, then returns a
// plain, ordinary result shape (no verdict/prUrl keys).
export const meta = {
    name: 'hello-world',
    description: 'plain non-se workflow, no sprint/beads domain concepts'
};

export async function main(context) {
    const { agent, command, log, phase } = context;

    phase('Greeting');
    // The mock fleetApi used by the e2e test echoes the command text back as
    // the output, so a long command string is enough to exceed the default
    // head(2000)+tail(1000) cap and get truncated in stored state.
    const longCommand = 'echo ' + 'x'.repeat(5000);
    const cmdResult = await command(longCommand, { member_name: 'fleet-dev' });
    log(`command produced ${cmdResult.length} chars`);

    phase('Agent');
    const agentResult = await agent('Say hello world', { member_name: 'fleet-dev' });
    log(`agent said: ${agentResult}`);

    return { status: 'ok', greeting: 'hello world' };
}
