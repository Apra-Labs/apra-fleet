// Fixture for apra-fleet-workflow-journal.test.mjs (apra-fleet-unw.11, F6).
// Three sequential agent() calls, in order -- lets tests deterministically
// control which activities are "already completed" (positions 0..N-1) vs.
// "still to run" (positions N..) when simulating a crash + resume.
// `args.step2Prompt` lets a test change the 2nd call's prompt text to
// exercise divergence detection at that exact position.
export async function main(context) {
    const { agent, args } = context;
    const r1 = await agent('step1', { member_name: 'fleet-dev', label: 'step1', model: 'gpt-4o' });
    const r2 = await agent(args.step2Prompt || 'step2', { member_name: 'fleet-dev', label: 'step2', model: 'gpt-4o' });
    const r3 = await agent('step3', { member_name: 'fleet-dev', label: 'step3', model: 'gpt-4o' });
    return { r1, r2, r3 };
}
