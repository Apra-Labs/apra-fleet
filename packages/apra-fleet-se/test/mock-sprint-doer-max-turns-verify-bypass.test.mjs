import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// apra-fleet-33c.2: end-to-end verification of the apra-fleet-33c.1 fix,
// through the REAL runner.js doer-streak max_turns handler (runSprintCycle(),
// ~line 7036), not just a read of the diff.
//
// Root incident (apra-fleet-k7b.4/k7b.6, sprint xuo, fleet-win-dev1,
// 2026-07-30): both beads were implemented, committed, and bd closed by
// 02:48:04, but the doer kept running past its VERIFY checkpoint (a final
// "sanity check via advisor") and hit max_turns at 02:50:11. The orchestrator
// had already D-pulled and could see both beads closed, but classified the
// streak FAILED anyway and fired a wasted resume dispatch. apra-fleet-33c.1
// added a pre-resume verifyDoerStreakClosed() check: if every assigned bead
// id is already closed when max_turns hits, the streak is recorded 'success'
// (with a logged warning about the missed VERIFY) and NO resume is dispatched
// -- this is defense in depth alongside the doer.md VERIFY-discipline fix
// (apra-fleet-gd0.1/gd0.2), catching the case even if a doer regresses there.
//
// Test 1 drives exactly that scenario: the doer bd-closes its bead, THEN its
// dispatch reports max_turns_exhausted (simulating "closed cleanly, kept
// running past VERIFY, ran out of turns"). Test 2 is the counter-case: the
// doer does NOT close its bead before max_turns hits, proving the resume
// ladder still fires (existing behavior unchanged) when there is genuinely
// unfinished work.
// =============================================================================

const approveReviewer = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});

function assignedIdsFromPrompt(prompt) {
    const match = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

test('mock sprint: a max_turns-exhausted doer streak whose bead is ALREADY closed is classified success, logs the missed-VERIFY warning, and issues NO resume dispatch', async () => {
    await withScenarioMarkers('maxturnsclosed', async () => {
        let doerCalls = 0;

        const result = await runDevelopLoopScenario('maxturnsclosed', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: max_turns already-closed scenario work' }],
            maxCycles: 1,
            reviewerHandler: approveReviewer,
            doerHandler: async ({ opts, tempDir: td }) => {
                doerCalls += 1;
                // The doer closes its assigned bead(s) -- exactly the
                // "implemented, committed, bd closed" part of the incident --
                // THEN its dispatch reports max_turns_exhausted, simulating a
                // doer that kept running past VERIFY instead of stopping.
                const ids = assignedIdsFromPrompt(opts.prompt);
                for (const id of ids) {
                    await runCmd(`bd close ${id}`, td);
                }
                return {
                    content: [{ text: 'stopped after max turns, but already closed all assigned beads before this point' }],
                    structuredContent: { isError: true, reason: 'max_turns_exhausted' },
                };
            },
        });

        assert.ok(!result.error, `Scenario should not throw: ${result.error ? result.error.message : ''}`);
        assert.strictEqual(doerCalls, 1, `Expected exactly ONE doer dispatch (no resume) since the bead was already closed, got ${doerCalls} calls`);
        assert.ok(
            result.logs.some((m) => m.includes('all assigned bead id(s) are already closed') && m.includes('WARNING: the doer missed the VERIFY checkpoint')),
            `Expected the missed-VERIFY warning to be logged, logs: ${JSON.stringify(result.logs)}`
        );
        assert.ok(
            result.logs.some((m) => m.includes('Treating this streak as a successful completion, not a failure; issuing NO resume dispatch')),
            `Expected the "treating as successful, no resume" log line, logs: ${JSON.stringify(result.logs)}`
        );
        assert.ok(
            !result.logs.some((m) => m.includes('resuming the same session with max_turns=')),
            `Expected NO resume-dispatch log line (a wasted resume), logs: ${JSON.stringify(result.logs)}`
        );
        const outcomesLine = result.logs.find((m) => m.includes('streak outcomes:'));
        assert.ok(outcomesLine, `Expected a "streak outcomes" summary log line, logs: ${JSON.stringify(result.logs)}`);
        assert.ok(
            outcomesLine.includes('"outcome":"success"'),
            `Expected the streak outcome to be recorded as "success", line: ${outcomesLine}`
        );
    });
});

test('mock sprint: a max_turns-exhausted doer streak with a bead STILL OPEN still resumes (existing behavior unchanged)', async () => {
    await withScenarioMarkers('maxturnsopen', async () => {
        let doerCalls = 0;
        let capturedIds = [];

        const result = await runDevelopLoopScenario('maxturnsopen', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: max_turns still-open scenario work' }],
            maxCycles: 1,
            reviewerHandler: approveReviewer,
            doerHandler: async ({ opts, tempDir: td }) => {
                doerCalls += 1;
                if (doerCalls === 1) {
                    // First dispatch exhausts max_turns WITHOUT closing its
                    // bead -- genuinely unfinished work, unlike Test 1 above.
                    capturedIds = assignedIdsFromPrompt(opts.prompt);
                    return {
                        content: [{ text: 'stopped after max turns, did not close its assigned bead(s)' }],
                        structuredContent: { isError: true, reason: 'max_turns_exhausted' },
                    };
                }
                // Resume dispatch: finish the work now.
                for (const id of capturedIds) {
                    await runCmd(`bd close ${id}`, td);
                }
                return {
                    content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: capturedIds, notes: 'Closed on resume.' }) }],
                };
            },
        });

        assert.ok(!result.error, `Scenario should not throw: ${result.error ? result.error.message : ''}`);
        assert.ok(doerCalls >= 2, `Expected the streak to be resumed (>=2 doer dispatches) since the bead was still open, got ${doerCalls} calls`);
        assert.ok(
            result.logs.some((m) => m.includes('resuming the same session with max_turns=')),
            `Expected the resume-dispatch log line to fire, logs: ${JSON.stringify(result.logs)}`
        );
        assert.ok(
            !result.logs.some((m) => m.includes('all assigned bead id(s) are already closed')),
            `Did NOT expect the already-closed short-circuit to fire when the bead was still open, logs: ${JSON.stringify(result.logs)}`
        );
        const outcomesLine = result.logs.find((m) => m.includes('streak outcomes:'));
        assert.ok(outcomesLine, `Expected a "streak outcomes" summary log line, logs: ${JSON.stringify(result.logs)}`);
        assert.ok(
            outcomesLine.includes('"outcome":"success"') || outcomesLine.includes('"outcome":"retried"'),
            `Expected the streak to still complete successfully via the resume ladder (success or retried), line: ${outcomesLine}`
        );
    });
});
