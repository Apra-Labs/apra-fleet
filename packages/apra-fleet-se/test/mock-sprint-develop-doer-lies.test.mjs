import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-unw.16 acceptance criterion 4: doer "lies" (success text,
// bead never actually closed) is treated as a FAILURE, not a success
// =============================================================================
test('mock sprint: a doer that lies about closing a bead is treated as a failure', async () => {
    await withScenarioMarkers('liar (doer lies)', async () => {
        console.log('Running mock sprint scenario (doer lies about closing a bead)...');
        const liar = await runDevelopLoopScenario('liar', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Lied about closing' },
            ],
            doerHandler: async ({ opts }) => {
                const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                // Deliberately do NOT call `bd close` -- report success anyway.
                return {
                    content: [{
                        text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'All done, closed successfully!' })
                    }]
                };
            },
        });
        check(!liar.error, `Doer-lies scenario should not error: ${liar.error ? liar.error.message : ''}`);
        const liedTaskId = liar.tasks.find((t) => t.title === 'Task: Lied about closing').id;
        check(
            liar.finalBeadsById.get(liedTaskId) && liar.finalBeadsById.get(liedTaskId).status !== 'closed',
            `Expected the bead the doer lied about to remain open, got: ${JSON.stringify(liar.finalBeadsById.get(liedTaskId))}`
        );
        check(
            liar.logs.some((m) => m.includes('treating streak as FAILED') && m.includes(liedTaskId)),
            `Expected a "treating streak as FAILED" log line naming '${liedTaskId}' despite the doer's success-looking report, logs: ${JSON.stringify(liar.logs)}`
        );
    });
});
