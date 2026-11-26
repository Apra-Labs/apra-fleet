// apra-fleet-hzeb.4.2 -- fleet-sprint usage-limit pause/resume/re-probe
// controller.
//
// This module owns the cooperative-pause control loop a role dispatch enters
// when a provider reports a usage/rate limit (execute_prompt relays it as an
// AgentDispatchError whose details.reason === 'usage_limit', carrying the
// provider's UsageLimitSignal on details.usageLimit). It is INJECTED into
// dispatch-role.mjs as ctx.onUsageLimit by runner.js -- never imported there,
// so the engine stays free of runner-side primitives (requestPause/
// requestResume/agent) and this loop stays unit-testable with an injected
// clock, sleep and agent (no real waits, no live fleet).
//
// WHY A DEDICATED MODULE (not inline in runner.js): the probe is a REAL
// agent() dispatch, and runner.js's dispatch-safety census pins its own
// agent() call-site count at zero now that every role ladder runs through the
// dispatchRole engine. Housing the probe here keeps that census intact while
// still guarding this dispatch site under the shared guarded-module list
// (member_name is spelled explicitly at the call site, exactly as
// dispatch-safety-guard.mjs requires).
//
// WHAT THIS DOES NOT DO: it never invents its own wait window. The guessed
// one-hour fallback is the PROVIDER adapter's (provider.ts's
// DEFAULT_USAGE_LIMIT_RESUME_MS, surfaced on the signal's resumeAt); this
// controller only ever reads the signal's resumeAt or steps the reprobe
// backoff ladder from role-policies.mjs. It deliberately hard-codes no
// millisecond wait window of its own.
//
// KNOWN SIMPLIFICATIONS (apra-fleet-hzeb.10 -- documented, not fixed here):
// (1) the pause this controller requests is SPRINT-WIDE, not per-member --
// only the rate-limited `member` is re-probed above; every other member's
// dispatches are simply gated by the engine's cooperative pause rather than
// each being individually probed for its own usage limit.
// (2) a pause held longer than ~30 minutes (DEFAULT_IDLE_TIMEOUT_MS in
// src/services/cloud/idle-manager.ts) can let the idle manager suspend a
// cloud member's VM while it sits reservation-released during the wait;
// ensureCloudReady (src/tools/execute-prompt.ts) transparently restarts it
// on the probe dispatch above, so this is logged but given no special
// handling here.
import { CancelledError, isErrorLogged } from '@apralabs/apra-fleet-workflow';
import { isUsageLimitDispatchError, usageLimitOf, UsageLimitWaitExhaustedError } from './errors.mjs';
import { USAGE_LIMIT_BUDGET_DEFAULTS } from './role-policies.mjs';
import { createModelReporter } from './model-log.mjs';

// A minimal, target-agnostic probe. Its ONLY purpose is to observe whether the
// member still trips the usage limit, so it is the shortest possible real
// dispatch: one turn, a one-line generic prompt (no target-repo assumptions,
// no bead ids -- check-generic-boundary.mjs), a fresh session, a short timeout.
const PROBE_PROMPT = 'Reply with the single word: ok.';
const PROBE_TIMEOUT_S = 60;
// Longest slice of a probe failure message the log carries; a longer one is cut
// and ends with PROBE_ERROR_TRUNCATION_MARKER.
export const PROBE_ERROR_LOG_MAX_CHARS = 300;
export const PROBE_ERROR_TRUNCATION_MARKER = '...[truncated]';

function boundedProbeError(err) {
    // The workflow already wrote this failure's text to the log at the
    // dispatch site: name its kind only, so the payload appears once.
    if (isErrorLogged(err)) {
        const kind = err.details && err.details.reason ? err.details.reason : (err.name || 'error');
        return `${kind}; its text is in the [Agent API Error] line above`;
    }
    const text = String(err && err.message ? err.message : err);
    return text.length > PROBE_ERROR_LOG_MAX_CHARS
        ? text.slice(0, PROBE_ERROR_LOG_MAX_CHARS) + PROBE_ERROR_TRUNCATION_MARKER
        : text;
}

/** True for an AgentDispatchError whose reason shows the agent ran a turn. */
function isMaxTurnsExhausted(err) {
    return !!(err && err.details && err.details.reason === 'max_turns_exhausted');
}

