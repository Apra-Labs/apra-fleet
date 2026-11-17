// Per-role, per-cycle round-resume session registry for fleet-sprint
// (apra-fleet-3swo.6.15). Extracted out of runner.js; runner.js re-exports
// every symbol it previously exported from this region, so existing
// importers of fleet-sprint/runner.js resolve unchanged.
//
// This module owns:
//   - DEFAULT_CONTEXT_CEILING: the estimated-token ceiling above which a
//     resumed session is treated as near its context window.
//   - createRoundSessionRegistry: the registry itself, driving "round
//     resume" -- within ONE sprint cycle's approval loop a role (planner,
//     reviewer, ...) resumes its OWN prior-round session by explicit session
//     id, so a re-plan / re-review keeps the context it already built.

// Ceiling, in estimated tokens, above which a resumed session is treated as
// near its context window (see createRoundSessionRegistry).
export const DEFAULT_CONTEXT_CEILING = 150000;

/**
 * Per-role, per-cycle session registry driving "round resume": within ONE
 * sprint cycle's approval loop a role (planner, reviewer, ...) resumes its OWN
 * prior-round session by explicit session id, so a re-plan / re-review keeps
 * the context it already built. The session id comes from agent()'s
 * onSessionId callback (packages/apra-fleet-workflow).
 *
 * Guards, all enforced here so the call sites stay tiny:
 *   - NEVER resume across cycles (fresh eyes): an entry is keyed to the cycle
 *     it was recorded in; asking for another cycle yields a fresh session.
 *   - A failed/timed-out round resumes nothing: its call site invokes
 *     clear(role), so a broken partial context is never carried forward.
 *   - An entry whose recorded usage was at/above `ceilingFraction` of
 *     `contextCeiling` yields a fresh session, since resuming a session near
 *     its window limit starts the next round out of room. This only bites when
 *     the provider actually reported usage: with no usage number the entry is
 *     never flagged near-ceiling and resume proceeds.
 *   - Resume support is detected by CAPABILITY, not provider name: a provider
 *     that cannot resume returns no session id, record() stores nothing, and
 *     resumeArgFor() yields `false`. There is deliberately no
 *     `provider === 'claude'`-style name test anywhere.
 *
 * @param {{ log?: (msg: string) => void, contextCeiling?: number, ceilingFraction?: number }} [opts]
 */
export function createRoundSessionRegistry(opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    const contextCeiling = typeof opts.contextCeiling === 'number' && opts.contextCeiling > 0
        ? opts.contextCeiling
        : DEFAULT_CONTEXT_CEILING;
    const ceilingFraction = typeof opts.ceilingFraction === 'number' && opts.ceilingFraction > 0
        ? opts.ceilingFraction
        : 0.9;
    // role -> { cycle: number, sessionId: string, nearCeiling: boolean }
    const byRole = new Map();

    /**
     * Record the session id a dispatch of `role` returned during `cycle`.
     * A no-op for a missing/empty id (e.g. a provider that does not support
     * resume) so the next round stays fresh.
     */
    function record(role, cycle, sessionId, meta = {}) {
        if (!role || typeof sessionId !== 'string' || sessionId === '') {
            return;
        }
        const totalTokens = meta && meta.usage && typeof meta.usage.total_tokens === 'number'
            ? meta.usage.total_tokens
            : null;
        const nearCeiling = totalTokens !== null && totalTokens >= contextCeiling * ceilingFraction;
        byRole.set(role, { cycle, sessionId, nearCeiling });
        if (nearCeiling) {
            log(`[round-resume] ${role} session recorded near the context ceiling ` +
                `(~${totalTokens} tokens >= ${Math.round(contextCeiling * ceilingFraction)}); ` +
                `the next round in this cycle will start a FRESH session.`);
        }
    }

    /**
     * The `resume` argument the NEXT dispatch of `role` in `cycle` should carry:
     * the stored session id (a string) to resume that same session, or `false`
     * to start fresh. Fresh whenever there is no prior round, the prior round
     * was in a different cycle, the prior round ended near the context ceiling,
     * or no session id was ever captured (provider without resume support).
     */
    function resumeArgFor(role, cycle) {
        const entry = byRole.get(role);
        if (!entry) return false;                 // no prior round -> fresh (R1)
        if (entry.cycle !== cycle) return false;  // never resume across cycles
        if (entry.nearCeiling) return false;      // near context ceiling -> fresh
        if (!entry.sessionId) return false;       // no captured id -> fresh
        return entry.sessionId;                   // resume THAT session explicitly
    }

    /**
     * Drop any stored session for `role` so its next round starts fresh. Called
     * by a dispatch site when the just-run round failed/timed out -- resuming a
     * failed session would carry a broken/partial context forward.
     */
    function clear(role) {
        byRole.delete(role);
    }

    return { record, resumeArgFor, clear };
}
