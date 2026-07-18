// Fixture for apra-fleet-workflow-sprint-state.test.mjs (apra-fleet-eft.2.2).
// Returns a { verdict, prUrl } shaped result, like the auto-sprint runner's
// own workflow script return value, so the "end" handler's enrichment of
// state.verdict/state.prUrl (src/viewer/index.mjs) has something real to
// pick up -- test-end-event-success.mjs's plain { result } shape leaves both
// fields null and can't exercise this path.
export async function main(context) {
    const { agent } = context;
    await agent('hello', { member_name: 'fleet-dev' });
    return { verdict: 'MERGED', prUrl: 'https://github.com/example/repo/pull/42' };
}
