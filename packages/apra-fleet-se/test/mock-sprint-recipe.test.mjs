import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// A sprint design end to end through the real runner.js on the mock-sprint
// harness: review, final review and harvest turned off, a command block after
// the build, and a model floor under the doer. No reviewer, final reviewer or
// harvester may be dispatched, and the sprint still finishes.
// =============================================================================

const idsFromPrompt = (prompt) => {
    const m = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};

test('mock sprint: a lean design skips review, final review and harvest, and runs its blocks', async () => {
    await withScenarioMarkers('recipe lean design', async () => {
        const doerModels = [];
        const scenario = await runDevelopLoopScenario('recipe-lean', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Lean one' }, { title: 'Task: Lean two' }],
            extraRunnerArgs: {
                recipe: {
                    name: 'Lean',
                    build: { minModel: 'standard' },
                    review: { run: 'off' },
                    finish: { finalReview: false, harvest: false },
                    blocks: [{ kind: 'command', name: 'Unit tests', command: 'node --version' }],
                },
            },
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                doerModels.push(opts.model);
                const ids = idsFromPrompt(opts.prompt);
                // A classic doer closes its own tasks.
                for (const id of ids) await rc(`bd close ${id}`, td);
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'done' }) }] };
            },
            reviewerHandler: async () => { throw new Error('the design turned review off: no reviewer may run'); },
            finalReviewHandler: async () => { throw new Error('the design turned the final review off'); },
        });
        assert.ok(!scenario.error, `lean scenario errored: ${scenario.error ? scenario.error.stack : ''}`);
        const agents = scenario.dispatched.map((d) => d.agent);
        assert.ok(agents.includes('doer'), `a doer ran: ${JSON.stringify(agents)}`);
        for (const role of ['reviewer', 'harvester']) {
            assert.ok(!agents.includes(role), `no ${role} dispatch: ${JSON.stringify(agents)}`);
        }
        assert.ok(!scenario.dispatched.some((d) => d.label === 'Final Review'), 'no final review dispatch');
        assert.ok(doerModels.length > 0 && doerModels.every((m) => m && !/haiku|cheap/i.test(String(m))), `doer ran at or above the floor: ${JSON.stringify(doerModels)}`);
        assert.ok(scenario.commandLog.some((c) => String(c).includes('node --version')), 'the command block ran');
        const says = (re) => scenario.logs.some((m) => re.test(m));
        assert.ok(says(/Block "Unit tests" C1: passed/), 'block result logged');
        assert.ok(says(/review is turned off in this sprint design/), 'exit without a review');
        assert.ok(says(/Final Review: turned off in this sprint design -- verdict PASS/), 'verdict from task state');
        assert.ok(says(/Harvest is turned off in this sprint design/), 'harvest skipped');
        assert.equal(scenario.result && scenario.result.status, 'success', `sprint result: ${JSON.stringify(scenario.result)}`);
    });
});
