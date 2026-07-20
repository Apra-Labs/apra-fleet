import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-unw.17 (A5) acceptance criterion 1: an orphaned in_progress
// bead must NOT be read as sprint success
// =============================================================================
// Root-cause regression test for the exact A5 bug: `bd list --ready == []`
// used to be equated with "the sprint is done", even when a bead was
// left permanently in_progress/blocked (never picked up by any doer
// because it's not in `--ready`). Here one task is force-set to
// `in_progress` before the sprint runs (simulating an orphaned bead --
// e.g. a doer that claimed it in an earlier, now-dead run) and is never
// touched again; a sibling, independent task closes normally. The
// sprint must complete (not throw) but its evidence-based final verdict
// must be FAIL, and the workflow's returned status must be 'failed', not
// a blanket 'success'.
test('mock sprint: an orphaned in_progress bead must not be read as sprint success', async () => {
    await withScenarioMarkers('orphaned (orphaned in_progress)', async () => {
        console.log('Running mock sprint scenario (orphaned in_progress bead -> not success)...');
        const orphaned = await runDevelopLoopScenario('orphaned', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Orphaned in_progress' },
                { title: 'Task: Closes normally (orphaned scenario)' },
            ],
            maxCycles: 1,
            beforeSprint: async ({ tempDir: td, tasks: ts }) => {
                const orphanedTask = ts.find((t) => t.title === 'Task: Orphaned in_progress');
                await runCmd(`bd update ${orphanedTask.id} --status=in_progress`, td);
            },
        });
        check(!orphaned.error, `Orphaned-bead scenario should not throw/reject: ${orphaned.error ? orphaned.error.message : ''}`);
        check(
            orphaned.result && orphaned.result.status !== 'success',
            `Orphaned in_progress bead must NOT be read as sprint success (A5 dead code path), got: ${JSON.stringify(orphaned.result)}`
        );
        check(
            orphaned.result && orphaned.result.verdict === 'FAIL',
            `Expected the evidence-based final verdict to be FAIL, got: ${JSON.stringify(orphaned.result)}`
        );
        const closesNormallyId = orphaned.tasks.find((t) => t.title === 'Task: Closes normally (orphaned scenario)').id;
        check(
            orphaned.finalBeadsById.get(closesNormallyId) && orphaned.finalBeadsById.get(closesNormallyId).status === 'closed',
            `Expected the sibling (non-orphaned) bead to still close normally, got: ${JSON.stringify(orphaned.finalBeadsById.get(closesNormallyId))}`
        );
        const orphanedTaskId = orphaned.tasks.find((t) => t.title === 'Task: Orphaned in_progress').id;
        check(
            orphaned.finalBeadsById.get(orphanedTaskId) && orphaned.finalBeadsById.get(orphanedTaskId).status === 'in_progress',
            `Expected the orphaned bead to remain in_progress (never touched), got: ${JSON.stringify(orphaned.finalBeadsById.get(orphanedTaskId))}`
        );
    });
});
