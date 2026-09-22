import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentDispatchError, CancelledError, FleetWorkflow } from '@apralabs/apra-fleet-workflow';

import { createUsageLimitPauseController } from '../fleet-sprint/usage-limit-controller.mjs';
import {
    UsageLimitWaitExhaustedError,
    isUsageLimitDispatchError,
    usageLimitOf,
} from '../fleet-sprint/errors.mjs';
import { isTypedAbortError } from '../fleet-sprint/abort.mjs';
import { USAGE_LIMIT_BUDGET_DEFAULTS } from '../fleet-sprint/role-policies.mjs';
import { dispatchRole } from '../fleet-sprint/dispatch-role.mjs';
import { createRecordingCtx, ROLE_CALL_OPTS } from './helpers/dispatch-role-harness.mjs';

// =============================================================================
// apra-fleet-hzeb.4.3 -- fleet-sprint usage-limit pause/resume POLICY suite.
//
// This suite exercises the three cooperating pieces of the usage-limit
// pause/resume feature landed by apra-fleet-hzeb.4.1 (error taxonomy +
// budgets) and hzeb.4.2 (the controller + the dispatchRole hook):
//
//   1. createUsageLimitPauseController() (fleet-sprint/usage-limit-controller.mjs)
//      -- the cooperative pause/re-probe control loop, with an INJECTED clock,
//      sleep, agent, requestPause and requestResume so every assertion runs
//      with ZERO real wall-clock.
//   2. dispatchRole()'s usage-limit hook (fleet-sprint/dispatch-role.mjs, the
//      `retry.usageLimitPause && isUsageLimitDispatchError(err) &&
//      ctx.onUsageLimit` block) -- that a usage_limit dispatch error is handed
//      to the controller, the role is re-dispatched on {resumed:true} WITHOUT
//      charging a ladder attempt, and the resume-vs-fresh re-dispatch path is
//      chosen by the reported sessionId.
//   3. The two wired together against a REAL FleetWorkflow pause primitive
//      (the engine-level integration case).
//
// REVERT-FAILS GUARD (acceptance criterion): each block below names, in a
// comment, the production behaviour it guards. Reverting hzeb.4.2's
// controller/hook -- so a usage_limit dispatch error falls through to the
// generic retry ladder and aborts as it did before this epic -- makes at least
// one assertion here FAIL:
//   * The controller unit tests import createUsageLimitPauseController directly;
//     removing the module or its pause/re-probe loop fails them outright.
//   * The dispatchRole hook tests assert ctx.onUsageLimit is called exactly
//     once and the role re-dispatches without consuming an attempt; with the
//     hook reverted the usage_limit error is instead classified/degraded (or
//     retried generically), onUsageLimit is never called, and the "exactly one
//     hook call + re-dispatch + attempts unchanged" assertions fail.
//   * The integration test asserts the engine actually reaches 'paused' then
//     'resumed' and completes with the re-dispatched verdict; with the hook
//     reverted no pause is ever requested and the assertion on the pause
//     lifecycle fails.
// =============================================================================

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// A fixed epoch so every "resumeAt N ahead" is exact under the injected clock.
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const isoAt = (ms) => new Date(ms).toISOString();

/**
 * A provider usage-limit dispatch error, shaped exactly as execute_prompt
 * relays one (errors.mjs: details.reason === 'usage_limit', the provider's
 * UsageLimitSignal on details.usageLimit, the failing session on
 * details.sessionId). Kept local so a controller/hook regression cannot be
 * masked by a test-only error shape.
 */
function usageLimitError({ signal = null, sessionId = null, message = 'hit your usage limit' } = {}) {
    return new AgentDispatchError(message, {
        details: { reason: 'usage_limit', ...(signal ? { usageLimit: signal } : {}), ...(sessionId ? { sessionId } : {}) },
    });
}

/** A recording set of controller dependencies with an injected clock/sleep. */
function recordingDeps({ agentResponses = [], now = () => T0, budgets = {} } = {}) {
    const rec = { pauses: [], resumes: [], sleeps: [], probes: [], logs: [] };
    const queue = [...agentResponses];
    return {
        rec,
        deps: {
            requestPause: (reason, opts) => { rec.pauses.push({ reason, opts }); },
            requestResume: (reason) => { rec.resumes.push({ reason }); return Promise.resolve(); },
            agent: async (prompt, opts) => {
                rec.probes.push({ prompt, opts });
                const next = queue.length > 0 ? queue.shift() : 'ok';
                if (typeof next === 'function') return next();
                if (next instanceof Error) throw next;
                return next;
            },
            sleep: async (ms) => { rec.sleeps.push(ms); },
            now,
            log: (m) => rec.logs.push(m),
            budgets,
        },
    };
}

