// =============================================================================
// Lane order never holds children behind laned sibling containers.
//
// Reproduces the logged deadlock shape: two sibling containers A and B (each
// the parent of in-scope tasks) both at lane S streakOrder 0, and their
// children A.1 (S, order 1), B.1 (S, order 1), A.2 (S, order 2). Before the
// fix Develop logged "HELD by lane order" for every child (behind A and B,
// which can only close after their children) and the run ended in a generic
// stale-cycle StalledSprintError.
//
// Drives the REAL runner through the mock-sprint harness: the doers close the
// children, the reviewer approves, and the containers close as usual once
// their children are closed (verify-routed, closed by Integration Test).
//
// REVERT CHECK (checked when this test was written): with the container
// exclusion removed from lowerOrderLaneMates in fleet-sprint/beads-scope.mjs
// (the helper all three lane-order sites, including worklists.mjs's
// holdBackByLaneOrder, go through), no child is dispatched, the HELD line
// names them behind A and B, and this test fails.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const S = 'lane-s';
const TITLES = {
    a: 'Task: container A',
    b: 'Task: container B',
    a1: 'Task: A.1 child work',
    b1: 'Task: B.1 child work',
    a2: 'Task: A.2 child work',
};

const assignedIds = (prompt) => {
    const match = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};

const closeAssignedDoer = async ({ opts, tempDir }) => {
    const ids = assignedIds(opts.prompt);
    for (const id of ids) await runCmd(`bd close ${id}`, tempDir);
    return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed all assigned beads.' }) }] };
};

const approvingReviewer = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Looks good.', reopenIds: [], newTasks: [] }) }],
});

test('mock sprint: laned sibling containers ahead of their children -> children dispatched and closed, no stall', async () => {
    await withScenarioMarkers('lanecontainerorder', async () => {
        const ids = {};
        const run = await runDevelopLoopScenario('lanecontainerorder', {
            members: ['local'],
            taskSpecs: Object.values(TITLES).map((title) => ({ title })),
            maxCycles: 3,
            withRunbooks: true,
            beforeSprint: async ({ tempDir, tasks }) => {
                for (const [key, title] of Object.entries(TITLES)) ids[key] = tasks.find((t) => t.title === title).id;
                await runCmd(`bd update ${ids.a1} --parent ${ids.a}`, tempDir);
                await runCmd(`bd update ${ids.b1} --parent ${ids.b}`, tempDir);
                await runCmd(`bd update ${ids.a2} --parent ${ids.a}`, tempDir);
                await runCmd(`bd update ${ids.a} --set-metadata streak=${S} --set-metadata streakOrder=0`, tempDir);
                await runCmd(`bd update ${ids.b} --set-metadata streak=${S} --set-metadata streakOrder=0`, tempDir);
                await runCmd(`bd update ${ids.a1} --set-metadata streak=${S} --set-metadata streakOrder=1`, tempDir);
                await runCmd(`bd update ${ids.b1} --set-metadata streak=${S} --set-metadata streakOrder=1`, tempDir);
                await runCmd(`bd update ${ids.a2} --set-metadata streak=${S} --set-metadata streakOrder=2`, tempDir);
            },
            doerHandler: closeAssignedDoer,
            reviewerHandler: approvingReviewer,
        });

        assert.ok(!run.error, `the run must not throw (no StalledSprintError): ${run.error && `${run.error.name}: ${run.error.message}`}`);
        assert.ok(run.dispatched.some((d) => d.label === 'Final Review'), 'the run must reach Final Review');

        // All three children dispatched in Develop and closed.
        const children = [ids.a1, ids.b1, ids.a2];
        const doerAssigned = run.dispatched.filter((d) => d.agent === 'doer').flatMap((d) => assignedIds(d.prompt));
        for (const id of children) {
            assert.ok(doerAssigned.includes(id), `child ${id} must be dispatched to a doer, got ${JSON.stringify(doerAssigned)}`);
            assert.equal(run.finalBeadsById.get(id).status, 'closed', `child ${id} must end closed`);
        }
        // No HELD-by-lane-order line names a child.
        const heldLines = run.logs.filter((l) => /HELD by lane order/.test(l));
        for (const id of children) {
            assert.ok(!heldLines.some((l) => l.includes(id)), `no HELD line may name ${id}: ${JSON.stringify(heldLines)}`);
        }
        // The containers close as usual after their children.
        assert.equal(run.finalBeadsById.get(ids.a).status, 'closed', 'container A closes after its children');
        assert.equal(run.finalBeadsById.get(ids.b).status, 'closed', 'container B closes after its children');

        // The ignored-container log line appears exactly once per container.
        for (const id of [ids.a, ids.b]) {
            const lines = run.logs.filter((l) => l.startsWith(`Lane order: ${id} carries lane metadata (streak ${S}) but is a container`));
            assert.equal(lines.length, 1, `expected one ignored-lane line for ${id}, got ${JSON.stringify(lines)}`);
        }
    });
});
