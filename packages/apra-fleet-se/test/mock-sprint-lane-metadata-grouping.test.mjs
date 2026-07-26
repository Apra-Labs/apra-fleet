import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-eft.76.5 -- end-to-end (mock-sprint) verification of eft.76
// changes #1+#3: a plan WITH lane metadata (`streak`/`streakOrder`) produces
// the exact deterministic streak grouping and issues NO runtime "Streak
// Assignment" LLM dispatch; a plan WITHOUT lane metadata falls back to the
// LLM assignment path unchanged. The pure-function grouping logic itself
// (groupStreaksFromLaneMetadata) is already unit-covered in
// streak-lane-grouping.test.mjs -- this file exercises the SAME wiring
// through a real develop round (real bd metadata read via `bd list --ready
// --json`, real runner.js dispatch decision) end to end.
// =============================================================================

test('mock sprint: lane metadata yields deterministic grouping with no Streak Assignment dispatch', async () => {
    await withScenarioMarkers('lane metadata (deterministic grouping)', async () => {
        console.log('Running mock sprint scenario (lane metadata -> deterministic grouping, no Streak Assignment dispatch)...');
        const scenario = await runDevelopLoopScenario('lane-metadata', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Lane A first' },
                { title: 'Task: Lane A second' },
                { title: 'Task: Lane B only' },
            ],
            // Stamp planner-shaped lane metadata onto every ready bead BEFORE
            // the sprint runs -- exactly the `streak`/`streakOrder` metadata
            // contract planner.md emits per apra-fleet-eft.76.1 (same
            // `--metadata` channel used elsewhere in this harness for
            // `model`). Two beads share lane "lane-a" (ordered 1, 2); one
            // bead is alone in lane "lane-b" (order 1).
            beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => {
                const laneAFirst = tasks.find((t) => t.title === 'Task: Lane A first');
                const laneASecond = tasks.find((t) => t.title === 'Task: Lane A second');
                const laneBOnly = tasks.find((t) => t.title === 'Task: Lane B only');
                await rc(`bd update ${laneAFirst.id} --set-metadata streak=lane-a --set-metadata streakOrder=1`, td);
                await rc(`bd update ${laneASecond.id} --set-metadata streak=lane-a --set-metadata streakOrder=2`, td);
                await rc(`bd update ${laneBOnly.id} --set-metadata streak=lane-b --set-metadata streakOrder=1`, td);
            },
        });
        check(!scenario.error, `Lane-metadata scenario should not error: ${scenario.error ? scenario.error.message : ''}`);
        check(scenario.result && scenario.result.status === 'success', `Expected a successful sprint (every bead closes in one round): ${JSON.stringify(scenario.result)}`);

        const laneAFirstId = scenario.tasks.find((t) => t.title === 'Task: Lane A first').id;
        const laneASecondId = scenario.tasks.find((t) => t.title === 'Task: Lane A second').id;
        const laneBOnlyId = scenario.tasks.find((t) => t.title === 'Task: Lane B only').id;

        // (1) The deterministic-grouping log line fired, naming exactly 2
        // streaks in lane order (lane-a's two beads, ordered by
        // streakOrder, then lane-b's single bead) -- the EXACT shape
        // groupStreaksFromLaneMetadata() computes, not just "some grouping
        // happened".
        const expectedLogFragment = `Streak grouping: deterministic from lane metadata -- 2 streak(s), no Streak Assignment dispatch ` +
            `([${laneAFirstId}, ${laneASecondId}] [${laneBOnlyId}]).`;
        check(
            scenario.logs.some((m) => m === expectedLogFragment),
            `Expected the exact deterministic-grouping log line, got logs: ${JSON.stringify(scenario.logs.filter((m) => m.includes('Streak grouping')))}`
        );

        // (2) NO runtime Streak Assignment LLM dispatch was ever issued --
        // that agent() call is distinguished (see mock-sprint-harness.mjs's
        // isStreakAssignment) by its prompt containing 'Ready bead ids:'.
        check(
            !scenario.dispatched.some((d) => d.prompt.includes('Ready bead ids:')),
            `Expected NO Streak Assignment dispatch when every ready bead carries lane metadata, but found one: ${JSON.stringify(scenario.dispatched.filter((d) => d.prompt.includes('Ready bead ids:')))}`
        );

        // (3) Dispatch shape matches the deterministic grouping: lane-a's
        // two beads are assigned to the SAME doer streak (one dispatch,
        // both ids), lane-b's bead is assigned to its own separate streak.
        const doerDispatches = scenario.dispatched.filter((d) => d.agent === 'doer');
        const idsForDispatch = (d) => {
            const match = d.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
            return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
        };
        const laneAStreak = doerDispatches.find((d) => idsForDispatch(d).includes(laneAFirstId));
        check(laneAStreak, `Expected a doer dispatch covering lane-a bead '${laneAFirstId}'`);
        check(
            idsForDispatch(laneAStreak).length === 2 &&
                idsForDispatch(laneAStreak).includes(laneAFirstId) &&
                idsForDispatch(laneAStreak).includes(laneASecondId),
            `Expected lane-a's two beads to be dispatched together in one streak, got: ${JSON.stringify(idsForDispatch(laneAStreak))}`
        );
        const laneBStreak = doerDispatches.find((d) => idsForDispatch(d).includes(laneBOnlyId));
        check(laneBStreak, `Expected a doer dispatch covering lane-b bead '${laneBOnlyId}'`);
        check(
            idsForDispatch(laneBStreak).length === 1,
            `Expected lane-b's bead to be dispatched alone in its own streak, got: ${JSON.stringify(idsForDispatch(laneBStreak))}`
        );

        // (4) All three beads actually closed.
        for (const id of [laneAFirstId, laneASecondId, laneBOnlyId]) {
            check(
                scenario.finalBeadsById.get(id) && scenario.finalBeadsById.get(id).status === 'closed',
                `Expected bead '${id}' to be closed, got: ${JSON.stringify(scenario.finalBeadsById.get(id))}`
            );
        }
    });
});

