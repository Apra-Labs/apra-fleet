// =============================================================================
// Auto-sprint supervisor -- shared ISO-timestamp log prefix (apra-fleet-k7b.2)
// =============================================================================
//
// The 2026-07-30 incident forensics had to recover crash times from
// `detectedAt` fields inside state files because supervisor-serve.log lines
// (watchdog/proxy/reconcile/readopt) carried none of their own -- there was
// no way to answer "when did this log line happen" without cross-referencing
// a different file. This module is the ONE shared wrapper every one of those
// four log sites uses, so every future log line an operator greps for in
// supervisor-serve.log already carries a timestamp, with no risk of the four
// call sites drifting into four slightly different formats.
//
// Deliberately a PREFIX, not a reformat: existing tests/operators grep for
// substrings like '[watchdog]' / '[reconcile]' / '[proxy]' / '[readopt]' in
// log output; prepending the ISO stamp before the existing tag preserves
// every one of those substring matches instead of restructuring the line.
// =============================================================================

/**
 * Wrap a logger so every log/error/warn call is prefixed with an ISO-8601
 * timestamp, ahead of the caller's own message (which keeps its own
 * '[tag]' prefix intact for existing substring-matching tests/greps).
 * A method absent on the source logger (e.g. no `warn`) stays absent on the
 * wrapped logger too, matching every existing `logger.foo?.()` call site's
 * optional-chaining convention.
 *
 * @param {{ log?: Function, error?: Function, warn?: Function }} [logger]
 * @param {() => string} [now] injectable clock, for deterministic tests
 * @returns {{ log?: Function, error?: Function, warn?: Function }}
 */
export function withTimestamps(logger = console, now = () => new Date().toISOString()) {
    const wrap = (fn) => {
        if (typeof fn !== 'function') return undefined;
        return (...args) => {
            const [first, ...rest] = args;
            fn(`${now()} ${first}`, ...rest);
        };
    };
    // Deliberately no internal error->log / warn->log fallback here: every
    // existing call site already does its OWN `(logger.error ?? logger.log)`
    // fallback on whatever logger it was handed, so wrapping only the
    // methods actually present (and leaving the rest undefined) keeps that
    // fallback resolution happening exactly where it already did, just with
    // a timestamped function on the other end of it.
    return {
        log: wrap(logger.log ? logger.log.bind(logger) : undefined),
        error: wrap(logger.error ? logger.error.bind(logger) : undefined),
        warn: wrap(logger.warn ? logger.warn.bind(logger) : undefined),
    };
}
