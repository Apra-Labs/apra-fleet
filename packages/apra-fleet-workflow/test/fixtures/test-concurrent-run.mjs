// Fixture for apra-fleet-workflow-concurrency.test.mjs (apra-fleet-unw.9, F11).
//
// Sets a phase derived from `args.tag`, optionally waits `args.delayMs`
// (simulating slow work / giving a sibling concurrent run a chance to run
// and mutate any SHARED mutable state), then dispatches a single agent()
// call labeled with its own tag. Used to prove that two concurrent
// `WorkflowEngine.executeFile()` calls against the SAME `FleetWorkflow`
// instance no longer stomp on each other's `args`/phase attribution.
export async function main(context) {
    const { agent, phase, args } = context;

    phase(`Phase-${args.tag}`);

    if (args.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, args.delayMs));
    }

    const result = await agent(`hello from ${args.tag}`, {
        member_name: 'fleet-dev',
        label: args.tag
    });

    return { tag: args.tag, result };
}
