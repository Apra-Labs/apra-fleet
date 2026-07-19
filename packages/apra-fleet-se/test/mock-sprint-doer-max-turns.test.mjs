import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

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
            result.logs.some((m) => m.includes('exhausted its turn limit (max_turns)') && m.includes('resuming the same session with max_turns=200 (attempt 1/2)')),
            `Expected the first resume attempt's log line, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            result.logs.some((m) => m.includes('resuming the same session with max_turns=400 (attempt 2/2)')),
            `Expected the second (escalated) resume attempt's log line, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            result.logs.some((m) => m.includes('still failing after 2 resume attempt(s)') && m.includes('flagging as too-complex-for-one-streak')),
            `Expected the bounded-give-up log line once all resume attempts also exhaust max_turns, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            !result.logs.some((m) => /Doer streak .* threw:.*Retrying once\.$/.test(m)),
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
        check(observedOpts[1]?.max_turns === 200, `expected the first resume to escalate max_turns to 200, got ${observedOpts[1]?.max_turns}`);
        check(
            result.logs.some((m) => m.includes('resuming the same session with max_turns=200 (attempt 1/2)')),
            `Expected the resume attempt's log line, logs: ${JSON.stringify(result.logs)}`
        );
        // The first resume succeeded (a normal VERIFY, not another
        // max_turns_exhausted throw), so it must NOT escalate to a second
        // resume attempt or report a give-up within that same round.
        check(
            !result.logs.some((m) => m.includes('resuming the same session with max_turns=400 (attempt 2/2)')),
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
            result.logs.some((m) => /Doer streak .* threw:.*Retrying once\.$/.test(m)),
            `Expected the generic blind-retry log line for a non-max_turns dispatch failure, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            !result.logs.some((m) => m.includes('exhausted its turn limit (max_turns)')),
            `Did NOT expect the max_turns-specific log line for a generic dispatch failure, logs: ${JSON.stringify(result.logs)}`
        );
    });
});
