import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-unw.16 acceptance criterion 3: reviewer JSON reopenIds ->
// ORCHESTRATOR (not the LLM) applies bd update --status=open
// =============================================================================
test('mock sprint: reviewer reopenIds are applied by the orchestrator, not the reviewer itself', async () => {
    await withScenarioMarkers('reopen (reviewer reopenIds)', async () => {
        console.log('Running mock sprint scenario (reviewer reopenIds -> orchestrator applies)...');
        const reopen = await runDevelopLoopScenario('reopen', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Reopen target A' },
                { title: 'Task: Reopen target B' },
            ],
            reviewerHandler: async ({ reviewRound: rRound, tempDir: td }) => {
                if (rRound === 1) {
                    const listRes = JSON.parse((await runCmd('bd list --all --json', td)).stdout || '[]');
                    const targetA = listRes.find((b) => b.title === 'Task: Reopen target A');
                    return {
                        content: [{
                            text: JSON.stringify({
                                verdict: 'CHANGES_NEEDED',
                                notes: 'Target A needs a fix.',
                                reopenIds: [targetA.id],
                                newTasks: [],
                            })
                        }]
                    };
                }
                return { content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'All good now.', reopenIds: [], newTasks: [] }) }] };
            },
        });
        check(!reopen.error, `Reopen scenario should not error: ${reopen.error ? reopen.error.message : ''}`);
        const targetAId = reopen.tasks.find((t) => t.title === 'Task: Reopen target A').id;
        const targetBId = reopen.tasks.find((t) => t.title === 'Task: Reopen target B').id;
        check(
            reopen.commandLog.some((c) => c === `bd update ${targetAId} --status=open`),
            `Expected the RUNNER (orchestrator) to issue 'bd update ${targetAId} --status=open', commandLog: ${JSON.stringify(reopen.commandLog)}`
        );
        check(
            !reopen.commandLog.some((c) => c === `bd update ${targetBId} --status=open`),
            `Did NOT expect a reopen command for bead '${targetBId}' (not in reopenIds), commandLog: ${JSON.stringify(reopen.commandLog)}`
        );
        // Confirm the reviewer's own mock handler is a pure JSON-return -- it
        // never calls runCmd('bd update ...'/'bd close ...'), i.e. only the
        // orchestrator's own code (buildMockFleetApi's executeCommand path,
        // invoked FROM runner.js's command() calls) ever issues the reopen.
        // Grep the actual reviewer DISPATCH PROMPT text (not just the mock's
        // behavior) to confirm runner.js's prompt itself forbids bd mutation --
        // this is the "redundant, dispatch-prompt-level" contract required by
        // apra-fleet-unw.16 Work item 4.
        const reviewerDispatchPrompts = reopen.dispatched.filter((d) => d.agent === 'reviewer' && d.label !== 'Final Review');
        check(reviewerDispatchPrompts.length >= 1, 'Expected at least one non-final reviewer dispatch in the reopen scenario');
        for (const d of reviewerDispatchPrompts) {
            check(
                /do not (run any `?bd`? command yourself|mutate beads directly)/i.test(d.prompt) || d.prompt.includes('Do NOT run any `bd` command yourself'),
                `Reviewer dispatch prompt did not forbid direct bd mutation: ${d.prompt}`
            );
            check(
                d.prompt.includes('reopenIds') && d.prompt.includes('newTasks'),
                `Reviewer dispatch prompt did not mention returning reopenIds/newTasks only: ${d.prompt}`
            );
        }
    });
});
