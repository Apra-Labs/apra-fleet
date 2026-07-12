// Fixture for apra-fleet-unw2.14 (N18): replayed agent activities re-debit the
// run budget (deliberate "total-spend-view" semantics). Two agent() calls,
// then the run returns the per-run budget spent so a test can assert a resumed
// run's budget reflects the replayed (cached) costs too, not just live
// dispatches.
export async function main(context) {
    const { agent, budget } = context;
    await agent('bstep1', { member_name: 'fleet-dev', label: 'bstep1', model: 'gpt-4o' });
    await agent('bstep2', { member_name: 'fleet-dev', label: 'bstep2', model: 'gpt-4o' });
    return { spent: budget.spent() };
}
