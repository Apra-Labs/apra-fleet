// =============================================================================
// pr-not-opened.mjs -- derive the "PR not opened" marker for a finished sprint
// (branch pushed, PR skipped) from its persisted terminal state or its
// FINISHED history event. Additive and display-only: the verdict value and
// exit code are never read back or changed here.
//
// ASCII only.
// =============================================================================

const PR_SKIP_WARNING_RE = /PR not opened/i;

/**
 * @param {{ prSkipped?: {reason?: string, message?: string}|null, resultStatus?: string|null, warnings?: string[] }} src
 * @returns {{ reason: string }|null} null when the PR was opened (or nothing says it was skipped)
 */
export function derivePrNotOpened({ prSkipped, resultStatus, warnings } = {}) {
    if (prSkipped && typeof prSkipped === 'object') {
        const reason = typeof prSkipped.reason === 'string' && prSkipped.reason
            ? prSkipped.reason
            : (typeof prSkipped.message === 'string' && prSkipped.message ? prSkipped.message : 'unknown');
        return { reason };
    }
    if (resultStatus === 'success-with-warnings' && Array.isArray(warnings)) {
        const w = warnings.find((x) => typeof x === 'string' && PR_SKIP_WARNING_RE.test(x));
        if (w) {
            const m = /\(reason:\s*([^)]+)\)/.exec(w);
            return { reason: m ? m[1].trim() : w };
        }
    }
    return null;
}

/**
 * Verdict + marker from a persisted terminal run state (old_runs/<runId>.json).
 * @param {object|null|undefined} state
 * @returns {{ verdict: string|null, resultStatus: string|null, prNotOpened: {reason: string}|null }}
 */
export function terminalInfoFromState(state) {
    const res = state && typeof state === 'object' && state.result && typeof state.result === 'object' ? state.result : null;
    const verdict = (res && typeof res.verdict === 'string' ? res.verdict : null)
        ?? (state && state.extensions && state.extensions.terminal && typeof state.extensions.terminal.verdict === 'string' ? state.extensions.terminal.verdict : null);
    const resultStatus = res && typeof res.status === 'string' ? res.status : null;
    const warnings = res && Array.isArray(res.warnings) ? res.warnings : [];
    return { verdict, resultStatus, prNotOpened: derivePrNotOpened({ prSkipped: res ? res.prSkipped : null, resultStatus, warnings }) };
}

/**
 * Verdict + marker from a history FINISHED event.
 * @param {object|null|undefined} fin
 */
export function terminalInfoFromHistory(fin) {
    if (!fin || typeof fin !== 'object') return { verdict: null, resultStatus: null, prNotOpened: null };
    const resultStatus = typeof fin.resultStatus === 'string' ? fin.resultStatus : null;
    return {
        verdict: typeof fin.verdict === 'string' ? fin.verdict : null,
        resultStatus,
        prNotOpened: derivePrNotOpened({ prSkipped: fin.prSkipped, resultStatus, warnings: fin.warnings }),
    };
}
