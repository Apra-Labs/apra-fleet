import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentDispatchError, FleetWorkflow } from '@apralabs/apra-fleet-workflow';

import { createUsageLimitPauseController } from '../fleet-sprint/usage-limit-controller.mjs';
import { dispatchRole } from '../fleet-sprint/dispatch-role.mjs';
import { createRecordingCtx, ROLE_CALL_OPTS } from './helpers/dispatch-role-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';

// =============================================================================
// End-to-end: an operator resume during a usage-limit pause wakes the run.
//
// A REAL FleetWorkflow runs a script (runWithContext) whose role dispatch hits
// a provider usage limit with a resume time ONE HOUR ahead. dispatchRole hands
// it to createUsageLimitPauseController, wired exactly as runner.js wires it:
// the script context's own requestPause/requestResume, a fake agent for the
// probe, the REAL clock and the REAL default sleep (no injected seams). The
// test then resumes the run the way the dashboard /resume endpoint does
// (workflow.requestResume with the endpoint's reason) and asserts:
//   * the probe dispatch happens within seconds, not at the one-hour resumeAt;
//   * the run log carries the operator-resume wake line;
//   * a probe that still reports usage_limit pauses the run again
//     ('pause:requested' a second time);
//   * no timer is left pending once the run ends (checked directly on the
//     active handles; the file also has no forced exit, so a leaked one-hour
//     timer would hold this test process open).
//
// GUARDS: the controller's race of its wait against the pause-end handle
// requestPause returns. With that reverted the wait sleeps the full hour and
// the bounded waits below fail.
// =============================================================================

const RESUME_REASON = 'Resume requested via dashboard /resume endpoint';
const PROBE_LABEL_PREFIX = 'usage-limit re-probe:';
// The acceptance bound for the operator-resume wake itself (not scaled: the
// wake is a promise settle, observed in milliseconds).
const WAKE_BOUND_MS = 5000;
// Setup/teardown waits get the load-scaled budget.
const SETUP_MS = scaledTimeout(5000, { concurrency: TEST_CONCURRENCY });
const HOUR_MS = 60 * 60 * 1000;

function usageLimitError(resumeAt) {
    return new AgentDispatchError('hit your usage limit', {
        details: { reason: 'usage_limit', usageLimit: { resumeAt, resumeAtSource: 'parsed' } },
    });
}

/** Resolves once `cond()` holds, or rejects after `ms` (its timer cleared either way). */
function waitFor(cond, ms, what) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = setInterval(() => {
            if (cond()) { clearInterval(poll); resolve(Date.now() - started); return; }
            if (Date.now() - started > ms) { clearInterval(poll); reject(new Error(`not within ${ms}ms: ${what}`)); }
        }, 10);
    });
}

const pendingTimers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

test('an operator resume during a one-hour usage-limit wait probes within seconds; a still-limited probe pauses again', async () => {
    const fleetApi = {
        async executePrompt() { return { content: [{ text: 'ok' }] }; },
        async executeCommand(payload) { return { content: [{ text: payload.command }], isError: false }; },
    };
    const wf = new FleetWorkflow(fleetApi);
    // A clean-state boundary that is always open, so the pause engages.
    wf.setPauseGuard(() => true);
    const pauseRequests = [];
    wf.on('pause:requested', (p) => pauseRequests.push(p));

    const runLog = [];
    const probes = [];
    // The fake probe agent: the first probe still sees the limit (another
    // hour), the second one finds the member usable again.
    const probeResponses = [() => usageLimitError(new Date(Date.now() + HOUR_MS).toISOString()), () => 'ok'];
    const fakeAgent = async (prompt, opts) => {
        probes.push(opts.label);
        const next = probeResponses.shift();
        const value = next ? next() : 'ok';
        if (value instanceof Error) throw value;
        return value;
    };

    const timersBefore = pendingTimers();
    const firstLimit = usageLimitError(new Date(Date.now() + HOUR_MS).toISOString());

    const run = wf.runWithContext({}, async (context) => {
        const { ctx, rec } = createRecordingCtx({
            responses: [firstLimit, { verdict: 'APPROVED', notes: 'continued after the operator resume' }],
        });
        ctx.log = (m) => { runLog.push(m); };
        // Wired exactly as runner.js does: the context's requestPause and
        // requestResume passed straight in, the real clock and default sleep.
        ctx.onUsageLimit = createUsageLimitPauseController({
            requestPause: context.requestPause,
            requestResume: context.requestResume,
            agent: fakeAgent,
            log: ctx.log,
        });
        const outcome = await dispatchRole(ctx, 'reviewer', { ...ROLE_CALL_OPTS.reviewer });
        return { outcome, dispatches: rec.dispatches.length };
    });

    // First pause: the dispatch hit the limit and the run is waiting ~1h.
    await waitFor(() => wf._paused && pauseRequests.length === 1, SETUP_MS, 'the first usage-limit pause');
    assert.equal(pauseRequests[0].source, 'usage_limit');
    assert.equal(probes.length, 0, 'no probe while waiting');

    // Operator resume, as the dashboard /resume endpoint issues it.
    await wf.requestResume(RESUME_REASON);
    const wakeMs = await waitFor(() => probes.length === 1, WAKE_BOUND_MS, 'the probe after the operator resume');
    assert.ok(wakeMs < WAKE_BOUND_MS, `probe ran ${wakeMs}ms after the resume`);
    assert.ok(probes[0].startsWith(PROBE_LABEL_PREFIX), `probe label: ${probes[0]}`);
    assert.ok(
        runLog.some((m) => m.includes('woken by operator resume') && m.includes(RESUME_REASON)),
        `run log lacks the operator-resume wake line: ${JSON.stringify(runLog)}`
    );

    // The probe still reported the limit: the run pauses again.
    await waitFor(() => pauseRequests.length === 2 && wf._paused, SETUP_MS, 'the second pause after the still-limited probe');

    // Second operator resume: the next probe succeeds and the role re-dispatches.
    await wf.requestResume(RESUME_REASON);
    let finished = false;
    run.then(() => { finished = true; }, () => { finished = true; });
    await waitFor(() => finished, SETUP_MS, 'the run finishing after the second resume');
    const result = await run;
    assert.equal(probes.length, 2);
    assert.equal(result.outcome.ok, true);
    assert.deepEqual(result.outcome.value, { verdict: 'APPROVED', notes: 'continued after the operator resume' });
    assert.equal(result.dispatches, 2, 'the limited dispatch + the post-resume re-dispatch');

    // No one-hour wait timer is left behind.
    assert.equal(pendingTimers(), timersBefore, 'no timer left pending after the run ended');
});