// ---------------------------------------------------------------------------
// 1. CONTROLLER unit tests (injected clock/sleep -- no real waits).
//
// GUARDS: createUsageLimitPauseController()'s wait-window derivation, its
// requestPause payload, its bounded re-probe ladder, and its typed give-up.
// ---------------------------------------------------------------------------
describe('usage-limit controller: wait-window derivation', () => {
    test("a parsed resumeAt 3h ahead sleeps ~3h and the pause carries resumeAt + source=parsed", async () => {
        // GUARDS: the controller trusts the provider's PARSED resumeAt as the
        // wait window (never its own invented default) and surfaces it on the
        // engine pause so the dashboard can show the resume time.
        const resumeAt = isoAt(T0 + 3 * HOUR);
        const { deps, rec } = recordingDeps({ agentResponses: ['ok'] });
        const controller = createUsageLimitPauseController(deps);

        const outcome = await controller({
            member: 'bob',
            roleLabel: 'Doer streak [bead-1]',
            signal: { resumeAt, resumeAtSource: 'parsed' },
        });

        assert.deepEqual(outcome, { resumed: true });
        assert.equal(rec.sleeps.length, 1, 'exactly one pause/sleep before the successful probe');
        assert.equal(rec.sleeps[0], 3 * HOUR, 'slept for exactly the parsed 3h window (< MAX_WAIT, so unclamped)');
        assert.equal(rec.pauses.length, 1);
        assert.equal(rec.pauses[0].opts.resumeAt, resumeAt, 'requestPause payload carries the parsed resumeAt');
        assert.equal(rec.pauses[0].opts.source, 'usage_limit', "pause source is the engine's usage_limit tag");
        assert.ok(
            rec.logs.some((m) => m.includes('source=parsed')),
            `the pause was classified parsed in the log, got: ${JSON.stringify(rec.logs)}`
        );
    });

    test('a resumeAt beyond MAX_WAIT is clamped down to the remaining wait budget', async () => {
        // GUARDS: the clamp -- the controller never pauses past its total wait
        // budget even when a provider reports a resume time hours beyond it.
        const { deps, rec } = recordingDeps({
            agentResponses: ['ok'],
            budgets: { USAGE_LIMIT_MAX_WAIT_S: 6 * 60 * 60 },
        });
        const controller = createUsageLimitPauseController(deps);

        const outcome = await controller({
            member: 'bob',
            roleLabel: 'Reviewer',
            signal: { resumeAt: isoAt(T0 + 8 * HOUR), resumeAtSource: 'parsed' },
        });

        assert.deepEqual(outcome, { resumed: true });
        assert.equal(rec.sleeps[0], 6 * HOUR, 'the 8h resumeAt was clamped to the 6h MAX_WAIT budget');
    });

    test('a guessed resumeAt waits exactly the window the signal provided', async () => {
        // GUARDS: the "guessed" fallback resumeAt is the PROVIDER adapter's, not
        // the controller's -- so the controller honours it verbatim (source is
        // reported as guessed) rather than substituting a window of its own.
        const { deps, rec } = recordingDeps({ agentResponses: ['ok'] });
        const controller = createUsageLimitPauseController(deps);

        await controller({
            member: 'bob',
            roleLabel: 'Doer streak [bead-1]',
            signal: { resumeAt: isoAt(T0 + 90 * MIN), resumeAtSource: 'guessed' },
        });

        assert.equal(rec.sleeps[0], 90 * MIN, 'waited exactly the guessed 90m window from the signal');
        assert.ok(
            rec.logs.some((m) => m.includes('source=guessed')),
            `the pause was classified guessed in the log, got: ${JSON.stringify(rec.logs)}`
        );
    });
});

