import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-3swo.4.7: the Re-Review verdict site must apply its reopenIds
// through the SAME goal-scope guard as the per-round reviewer and Final
// Review.
//
// Re-Review is the "0 open goal-priority beads but no review ran THIS cycle"
// branch. Before this change it was the ONE verdict site that looped over
// reopenIds issuing `bd update <id> --status=open` with no guard at all, so a
// re-reviewer naming a DEFERRED below-goal bead dragged it straight back into
// a sprint that no longer targeted it -- injecting out-of-scope work and
// pinning the verdict at CHANGES_NEEDED.
//
// This drives the REAL runner.js Re-Review branch end to end against a real
// bd database (not the guard helper in isolation), so reverting the guard at
// that site makes this test fail.
//
// Scenario shape is borrowed from the stale-APPROVED regression: cycle 1
// closes A and leaves B `blocked` (counts toward the goal-priority open count
// but is never re-offered via `--ready`, so cycle 2's Develop/Review loop is
// skipped); cycle 2's Deploy closes B out of band, so the exit check reads 0
// open at goal with no review this cycle -- exactly the Re-Review trigger.
// On top of that, a P3 bead sits deferred below the P1/P2 goal the whole time,
// and the re-review names it in reopenIds.
// =============================================================================
test('mock sprint: the Re-Review site refuses a below-goal reopen id, with the shared deferred-scope outcome', async () => {
    await withScenarioMarkers('rereviewguard (goal-scope guard at the Re-Review site)', async () => {
        let deployCalls = 0;
        let reviewCalls = 0;
        let deferredId = null;

        const scenario = await runDevelopLoopScenario('rereviewguard', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: A closes normally (re-review guard scenario)' },
                { title: 'Task: B stays blocked (re-review guard scenario)' },
            ],
            goal: 'P1/P2',
            maxCycles: 2,
            withRunbooks: true,
            // A P3 bead the sprint has DEFERRED: below the P1/P2 goal, so it
            // never counts toward the goal-priority open count and never
            // blocks the exit check -- but it IS in sprint scope, so the
            // goal-scope allowlist knows about it and can refuse it.
            beforeSprint: async ({ tempDir: td, runCmd: run, epicBead }) => {
                const createRes = await run(
                    'bd create -t task -p 3 "Task: deferred P3 (re-review guard scenario)" '
                    + '-d "Deliberately below the sprint goal -- must never be reopened by a re-review." --silent',
                    td
                );
                deferredId = createRes.stdout.trim();
                await run(`bd update ${deferredId} --parent ${epicBead.id}`, td);
                await run(`bd update ${deferredId} --status=deferred`, td);
            },
            doerHandler: async ({ opts, tempDir: td }) => {
                const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                const listRes = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
                const bTask = listRes.find((b) => b.title === 'Task: B stays blocked (re-review guard scenario)');
                const closedIds = [];
                for (const id of ids) {
                    if (bTask && id === bTask.id) {
                        await runCmd(`bd update ${id} --status=blocked`, td);
                    } else {
                        await runCmd(`bd close ${id}`, td);
                        closedIds.push(id);
                    }
                }
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds, notes: 'Closed A; left B blocked.' }) }] };
            },
            // Call 1 is cycle 1's ordinary in-loop review (APPROVED, so the
            // Develop loop ends). Call 2 is cycle 2's RE-REVIEW: it names the
            // deferred P3 bead in reopenIds -- the exact move the guard must
            // refuse -- alongside a genuinely in-goal id it must still honour.
            reviewerHandler: async ({ tempDir: td }) => {
                reviewCalls++;
                if (reviewCalls === 1) {
                    return { content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved; B deferred as out-of-scope.', reopenIds: [], newTasks: [] }) }] };
                }
                const listRes = JSON.parse((await runCmd('bd list --all --json', td)).stdout || '[]');
                const aTask = listRes.find((b) => b.title === 'Task: A closes normally (re-review guard scenario)');
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'CHANGES_NEEDED',
                            notes: 'Re-review wants the deferred P3 bead back plus a real in-goal rework.',
                            reopenIds: [deferredId, aTask.id],
                            newTasks: [],
                        }),
                    }],
                };
            },
            deployHandler: async ({ tempDir: td }) => {
                deployCalls++;
                if (deployCalls === 2) {
                    const listRes = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
                    const bTask = listRes.find((b) => b.title === 'Task: B stays blocked (re-review guard scenario)');
                    if (bTask) await runCmd(`bd close ${bTask.id}`, td);
                }
                return { content: [{ text: JSON.stringify({ deployed: true, notes: `Deploy call #${deployCalls}` }) }] };
            },
            finalReviewHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'PASS', notes: 'Final review pass.', reopenIds: [], newTasks: [] }) }]
            }),
        });

        check(!scenario.error, `Scenario should not throw: ${scenario.error ? scenario.error.message : ''}`);
        check(deferredId, 'the deferred P3 bead should have been created');

        // The Re-Review branch really did run -- otherwise this test would
        // vacuously pass by never exercising the site at all.
        check(
            scenario.logs.some((m) => m.includes('no review ran THIS cycle') && m.includes('fresh re-review')),
            `Expected the Re-Review branch to fire. Logs: ${JSON.stringify(scenario.logs.slice(-40))}`
        );

        // (1) The guard fired at the Re-Review site, with the SAME outcome
        //     text the per-round reviewer and Final Review emit.
        const skipLine = scenario.logs.find((m) => m.includes('deferred scope, not reopened') && m.includes(deferredId));
        check(
            skipLine,
            `Expected the Re-Review site to skip the below-goal bead ${deferredId} with the shared `
            + `"deferred scope, not reopened" outcome. Logs: ${JSON.stringify(scenario.logs.filter((m) => m.includes('reopenIds')))}`
        );
        check(
            skipLine.startsWith('Re-review reopenIds: SKIPPED'),
            `The Re-Review skip must be labelled as such, got: ${skipLine}`
        );
        check(
            skipLine.includes("below this sprint's goal P1/P2"),
            `The skip must name the goal it was measured against, got: ${skipLine}`
        );

        // (2) The bead was genuinely NOT reopened -- the log is not the only
        //     evidence; its real status must be untouched.
        const finalDeferred = scenario.finalBeadsById.get(deferredId);
        check(
            finalDeferred && finalDeferred.status !== 'open',
            `The below-goal bead must NOT have been reopened by the re-review, got: ${JSON.stringify(finalDeferred)}`
        );

        // (3) The guard is not vacuously strict: the in-goal id named in the
        //     SAME re-review verdict was still reopened.
        check(
            scenario.logs.some((m) => m.includes('Reopen ') && !m.includes(deferredId))
            || [...scenario.finalBeadsById.values()].some((b) => b.status === 'open' && b.priority <= 2),
            `Expected the in-goal reopen in the same verdict to still be applied. `
            + `Final beads: ${JSON.stringify([...scenario.finalBeadsById.values()].map((b) => ({ id: b.id, s: b.status, p: b.priority })))}`
        );
    });
});