/** The default injected sleep: a non-blocking timer that keeps the event loop
 * (and the viewer's /state endpoint) responsive while the sprint is paused.
 * An optional AbortSignal cancels it: the timer is cleared and the promise
 * resolves at once, so a wait cut short leaves no pending timer behind. */
function defaultSleep(ms, { signal } = {}) {
    return new Promise((resolve) => {
        if (signal && signal.aborted) { resolve(); return; }
        const onAbort = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

/** The pause-end promise of a requestPause() return value, or null when the
 * caller's requestPause returns no handle (older engines, test mocks). */
function pauseEndedOf(handle) {
    const ended = handle && handle.ended;
    return ended && typeof ended.then === 'function' ? ended : null;
}

/**
 * Waits `waitMs` on the injected sleep, racing it against an operator RESUME
 * of the pause (the pause-end handle settling with outcome 'resume'). Resolves
 * { wake: 'timer' }, { wake: 'resume', reason } or { wake: 'stop', reason }.
 * A stop (also one already in effect when the wait starts) ends the wait at
 * once so the caller can unwind with a CancelledError.
 */
async function waitOrOperatorResume(sleep, waitMs, ended) {
    if (!ended) {
        await sleep(waitMs);
        return { wake: 'timer', pauseEnd: null };
    }
    const box = { pauseEnd: null };
    const cancel = new AbortController();
    const resumed = ended.then((end) => {
        box.pauseEnd = end || null;
        return end && (end.outcome === 'resume' || end.outcome === 'stop') ? end : new Promise(() => {});
    });
    const timer = Promise.resolve(sleep(waitMs, { signal: cancel.signal })).then(() => null);
    const winner = await Promise.race([resumed, timer]);
    // Clear a still-pending default timer: nothing may keep the process alive
    // once the wait is over.
    cancel.abort();
    if (winner) return { wake: winner.outcome === 'stop' ? 'stop' : 'resume', reason: winner.reason, pauseEnd: box.pauseEnd };
    return { wake: 'timer', pauseEnd: box.pauseEnd };
}

/**
 * Builds the ctx.onUsageLimit controller dispatch-role.mjs arms when a role's
 * retry.usageLimitPause is set.
 *
 * @param {object} deps
 * @param {(reason: string, opts?: { resumeAt?: string, source?: string }) => any} deps.requestPause
 *   engine cooperative-pause primitive (script-facing, apra-fleet-hzeb.3): pausing
 *   releases member reservations, the watchdog reads PAUSED, and the dashboard
 *   shows the expected resume time. It may return (or resolve to) a pause-end
 *   handle `{ ended: Promise<{ outcome: 'resume'|'stop', reason }> }`: an
 *   operator resume settling it ends the wait at once and goes straight to
 *   the probe. Returning nothing keeps the plain timed wait.
 * @param {(reason: string) => Promise<void>} deps.requestResume
 *   engine resume primitive; its pre-resume hook re-reserves + resyncs the
 *   member as a HARD BARRIER before the probe dispatch runs.
 * @param {(prompt: string, opts: object) => Promise<any>} deps.agent the
 *   runner's dispatch function, used for the one real re-probe dispatch.
 * @param {(msg: string) => void} [deps.log]
 * @param {object} [deps.budgets] usage-limit budgets (USAGE_LIMIT_MAX_WAIT_S,
 *   USAGE_LIMIT_MAX_REPROBES, USAGE_LIMIT_MIN_WAIT_S,
 *   USAGE_LIMIT_REPROBE_BACKOFF_MS); each falls back to
 *   USAGE_LIMIT_BUDGET_DEFAULTS.
 * @param {() => number} [deps.now] injected epoch-ms clock (default Date.now).
 * @param {(ms: number, opts?: { signal?: AbortSignal }) => Promise<void>} [deps.sleep]
 *   injected timer (default a real non-blocking setTimeout that the optional
 *   signal cancels).
 * @returns {(args: { member: string, roleLabel: string, signal: object|null,
 *   sessionId?: string|null, tier?: string }) =>
 *   Promise<{ resumed: true } | { resumed: false, error: Error }>}
 */
export function createUsageLimitPauseController({
    requestPause,
    requestResume,
    agent,
    log = () => {},
    budgets = {},
    now = () => Date.now(),
    sleep = defaultSleep,
} = {}) {
    const maxWaitS = budgets.USAGE_LIMIT_MAX_WAIT_S ?? USAGE_LIMIT_BUDGET_DEFAULTS.USAGE_LIMIT_MAX_WAIT_S;
    const maxReprobes = budgets.USAGE_LIMIT_MAX_REPROBES ?? USAGE_LIMIT_BUDGET_DEFAULTS.USAGE_LIMIT_MAX_REPROBES;
    const minWaitS = budgets.USAGE_LIMIT_MIN_WAIT_S ?? USAGE_LIMIT_BUDGET_DEFAULTS.USAGE_LIMIT_MIN_WAIT_S;
    const backoffLadder = budgets.USAGE_LIMIT_REPROBE_BACKOFF_MS ?? USAGE_LIMIT_BUDGET_DEFAULTS.USAGE_LIMIT_REPROBE_BACKOFF_MS;
    const maxWaitMs = maxWaitS * 1000;
    const minWaitMs = minWaitS * 1000;

    // `sessionId` (the session that hit the limit) is part of the caller's
    // payload but deliberately unused here: the probe is a FRESH dispatch
    // (resume:false), so it never resumes the limited session. It is left off
    // the destructure rather than bound-and-ignored to keep the linter quiet.
    return async function onUsageLimit({ member, roleLabel, signal, tier } = {}) {
        const firstHitAt = now();
        // The signal that drives THIS pause: the failing dispatch's signal
        // first, then whatever fresh signal each reprobe reports (or null,
        // which drops onto the backoff ladder).
        let currentSignal = signal || null;
        let reprobes = 0;
        let waitedMs = 0;
        let lastResumeAt = currentSignal && currentSignal.resumeAt ? currentSignal.resumeAt : null;

        const exhausted = () => new UsageLimitWaitExhaustedError(
            `Usage limit on member ${member} (${roleLabel}) did not clear within the allowed ` +
            `wait budget (${maxWaitS}s / ${maxReprobes} reprobes)` +
            (lastResumeAt ? `; last reported resume time was ${lastResumeAt}.` : '.'),
            {
                member,
                roleLabel,
                firstHitAt,
                lastResumeAt: lastResumeAt ? new Date(lastResumeAt).getTime() : null,
                reprobes,
                waitedMs,
            }
        );

        for (;;) {
            const remainingMs = maxWaitMs - waitedMs;
            if (remainingMs <= 0) return { resumed: false, error: exhausted() };

            // Wait for THIS pause. Trust the provider's own resumeAt when it
            // gave one (parsed or guessed -- either way it is the signal's, not
            // ours); otherwise step the reprobe backoff ladder. NEVER a
            // hard-coded window here.
            let targetMs;
            let source;
            if (currentSignal && currentSignal.resumeAt) {
                targetMs = new Date(currentSignal.resumeAt).getTime() - now();
                source = currentSignal.resumeAtSource || 'parsed';
                lastResumeAt = currentSignal.resumeAt;
            } else {
                targetMs = backoffLadder[Math.min(reprobes, backoffLadder.length - 1)];
                source = 'backoff';
            }
            // Clamp: never below the floor, never past the remaining budget.
            const waitMs = Math.min(Math.max(targetMs, minWaitMs), remainingMs);

            log(
                `usage limit on member ${member} (${roleLabel}): source=${source}` +
                (lastResumeAt ? `, resumeAt=${lastResumeAt}` : '') +
                `, pausing ~${Math.round(waitMs / 1000)}s (reprobe ${reprobes}/${maxReprobes}).`
            );

            // Pause the whole run through the engine primitive. dispatch-role.mjs
            // guarantees this runs OUTSIDE any git-sync bracket, so the
            // clean-state pause guard engages the pause here rather than
            // deferring it forever.
            const pauseHandle = await requestPause(
                `usage limit on member ${member} (${roleLabel})`,
                { ...(lastResumeAt ? { resumeAt: lastResumeAt } : {}), source: 'usage_limit' }
            );
            // Sleep on the injected timer (never a blocking loop), raced
            // against an operator resume of this pause when requestPause
            // returned a pause-end handle. A cooperative stop taken here
            // surfaces on the next resume/probe below and is propagated, never
            // swallowed.
            const waitStartedAt = now();
            const waited = await waitOrOperatorResume(sleep, waitMs, pauseEndedOf(pauseHandle));
            if (waited.wake === 'stop') {
                // The run was stopped during (or before) the wait: no resume,
                // no probe, no new pause -- unwind like any operator stop.
                log(
                    `usage limit wait on member ${member} (${roleLabel}) ended by a stop` +
                    (waited.reason ? ` (${waited.reason})` : '') + ' -- cancelling.'
                );
                throw new CancelledError(
                    `[Workflow Error] ${waited.reason || 'run stopped during the usage-limit wait'}`
                );
            }
            if (waited.wake === 'resume') {
                // The operator resumed the run during the wait: the cause may
                // be fixed, so probe now instead of sleeping on to the
                // provider's resume time. The operator's resume already ran
                // the pre-resume hook (re-reserve + resync), so no own
                // requestResume here. The probe still decides: one that still
                // sees the usage limit re-enters this loop.
                waitedMs += Math.min(Math.max(now() - waitStartedAt, 0), waitMs);
                log(
                    `usage limit wait on member ${member} (${roleLabel}) woken by operator resume` +
                    (waited.reason ? ` (${waited.reason})` : '') + ' -- probing now.'
                );
            } else {
                waitedMs += waitMs;
                // Resume: the engine's pre-resume hook re-reserves + resyncs the
                // member (a MemberReservationResumeError propagates as today).
                await requestResume(`usage limit wait elapsed on member ${member} (${roleLabel})`);
            }

            // Probe before trusting the clock: one real dispatch to the same
            // member at the same tier.
            try {
                // Deliberately NOT strict (no fail_on_permission_denial): the
                // probe only tests whether the member answers at all after a
                // usage-limit wait, it runs no tools, and a permission refusal
                // there says nothing about the usage limit. A refusal must not
                // be read as a usage limit (isUsageLimitDispatchError matches
                // only the usage_limit reason) nor abort the wait: any such
                // outcome falls through to the inconclusive-probe handling below.
                const probeModel = createModelReporter();
                const logProbeModel = (err) => log(`${roleLabel}: usage-limit re-probe on member '${member}' -- requested tier ${tier ?? 'none'}, ${probeModel.describe(err)}`);
                await agent(PROBE_PROMPT, {
                    member_name: member,
                    onModelId: probeModel.onModelId,
                    ...(tier ? { model: tier } : {}),
                    max_turns: 1,
                    resume: false,
                    timeout_s: PROBE_TIMEOUT_S,
                    label: `usage-limit re-probe: ${member}`,
                }).then(
                    (v) => { logProbeModel(); return v; },
                    (e) => { logProbeModel(e); throw e; },
                );
                // Probe succeeded -- the member is usable again.
                return { resumed: true };
            } catch (probeErr) {
                // A cooperative stop (requestStop -> CancelledError) taken
                // during the pause is NOT a probe failure: propagate it so an
                // operator stop still tears the run down mid-pause. Never
                // swallowed by the inconclusive-probe path below.
                if (probeErr instanceof CancelledError) throw probeErr;
                // The model answered but called a tool (turn cap hit): the
                // provider accepted a turn, so the limit is lifted.
                if (isMaxTurnsExhausted(probeErr)) {
                    log(
                        `usage limit re-probe for member ${member} (${roleLabel}) proved the limit lifted ` +
                        `(max_turns_exhausted) -- proceeding to re-dispatch.`
                    );
                    return { resumed: true };
                }
                if (isUsageLimitDispatchError(probeErr)) {
                    reprobes += 1;
                    // Prefer the probe's OWN fresh signal (a new parsed
                    // resumeAt); absent one, the next pass drops onto the
                    // backoff ladder.
                    currentSignal = usageLimitOf(probeErr) || null;
                    if (reprobes > maxReprobes || waitedMs >= maxWaitMs) {
                        return { resumed: false, error: exhausted() };
                    }
                    continue;
                }
                // Any OTHER probe outcome (a transient busy/transport error) is
                // inconclusive: log it and let the real re-dispatch be the final
                // test rather than burning a reprobe on an unrelated fault.
                log(
                    `usage limit re-probe for member ${member} (${roleLabel}) was inconclusive ` +
                    `(${boundedProbeError(probeErr)}) -- proceeding to re-dispatch.`
                );
                return { resumed: true };
            }
        }
    };
}
