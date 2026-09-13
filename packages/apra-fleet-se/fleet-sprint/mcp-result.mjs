// =============================================================================
// Shared MCP result-text helpers (apra-fleet-3swo.2.4).
//
// Extracted move-only from fleet-sprint/runner.js, which defined `resultText`
// TWICE as identical inner functions (inside createMemberReservationClient and
// createMemberSessionGuard) plus a separate module-level `toolErrorText`. This
// module is now the single owner of both; runner.js imports and re-exports
// them so its existing facade (67 direct importers) stays intact.
//
// Behavior is unchanged, including how an empty or missing MCP `content`
// array is handled: `resultText` returns '' in that case, which several
// runner.js call sites log with a `|| '(no detail)'` fallback that appears
// verbatim in golden transcripts -- do not change this without checking those
// fixtures.
//
// content[0] is NOT reliably the tool result: src/services/tool-registry.ts
// wrapTool() may prepend a user-audience onboarding/welcome-back display
// banner ahead of the real result (and append a nudge suffix banner after
// it). resultText skips any content entry that is such a banner --
// identified by annotations.audience containing 'user', or by its text
// containing an <apra-fleet-display> open tag as a belt-and-braces fallback
// -- and returns the first entry that is not one.
// =============================================================================

/**
 * True when a content entry is a user-audience display banner (onboarding
 * preamble or nudge suffix) rather than actual tool output.
 * @param {any} entry
 * @returns {boolean}
 */
function isDisplayBanner(entry) {
    if (!entry) return false;
    if (entry.annotations && Array.isArray(entry.annotations.audience) && entry.annotations.audience.includes('user')) {
        return true;
    }
    return typeof entry.text === 'string' && /<apra-fleet-display[^>]*>/i.test(entry.text);
}

/**
 * Best-effort human-readable text out of an MCP tool result's content array.
 * Accepts a raw string result too (some callers pass one through directly).
 * @param {any} result
 * @returns {string}
 */
export function resultText(result) {
    if (typeof result === 'string') return result;
    if (result && Array.isArray(result.content)) {
        for (const entry of result.content) {
            if (entry && typeof entry.text === 'string' && !isDisplayBanner(entry)) {
                return entry.text;
            }
        }
    }
    return '';
}

/**
 * Best-effort human-readable text out of an MCP error result, for logging.
 * @param {any} res
 * @returns {string}
 */
export function toolErrorText(res) {
    const first = res && Array.isArray(res.content) ? res.content[0] : null;
    return (first && typeof first.text === 'string' && first.text) || 'no error text returned';
}
