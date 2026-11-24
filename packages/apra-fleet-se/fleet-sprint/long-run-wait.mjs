// The engine-stated bounded wait for long-running commands (apra-fleet-sox2.1).
//
// WHY: role prompts used to tell a role to check a backgrounded long run "at
// least once a minute" so the dispatch inactivity watchdog would not mistake
// it for a hang. Every check is a full-context model turn, so a long suite
// polled per minute re-sent hundreds of thousands of tokens per check. The
// watchdog's real budget is the dispatch's timeout_s (the inactivity budget,
// normally 30 minutes), so a per-minute cadence was far tighter than needed.
//
// DESIGN DECISION: a role may block in ONE tool call for up to a wait limit W
// the engine states in the dispatched prompt, derived from the SAME value the
// engine passes as that dispatch's timeout_s. W is strictly below the
// inactivity budget (so a real hang is still caught) and never above the
// host command tool's own per-call timeout cap minus a safety headroom. The alternative -- the engine
// running the suite itself and handing back the result -- does not fit the
// dispatch model: the engine never runs target commands on a member mid-
// dispatch, and which command is "the suite" is a role judgement (single
// test file, full run, playbook part), not something the engine knows.
//
// The role prompt .md files refer to "the engine-stated wait limit" and never
// hard-code a cadence, so prompt text and engine cannot drift.

/**
 * The largest per-call timeout a supported host's command tool accepts, in
 * seconds (10 minutes). A stated wait above this could not be honoured by one
 * tool call, so W never exceeds it.
 */
export const HOST_TOOL_CALL_CAP_S = 600;

/**
 * Headroom kept below the host cap: a wait that used the full cap would be
 * killed by the tool timeout (process start-up and the final print take
 * time), so the stated limit sits this far under it.
 */
export const HOST_TOOL_CALL_HEADROOM_S = 60;

/** The largest wait limit the engine ever states (540 s). */
export const MAX_WAIT_LIMIT_S = HOST_TOOL_CALL_CAP_S - HOST_TOOL_CALL_HEADROOM_S;

/**
 * The role personas whose role prompts carry the long-running-command wait
 * guidance, and so receive the engine-stated wait limit with every dispatch.
 */
export const LONG_RUN_WAIT_AGENT_TYPES = Object.freeze([
    'doer',
    'reviewer',
    'integ-test-runner',
    'regression-test-runner',
]);

/**
 * The wait limit W, in whole seconds, for a dispatch whose inactivity budget
 * (timeout_s) is `inactivityTimeoutS`: half the budget, capped at
 * MAX_WAIT_LIMIT_S (the host per-call cap less headroom). Always strictly below the budget, so one maximal wait
 * leaves at least half the budget for the turn that follows it.
 *
 * @param {number} inactivityTimeoutS
 * @returns {number}
 */
export function resolveLongRunWaitS(inactivityTimeoutS) {
    if (typeof inactivityTimeoutS !== 'number' || !Number.isFinite(inactivityTimeoutS) || inactivityTimeoutS <= 0) {
        throw new RangeError(`long-run-wait: inactivity budget must be a positive finite number of seconds, got ${JSON.stringify(inactivityTimeoutS)}.`);
    }
    return Math.min(MAX_WAIT_LIMIT_S, Math.floor(inactivityTimeoutS / 2));
}

/** True when `agentType` is a persona that is told the wait limit. */
export function receivesLongRunWait(agentType) {
    return typeof agentType === 'string' && LONG_RUN_WAIT_AGENT_TYPES.includes(agentType);
}

function minutes(seconds) {
    const m = Number((seconds / 60).toFixed(1));
    return `${m} minute${m === 1 ? '' : 's'}`;
}

/**
 * The block the engine appends to a dispatched prompt, stating the wait
 * limit and the inactivity budget it was derived from. Returns null when the
 * budget is too small to allow any wait (W < 1s): there is no honest limit to
 * state then.
 *
 * @param {number} inactivityTimeoutS
 * @returns {string|null}
 */
export function longRunWaitNotice(inactivityTimeoutS) {
    const waitS = resolveLongRunWaitS(inactivityTimeoutS);
    if (waitS < 1) return null;
    return [
        '## Engine-stated wait limit',
        '',
        `Inactivity budget for this dispatch: ${inactivityTimeoutS} seconds (${minutes(inactivityTimeoutS)}). `
            + 'A session that shows no activity for that long is treated as hung and stopped.',
        `Wait limit: ${waitS} seconds (${minutes(waitS)}). One tool call that waits on a long-running `
            + 'command (a blocking wait on a backgrounded job, or a read of its output with a wait) may block '
            + `for up to ${waitS} seconds. Use the full limit for each check rather than many short checks; `
            + 'see your role prompt\'s guidance on waiting for long-running commands.',
    ].join('\n');
}