describe('usage-limit controller: bounded re-probe ladder', () => {
    test('two usage_limit re-probes then success -> 3 pauses on the backoff ladder, {resumed:true}', async () => {
        // GUARDS: with NO provider resumeAt the controller steps its own
        // role-policies backoff ladder (never a hard-coded window), re-probes
        // the member on each wake, and reports resumed once a probe clears.
        const ladder = USAGE_LIMIT_BUDGET_DEFAULTS.USAGE_LIMIT_REPROBE_BACKOFF_MS;
        const { deps, rec } = recordingDeps({
            // signal has no resumeAt -> ladder-driven; probes fail twice then pass.
            agentResponses: [
                usageLimitError(),
                usageLimitError(),
                'ok',
            ],
        });
        const controller = createUsageLimitPauseController(deps);

        const outcome = await controller({ member: 'bob', roleLabel: 'Reviewer', signal: null });

        assert.deepEqual(outcome, { resumed: true });
        assert.equal(rec.pauses.length, 3, 'one pause per wake: initial + two re-probes');
        assert.equal(rec.probes.length, 3, 'one real probe dispatch per wake');
        assert.deepEqual(
            rec.sleeps,
            [ladder[0], ladder[1], ladder[2]],
            'each pause honoured the next rung of the reprobe backoff ladder'
        );
        // The pauses on a ladder-driven wait carry no resumeAt (there was none).
        assert.ok(rec.pauses.every((p) => p.opts.resumeAt === undefined), 'ladder pauses carry no resumeAt');
    });

    test('re-probes beyond MAX_REPROBES give up with UsageLimitWaitExhaustedError naming the member', async () => {
        // GUARDS: the reprobe ceiling -- a member that keeps tripping the limit
        // is eventually abandoned with the typed give-up error that abort.mjs
        // routes to an [ABORTED] terminal record.
        const { deps, rec } = recordingDeps({
            agentResponses: [
                usageLimitError(), usageLimitError(), usageLimitError(),
                usageLimitError(), usageLimitError(), usageLimitError(),
            ],
            budgets: { USAGE_LIMIT_MAX_REPROBES: 2 },
        });
        const controller = createUsageLimitPauseController(deps);

        const outcome = await controller({ member: 'bob', roleLabel: 'Reviewer', signal: null });

        assert.equal(outcome.resumed, false);
        assert.ok(outcome.error instanceof UsageLimitWaitExhaustedError, 'gave up with the typed exhaustion error');
        assert.equal(outcome.error.member, 'bob', 'the give-up error names the rate-limited member');
        assert.equal(outcome.error.roleLabel, 'Reviewer');
        assert.equal(outcome.error.reprobes, 3, 'gave up on the reprobe that pushed past MAX_REPROBES=2');
        assert.ok(isTypedAbortError(outcome.error), 'the give-up is a typed sprint abort (-> verdict ABORTED)');
        assert.ok(rec.probes.length >= 3, 'at least one probe past the ceiling was attempted before giving up');
    });

    test('a wall-clock beyond MAX_WAIT_S gives up with the typed error carrying waitedMs and lastResumeAt', async () => {
        // GUARDS: the total wall-clock ceiling -- independent of the reprobe
        // count, the accumulated pause time cannot exceed MAX_WAIT_S. The
        // terminalReason detail (member + last reported resumeAt) is what an
        // operator reads off the ABORTED record.
        const resumeAt = isoAt(T0 + 3 * HOUR);
        const { deps } = recordingDeps({
            agentResponses: [
                // First probe reports a fresh parsed resumeAt (drives the second
                // wait); it never clears, so the wall clock runs out.
                usageLimitError({ signal: { resumeAt, resumeAtSource: 'parsed' } }),
                usageLimitError({ signal: { resumeAt, resumeAtSource: 'parsed' } }),
                usageLimitError({ signal: { resumeAt, resumeAtSource: 'parsed' } }),
            ],
            budgets: { USAGE_LIMIT_MAX_WAIT_S: 30 * 60, USAGE_LIMIT_MAX_REPROBES: 10, USAGE_LIMIT_MIN_WAIT_S: 60 },
        });
        const controller = createUsageLimitPauseController(deps);

        const outcome = await controller({
            member: 'carol',
            roleLabel: 'Doer streak [bead-9]',
            signal: { resumeAt, resumeAtSource: 'parsed' },
        });

        assert.equal(outcome.resumed, false);
        assert.ok(outcome.error instanceof UsageLimitWaitExhaustedError);
        assert.equal(outcome.error.member, 'carol');
        assert.ok(outcome.error.waitedMs <= 30 * MIN, 'never waited past the 30m MAX_WAIT_S budget');
        assert.equal(outcome.error.lastResumeAt, T0 + 3 * HOUR, 'the give-up carries the last reported resumeAt (epoch ms)');
        assert.ok(isTypedAbortError(outcome.error));
    });
});

