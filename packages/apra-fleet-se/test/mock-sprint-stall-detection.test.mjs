import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StalledSprintError, ReviewerContractViolationError } from '../auto-sprint/errors.mjs';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-unw.17 (A5) acceptance criterion 2: stall-abort after 2
// consecutive zero-progress cycles
// =============================================================================
// A doer that always claims success but never actually runs `bd close`
// (so the assigned bead is never verified-closed -- see the "doer lies"
// FAILED-streak handling in the Develop loop) keeps the same bead ready
// forever: the closed-bead count in scope never changes cycle over
// cycle. With max_cycles=5, the sprint must abort via a typed
// StalledSprintError well before cycle 5 (after 2 consecutive
// zero-progress cycles), rather than silently burning every remaining
// cycle.
test('mock sprint: zero-progress every cycle triggers a stall-abort well before max_cycles', async () => {
    await withScenarioMarkers('stalled (stall-abort)', async () => {
        console.log('Running mock sprint scenario (stall-abort: zero progress every cycle)...');
        const stalled = await runDevelopLoopScenario('stalled', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Never actually closes' }],
            maxCycles: 5,
            doerHandler: async ({ opts }) => {
                const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                // Deliberately never runs `bd close` -- the bead stays ready
                // forever and the closed-bead count in scope never advances.
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Claims done, never actually closes.' }) }] };
            },
            reviewerHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved (mock never inspects real state).', reopenIds: [], newTasks: [] }) }]
            }),
        });
        check(!!stalled.error, 'Expected engine.executeFile() to reject with a stall abort, but it resolved successfully');
        check(
            stalled.error instanceof StalledSprintError,
            `Expected a StalledSprintError, got: ${stalled.error ? stalled.error.constructor.name + ': ' + stalled.error.message : 'no error'}`
        );
        check(
            stalled.error && stalled.error.staleCycles === 2,
            `Expected the StalledSprintError to report staleCycles === 2, got: ${stalled.error ? JSON.stringify(stalled.error.staleCycles) : 'n/a'}`
        );
        // The abort must land well before the max_cycles=5 ceiling -- assert the
        // "Sprint Cycle N" group-start count implied by the closed-count history
        // recorded on the error is short (<=3 cycles), not 5.
        check(
            stalled.error && Array.isArray(stalled.error.closedCountHistory) && stalled.error.closedCountHistory.length <= 3,
            `Expected the stall abort to fire within 3 cycles (well before max_cycles=5), got closedCountHistory: ${stalled.error ? JSON.stringify(stalled.error.closedCountHistory) : 'n/a'}`
        );
    });
});

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
// mock-sprint-develop-failures.test.mjs for the same reviewer-never-
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

// =============================================================================
// apra-fleet-unw2.6 (N8) regression 2: CHANGES_NEEDED with empty
// reopenIds AND empty newTasks (a schema-legal but self-contradictory
// verdict -- nothing for the orchestrator to act on) must never
// silently accumulate toward stall-abort even after every bead in scope
// is already closed. It is retried once, then surfaced distinctly as a
// ReviewerContractViolationError -- never misreported as
// StalledSprintError (a finished sprint must not read as "stalled").
// =============================================================================
test('mock sprint: a self-contradictory CHANGES_NEEDED verdict surfaces as a distinct contract-violation error', async () => {
    await withScenarioMarkers('contractviolation (reviewer contract violation)', async () => {
        console.log('Running mock sprint scenario (reviewer contract violation: CHANGES_NEEDED with empty reopenIds/newTasks)...');
        const contractViolation = await runDevelopLoopScenario('contractviolation', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Closes fine but reviewer contradicts itself' }],
            maxCycles: 3,
            // The doer does its job correctly and closes the bead; only the
            // REVIEWER contradicts itself on every round.
            reviewerHandler: async () => ({
                content: [{
                    text: JSON.stringify({
                        verdict: 'CHANGES_NEEDED',
                        notes: 'Contradictory: nothing to reopen, nothing new to create, yet not approved.',
                        reopenIds: [],
                        newTasks: [],
                    })
                }]
            }),
        });
        check(!!contractViolation.error, 'Expected the reviewer contract violation to abort the sprint with a distinct error, but it resolved successfully');
        check(
            contractViolation.error instanceof ReviewerContractViolationError,
            `Expected a ReviewerContractViolationError, got: ${contractViolation.error ? contractViolation.error.constructor.name + ': ' + contractViolation.error.message : 'no error'}`
        );
        check(
            !(contractViolation.error instanceof StalledSprintError),
            `A finished sprint (bead already closed) hitting a contract-violating reviewer round must never be misreported as StalledSprintError, got: ${contractViolation.error ? contractViolation.error.constructor.name : 'n/a'}`
        );
        const contractViolationTaskId = contractViolation.tasks[0].id;
        check(
            contractViolation.finalBeadsById.get(contractViolationTaskId) && contractViolation.finalBeadsById.get(contractViolationTaskId).status === 'closed',
            `Expected the bead to actually be closed (the doer did its job; only the review contract was violated), got: ${JSON.stringify(contractViolation.finalBeadsById.get(contractViolationTaskId))}`
        );
        check(
            contractViolation.logs.some((m) => m.includes('contract violation')),
            `Expected a logged 'contract violation' warning, logs: ${JSON.stringify(contractViolation.logs)}`
        );
        const contractViolationReviewCalls = contractViolation.dispatched.filter((d) => d.agent === 'reviewer' && d.label !== 'Final Review');
        check(
            contractViolationReviewCalls.length === 2,
            `Expected exactly 2 reviewer dispatches (initial + one retry) before surfacing the contract violation distinctly, got ${contractViolationReviewCalls.length}`
        );
    });
});
