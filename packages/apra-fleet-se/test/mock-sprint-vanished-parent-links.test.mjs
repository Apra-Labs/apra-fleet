// =============================================================================
// End-to-end guard: a beads merge outside the sprint silently drops the
// parent-child rows of the sprint's tree mid-run.
//
// Root: a bug bead. Under it two intermediate parents (run once with
// feature-type and once with task-type intermediates), each with leaf tasks.
// During Develop round 1 -- after the doer closed its leaves -- the harness
// removes every parent-child link of the tree directly in the backlog clone,
// outside the engine's command path, the way an auto-resolved merge pulled by
// any clone would. Nothing in the run removed those links.
//
// Before the fix the engine's scope then held only the root: the root was
// dispatched to a doer as a leaf, nothing was verify-routed, the closed count
// stopped moving and the run ended in StalledSprintError.
//
// Asserted:
//   - an ERROR line names each lost child/parent edge;
//   - every edge is present in the backlog DB at the end;
//   - the root is never dispatched to a doer;
//   - both intermediates are verify-routed and the run finishes PASS.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const report = (obj) => ({ content: [{ text: JSON.stringify(obj) }] });
const assignedIds = (prompt) => {
    const match = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
// Ids carry dots (parent.child), so stop at the sentence's '. ' not at any '.'.
const verifyIdsOf = (prompt) => {
    const match = prompt.match(/verification-closure:\s*(.+?)\.\s/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const errText = (run) => (run.error ? `${run.error.constructor.name}: ${run.error.message}` : 'none');

async function runVanishedLinks(tag, intermediateType) {
    const tree = { root: null, intermediates: [], leaves: [], edges: [] };
    const doerAssigned = [];
    const integVerifyIds = [];
    let dropped = false;

    const doerHandler = async ({ opts, runCmd: rc, tempDir: td }) => {
        const ids = assignedIds(opts.prompt);
        doerAssigned.push(...ids);
        const closed = [];
        for (const id of ids) {
            // A doer handed the root (a decomposed parent) finds nothing of its
            // own to implement: no change, nothing closed.
            if (id === tree.root) continue;
            await rc(`bd close ${id} --reason "Done"`, td);
            closed.push(id);
        }
        if (!dropped) {
            // The external merge: every parent-child link of the tree is gone
            // from the backlog clone. Issued straight against the DB, never
            // through the engine's command path.
            dropped = true;
            for (const { child } of tree.edges) await rc(`bd update ${child} --parent ""`, td);
        }
        return report({ status: 'VERIFY', closedIds: closed, notes: closed.length ? 'Closed.' : 'Nothing to change.' });
    };

    const integHandler = async ({ opts, runCmd: rc, tempDir: td }) => {
        const ids = verifyIdsOf(opts.prompt);
        integVerifyIds.push(...ids);
        for (const id of ids) await rc(`bd close ${id} --reason "Verified against the deployed build."`, td);
        return report({
            featuresClosed: ids.length, issuesCreated: 0, passed: true, bugsFiled: [],
            verifySetClosed: ids, verifySetLeftOpen: [],
            summary: ids.length ? `Verified and closed: ${ids.join(', ')}.` : 'Nothing to verify.',
        });
    };

    const run = await runDevelopLoopScenario(tag, {
        members: ['local'],
        taskSpecs: [
            { title: 'Task: leaf one', priority: 'P1' },
            { title: 'Task: leaf two', priority: 'P1' },
            { title: 'Task: leaf three', priority: 'P1' },
        ],
        withRunbooks: true,
        maxCycles: 4,
        goal: 'P1/P2',
        doerHandler,
        reviewerHandler: async () => report({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }),
        finalReviewHandler: async () => report({ verdict: 'PASS', notes: 'Rubber-stamp PASS.' }),
        integHandler,
        beforeSprint: async ({ tempDir, runCmd, epicBead, tasks }) => {
            tree.root = epicBead.id;
            await runCmd(`bd update ${epicBead.id} -t bug`, tempDir);
            const mk = async (title) => String((await runCmd(`bd create -t ${intermediateType} "${title}" -d "Intermediate parent." -p 1 --parent ${epicBead.id} --silent`, tempDir)).stdout || '').trim();
            const first = await mk('Intermediate: first group');
            const second = await mk('Intermediate: second group');
            tree.intermediates = [first, second];
            const placement = [first, first, second];
            for (let i = 0; i < tasks.length; i++) {
                await runCmd(`bd update ${tasks[i].id} --parent ${placement[i]}`, tempDir);
                tree.leaves.push(tasks[i].id);
                tree.edges.push({ child: tasks[i].id, parent: placement[i] });
            }
            tree.edges.push({ child: first, parent: epicBead.id }, { child: second, parent: epicBead.id });
        },
    });
    return { run, tree, doerAssigned, integVerifyIds, dropped: () => dropped };
}

for (const [intermediateType, tag] of [['feature', 'vlinkfeat'], ['task', 'vlinktask']]) {
    test(`${intermediateType}-type intermediates: dropped parent-child rows are restored, the root is never a leaf, the run finishes PASS`, { timeout: 300000 }, async () => {
        await withScenarioMarkers(`vanished parent links ${intermediateType}`, async () => {
            const { run, tree, doerAssigned, integVerifyIds, dropped } = await runVanishedLinks(tag, intermediateType);
            const logs = run.logs;
            const dump = () => logs.filter((l) => /^ERROR|Route C|evaluation|Goal priority|stall/i.test(l)).join('\n');

            assert.ok(dropped(), 'the harness dropped the parent-child rows during Develop round 1');
            for (const { child, parent } of tree.edges) {
                assert.ok(
                    logs.some((l) => l.startsWith('ERROR: parent-child link vanished') && l.includes(`'${child}' is no longer a child of '${parent}'`)),
                    `an ERROR names the lost edge ${child} -> ${parent}:\n${dump()}`,
                );
                assert.equal(run.finalBeadsById.get(child) && run.finalBeadsById.get(child).parent, parent,
                    `the edge ${child} -> ${parent} is back in the backlog DB`);
            }
            assert.ok(!doerAssigned.includes(tree.root), `the root ${tree.root} is never dispatched to a doer: ${JSON.stringify(doerAssigned)}`);
            // Verify-routed at either classification point: a cycle-top Route
            // line, or the Integ Test verify set (verification-closure).
            for (const id of tree.intermediates) {
                const routed = integVerifyIds.includes(id) || logs.some((l) => /^Route C\d+: /.test(l) && l.includes(id));
                assert.ok(routed, `${id} is verify-routed (integ verify set ${JSON.stringify(integVerifyIds)}):\n${dump()}`);
                assert.equal(run.finalBeadsById.get(id).status, 'closed', `${id} is closed by verification`);
            }
            assert.equal(run.error, null, `the run finishes: ${errText(run)}\n${dump()}`);
            assert.equal(run.result && run.result.verdict, 'PASS', JSON.stringify(run.result));
        });
    });
}
