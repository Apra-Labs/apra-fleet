import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-p4f.3 (superseded): a doer streak that exhausts its turn limit
// (max_turns) is NOT a generic transient dispatch failure, so runner.js's
// doer-retry wrapper must not treat it with a blind identical retry (same
// prompt, same max_turns -- which would deterministically exhaust again).
//
// It previously just gave up and flagged the streak as too-complex.
// Superseded: it now RESUMES the same session with a short "continue" nudge
// and an escalated max_turns (bounded, doubling each attempt) instead of
// giving up or regrouping/splitting the streak -- a resume is not identical
// to the original dispatch (same context, more turns, no re-planning), so it
// can actually let a longer-than-expected streak finish. Only after
// exhausting the bounded resume attempts does it fall back to flagging the
// streak as too-complex.
// =============================================================================
test('mock sprint: a max_turns-exhausted doer streak resumes with escalated max_turns instead of blindly retrying or giving up immediately', async () => {
    await withScenarioMarkers('doermaxturns', async () => {
        console.log('Running mock sprint scenario (doer streak dispatch reports max_turns_exhausted on every attempt)...');
        const result = await runDevelopLoopScenario('doermaxturns', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: doer max_turns scenario work' }],
            maxCycles: 1,
            doerHandler: async () => ({
                content: [{ text: 'stopped after max turns, simulating a max_turns-exhausted doer dispatch' }],
                structuredContent: { isError: true, reason: 'max_turns_exhausted' },
            }),
        });

        check(
            result.logs.some((m) => m.includes('exhausted its turn limit (max_turns)') && m.includes('resuming the same session with max_turns=1000 (attempt 1/2)')),
            `Expected the first resume attempt's log line, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            result.logs.some((m) => m.includes('resuming the same session with max_turns=2000 (attempt 2/2)')),
            `Expected the second (escalated) resume attempt's log line, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            result.logs.some((m) => m.includes('still failing after 2 resume attempt(s)') && m.includes('flagging as too-complex-for-one-streak')),
            `Expected the bounded-give-up log line once all resume attempts also exhaust max_turns, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            // apra-fleet-3swo.5.7: the doer ladder moved onto the dispatchRole
            // engine, which names the attempt number where the ladder used to
            // say "Retrying once." Same fact either way.
            !result.logs.some((m) => /Doer streak .* dispatch threw:.*Retrying \(attempt 2 of 2\)\.$/.test(m)),
            `Did NOT expect the generic blind-retry-once log line for a max_turns dispatch, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

test('mock sprint: a max_turns-exhausted doer streak that succeeds on its first resume attempt does not escalate further or give up', async () => {
    await withScenarioMarkers('doermaxturnsresumeok', async () => {
        console.log('Running mock sprint scenario (doer streak exhausts max_turns once, then completes on resume)...');
        // Note: the mock "continue" resume prompt (runner.js's
        // dispatchDoerResume) deliberately does NOT repeat the assigned bead
        // ids -- a real resumed session already has them in context. The
        // mock doerHandler below captures the bead id from the FIRST (fresh)
        // dispatch's prompt and reuses it when reporting success on the
        // resume call, mirroring what a real resumed doer session would
        // already know.
        //
        // This harness's mock doer responses are not backed by a real `bd
        // close` -- runner.js's own post-streak `bd show` check will
        // therefore still see the bead as open no matter what JSON the
        // handler returns, so the Develop/Review loop keeps redispatching a
        // FRESH (non-resume) attempt in later rounds. That is a harness
        // limitation unrelated to the resume-and-continue fix under test --
        // this test only asserts on the FIRST round's dispatch sequence
        // (original -> one successful resume, no further escalation), not
        // on whether the overall scenario ultimately reports the streak
        // closed. Assertions are collected via plain variables (not thrown
        // inside the handler) so a mismatch surfaces as a normal test
        // failure rather than an opaque transport error.
        let calls = 0;
        let capturedBeadId = null;
        const observedOpts = [];
        const result = await runDevelopLoopScenario('doermaxturnsresumeok', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: doer max_turns resume-success scenario work' }],
            maxCycles: 1,
            doerHandler: async ({ opts }) => {
                calls++;
                observedOpts.push({ resume: opts.resume, max_turns: opts.max_turns });
                if (calls === 1) {
                    const beadIdMatch = opts.prompt.match(/apra-fleet-mock-sprint-\S+/);
                    capturedBeadId = beadIdMatch ? beadIdMatch[0] : null;
                    return {
                        content: [{ text: 'stopped after max turns' }],
                        structuredContent: { isError: true, reason: 'max_turns_exhausted' },
                    };
                }
                return {
                    content: [{
                        text: JSON.stringify({
                            status: 'VERIFY',
                            closedIds: capturedBeadId ? [capturedBeadId] : [],
                            notes: 'Completed on resume after the original attempt exhausted max_turns.',
                        }),
                    }],
                };
            },
        });

        check(calls >= 2, `expected at least 2 doer dispatches (original + first resume), got ${calls}`);
        check(observedOpts[0]?.resume !== true, `first dispatch should not be a resume, got resume=${observedOpts[0]?.resume}`);
        check(observedOpts[1]?.resume === true, `the retry after max_turns exhaustion must be a session resume, not a fresh dispatch, got resume=${observedOpts[1]?.resume}`);
        check(observedOpts[1]?.max_turns === 1000, `expected the first resume to escalate max_turns to 1000, got ${observedOpts[1]?.max_turns}`);
        check(
            result.logs.some((m) => m.includes('resuming the same session with max_turns=1000 (attempt 1/2)')),
            `Expected the resume attempt's log line, logs: ${JSON.stringify(result.logs)}`
        );
        // The first resume succeeded (a normal VERIFY, not another
        // max_turns_exhausted throw), so it must NOT escalate to a second
        // resume attempt or report a give-up within that same round.
        check(
            !result.logs.some((m) => m.includes('resuming the same session with max_turns=2000 (attempt 2/2)')),
            `Did NOT expect a second (escalated) resume attempt when the first resume succeeded, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            !result.logs.some((m) => m.includes('still failing after')),
            `Did NOT expect a give-up log line when the resume attempt succeeded, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

test('mock sprint: a generic (non-max_turns) doer dispatch failure still gets the blind retry-once', async () => {
    await withScenarioMarkers('doergenericretry', async () => {
        console.log('Running mock sprint scenario (doer streak dispatch fails generically, then succeeds on retry)...');
        let calls = 0;
        const result = await runDevelopLoopScenario('doergenericretry', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: doer generic-retry scenario work' }],
            maxCycles: 1,
            doerHandler: async ({ opts }) => {
                calls++;
                if (calls === 1) {
                    return {
                        content: [{ text: 'transient dispatch failure, simulating a generic (non-max_turns) doer error' }],
                        structuredContent: { isError: true, reason: 'dispatch_failed' },
                    };
                }
                const beadIdMatch = opts.prompt.match(/apra-fleet-mock-sprint-\S+/);
                return {
                    content: [{
                        text: JSON.stringify({
                            status: 'VERIFY',
                            closedIds: beadIdMatch ? [beadIdMatch[0]] : [],
                            notes: 'Recovered on retry.',
                        }),
                    }],
                };
            },
        });

        check(
            result.logs.some((m) => /Doer streak .* dispatch threw:.*Retrying \(attempt 2 of 2\)\.$/.test(m)),
            `Expected the generic blind-retry log line for a non-max_turns dispatch failure, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            !result.logs.some((m) => m.includes('exhausted its turn limit (max_turns)')),
            `Did NOT expect the max_turns-specific log line for a generic dispatch failure, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

// =============================================================================
// apra-fleet-eft.75.3 -- end-to-end verification of the apra-fleet-eft.75 fix,
// through the REAL runner.js call site rather than only the isolated
// createMemberSessionGuard unit tests (member-session-guard.test.mjs) or the
// standalone pidfile-lock tests (sprint-lock.test.mjs /
// sprint-lock-engine-wiring.test.mjs).
//
// Root incident: engine resume of a presumed-dead/timed-out session
// re-dispatched to the same member WITHOUT first confirming the prior
// attempt's process had actually exited -- both stayed alive concurrently
// for 50+ minutes.
//
// This test drives an actual doer max_turns-exhausted -> resume cycle
// through runSprintCycle()/main() (via WorkflowEngine.executeFile(), exactly
// as bin/cli.mjs invokes it in production) and injects a spy `args.callTool`
// -- the same known arg key bin/cli.mjs wires from its live
// `mcpClient.callTool` (apra-fleet-eft.75.1) -- to prove the REAL resume
// call site (runner.js's doer max-turns resume ladder, ~line 5649) calls
// `memberSessionGuard.killIfAlive(doerMember)` -- which calls the fleet's
// `stop_prompt` tool via callTool -- and that this call completes BEFORE the
// resume dispatch is fired, i.e. no two concurrent sessions.
// =============================================================================
test('mock sprint: a max_turns-exhausted doer streak resume calls the REAL pre-resume session guard (stop_prompt via callTool) before the resume dispatch fires', async () => {
    await withScenarioMarkers('doermaxturnsguard', async () => {
        console.log('Running mock sprint scenario (doer streak max_turns_exhausted -> resume, with a real callTool spy proving the pre-resume session guard fires first)...');
        const order = [];
        let doerCalls = 0;

        const result = await runDevelopLoopScenario('doermaxturnsguard', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: doer max_turns session-guard wiring scenario work' }],
            maxCycles: 1,
            callTool: async (name, args) => {
                order.push(`callTool:${name}:${args && args.member_name}`);
                return '[OK] killed stale process';
            },
            doerHandler: async ({ opts }) => {
                doerCalls += 1;
                if (doerCalls === 1) {
                    order.push('doer-dispatch-original');
                    return {
                        content: [{ text: 'stopped after max turns, simulating a max_turns-exhausted doer dispatch' }],
                        structuredContent: { isError: true, reason: 'max_turns_exhausted' },
                    };
                }
                order.push(`doer-dispatch-resume(resume=${opts.resume})`);
                return {
                    content: [{
                        text: JSON.stringify({ status: 'VERIFY', closedIds: [], notes: 'Completed on resume.' }),
                    }],
                };
            },
        });

        check(
            order.includes('callTool:stop_prompt:local'),
            `Expected the real pre-resume guard to call stop_prompt('local') via the injected callTool, order: ${JSON.stringify(order)}`
        );
        const stopIdx = order.indexOf('callTool:stop_prompt:local');
        const resumeIdx = order.findIndex((e) => e.startsWith('doer-dispatch-resume'));
        check(
            stopIdx !== -1 && resumeIdx !== -1 && stopIdx < resumeIdx,
            `Expected stop_prompt to fire BEFORE the resume dispatch (kill-before-second-session), order: ${JSON.stringify(order)}`
        );
        check(
            result.logs.some((m) => m.includes("pre-resume stop_prompt for 'local'") && m.includes('killed stale process')),
            `Expected the guard's own log line reporting the stop_prompt result, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

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
