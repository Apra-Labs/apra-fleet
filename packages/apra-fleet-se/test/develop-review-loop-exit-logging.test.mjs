import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-0pu.2: coverage for the Develop/Review round-cap loop-exit
// logging fixed by apra-fleet-0pu.1.
// =============================================================================
//
// runner.js's Develop & Review loop (packages/apra-fleet-se/fleet-sprint/
// runner.js) runs up to 3 rounds (devRounds < 3). Each round that still has
// ready/reopened work logs the generic "System found N beads still open/
// ready. Looping back to develop." line -- including the LAST round before
// the loop exits via the 3-round cap. Before apra-fleet-0pu.1, that made the
// cap-exit indistinguishable in the log from an ordinary mid-loop round: the
// terminating line for the phase was the same misleading "Looping back to
// develop" text even though the loop was NOT actually going to loop back
// again. apra-fleet-0pu.1 added a distinct, unconditional post-loop line --
// "Develop/Review round cap (3) reached this cycle with N bead(s) still
// open/reopened -- deferring to next cycle." -- logged only when the loop
// exited at devRounds === 3 with work still pending, so it always reads as
// the true terminating line for that phase in that case.
//
// These two scenarios drive the real loop (via the existing
// runDevelopLoopScenario mock-sprint harness, mocking only the doer/reviewer
// LLM dispatches, not runner.js's own loop/log logic) through both exit
// paths and assert on the captured 'log' event text:
//   1. round-cap path: a bead that never converges (doer closes it, reviewer
//      reopens it) every round exhausts all 3 rounds with work still open.
//   2. organic-completion path: a bead that converges on round 1 (doer
//      closes it, reviewer approves) empties stillOpen before the cap.

test('mock sprint: Develop/Review round-cap exit logs a distinct "deferring to next cycle" line as the terminating line, not "Looping back"', async () => {
    await withScenarioMarkers('round-cap exit logging', async () => {
        const scenario = await runDevelopLoopScenario('round-cap-exit', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Never converges' },
            ],
            doerHandler: async ({ opts, tempDir: td }) => {
                const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                for (const id of ids) {
                    await runCmd(`bd close ${id}`, td);
                }
                return {
                    content: [{
                        text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed pending re-review.' })
                    }]
                };
            },
            // Reopens the sole task under this epic on EVERY round (not just
            // round 1) so stillOpen never empties out and the loop is forced
            // to exhaust all 3 rounds -- the round-cap exit path.
            reviewerHandler: async ({ tempDir: td, epicBead: epic }) => {
                const closedRes = await runCmd(`bd list --parent ${epic.id} --status=closed --json`, td);
                const closedBeads = JSON.parse(closedRes.stdout || '[]');
                const target = closedBeads[0];
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'CHANGES_NEEDED',
                            notes: 'Still not acceptable, please retry.',
                            reopenIds: target ? [target.id] : [],
                            newTasks: [],
                        })
                    }]
                };
            },
        });

        check(!scenario.error, `Round-cap scenario should not abort/throw: ${scenario.error ? scenario.error.message : ''}`);

        const taskId = scenario.tasks[0].id;

        const roundCapMsg = scenario.logs.find((m) => /Develop\/Review round cap \(3\) reached this cycle with \d+ bead\(s\) still open\/reopened -- deferring to next cycle\./.test(m));
        check(roundCapMsg, `Expected a distinct round-cap "deferring to next cycle" log line, got logs: ${JSON.stringify(scenario.logs)}`);

        const loopingBackIndices = scenario.logs
            .map((m, i) => (/Looping back to develop\./.test(m) ? i : -1))
            .filter((i) => i >= 0);
        check(loopingBackIndices.length > 0, `Expected at least one "Looping back to develop" line across the 3 rounds, got logs: ${JSON.stringify(scenario.logs)}`);

        const roundCapIndex = scenario.logs.indexOf(roundCapMsg);
        const lastLoopingBackIndex = Math.max(...loopingBackIndices);
        check(
            roundCapIndex > lastLoopingBackIndex,
            `Expected the round-cap line to be the TERMINATING line for the Develop/Review loop (logged after the last "Looping back" line), got roundCapIndex=${roundCapIndex}, lastLoopingBackIndex=${lastLoopingBackIndex}, logs: ${JSON.stringify(scenario.logs)}`
        );
        check(
            !scenario.logs.slice(roundCapIndex + 1).some((m) => /Looping back to develop\./.test(m)),
            `Did not expect "Looping back to develop" to appear after the round-cap line -- it must be the true terminating line, logs: ${JSON.stringify(scenario.logs)}`
        );

        // Carry-forward: the repeatedly-reopened bead is not lost at the
        // cap -- it survives, still a real bead, in a non-closed state
        // (reopened, ready for the next cycle) rather than silently dropped.
        const finalTask = scenario.finalBeadsById.get(taskId);
        check(
            finalTask && finalTask.status !== 'closed',
            `Expected the never-converging bead to survive the round cap in a non-closed state (carried forward, not lost), got: ${JSON.stringify(finalTask)}`
        );
    });
});

test('mock sprint: Develop/Review organic-completion exit logs a distinct "cycle organically complete" line and never the round-cap line', async () => {
    await withScenarioMarkers('organic-completion exit logging', async () => {
        const scenario = await runDevelopLoopScenario('round-cap-organic', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Converges immediately' },
            ],
            doerHandler: async ({ opts, tempDir: td }) => {
                const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                for (const id of ids) {
                    await runCmd(`bd close ${id}`, td);
                }
                return {
                    content: [{
                        text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed successfully.' })
                    }]
                };
            },
            reviewerHandler: async () => ({
                content: [{
                    text: JSON.stringify({ verdict: 'APPROVED', notes: 'Looks good.', reopenIds: [], newTasks: [] })
                }]
            }),
        });

        check(!scenario.error, `Organic-completion scenario should not abort/throw: ${scenario.error ? scenario.error.message : ''}`);

        const taskId = scenario.tasks[0].id;

        check(
            scenario.logs.some((m) => m.includes('All beads processed this cycle -- cycle organically complete.')),
            `Expected the distinct organic-completion log line, got logs: ${JSON.stringify(scenario.logs)}`
        );
        check(
            !scenario.logs.some((m) => /Develop\/Review round cap \(3\) reached this cycle/.test(m)),
            `Did not expect the round-cap line to appear at all on the organic-completion path, got logs: ${JSON.stringify(scenario.logs)}`
        );

        const finalTask = scenario.finalBeadsById.get(taskId);
        check(
            finalTask && finalTask.status === 'closed',
            `Expected the converging bead to be closed on the organic-completion path, got: ${JSON.stringify(finalTask)}`
        );
    });
});
