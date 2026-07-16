import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-unw2.18 (N18) fix (a): a goal-priority bead with 'deferred'
// status must be counted as NOT done for the sprint's exit-check logic.
// A deferred bead AT goal priority (P1/P2, the default task priority)
// must prevent exit success -- unlike an out-of-goal (P3) bead, which is
// legitimately never counted regardless of its status (see the
// "goalpriority" scenario in mock-sprint-exit-goalpriority-p3.test.mjs).
// `bd list --priority-max=<goalMax>` only includes P3 and worse. Get a
// bead at goal priority DEFERRED (not closed) so it lands in
// NOT_DONE_STATUSES's `--priority-max` window.
// =============================================================================
test('mock sprint: a deferred goal-priority bead must not allow exit success', async () => {
    await withScenarioMarkers('deferredgoalpriority', async () => {
        console.log('Running mock sprint scenario (deferred goal-priority bead must not allow exit success)...');
        const deferredGoalPriority = await runDevelopLoopScenario('deferredgoalpriority', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: A closes normally (deferred-goal-priority scenario)' },
                { title: 'Task: B deferred, never closed (deferred-goal-priority scenario)' },
            ],
            maxCycles: 2,
            // Close A normally; defer B (both are default/goal priority, i.e.
            // in-scope for the P1/P2 goal) -- simulating the harvester deferring
            // a goal-priority issue mid-sprint per its contract.
            doerHandler: async ({ opts, tempDir: td }) => {
                const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                const listRes = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
                const bTask = listRes.find((b) => b.title === 'Task: B deferred, never closed (deferred-goal-priority scenario)');
                const closedIds = [];
                for (const id of ids) {
                    if (bTask && id === bTask.id) {
                        await runCmd(`bd update ${id} --status=deferred`, td);
                    } else {
                        await runCmd(`bd close ${id}`, td);
                        closedIds.push(id);
                    }
                }
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds, notes: 'Closed A; deferred B (goal-priority, never closed).' }) }] };
            },
            reviewerHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'A approved; B deferred (still counts as goal-priority open).', reopenIds: [], newTasks: [] }) }]
            }),
        });
        check(!deferredGoalPriority.error, `Deferred goal-priority scenario should not throw: ${deferredGoalPriority.error ? deferredGoalPriority.error.message : ''}`);
        check(
            !(deferredGoalPriority.result && deferredGoalPriority.result.status === 'success'),
            `Expected the sprint to NOT exit as success while a goal-priority bead remains deferred (never closed), got: ${JSON.stringify(deferredGoalPriority.result)}`
        );
        const deferredTaskA = deferredGoalPriority.tasks.find((t) => t.title === 'Task: A closes normally (deferred-goal-priority scenario)');
        const deferredTaskB = deferredGoalPriority.tasks.find((t) => t.title === 'Task: B deferred, never closed (deferred-goal-priority scenario)');
        check(
            deferredGoalPriority.finalBeadsById.get(deferredTaskA.id) && deferredGoalPriority.finalBeadsById.get(deferredTaskA.id).status === 'closed',
            `Expected task A to be closed, got: ${JSON.stringify(deferredGoalPriority.finalBeadsById.get(deferredTaskA.id))}`
        );
        check(
            deferredGoalPriority.finalBeadsById.get(deferredTaskB.id) && deferredGoalPriority.finalBeadsById.get(deferredTaskB.id).status === 'deferred',
            `Expected task B to remain deferred (never closed), got: ${JSON.stringify(deferredGoalPriority.finalBeadsById.get(deferredTaskB.id))}`
        );
    });

    // apra-fleet-unw2.18 (N18) fix (b): reviewer prompt's embedded bd show
    // --json must be wrapped with wrapUntrustedBlock for A7 fencing
    // compliance -- covered by the run1ReviewerDispatches assertions in
    // mock-sprint-happy-path.test.mjs (apra-fleet-fih.2; formerly a
    // dedicated 'reviewerpromptfence' scenario here).
    const runnerSource = await fs.readFile(path.join(__dirname, '../auto-sprint/runner.js'), 'utf-8');
    check(
        !/return\s*\{\s*status:\s*'success'/.test(runnerSource),
        'runner.js source must not contain an unconditional return { status: \'success\', ... } -- the return value must be verdict-driven (A6)'
    );
    check(
        /status:\s*finalVerdictResult\.verdict\s*===\s*'PASS'\s*\?\s*'success'\s*:\s*'failed'/.test(runnerSource),
        'runner.js source must derive the returned status from the final verdict (A6)'
    );
});
