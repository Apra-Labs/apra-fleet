// Fixture for apra-fleet-unw2.14 (N6): order-independent replay keys across
// parallel() branches -- the "parallel develop phase" resume case.
//
// Two streaks (doers) run concurrently in a parallel() barrier. Each streak
// dispatches TWO agent() calls (an "impl" then a "test") whose prompt text is
// keyed to the streak IDENTITY, not to timing -- so the logical call sites are
// identical regardless of how the two branches interleave at runtime.
//
// `args.delays` (a 2-element array of per-streak millisecond delays) lets a
// test FORCE a particular interleaving: the streak with the smaller delay
// reaches its dispatches first. Recording the journal under one delay ordering
// and resuming under a reversed one exercises the exact bug N6 fixes -- under
// the pre-N6 single shared counter, the two runs assigned different sequence
// numbers to the same logical calls and missed the replay cache; under N6 the
// per-branch hierarchical sub-sequence keeps every key stable.
export async function main(context) {
    const { agent, parallel, args } = context;
    const delays = args.delays || [0, 0];
    const streaks = [
        { id: 'streak-a', delayMs: delays[0] },
        { id: 'streak-b', delayMs: delays[1] }
    ];

    const results = await parallel(streaks, async (streak) => {
        await new Promise((r) => setTimeout(r, streak.delayMs));
        const impl = await agent(`implement ${streak.id}`, {
            member_name: 'fleet-dev',
            label: `${streak.id}-impl`,
            model: 'gpt-4o'
        });
        // A second await gap so the sibling branch can interleave between this
        // branch's two dispatches under whichever delay ordering is in effect.
        await new Promise((r) => setTimeout(r, streak.delayMs));
        const test = await agent(`test ${streak.id}`, {
            member_name: 'fleet-dev',
            label: `${streak.id}-test`,
            model: 'gpt-4o'
        });
        return { id: streak.id, impl, test };
    });

    return { results };
}
