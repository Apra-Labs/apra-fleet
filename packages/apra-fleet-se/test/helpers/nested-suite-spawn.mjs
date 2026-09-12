// =============================================================================
// apra-fleet-3swo.53: shared nested-suite spawn-result handling, extracted out
// of phase1-leaf-facade-completeness.test.mjs and phase3-dispatch-engine-
// completeness.test.mjs. Both files spawn nested `node --test` children via
// execFileSync and need to turn the resulting spawnSync error (or lack
// thereof) into either a pass or a diagnosable failure that distinguishes an
// OUTER budget expiring (ETIMEDOUT) from an INNER child failure (non-zero
// exit) -- the distinction apra-fleet-80q3 exists because losing it once
// already caused a real inner failure to be misread as "the budget fix did
// not hold".
//
// Before this extraction, MAX_NESTED_SUITE_FAILURE_EXCERPT_CHARS and
// excerptChildOutput were byte-identical copies in both files (apra-fleet-
// 3swo.49 ported them from phase1 to phase3), and handleNestedSuiteSpawnResult
// differed only in cosmetic ways (quote style, whether the ETIMEDOUT
// remediation sentence named PHASE1_ or PHASE3_NESTED_SUITE_TIMEOUT_MS, and
// whether the budget source arrived as a parameter -- phase3's backend-aware
// resolveNestedSuiteTimeoutBudget() -- or was computed ad hoc from the env
// inside the function -- phase1's pre-refactor shape). Both files' tests then
// asserted the SAME marker strings ('did NOT expire', 'child stdout (tail):',
// 'truncated') and split on the same markers to isolate a "wrapper prefix",
// so a wording change made in one copy could silently desynchronize the
// other file's contract while leaving both suites green. This module is the
// single source of truth those two copies now both import.
// =============================================================================

/** Length cap on how much of a failing child's stdout/stderr is quoted into
 * the wrapped non-timeout error message, so a multi-megabyte nested suite
 * failure cannot flood the outer test report. The original, uncapped output
 * is still reachable via the thrown error's `.cause`. */
export const MAX_NESTED_SUITE_FAILURE_EXCERPT_CHARS = 4000;

/**
 * Returns a length-capped tail excerpt of a (possibly huge, possibly
 * undefined) child stdout/stderr string, annotated when truncated.
 */
export function excerptChildOutput(text) {
    if (!text) return '(empty)';
    if (text.length <= MAX_NESTED_SUITE_FAILURE_EXCERPT_CHARS) return text;
    return (
        `...[truncated, showing last ${MAX_NESTED_SUITE_FAILURE_EXCERPT_CHARS} of ${text.length} chars]...\n` +
        text.slice(-MAX_NESTED_SUITE_FAILURE_EXCERPT_CHARS)
    );
}

/**
 * Pure helper: turns a spawnSync error (or lack thereof) into either a pass
 * (returns void) or throws with a descriptive message.
 *
 * Node distinguishes a timeout from a genuine non-zero-exit failure at the
 * error-object level (verified directly, both by standalone repro and by the
 * adversarial case in each caller's own test suite): a timed-out spawnSync
 * sets `error.code === 'ETIMEDOUT'` with `error.status === null`, while a
 * plain non-zero exit leaves `code` undefined and sets `error.status` to the
 * exit code. Classification below is by `error.code` alone, never by
 * sniffing `error.message` -- a real timeout's message ('spawnSync ...
 * ETIMEDOUT') and a real failure's message ('Command failed: ...') never mix
 * in practice, but nothing about the shape of an Error object prevents a
 * caller from constructing that combination, so the classification itself
 * must not depend on message text.
 *
 * apra-fleet-80q3.1 (phase1) / apra-fleet-3swo.49 (phase3 port): an inner
 * child failure (non-timeout) used to be re-thrown BARE in both files, which
 * made it textually indistinguishable from the outer budget itself expiring
 * once the raw "spawnSync ... ETIMEDOUT"-shaped text reached a report. The
 * two cases are now textually distinguishable: the ETIMEDOUT branch always
 * names the budget and its source; the non-timeout branch instead names the
 * outer suite label, states explicitly that the outer budget did NOT expire,
 * and quotes the child's exit status plus a length-capped tail of its
 * stdout/stderr so the failing inner file is identifiable from the wrapped
 * message alone. The original spawn error (with its full, uncapped
 * stdout/stderr) is preserved as `.cause` on the thrown error, so no
 * information is lost -- only what reaches the message text is bounded.
 *
 * @param {string} suiteLabel - name of the nested suite (e.g., 'golden-transcript')
 * @param {Error|null} spawnError - error from execFileSync (or null on success)
 * @param {number} budgetMs - timeout budget in milliseconds
 * @param {string} budgetSource - human-readable description of where budgetMs came from
 * @param {string} envVarName - name of the env var a reader should raise if this run is genuinely this slow (e.g. 'PHASE1_NESTED_SUITE_TIMEOUT_MS')
 * @param {string} [extraTimeoutGuidance] - gate-specific sentence appended after the shared remediation sentence in the ETIMEDOUT message (e.g. phase1's bd+dolt-latency pointer). Omitted entirely when empty.
 * @throws {Error} if spawnError is truthy (wrapped ETIMEDOUT, or wrapped inner failure with cause)
 */
export function handleNestedSuiteSpawnResult(suiteLabel, spawnError, budgetMs, budgetSource, envVarName, extraTimeoutGuidance = '') {
    if (!spawnError) {
        // Success case: no error, nothing to throw
        return;
    }
    if (spawnError.code === 'ETIMEDOUT') {
        throw new Error(
            `nested suite '${suiteLabel}' exceeded its ${budgetMs}ms budget, from ${budgetSource}. ` +
            `Raise ${envVarName} if this run is genuinely this slow here.` +
            (extraTimeoutGuidance ? ` ${extraTimeoutGuidance}` : '')
        );
    }
    // Non-timeout failure: the failure is INSIDE the nested child, not the
    // outer budget expiring. Wrap it so that fact is stated explicitly,
    // keeping the original error reachable as `cause`.
    const status = spawnError.status === undefined || spawnError.status === null ? 'unknown' : spawnError.status;
    throw new Error(
        `nested suite '${suiteLabel}' failed, but its outer budget of ${budgetMs}ms (from ${budgetSource}) did NOT ` +
        `expire -- the failure is inside the nested child itself, not this gate's own timeout. child exit status: ` +
        `${status}. ` +
        `child stdout (tail):\n${excerptChildOutput(spawnError.stdout)}\n` +
        `child stderr (tail):\n${excerptChildOutput(spawnError.stderr)}`,
        { cause: spawnError },
    );
}
