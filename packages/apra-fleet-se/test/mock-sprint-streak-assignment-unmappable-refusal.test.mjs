// End-to-end mock sprint: the Streak Assignment dispatch is refused a tool call
// no permission grant can allow (a chained/backgrounded shell command). The
// role has no same-session resume, so the engine must NOT end the sprint with
// MemberPermissionDeniedError: it logs the refusal, uses the deterministic
// one-bead-per-streak grouping, and proceeds to Develop.
//
// CONSTRAINT: the ready beads carry NO streak/streakOrder lane metadata;
// otherwise develop takes the deterministic lane grouping and never dispatches
// Streak Assignment (the test would pass vacuously).
//
// Reverting the dispatch-role.mjs fallback-value degrade for an unmappable
// refusal makes this fail: MemberPermissionDeniedError aborts the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';

const CHAINED = 'for i in 1 2 3; do echo $i; done';
const UNMAPPABLE = Object.freeze({
    actions: ['Bash'],
    denials: [{ action: 'Bash', target: CHAINED, suggestedGrants: [] }],
    suggestedGrants: [],
    hint: `claude refused Bash "${CHAINED}".`,
    signals: ['result_json'],
});

function permissionDenied(block) {
    const reply = JSON.stringify({ streaks: [] });
    return {
        content: [{ text: `[FAIL] execute_prompt on "local": permission denied -- ${block.hint}\n[partial response]\n${reply}` }],
        structuredContent: { isError: true, reason: 'permission_denied', permissionDenied: block, response: reply, sessionId: 'mock-streak-refused-session' },
    };
}
const approve = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});

test('an unmappable refusal on Streak Assignment falls back to one-bead-per-streak and the sprint continues', { timeout: scaledTimeout(180000) }, async () => {
    invalidateSyncRemoteCache(); clearLastSyncedTip(); clearTipProbeFailures();
    await withScenarioMarkers('streak assignment unmappable refusal', async () => {
        let streakCalls = 0;
        const scenario = await runDevelopLoopScenario('sa-unmappable', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: No lane A' }, { title: 'Task: No lane B' }],
            maxCycles: 1,
            streakAssignmentHandler: async () => {
                streakCalls += 1;
                return permissionDenied(UNMAPPABLE);
            },
            reviewerHandler: approve,
        });
        // AC1: the dispatch really happened (no lane metadata short-circuit).
        assert.equal(streakCalls, 1, 'Streak Assignment was dispatched exactly once (no resume, no re-ask)');
        const streakDispatches = scenario.dispatched.filter((d) => d.prompt.includes('Ready bead ids:'));
        assert.ok(streakDispatches.length <= 1);
        // AC2: refusal log + fallback log; no abort; one doer streak per bead.
        const refusalLine = scenario.logs.find((l) => l.includes('Streak Assignment: unmappable refusal') && l.includes(CHAINED));
        assert.ok(refusalLine, `refusal log names the refused call: ${JSON.stringify(scenario.logs.filter((l) => l.includes('Streak Assignment')))}`);
        assert.match(refusalLine, /deterministic fallback/);
        assert.ok(scenario.logs.some((l) => /one-bead-per-streak/.test(l)), 'the one-bead-per-streak fallback line is logged');
        assert.ok(!scenario.error, `the sprint must not abort: ${scenario.error && scenario.error.message}`);
        const doers = scenario.dispatched.filter((d) => d.agent === 'doer');
        assert.equal(doers.length, 2, `one doer streak per ready bead: ${doers.length}`);
        assert.equal(scenario.result && scenario.result.status, 'success', JSON.stringify(scenario.result));
    });
});
