// Fixture for apra-fleet-workflow-hard-kill.test.mjs (apra-fleet-eft.2.4).
//
// Dispatches `context.args.iterations` sequential agent() calls. The
// harness's own fleetApi (sigkill-harness.mjs) resolves each call after a
// real (not mocked/faked-timer) delay -- unlike the other fixtures in this
// directory (single agent() call, resolves near-instantly), this one is
// deliberately long-running: it exists so an out-of-process harness can be
// SIGKILLed partway through a real run and the test can assert the on-disk
// running/<id>.json reflects some-but-not-all of the iterations -- i.e.
// genuine mid-run progress bounded by at most one debounce window, not a
// script that already finished (or never started) by the time the kill
// signal lands.
export async function main(context) {
    const { agent, args } = context;
    const iterations = args.iterations || 10;
    const results = [];
    for (let i = 0; i < iterations; i++) {
        const result = await agent(`step-${i}`, { member_name: 'fleet-dev' });
        results.push(result);
    }
    return { verdict: 'MERGED', prUrl: 'https://github.com/example/repo/pull/99', steps: results.length };
}
