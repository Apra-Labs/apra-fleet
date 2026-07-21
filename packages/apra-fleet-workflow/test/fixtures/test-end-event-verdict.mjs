// Fixture for apra-fleet-workflow-sprint-state.test.mjs (apra-fleet-eft.2.2).
// Returns a { verdict, prUrl } shaped result, like the auto-sprint runner's
// own workflow script return value, so the "end" handler's enrichment of
// state.result (src/viewer/index.mjs, apra-fleet-eft.37.3 -- core stores the
// return value WHOLESALE and opaquely, it never mints verdict/prUrl by name)
// has something real to pick up -- test-end-event-success.mjs's plain
// { result } shape leaves state.result a different (nested) shape and can't
// exercise this scalar-field path as directly.
export async function main(context) {
    const { agent } = context;
    await agent('hello', { member_name: 'fleet-dev' });
    return { verdict: 'MERGED', prUrl: 'https://github.com/example/repo/pull/42' };
}
