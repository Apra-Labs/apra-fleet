// End-to-end mock sprint for the VERIFY-no-change set-aside: a doer that
// answers VERIFY for an open bead without closing it (nothing to code) is
// dispatched onto that bead exactly once; the bead is set aside with a logged
// reason and the sprint finishes through the set-aside carry-over exit, naming
// the bead, instead of re-dispatching it every round until StalledSprintError.
//
// Reverting the set-aside (phases/develop.mjs recordDoerVerifyNoChange) makes
// this fail: the bead is re-dispatched every round of every cycle and the run
// ends in StalledSprintError.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';

const resetSyncMemo = () => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
};
const assignedIds = (prompt) => {
    const match = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const report = (obj) => ({ content: [{ text: JSON.stringify(obj) }] });
const approve = async () => report({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] });
const rubberStampPass = async () => report({ verdict: 'PASS', notes: 'Rubber-stamp PASS from the final reviewer.' });

const NOTHING = 'Task: only verification left';
const WORK = 'Task: real implementation';
const VERIFY_NOTES = 'Nothing to code: the remaining work is verification only.';

test('mock sprint: a doer VERIFY with no change is dispatched once, set aside with its reason, and carried over', async () => {
    resetSyncMemo();
    await withScenarioMarkers('doer verify no change carry-over', async () => {
        const run = await runDevelopLoopScenario('dvnc-carry', {
            members: ['local'],
            taskSpecs: [{ title: NOTHING, priority: 'P1' }, { title: WORK, priority: 'P1' }],
            maxCycles: 3,
            beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => {
                for (const [i, title] of [NOTHING, WORK].entries()) {
                    const id = tasks.find((x) => x.title === title).id;
                    await rc(`bd update ${id} --set-metadata streak=lane-${i} --set-metadata streakOrder=1`, td);
                }
            },
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts.prompt);
                const list = JSON.parse((await rc('bd list --json', td)).stdout || '[]');
                const nothing = list.find((b) => b.title === NOTHING);
                if (nothing && ids.includes(nothing.id)) {
                    return report({ status: 'VERIFY', closedIds: [], notes: VERIFY_NOTES });
                }
                for (const x of ids) await rc(`bd close ${x}`, td);
                return report({ status: 'VERIFY', closedIds: ids, notes: 'Done.' });
            },
            reviewerHandler: approve,
            finalReviewHandler: rubberStampPass,
        });
        const id = (title) => run.tasks.find((t) => t.title === title).id;
        const nothing = id(NOTHING);

        // Dispatched onto the bead exactly once in the whole run.
        const onNothing = run.dispatched.filter((d) => d.agent === 'doer' && assignedIds(d.prompt).includes(nothing));
        assert.equal(onNothing.length, 1, `doer dispatches onto ${nothing}: ${onNothing.length}`);

        // The set-aside and its reason are logged.
        const line = run.logs.find((l) => l.includes('Doer VERIFY-no-change set-aside') && l.includes(`'${nothing}'`));
        assert.ok(line, `the set-aside must be logged: ${JSON.stringify(run.logs.filter((l) => /VERIFY/.test(l)))}`);
        assert.ok(line.includes('closed none of its beads') && line.includes(VERIFY_NOTES), line);

        // No stall: the run finishes through the carry-over exit naming the bead.
        assert.ok(!run.error, `no StalledSprintError expected: ${run.error && run.error.message}`);
        assert.equal(run.result.exitReason, 'set-aside-carry-over', JSON.stringify(run.result));
        assert.equal(run.finalBeadsById.get(id(WORK)).status, 'closed');
        assert.notEqual(run.finalBeadsById.get(nothing).status, 'closed');
        assert.deepEqual(run.result.carryOver.map((e) => e.id), [nothing]);
        assert.ok(run.result.carryOver[0].reason.includes('returned VERIFY'), run.result.carryOver[0].reason);
        assert.equal(run.result.verdict, 'FAIL', 'an at-goal bead carried over forces FAIL');
        assert.ok(run.result.notes.includes(`${nothing} -- `), run.result.notes);
    });
});
