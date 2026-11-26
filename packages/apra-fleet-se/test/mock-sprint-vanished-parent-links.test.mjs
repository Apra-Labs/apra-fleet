// =============================================================================
// End-to-end guard: a parent-child change an AGENT makes on its own clone,
// outside the engine's command path and with no beads pull in between, is
// never reverted by the parent-link guard.
//
// Root: a bug bead. Under it two intermediate parents (run once with
// feature-type and once with task-type intermediates), each with leaf tasks.
// During Develop round 1 -- after the doer closed its leaves -- the doer
// reparents the second leaf from the first intermediate to the second one,
// straight in the backlog clone. Only a link a beads PULL dropped is a
// restore candidate (fleet-sprint/parent-link-guard.mjs); this one vanished
// between two reads with no pull, so it was removed on purpose.
//
// Before the fix the engine "restored" every recorded link that vanished from
// a snapshot, so the reparent was silently undone (and a reversed blocks edge
// re-added would be refused by bd as a cycle, stopping the sprint).
//
// Asserted:
//   - no ERROR line restores (or reverts) any parent-child link;
//   - the moved leaf is under its new parent in the backlog DB at the end;
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
    const tree = { root: null, intermediates: [], leaves: [], edges: [], moved: null };
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
            // The agent's own change: the second leaf moves to the second
            // intermediate (both intermediates keep a child). Issued straight against the DB, never through the
            // engine's command path, and with no beads pull around it.
            dropped = true;
            await rc(`bd update ${tree.moved.child} --parent ${tree.moved.to}`, td);
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
            tree.moved = { child: tasks[1].id, from: first, to: second };
        },
    });
    return { run, tree, doerAssigned, integVerifyIds, dropped: () => dropped };
}

for (const [intermediateType, tag] of [['feature', 'vlinkfeat'], ['task', 'vlinktask']]) {
    test(`${intermediateType}-type intermediates: an agent reparent is not reverted, the root is never a leaf, the run finishes PASS`, { timeout: 300000 }, async () => {
        await withScenarioMarkers(`agent reparent kept ${intermediateType}`, async () => {
            const { run, tree, doerAssigned, integVerifyIds, dropped } = await runVanishedLinks(tag, intermediateType);
            const logs = run.logs;
            const dump = () => logs.filter((l) => /^ERROR|Route C|evaluation|Goal priority|stall/i.test(l)).join('\n');

            assert.ok(dropped(), 'the doer reparented the leaf during Develop round 1');
            assert.ok(!logs.some((l) => /^ERROR: parent-child link (vanished|reverted)/.test(l)), `no link is restored:\n${dump()}`);
            const { child, to } = tree.moved;
            assert.equal(run.finalBeadsById.get(child) && run.finalBeadsById.get(child).parent, to,
                `the moved leaf ${child} stays under its new parent ${to}`);
            for (const edge of tree.edges.filter((e) => e.child !== child)) {
                assert.equal(run.finalBeadsById.get(edge.child) && run.finalBeadsById.get(edge.child).parent, edge.parent,
                    `the untouched edge ${edge.child} -> ${edge.parent} is still in the backlog DB`);
            }
            assert.ok(!doerAssigned.includes(tree.root), `the root ${tree.root} is never dispatched to a doer: ${JSON.stringify(doerAssigned)}`);
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
