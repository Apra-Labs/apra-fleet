import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StalledSprintError } from '../auto-sprint/errors.mjs';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-unw2.7 (N9): stall detection high-water-mark progress +
// reopen-thrash flag
// =============================================================================
//
// findings/feedback-reassessment.md N9: the OLD stall detector compared
// each cycle's closed-bead count only to the IMMEDIATELY PRIOR cycle's
// count. A close/reopen OSCILLATION -- reviewer keeps sending the same
// bead back for "one more look" every time it closes, so the sprint
// never nets any real progress on it -- produces a count sequence like
// 5,4,5,4,... where every adjacent pair genuinely differs. That defeated
// the old delta check (which only resets/increments off adjacent
// equality), so the sprint burned every remaining cycle up to
// max_cycles doing net-zero work on the oscillating bead instead of
// aborting.
//
// This scenario drives exactly that pattern: one "Oscillator" bead that
// the mock reviewer reopens EVERY single time it sees it closed (a
// literal, unconditional "close it, reopen it, repeat" loop -- see the
// reviewerHandler below), alongside a short dependency CHAIN of five
// "Filler N" tasks (each blocked on the previous one via `bd link`) that
// close permanently, one at a time, as they're each unblocked. The
// filler chain supplies a few cycles of genuine forward progress (so the
// scenario isn't just a rename of the flat/monotone case immediately
// above) before it runs out, at which point ONLY the oscillator
// remains -- reproducing the oscillation failure mode in isolation.
//
// Empirically (verified by running this exact scenario before adding
// assertions) this produces a closed-count history of [3, 5, 5, 5]: a
// genuine RISE while the filler chain still has beads to reveal, then a
// PLATEAU once it's exhausted and only the perpetually-reopened
// oscillator is left. The high-water-mark fix (runner.js's
// `highWaterClosedCount`) correctly reads the two repeated `5`s at the
// plateau as zero progress and aborts -- well before `max_cycles`.
//
// The mock reviewer's `bd update <id> --status=open` reopen of the
// oscillator is applied by the ORCHESTRATOR (runner.js), never by the
// mock itself (see the reopen-scenario test in
// mock-sprint-develop-reopen.test.mjs for the same reviewer-never-
// mutates-beads contract) -- so this scenario exercises the real
// per-bead reopen-count bookkeeping added for N9, work item (b), not
// just a scripted mock side effect.
test('mock sprint: close/reopen oscillation drives a high-water-mark stall + reopen-thrash flag (N9)', async () => {
    await withScenarioMarkers('oscillation (N9 high-water-mark)', async () => {
        console.log('Running mock sprint scenario (N9: close/reopen oscillation drives high-water-mark stall + reopen-thrash flag)...');
        const oscillation = await runDevelopLoopScenario('oscillation', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Oscillator' },
                { title: 'Task: Filler 1' },
                { title: 'Task: Filler 2' },
                { title: 'Task: Filler 3' },
                { title: 'Task: Filler 4' },
                { title: 'Task: Filler 5' },
            ],
            // Generous ceiling: the whole point of N9 is that the stall abort
            // must fire well before this, not after burning every cycle.
            maxCycles: 10,
            beforeSprint: async ({ tempDir: td, tasks: ts }) => {
                // F2 depends on F1, F3 depends on F2, etc. -- only one filler is
                // ever `--ready` at a time, so the filler chain contributes one
                // genuine new close per cycle rather than closing all 5 at once
                // on cycle 1 (which would collapse this into a trivial no-op
                // scenario).
                const filler = (n) => ts.find((t) => t.title === `Task: Filler ${n}`);
                await runCmd(`bd link ${filler(2).id} ${filler(1).id}`, td);
                await runCmd(`bd link ${filler(3).id} ${filler(2).id}`, td);
                await runCmd(`bd link ${filler(4).id} ${filler(3).id}`, td);
                await runCmd(`bd link ${filler(5).id} ${filler(4).id}`, td);
            },
            // Default doerHandler closes every assigned bead for real (verified
            // via `bd show`, per the apra-fleet-unw.16 Work item 3 contract) --
            // no override needed here.
            reviewerHandler: async ({ tempDir: td, epicBead: epic }) => {
                const closedRes = JSON.parse((await runCmd(`bd list --parent ${epic.id} --status=closed --json`, td)).stdout || '[]');
                const oscillator = closedRes.find((b) => b.title === 'Task: Oscillator');
                if (oscillator) {
                    // Unconditional: EVERY time the oscillator is seen closed,
                    // send it back. This is the "close it, reopen it, repeat"
                    // pattern named in the N9 acceptance criteria, applied as
                    // many times as the Develop/Review loop re-encounters it.
                    return {
                        content: [{
                            text: JSON.stringify({
                                verdict: 'CHANGES_NEEDED',
                                notes: 'Sending the oscillator back for another look -- never actually satisfied.',
                                reopenIds: [oscillator.id],
                                newTasks: [],
                            })
                        }]
                    };
                }
                return { content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Filler work approved.', reopenIds: [], newTasks: [] }) }] };
            },
        });
        check(!!oscillation.error, 'Expected the oscillation scenario to reject with a stall abort, but it resolved successfully');
        check(
            oscillation.error instanceof StalledSprintError,
            `Expected a StalledSprintError, got: ${oscillation.error ? oscillation.error.constructor.name + ': ' + oscillation.error.message : 'no error'}`
        );
        check(
            oscillation.error && oscillation.error.staleCycles === 2,
            `Expected the StalledSprintError to report staleCycles === 2 (the configured stall window), got: ${oscillation.error ? JSON.stringify(oscillation.error.staleCycles) : 'n/a'}`
        );
        // The core N9 acceptance criterion: the abort must fire within the
        // configured stall window, NOT after burning all max_cycles=10 -- the
        // OLD delta-based check would have kept resetting staleCycles to 0 on
        // every cycle where the count differed from the cycle before it, and
        // would never have caught this until max_cycles was exhausted.
        check(
            oscillation.error && Array.isArray(oscillation.error.closedCountHistory) && oscillation.error.closedCountHistory.length <= 6,
            `Expected the oscillation stall-abort to fire well within the stall window (well before max_cycles=10), got closedCountHistory: ${oscillation.error ? JSON.stringify(oscillation.error.closedCountHistory) : 'n/a'}`
        );
        // Confirm the run genuinely made SOME real progress first (the filler
        // chain), rather than this degenerating into a copy of the flat/
        // monotone scenario above -- the history must show a real rise before
        // it plateaus.
        check(
            oscillation.error && Array.isArray(oscillation.error.closedCountHistory) && oscillation.error.closedCountHistory.length >= 2 &&
            oscillation.error.closedCountHistory[0] < oscillation.error.highWaterClosedCount,
            `Expected the closed-count history to show a genuine rise before plateauing (not flat from cycle 1), got closedCountHistory: ${oscillation.error ? JSON.stringify(oscillation.error.closedCountHistory) : 'n/a'}, highWaterClosedCount: ${oscillation.error ? oscillation.error.highWaterClosedCount : 'n/a'}`
        );
        // N9 work item (a): the error must report the high-water mark itself
        // (not just the raw history), and the plateau value must equal it.
        check(
            oscillation.error && oscillation.error.highWaterClosedCount === Math.max(...oscillation.error.closedCountHistory),
            `Expected highWaterClosedCount to equal the max of the recorded history, got highWaterClosedCount: ${oscillation.error ? oscillation.error.highWaterClosedCount : 'n/a'}, closedCountHistory: ${oscillation.error ? JSON.stringify(oscillation.error.closedCountHistory) : 'n/a'}`
        );
        // N9 work item (b): the oscillator bead -- reopened far more than the
        // K=3 thrash threshold across this run -- must be named as a thrashing
        // bead directly on the typed error, and its id must appear in the
        // human-readable message too (not just buried in structured details).
        const oscillatorTaskId = oscillation.tasks.find((t) => t.title === 'Task: Oscillator').id;
        check(
            oscillation.error && Array.isArray(oscillation.error.thrashIds) && oscillation.error.thrashIds.includes(oscillatorTaskId),
            `Expected the oscillator bead '${oscillatorTaskId}' to be flagged as a thrashing bead (reopened more than K=3 times), got thrashIds: ${oscillation.error ? JSON.stringify(oscillation.error.thrashIds) : 'n/a'}`
        );
        check(
            oscillation.error && oscillation.error.message.includes(oscillatorTaskId),
            `Expected the StalledSprintError message to name the thrashing bead '${oscillatorTaskId}' directly, got: ${oscillation.error ? oscillation.error.message : 'n/a'}`
        );
        // The filler chain's own beads must never be misflagged as thrash --
        // each of them was only ever reopened zero times (they close once and
        // stay closed).
        const fillerTaskIds = oscillation.tasks.filter((t) => t.title.startsWith('Task: Filler')).map((t) => t.id);
        check(
            oscillation.error && fillerTaskIds.every((id) => !oscillation.error.thrashIds.includes(id)),
            `Did NOT expect any filler bead to be flagged as thrash, got thrashIds: ${oscillation.error ? JSON.stringify(oscillation.error.thrashIds) : 'n/a'}, filler ids: ${JSON.stringify(fillerTaskIds)}`
        );
    });
});
