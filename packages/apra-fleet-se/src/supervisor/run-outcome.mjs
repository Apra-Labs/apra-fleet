// =============================================================================
// Auto-sprint supervisor -- "did this run end badly?" classification
// (apra-fleet-i9ag.16.7)
// =============================================================================
//
// ONE answer to "should the operator be shown a failure and its reason for
// this run", shared by the two places that ask it:
//
//   * dashboard.mjs -- renderFinishedRunsHtml() (the Finished Sprints card)
//     and renderSprintSection() (the Sprint Stack row) decide whether to
//     render the run's ending reason. Both are also shipped to the browser as
//     inline script text via `.toString()` inside sprintStackLiveScript(), so
//     everything here is written in the same dependency-free, ES5-shaped,
//     `.toString()`-embeddable style those renderers are.
//   * launch-form.mjs -- classifyLaunchFollow() decides whether the launch
//     form's own green 'Launched sprint ...' line must be replaced by a
//     failure (apra-fleet-i9ag.16.7's third part).
//
// It lives in its own module rather than in dashboard.mjs because launch-form.mjs
// needs it too and dashboard.mjs already imports launch-form.mjs -- putting it
// there would make that a cycle.
//
// Before this module the Finished Sprints card's reason line was hard-gated on
// `run.status === 'launch-failed'` (dashboard.mjs), so a run that ended with
// any OTHER bad status rendered NO reason no matter what reason data it
// carried -- the ABORTED-with-no-reason card the final M1 acceptance run hit.
// =============================================================================

/**
 * Terminal VERDICT strings that mean the run ended badly. Deliberately the
 * same set as dashboard.mjs's VERDICT_BADGE_COLORS `var(--danger)` entries
 * (the badge already renders these red) -- kept as its own explicit list
 * rather than derived by matching that map's CSS-variable strings, which
 * would make a purely cosmetic theme edit silently change classification.
 *
 * ABORTED is in here because it is the verdict a sprint child's own
 * fatal-diagnostics guard records (fleet-sprint/fatal-diagnostics.mjs writes
 * `{ verdict: 'ABORTED', failed: true, terminalReason: <kind>, lastError }`
 * into its terminal state on an unhandledRejection/uncaughtException) -- the
 * exact case the M1 acceptance run saw rendered with no reason at all.
 */
export const FAILED_VERDICTS = Object.freeze(['FAIL', 'CHANGES_NEEDED', 'ABORTED']);

/**
 * Run STATUS strings that mean the run ended badly, independent of any
 * verdict. `launch-failed` and `crashed` are watchdog.mjs classifier statuses
 * (WATCHDOG_STATUS); `failed`/`aborted` are accepted too so a status that
 * reaches the render layer straight off a terminal state file (rather than
 * through the classifier) is not silently treated as a clean ending.
 *
 * `running-unresponsive` is deliberately NOT here: a wedged-but-live child is
 * an operator-attention signal, never a declared ending (see watchdog.mjs's
 * file-level invariants).
 */
export const FAILED_RUN_STATUSES = Object.freeze(['launch-failed', 'crashed', 'failed', 'aborted']);

/**
 * True when a run's (status, verdict) pair says it ended badly -- i.e. the
 * operator should be shown its ending reason.
 *
 * Case-insensitive on both axes: a status arrives lower-case from the
 * watchdog classifier, while a verdict arrives from a child process in
 * whatever case that child wrote it ('FAIL', 'needs-changes', ...).
 *
 * @param {string|null|undefined} status
 * @param {string|null|undefined} verdict
 * @returns {boolean}
 */
export function isFailedRunOutcome(status, verdict) {
    var s = typeof status === 'string' ? status.toLowerCase() : '';
    if (FAILED_RUN_STATUSES.indexOf(s) !== -1) return true;
    var v = typeof verdict === 'string' ? verdict.toUpperCase() : '';
    return v.length > 0 && FAILED_VERDICTS.indexOf(v) !== -1;
}
