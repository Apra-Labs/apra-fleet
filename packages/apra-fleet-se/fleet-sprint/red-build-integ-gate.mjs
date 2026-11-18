// =============================================================================
// RED BUILD -> NO INTEGRATION TEST, AND NEVER A PASS VERDICT.
//
// A reviewer verdict can report `buildFailing: true` (the project's build or
// test suite fails on the branch under review). Before this module the engine
// kept only `verdict.verdict` at the review boundary, so after the Develop/
// Review round cap the Integration Test phase still dispatched against the red
// branch, ran whatever subset of tests the tasks named, and could close
// verify-set beads on a branch the reviewer had just reported broken.
//
// The rule, engine-side only (no role prompt, schema or tool change):
//   1. `lastBuildFailing` is RUN-scoped and sticky: a review that genuinely ran
//      sets it from its verdict (`buildFailing === true`), a later review
//      reporting it not true clears it, and a cycle that ran no review (or
//      whose review round was degraded -- the reviewer never stood behind the
//      fabricated verdict) leaves it as it was.
//   2. While it is true the Integration Test phase is NOT dispatched that
//      cycle: the skip is logged and recorded in `integFailures`, so no bead
//      is closed by integ against a red branch.
//   3. A run whose Integration Test was skipped for a red build, and that
//      never subsequently ran Integration Test after a green review, can
//      never publish a PASS verdict: Final Review forces it to FAIL.
//
// Pure: no command() or agent() site. runner.js owns the state and the integ
// gate; phases/final-review.mjs applies the verdict gate.
// =============================================================================

/**
 * The next value of the run-scoped `lastBuildFailing` flag after a review
 * round. A degraded round (`dispatchFailed`, a verdict the engine fabricated
 * because the reviewer could not be dispatched) carries no build evidence, so
 * it leaves the flag unchanged.
 *
 * @param {boolean} prev
 * @param {{ buildFailing?: boolean, dispatchFailed?: boolean } | null | undefined} verdict
 * @returns {boolean}
 */
export function nextLastBuildFailing(prev, verdict) {
    if (!verdict || verdict.dispatchFailed === true) return Boolean(prev);
    return verdict.buildFailing === true;
}

/**
 * The log line / integFailures note recorded when Integration Test is skipped
 * for a cycle because the last review reported a red build.
 * @param {number} cycle
 * @returns {string}
 */
export function formatRedBuildIntegSkipReason(cycle) {
    return `Skipping Integration Test Phase C${cycle}: the last review reported the build/tests failing ` +
        '(buildFailing: true) and no later review has reported them passing -- Integration Test is not ' +
        'run against a red branch, and no bead is closed by it this cycle.';
}

/**
 * The integFailures entry recorded for a red-build integ skip.
 * @param {number} cycle
 * @returns {{ cycle: number, notes: string, bugsFiled: string[], redBuildSkip: true }}
 */
export function redBuildIntegSkipEntry(cycle) {
    return { cycle, notes: formatRedBuildIntegSkipReason(cycle), bugsFiled: [], redBuildSkip: true };
}

/**
 * The Final Review verdict reason for a run whose Integration Test was skipped
 * for a red build and never ran after a later green review.
 * @param {{ cycle: number }} skip The latest red-build integ skip.
 * @returns {string}
 */
export function formatRedBuildIntegSkipVerdictReason(skip) {
    return `Integration Test was skipped in C${skip.cycle} because the last review reported the build/tests ` +
        'failing, and no later review reported them passing with Integration Test then run -- the sprint ' +
        'was never integration-tested on a green build and cannot PASS.';
}

/**
 * Applies the red-build integ-skip gate to the Final Review verdict. Returns a
 * NEW verdict object (never mutates the dispatch result). With no outstanding
 * skip, returns the input unchanged. With one, the verdict is FAIL and the
 * notes start with the reason; an LLM PASS is overridden, an LLM FAIL keeps
 * its own notes after it.
 *
 * @param {object} verdictResult Final Review verdict ({verdict, notes, ...}).
 * @param {{ cycle: number } | null} skip The latest red-build integ skip not
 *   cleared by a later green review and Integration Test run, or null.
 * @returns {object}
 */
export function applyRedBuildIntegSkipVerdictGate(verdictResult, skip) {
    if (!skip) return verdictResult;
    const reason = formatRedBuildIntegSkipVerdictReason(skip);
    const prior = verdictResult && typeof verdictResult.notes === 'string' ? verdictResult.notes : '';
    const overridden = !verdictResult || verdictResult.verdict === 'PASS';
    return {
        ...(verdictResult || {}),
        verdict: 'FAIL',
        notes: reason +
            (overridden ? ' (Final Review returned PASS; the orchestrator overrode it to FAIL.)' : '') +
            (prior ? `\n\n${prior}` : ''),
    };
}