test('mock sprint: a plan without lane metadata still falls back to the LLM Streak Assignment path', async () => {
    await withScenarioMarkers('no lane metadata (LLM fallback unchanged)', async () => {
        console.log('Running mock sprint scenario (no lane metadata -> LLM Streak Assignment fallback, unchanged)...');
        const scenario = await runDevelopLoopScenario('no-lane-metadata', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: No metadata A' },
                { title: 'Task: No metadata B' },
            ],
            // Deliberately NO beforeSprint metadata stamping -- these ready
            // beads carry no `streak` metadata at all, exercising the
            // "old plan predating eft.76" back-compat path.
            // Approve immediately (rather than the harness default, which
            // reopens the first closed bead on round 1) so this scenario
            // completes in exactly one develop round -- the point under
            // test is the fallback dispatch count for ONE round, not the
            // reopen/re-dispatch loop (covered elsewhere).
            reviewerHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }]
            }),
        });
        check(!scenario.error, `No-lane-metadata scenario should not error: ${scenario.error ? scenario.error.message : ''}`);
        check(scenario.result && scenario.result.status === 'success', `Expected a successful sprint: ${JSON.stringify(scenario.result)}`);

        // (1) The fallback log line fired (unchanged wording/behavior).
        check(
            scenario.logs.some((m) => m === 'Streak grouping: no lane metadata on this round\'s ready beads -- falling back to LLM Streak Assignment dispatch (back-compat with pre-eft.76 plans).'),
            `Expected the LLM-fallback log line, got logs: ${JSON.stringify(scenario.logs.filter((m) => m.includes('Streak grouping')))}`
        );

        // (2) The runtime Streak Assignment LLM dispatch DID run exactly
        // once this round (unlike the lane-metadata scenario above).
        const streakAssignmentDispatches = scenario.dispatched.filter((d) => d.prompt.includes('Ready bead ids:'));
        check(
            streakAssignmentDispatches.length === 1,
            `Expected exactly one Streak Assignment dispatch (no lane metadata present), got ${streakAssignmentDispatches.length}: ${JSON.stringify(scenario.dispatched.map((d) => d.prompt.slice(0, 80)))}`
        );

        // (3) Both beads still close via the (unchanged) mock's one-bead-
        // per-streak default LLM response.
        const idA = scenario.tasks.find((t) => t.title === 'Task: No metadata A').id;
        const idB = scenario.tasks.find((t) => t.title === 'Task: No metadata B').id;
        for (const id of [idA, idB]) {
            check(
                scenario.finalBeadsById.get(id) && scenario.finalBeadsById.get(id).status === 'closed',
                `Expected bead '${id}' to be closed, got: ${JSON.stringify(scenario.finalBeadsById.get(id))}`
            );
        }
    });
});
