import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// The sprint-start memory sweep, end to end through the real runner.js: the
// seeded token-usage memories are forgotten on the orchestrator member before
// any dispatch, one WARNING line names them, the legitimate memory stays, and
// the sprint proceeds.
// =============================================================================

const approvedReviewer = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});

test('mock sprint: seeded token-usage memories are forgotten at sprint start with one WARNING; the sprint proceeds', async () => {
    await withScenarioMarkers('memhygiene', async () => {
        const r = await runDevelopLoopScenario('memhygiene', {
            members: ['orch'],
            taskSpecs: [{ title: 'Task: memory hygiene' }],
            reviewerHandler: approvedReviewer,
            beadsMemories: {
                'run-a-doer': 'run-a doer sonnet tokens: input=95000 output=13000',
                'run-b-review': 'run-b opus tokens: input=118000 output=8000',
                'real-rule': 'Always run the linter before committing.',
            },
        });
        assert.equal(r.error, null, `expected the sprint to proceed, got: ${r.error && r.error.message}`);
        assert.ok(r.result && r.result.status === 'success', `expected success, got ${JSON.stringify(r.result)}`);
        assert.deepEqual([...r.forgottenMemories].sort(), ['run-a-doer', 'run-b-review']);
        const forgets = r.commandLogDetailed.filter((c) => c.command.startsWith('bd forget '));
        assert.equal(forgets.length, 2);
        assert.ok(forgets.every((c) => c.member === 'orch'));
        const warns = r.logs.filter((l) => l.startsWith('[beads-hygiene] WARNING: '));
        assert.equal(warns.length, 1, JSON.stringify(warns));
        assert.match(warns[0], /removed 2 token-usage memories from the beads DB: run-a-doer, run-b-review/);
        // Listed exactly once: sprint start only, no per-cycle re-run.
        assert.equal(r.commandLog.filter((c) => c === 'bd memories --json').length, 1, 'sprint start only');
    });
});
