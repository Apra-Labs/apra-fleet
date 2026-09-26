import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// Build pipeline mode end to end through the real runner.js and the real
// 'doer' role row (dispatchRole), on the mock-sprint harness: the doer works
// on its own task branch without any bd command, the orchestrator lands each
// branch and closes the task, and no per-round review runs -- the cycle's
// Re-Review reviews the work once everything has landed.
// =============================================================================

const idsFromPrompt = (prompt) => {
    const m = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};

test('mock sprint: pipeline mode builds each task on its own branch and lands it', async () => {
    await withScenarioMarkers('pipeline mode (single member)', async () => {
        const doerBranches = [];
        const scenario = await runDevelopLoopScenario('pipeline', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Pipeline one' }, { title: 'Task: Pipeline two' }],
            extraRunnerArgs: { pipeline: true },
            // This harness answers every git command with a canned success
            // (its tempDir is a bd scratch dir, not a git repo), so git
            // behaviour itself is covered by develop-pipeline.test.mjs against
            // real clones. Here the doer only reports back.
            doerHandler: async ({ opts }) => {
                const [id] = idsFromPrompt(opts.prompt);
                const branch = /Sprint track branch to work on:\s*(\S+?)\./.exec(opts.prompt)[1];
                doerBranches.push({ id, branch, prompt: opts.prompt });
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: [id], notes: 'done' }) }] };
            },
            reviewerHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
            }),
        });
        assert.ok(!scenario.error, `pipeline scenario errored: ${scenario.error ? scenario.error.stack : ''}`);

        assert.equal(doerBranches.length, 2, 'one doer dispatch per task');
        for (const d of doerBranches) {
            assert.match(d.branch, /--task-/, 'each task has its own branch');
            assert.match(d.prompt, /must NOT run any `bd` command/, 'the doer is told the orchestrator owns task state');
        }
        for (const t of scenario.tasks) {
            const final = scenario.finalBeadsById.get(t.id);
            assert.equal(final && final.status, 'closed', `task ${t.id} closed by the orchestrator at landing`);
        }
        // The git steps the runner issued for each task, in order.
        const gitCmds = scenario.commandLog.filter((c) => c.startsWith('git '));
        for (const d of doerBranches) {
            const cut = gitCmds.indexOf(gitCmds.find((c) => c.startsWith(`git checkout -B ${d.branch} `)));
            const merge = gitCmds.indexOf(`git merge --no-ff --no-edit ${d.branch}`);
            assert.ok(cut >= 0, `task branch ${d.branch} was cut: ${JSON.stringify(gitCmds)}`);
            assert.ok(merge > cut, `task branch ${d.branch} was merged after it was cut`);
            assert.ok(gitCmds.includes(`git push origin ${d.branch}`), `task branch ${d.branch} was pushed by its bracket`);
        }
        // Review runs once, at the end of the cycle, not after each landing.
        assert.ok(scenario.logs.some((m) => /Cycle 1: 0 open goal-priority bead\(s\) but no review ran THIS cycle/.test(m)),
            'no per-round review ran; the cycle-end Re-Review covers the work');
        assert.ok(scenario.logs.some((m) => /Build C1: pipeline mode -- one task at a time \(shared workspace\)/.test(m)), 'ran in pipeline mode');
        assert.ok(scenario.logs.some((m) => /Build C1 done: landed 2 task\(s\)/.test(m)), `both landed: ${JSON.stringify(scenario.logs.filter((m) => m.startsWith('Build C')))}`);
        assert.ok(!scenario.logs.some((m) => /^Develop C1 R1/.test(m)), 'the round loop did not run');
        assert.ok(scenario.result && scenario.result.status === 'success', `sprint result: ${JSON.stringify(scenario.result)}`);
    });
});