describe('usage-limit controller: cooperative stop propagation', () => {
    test('a requestStop during the pause/sleep propagates CancelledError and never probes', async () => {
        // GUARDS: an operator stop taken WHILE paused tears the run down mid-
        // pause -- the CancelledError is never swallowed, and no re-probe is
        // dispatched after the stop.
        const { deps, rec } = recordingDeps();
        deps.sleep = async () => { throw new CancelledError('operator stopped during pause'); };
        const controller = createUsageLimitPauseController(deps);

        await assert.rejects(
            () => controller({ member: 'bob', roleLabel: 'Reviewer', signal: { resumeAt: isoAt(T0 + HOUR), resumeAtSource: 'parsed' } }),
            (err) => err instanceof CancelledError
        );
        assert.equal(rec.probes.length, 0, 'no probe dispatched once the pause is cancelled');
        assert.equal(rec.resumes.length, 0, 'never resumed after a cancel during the pause');
        assert.equal(rec.pauses.length, 1, 'the pause was requested before the cancel');
    });

    test('a CancelledError surfacing on the probe is re-thrown, not treated as an inconclusive probe', async () => {
        // GUARDS: the probe catch re-throws a CancelledError (an operator stop
        // that lands on the wake dispatch) rather than swallowing it into the
        // "inconclusive -> proceed to re-dispatch" path.
        const { deps, rec } = recordingDeps({
            agentResponses: [new CancelledError('stopped on the re-probe')],
        });
        const controller = createUsageLimitPauseController(deps);

        await assert.rejects(
            () => controller({ member: 'bob', roleLabel: 'Reviewer', signal: { resumeAt: isoAt(T0 + HOUR), resumeAtSource: 'parsed' } }),
            (err) => err instanceof CancelledError
        );
        assert.equal(rec.probes.length, 1, 'exactly one probe ran; the cancel stopped any further re-probe');
    });
});

