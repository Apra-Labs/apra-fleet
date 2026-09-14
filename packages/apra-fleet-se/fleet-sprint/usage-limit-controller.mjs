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
import { CancelledError } from '@apralabs/apra-fleet-workflow';
import { isUsageLimitDispatchError, usageLimitOf, UsageLimitWaitExhaustedError } from './errors.mjs';
import { USAGE_LIMIT_BUDGET_DEFAULTS } from './role-policies.mjs';

// A minimal, target-agnostic probe. Its ONLY purpose is to observe whether the
// member still trips the usage limit, so it is the shortest possible real
// dispatch: one turn, a one-line generic prompt (no target-repo assumptions,
// no bead ids -- check-generic-boundary.mjs), a fresh session, a short timeout.
const PROBE_PROMPT = 'Reply with the single word: ok.';
const PROBE_TIMEOUT_S = 60;

/** The default injected sleep: a non-blocking timer that keeps the event loop
 * (and the viewer's /state endpoint) responsive while the sprint is paused. */
function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds the ctx.onUsageLimit controller dispatch-role.mjs arms when a role's
 * retry.usageLimitPause is set.
 *
 * @param {object} deps
 * @param {(reason: string, opts?: { resumeAt?: string, source?: string }) => (void|Promise<void>)} deps.requestPause
 *   engine cooperative-pause primitive (script-facing, apra-fleet-hzeb.3): pausing
 *   releases member reservations, the watchdog reads PAUSED, and the dashboard
 *   shows the expected resume time.
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
 * @param {(ms: number) => Promise<void>} [deps.sleep] injected timer (default a
 *   real non-blocking setTimeout).
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
            await requestPause(
                `usage limit on member ${member} (${roleLabel})`,
                { ...(lastResumeAt ? { resumeAt: lastResumeAt } : {}), source: 'usage_limit' }
            );
            // Sleep on the injected timer (never a blocking loop). A cooperative
            // stop taken here surfaces on the next resume/probe below and is
            // propagated, never swallowed.
            await sleep(waitMs);
            waitedMs += waitMs;
            // Resume: the engine's pre-resume hook re-reserves + resyncs the
            // member (a MemberReservationResumeError propagates as today).
            await requestResume(`usage limit wait elapsed on member ${member} (${roleLabel})`);

            // Probe before trusting the clock: one real dispatch to the same
            // member at the same tier.
            try {
                await agent(PROBE_PROMPT, {
                    member_name: member,
                    ...(tier ? { model: tier } : {}),
                    max_turns: 1,
                    resume: false,
                    timeout_s: PROBE_TIMEOUT_S,
                    label: `usage-limit re-probe: ${member}`,
                });
                // Probe succeeded -- the member is usable again.
                return { resumed: true };
            } catch (probeErr) {
                // A cooperative stop (requestStop -> CancelledError) taken
                // during the pause is NOT a probe failure: propagate it so an
                // operator stop still tears the run down mid-pause. Never
                // swallowed by the inconclusive-probe path below.
                if (probeErr instanceof CancelledError) throw probeErr;
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
                    `(${probeErr && probeErr.message ? probeErr.message : probeErr}) -- proceeding to re-dispatch.`
                );
                return { resumed: true };
            }
        }
    };
}
