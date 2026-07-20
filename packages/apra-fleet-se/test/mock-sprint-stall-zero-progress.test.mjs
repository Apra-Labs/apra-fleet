import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StalledSprintError } from '../auto-sprint/errors.mjs';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

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
