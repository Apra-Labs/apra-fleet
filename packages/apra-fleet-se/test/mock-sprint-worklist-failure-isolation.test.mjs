import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-eft.79.2 -- mid-worklist failure isolation (AC: "streak 2 of 3
// fails -> streak 1's closes stand, streak 3 still dispatched, only streak
// 2's open beads re-laned").
//
// One doer, three 1-bead streaks (planner lane metadata) -> one 3-streak
// ordered worklist. The doer closes streak 1, THROWS on streak 2 (twice --
// the engine retries a generic throw once), then closes streak 3 -- all in
// the same round. The failed streak's bead is re-dispatched ALONE on a later
// round and closes then.
// =============================================================================

const idsForDispatch = (d) => {
    const match = d.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};

test('mock sprint (mode ii): a failure in streak 2 of 3 keeps streak 1\'s closes, still dispatches streak 3, and re-lanes only streak 2\'s bead', async () => {
    await withScenarioMarkers('worklist failure isolation', async () => {
        let failCount = 0;

        const scenario = await runDevelopLoopScenario('wlfailiso', {
            members: ['solo'],
            taskSpecs: [
                { title: 'Task: WLF first' },
                { title: 'Task: WLF second (fails)' },
                { title: 'Task: WLF third' },
            ],
            // Three SEPARATE 1-bead lanes -> three streaks -> one 3-streak
            // worklist on the single doer.
            beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => {
                const first = tasks.find((t) => t.title === 'Task: WLF first');
                const second = tasks.find((t) => t.title === 'Task: WLF second (fails)');
                const third = tasks.find((t) => t.title === 'Task: WLF third');
                await rc(`bd update ${first.id} --set-metadata streak=lane-1 --set-metadata streakOrder=1 --set-metadata model=standard`, td);
                await rc(`bd update ${second.id} --set-metadata streak=lane-2 --set-metadata streakOrder=2 --set-metadata model=standard`, td);
                await rc(`bd update ${third.id} --set-metadata streak=lane-3 --set-metadata streakOrder=3 --set-metadata model=standard`, td);
            },
            reviewerHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }]
            }),
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = idsForDispatch({ prompt: opts.prompt });
                const listRes = JSON.parse((await rc('bd list --all --json', td)).stdout || '[]');
                const failing = listRes.find((b) => b.title === 'Task: WLF second (fails)');
                // Streak 2 fails on its first dispatch AND on the engine's
                // bounded retry of that same streak; its round-2 re-lane
                // (third time) succeeds.
                if (failing && ids.length === 1 && ids[0] === failing.id && failCount < 2) {
                    failCount += 1;
                    throw new Error(`mock doer failure for worklist streak 2 (attempt ${failCount})`);
                }
                for (const id of ids) {
                    await rc(`bd close ${id}`, td);
                }
                return {
                    content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed.' }) }],
                    // A resume-capable provider: session ids are reported, so
                    // this scenario also proves a FAILED streak clears the
                    // worklist session (streak 3 must dispatch fresh, never
                    // resuming the broken streak-2 session).
                    structuredContent: { sessionId: `sess-solo-${failCount}-${ids.join('_')}` },
                };
            },
        });

        check(!scenario.error, `Scenario should not abort: ${scenario.error ? scenario.error.message : ''}`);
        check(scenario.result && scenario.result.status === 'success', `Expected the sprint to eventually succeed, got: ${JSON.stringify(scenario.result)}`);

        const firstId = scenario.tasks.find((t) => t.title === 'Task: WLF first').id;
        const secondId = scenario.tasks.find((t) => t.title === 'Task: WLF second (fails)').id;
        const thirdId = scenario.tasks.find((t) => t.title === 'Task: WLF third').id;

        // The round packed one 3-streak worklist for the single doer.
        check(
            scenario.logs.some((m) => m.includes('Doer worklists: 3 ready streak(s) > 1 doer(s)')),
            `Expected the 3-streak worklist packing log, got: ${JSON.stringify(scenario.logs.filter((m) => m.includes('Doer worklists')))}`
        );

        const doerDispatches = scenario.dispatched.filter((d) => d.agent === 'doer');
        const dispatchIds = doerDispatches.map((d) => idsForDispatch(d));

        // Round-1 worklist order: streak 1, streak 2 (+ its same-streak
        // retry), then streak 3 -- streak 3 was STILL dispatched despite
        // streak 2's terminal failure (never cancelled).
        const i1 = dispatchIds.findIndex((ids) => ids.length === 1 && ids[0] === firstId);
        const i2 = dispatchIds.findIndex((ids) => ids.length === 1 && ids[0] === secondId);
        const i3 = dispatchIds.findIndex((ids) => ids.length === 1 && ids[0] === thirdId);
        check(i1 !== -1 && i2 !== -1 && i3 !== -1, `Expected all three streaks dispatched, got: ${JSON.stringify(dispatchIds)}`);
        check(i1 < i2 && i2 < i3, `Expected worklist order streak1 -> streak2 -> streak3, got indexes ${i1}, ${i2}, ${i3}: ${JSON.stringify(dispatchIds)}`);

        // Streak 3 dispatched FRESH: the failed streak-2 session was cleared,
        // never resumed into streak 3.
        const thirdDispatch = doerDispatches[i3];
        check(thirdDispatch.resume === false, `Expected streak 3 to start a FRESH session after streak 2's failure, got resume=${JSON.stringify(thirdDispatch.resume)}`);

        // Streak 2's failure was attributed to streak 2 only.
        check(
            scenario.logs.some((m) => m.includes(`Doer streak attribution [${secondId}]: closed=[] failed=[${secondId}]`)),
            `Expected streak 2's failure attribution line, got: ${JSON.stringify(scenario.logs.filter((m) => m.includes('attribution')))}`
        );

        // Only streak 2's bead was re-laned: a LATER dispatch carries only
        // secondId, and the already-closed first/third beads are never
        // re-dispatched.
        const laterSecond = dispatchIds.slice(i3 + 1).some((ids) => ids.length === 1 && ids[0] === secondId);
        check(laterSecond, `Expected a later re-lane dispatch carrying ONLY streak 2's bead, got: ${JSON.stringify(dispatchIds)}`);
        check(
            dispatchIds.filter((ids) => ids.includes(firstId)).length === 1
            && dispatchIds.filter((ids) => ids.includes(thirdId)).length === 1,
            `Expected the closed streak-1/streak-3 beads to never be re-dispatched, got: ${JSON.stringify(dispatchIds)}`
        );

        // Final state: everything closed; streak 1's close STOOD through the
        // streak-2 failure (never discarded/reopened by it).
        for (const id of [firstId, secondId, thirdId]) {
            const b = scenario.finalBeadsById.get(id);
            check(b && b.status === 'closed', `Expected bead '${id}' closed, got: ${JSON.stringify(b)}`);
        }

        // The one and only bd close of streak 1 happened during round 1 (the
        // doer handler closed it exactly once -- see the single dispatch
        // assertion above), so its close verifiably survived the sibling
        // failure rather than being redone later.
        check(failCount === 2, `Expected exactly 2 failing attempts on streak 2 (initial + engine retry), got ${failCount}`);
    });
});
