// Fixture for apra-fleet-workflow-concurrency.test.mjs (apra-fleet-unw.9, F11).
//
// This is the core F11 regression case: N `parallel()` branches, each
// calling `phase()` with a DISTINCT value, then (after an `await` gap, so
// sibling branches get a chance to run and mutate any SHARED mutable phase
// state) dispatching its own agent() activity. Before apra-fleet-unw.9, all
// branches shared a single `FleetWorkflow.currentPhase` field, so whichever
// branch called `phase()` last "won" for every activity emitted after that
// point -- including activities belonging to OTHER branches that were
// already in flight. Each branch's activity event here must carry ONLY that
// branch's own phase.
export async function main(context) {
    const { agent, parallel } = context;

    // Branch 0 sleeps the longest so branches 1 and 2 (which sleep less)
    // have a chance to call phase() and mutate any shared state before
    // branch 0 wakes up and reads "its own" phase for its agent() dispatch.
    const branches = [
        { name: 'alpha', delayMs: 40 },
        { name: 'beta', delayMs: 10 },
        { name: 'gamma', delayMs: 0 }
    ];

    await parallel(branches, async (branch) => {
        context.phase(`Phase-${branch.name}`);
        await new Promise((resolve) => setTimeout(resolve, branch.delayMs));
        await agent(`work for ${branch.name}`, {
            member_name: 'fleet-dev',
            label: branch.name
        });
    });

    return { status: 'success' };
}
