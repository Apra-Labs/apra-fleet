// Fixture for apra-fleet-eft.53.1: a script with two distinct phase()
// transitions and an agent() dispatch in each, so a test can assert that
// GET /state stamps phaseStartedAt on entry and phaseEndedAt on exit for
// every phase entry -- the earlier "Plan" phase must have both timestamps
// set once "Develop" begins, while "Develop" itself stays open
// (phaseEndedAt: null) until the run ends.
export async function main(context) {
    const { phase, agent } = context;
    phase('Plan');
    await agent('plan step', { member_name: 'fleet-dev' });
    phase('Develop');
    await agent('develop step', { member_name: 'fleet-dev' });
    return { result: 'done' };
}