// ---------------------------------------------------------------------------
// 2. dispatchRole HOOK unit tests (real engine, recording ctx, stub controller).
//
// GUARDS: the dispatch-role.mjs usage-limit catch block -- that a usage_limit
// error is handed to ctx.onUsageLimit exactly once, a {resumed:true} outcome
// re-dispatches WITHOUT charging a ladder attempt, and the resume-vs-fresh
// re-dispatch path follows the reported sessionId.
// ---------------------------------------------------------------------------
describe('dispatchRole usage-limit hook', () => {
    test('a usage_limit on the first attempt calls onUsageLimit once, does NOT charge an attempt, and re-dispatches on {resumed:true}', async () => {
        const signal = { resumeAt: isoAt(T0 + HOUR), resumeAtSource: 'parsed' };
        const { ctx, rec } = createRecordingCtx({
            responses: [usageLimitError({ signal }), { verdict: 'APPROVED', notes: 'ok' }],
        });
        const hookCalls = [];
        ctx.onUsageLimit = async (args) => { hookCalls.push(args); return { resumed: true }; };

        const outcome = await dispatchRole(ctx, 'reviewer', { ...ROLE_CALL_OPTS.reviewer });

        assert.equal(hookCalls.length, 1, 'the controller hook is invoked exactly once');
        assert.equal(hookCalls[0].member, ROLE_CALL_OPTS.reviewer.bindings['reviewerPool[0]']);
        assert.equal(hookCalls[0].signal, signal, 'the failing dispatch signal is handed to the controller');
        assert.equal(outcome.ok, true, 'the re-dispatch succeeded');
        assert.deepEqual(outcome.value, { verdict: 'APPROVED', notes: 'ok' }, 'the re-dispatched verdict is returned');
        assert.equal(outcome.attempts, 1, 'the usage-limit re-dispatch did NOT consume a ladder attempt');
        assert.equal(rec.dispatches.length, 2, 'exactly two real dispatches: the limited one + the re-dispatch');
    });

    test('with a reported sessionId the re-dispatch uses the resume path (warm session, resume prompt)', async () => {
        // GUARDS: canResumeSession -- a role WITH a max-turns resume ladder and a
        // reported sessionId continues the SAME session (resume prompt/label)
        // rather than starting fresh.
        const { ctx, rec } = createRecordingCtx({
            responses: [usageLimitError({ sessionId: 'sess-limited-1' }), { verdict: 'APPROVED', notes: 'resumed' }],
        });
        ctx.onUsageLimit = async () => ({ resumed: true });

        const outcome = await dispatchRole(ctx, 'reviewer', { ...ROLE_CALL_OPTS.reviewer });

        assert.equal(outcome.ok, true);
        assert.equal(rec.dispatches.length, 2);
        assert.equal(
            rec.dispatches[1].prompt,
            ROLE_CALL_OPTS.reviewer.resumePrompt,
            'the re-dispatch used the RESUME prompt (same-session continuation)'
        );
        assert.equal(rec.dispatches[1].options.resume, true, 'the resume dispatch continues the same session');
        assert.ok(rec.kills.length >= 1, 'the resume path ran its kill-stale-session pre-dispatch step');
    });

    test('without a reported sessionId the re-dispatch is fresh (main prompt, new session)', async () => {
        // GUARDS: the else branch -- absent a session to resume, the role is
        // re-dispatched fresh via the main prompt.
        const { ctx, rec } = createRecordingCtx({
            responses: [usageLimitError({ sessionId: null }), { verdict: 'APPROVED', notes: 'fresh' }],
        });
        ctx.onUsageLimit = async () => ({ resumed: true });

        const outcome = await dispatchRole(ctx, 'reviewer', { ...ROLE_CALL_OPTS.reviewer });

        assert.equal(outcome.ok, true);
        assert.equal(rec.dispatches.length, 2);
        assert.equal(
            rec.dispatches[1].prompt,
            ROLE_CALL_OPTS.reviewer.prompt,
            'the re-dispatch used the MAIN prompt (a fresh dispatch, not a resume)'
        );
        assert.notEqual(rec.dispatches[1].options.resume, true, 'a fresh re-dispatch does not resume a session');
    });

    test('an exhausted controller wait propagates its typed give-up error out of dispatchRole (no fabricated verdict)', async () => {
        // GUARDS: the "controller gave up" branch -- its typed
        // UsageLimitWaitExhaustedError is the ladder's last word and propagates
        // straight out, never degraded into a synthesized verdict.
        const giveUp = new UsageLimitWaitExhaustedError('rate limited past budget', { member: 'bob', roleLabel: 'Reviewer' });
        const { ctx } = createRecordingCtx({ responses: [usageLimitError({ signal: null })] });
        ctx.onUsageLimit = async () => ({ resumed: false, error: giveUp });

        await assert.rejects(
            () => dispatchRole(ctx, 'reviewer', { ...ROLE_CALL_OPTS.reviewer }),
            (err) => err === giveUp && isTypedAbortError(err)
        );
    });
});

// ---------------------------------------------------------------------------
// 3. Engine-level integration: the real FleetWorkflow pause primitive, the
//    real controller, and the real dispatchRole hook wired together with a
//    mocked fleet API and an injected clock.
//
// GUARDS: the whole pause -> resume -> probe -> re-dispatch lifecycle: a
// usage_limit on a role produces an ENGAGED 'paused' (never a stuck 'pausing'),
// releases reservations, and after the injected clock advances re-reserves,
// probes, and really re-dispatches -- the sprint continues with a normal
// verdict. This mirrors runner.js's real wiring (createUsageLimitPauseController
// fed the engine's requestPause/requestResume) and cli.mjs's real listeners
// (on('paused', release) + setPreResumeHook(re-reserve)).
// ---------------------------------------------------------------------------
describe('engine-level usage-limit pause/resume integration', () => {
    test('a usage_limit under WorkflowEngine pauses (not stuck pausing), releases + re-reserves, probes, and re-dispatches to completion', async () => {
        const timeline = [];
        const fleetApi = {
            async executePrompt(payload) {
                timeline.push(`probe-dispatch:${payload.member_name}`);
                return { content: [{ text: 'ok' }] };
            },
            async executeCommand(payload) {
                return { content: [{ text: payload.command }], isError: false };
            },
        };
        const wf = new FleetWorkflow(fleetApi);
        // A clean-state boundary that is always open, so a requested pause
        // ENGAGES ('paused') rather than deferring forever ('pausing').
        wf.setPauseGuard(() => true);
        // cli.mjs's real wiring: releasing member reservations on pause and
        // re-reserving them as a hard barrier before the first post-resume
        // dispatch. Modelled here as ordered timeline markers.
        wf.on('paused', () => timeline.push('paused:reservations-released'));
        wf.on('resumed', () => timeline.push('resumed'));
        wf.setPreResumeHook(async () => { timeline.push('re-reserve'); });

        const controller = createUsageLimitPauseController({
            requestPause: (reason, opts) => wf.requestPause(reason, opts),
            requestResume: (reason) => wf.requestResume(reason),
            agent: (prompt, opts) => wf.agent(prompt, opts),
            now: () => T0,
            sleep: async (ms) => { timeline.push(`clock-advanced:${ms}`); },
            log: () => {},
        });

        const signal = { resumeAt: isoAt(T0 + 2 * HOUR), resumeAtSource: 'parsed' };
        const { ctx, rec } = createRecordingCtx({
            responses: [usageLimitError({ signal }), { verdict: 'APPROVED', notes: 'sprint continued after the limit cleared' }],
        });
        ctx.onUsageLimit = controller;

        const outcome = await dispatchRole(ctx, 'reviewer', { ...ROLE_CALL_OPTS.reviewer });

        // The engine actually reached an ENGAGED pause and then resumed.
        assert.ok(timeline.includes('paused:reservations-released'), "the engine engaged 'paused' (not a stuck 'pausing')");
        assert.ok(timeline.includes('resumed'), "the engine emitted 'resumed'");
        assert.equal(wf._paused, false, 'the run is no longer paused once the limit cleared');

        // Strict lifecycle order: pause -> clock advance -> re-reserve barrier
        // -> resumed -> probe dispatch.
        const order = timeline.filter((e) => e !== `probe-dispatch:${rec.dispatches[0]?.member}`);
        assert.deepEqual(
            [
                order.indexOf('paused:reservations-released') <
                    order.findIndex((e) => e.startsWith('clock-advanced')),
                order.findIndex((e) => e.startsWith('clock-advanced')) < order.indexOf('re-reserve'),
                order.indexOf('re-reserve') < order.indexOf('resumed'),
            ],
            [true, true, true],
            `expected paused -> clock-advanced -> re-reserve -> resumed, got: ${JSON.stringify(timeline)}`
        );
        assert.ok(
            timeline.some((e) => e.startsWith('probe-dispatch:')),
            'a real re-probe dispatch ran through the engine after resume'
        );

        // The role really re-dispatched and the sprint completed with a normal verdict.
        assert.equal(outcome.ok, true);
        assert.deepEqual(outcome.value, { verdict: 'APPROVED', notes: 'sprint continued after the limit cleared' });
        assert.equal(outcome.attempts, 1, 'the pause/resume did not consume a ladder attempt');
        assert.equal(rec.dispatches.length, 2, 'the role dispatched twice: the limited attempt + the post-resume re-dispatch');
    });
});

// ---------------------------------------------------------------------------
// 4. No invented 1h default anywhere in fleet-sprint/** (acceptance criterion).
//
// GUARDS: the controller (and every other fleet-sprint module) must derive its
// wait window from a provider signal or the role-policies backoff ladder --
// never a hard-coded one-hour millisecond literal. Comments are stripped first
// so a documentary reference to a past incident's 3600000ms timeout does not
// count as a live default.
// ---------------------------------------------------------------------------
describe('fleet-sprint hygiene: no hard-coded one-hour default', () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const FLEET_SPRINT_DIR = path.join(__dirname, '..', 'fleet-sprint');

    function collectSourceFiles(dir) {
        const out = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) out.push(...collectSourceFiles(full));
            else if (/\.(mjs|js)$/.test(entry.name)) out.push(full);
        }
        return out;
    }

    // Strip block + line comments so only executable code is scanned.
    function stripComments(src) {
        return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    }

    test('no 3600000 / 60*60*1000 millisecond literal exists in fleet-sprint/** code', () => {
        const oneHourMs = /\b3600000\b/;
        const oneHourExpr = /60\s*\*\s*60\s*\*\s*1000/;
        const offenders = [];
        for (const file of collectSourceFiles(FLEET_SPRINT_DIR)) {
            const code = stripComments(fs.readFileSync(file, 'utf8'));
            if (oneHourMs.test(code) || oneHourExpr.test(code)) offenders.push(path.relative(FLEET_SPRINT_DIR, file));
        }
        assert.deepEqual(
            offenders,
            [],
            `a hard-coded one-hour default appears in fleet-sprint code (controller must not invent a 1h window): ${offenders.join(', ')}`
        );
    });
});
