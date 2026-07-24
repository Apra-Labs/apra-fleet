// apra-fleet-eft.9.6 (Plan 3.4 -- Dolt conflict recovery ladder, Tier 2).
//
// This module is the dolt counterpart of conflict-ladder.mjs's Tier 2
// (agent-with-runbook) git conflict escalation. Where conflict-ladder.mjs
// escalates when Tier 1's own git-porcelain check finds real unmerged paths,
// this module escalates a wedged dolt clone to a REAL agent dispatch ONLY
// when the two scripted recovery paths (Path A, apra-fleet-eft.9.4;
// Path B, apra-fleet-eft.9.5) have BOTH failed to close it:
//
//   - Path A's deterministic gate rejected the conflict shape (a multi-row
//     conflict, or a conflict outside the table allowlist), OR Path A hit a
//     genuine operational failure -- so Path B was attempted as the fallback;
//   - Path B ALSO failed: a scripted step (most commonly `bd bootstrap` or
//     the pending-mutation replay) returned output this ladder does not
//     recognize as one of its already-classified recoverable patterns.
//
// Script-first posture, never proceed blind: the whole point of this module
// is that neither Path A's gate rejection NOR an unrecognized Path B failure
// is ever silently swallowed or blindly retried. Both are recorded as a
// "wedged state" snapshot (clone path, conflict shape, last command output)
// BEFORE any further action, and Tier 2 is the escalation -- a real agent,
// armed with the runbook at auto-sprint/docs/dolt-tier2-runbook.md, is
// dispatched to resolve the clone with actual judgment. Exactly like the git
// Tier 2 (conflict-ladder.mjs), this module only DISPATCHES: it does not
// itself decide whether the agent's attempt succeeded -- that is the
// caller's job (mechanically re-observing `bd dolt status`/`bd dolt push`
// after dispatch, the same posture as runner.js's syncMemberAfter Tier 2
// re-verification).
// =============================================================================

/** Repo-relative path to the Tier 2 runbook doc this module's escalation
 *  prompt references. Kept as a constant so the reference cannot drift
 *  silently from the actual doc location. */
export const DEFAULT_TIER2_RUNBOOK_PATH = 'packages/apra-fleet-se/auto-sprint/docs/dolt-tier2-runbook.md';

/** Default embedded dolt data dir recorded in the wedged state when the
 *  caller does not supply a more specific `clonePath`. Mirrors
 *  dolt-recovery.mjs's DEFAULT_EMBEDDED_DATA_DIR. */
export const DEFAULT_CLONE_PATH = '.beads/embeddeddolt';

/**
 * Records the wedged state a Tier 2 dispatch is armed with: exactly the
 * three facts the runbook doc tells the dispatched agent to read first
 * (clone path, conflict shape, last command output), plus which ladder
 * stage produced it and when. Never partial -- every field is always
 * present (`null`/`'(unknown)'` rather than omitted) so a human/agent
 * reading it never has to guess whether a field was simply not collected.
 *
 * @param {{
 *   member: string,
 *   clonePath?: string,
 *   conflictShape?: object|null,
 *   lastOutput?: string|null,
 *   stage: string,
 *   now?: () => Date,
 * }} opts
 * @returns {{ member: string, clonePath: string, conflictShape: object|null, lastOutput: string, stage: string, recordedAt: string }}
 */
export function recordWedgedState(opts = {}) {
    const {
        member,
        clonePath = DEFAULT_CLONE_PATH,
        conflictShape = null,
        lastOutput = null,
        stage,
        now = () => new Date(),
    } = opts;
    if (!member) throw new Error('recordWedgedState requires a member in opts');
    if (!stage) throw new Error('recordWedgedState requires a stage in opts');
    return {
        member,
        clonePath,
        conflictShape,
        lastOutput: lastOutput == null ? '(no output captured)' : String(lastOutput),
        stage,
        recordedAt: now().toISOString(),
    };
}

/**
 * Builds the self-contained Tier 2 runbook prompt: the recorded wedged
 * state in full, plus a reference to the full runbook doc the dispatched
 * agent should follow step by step. ASCII-only per project convention.
 *
 * @param {{ member: string, wedgedState: object, runbookPath?: string }} opts
 * @returns {string}
 */
export function buildDoltTier2RunbookPrompt({ member, wedgedState, runbookPath = DEFAULT_TIER2_RUNBOOK_PATH }) {
    const shapeText = wedgedState && wedgedState.conflictShape
        ? JSON.stringify(wedgedState.conflictShape)
        : '(no gate result available -- Path A did not reach the conflict gate)';
    return [
        'DOLT CONFLICT RECOVERY RUNBOOK (Tier 2 of the dolt sync recovery ladder).',
        '',
        `The scripted recovery ladder (Path A resolve-in-place, Path B discard-and-` +
        `re-bootstrap) could not close a wedged beads clone for member '${member}'. ` +
        `Follow the full runbook at '${runbookPath}' EXACTLY, in order. Do not proceed ` +
        'past any output you do not recognize -- record what you observed and report it ' +
        'rather than guessing.',
        '',
        'WEDGED STATE (recorded before this dispatch -- read this first):',
        `  - member: ${wedgedState.member}`,
        `  - clone path: ${wedgedState.clonePath}`,
        `  - conflict shape (last Path A gate result): ${shapeText}`,
        `  - last command output: ${wedgedState.lastOutput}`,
        `  - ladder stage that escalated: ${wedgedState.stage}`,
        `  - recorded at: ${wedgedState.recordedAt}`,
        '',
        `See '${runbookPath}' for the full step-by-step recovery procedure.`,
        '',
        'Do not run any beads-content `bd` command unrelated to this recovery (no',
        'closing/reopening beads) -- this is a pure dolt-clone-recovery dispatch, not a',
        'development streak.',
    ].join('\n');
}

/**
 * Tier 2: dispatches an agent, armed with the runbook above, to resolve a
 * wedged dolt clone neither Path A nor Path B could close. This function
 * only DISPATCHES -- it deliberately does not itself decide whether the
 * attempt succeeded; the caller re-verifies success mechanically afterwards
 * (a clean `bd dolt status` and a genuinely successful `bd dolt push`),
 * exactly like the git ladder's Tier 2 never trusts the agent's own claim.
 *
 * @param {{
 *   agent: Function, member: string, wedgedState: object,
 *   log?: Function, model?: string, runbookPath?: string,
 * }} opts
 * @returns {Promise<unknown>} whatever the injected agent() call resolves to
 */
export async function dispatchDoltTier2Escalation({ agent, member, wedgedState, log = () => {}, model, runbookPath = DEFAULT_TIER2_RUNBOOK_PATH }) {
    if (typeof agent !== 'function') {
        throw new Error('dispatchDoltTier2Escalation requires an injected agent() in opts');
    }
    log(`[Dolt] Tier 2: dispatching a dolt conflict recovery runbook to member '${member}' -- ` +
        `wedged state: stage='${wedgedState.stage}', clonePath='${wedgedState.clonePath}'.`);
    const prompt = buildDoltTier2RunbookPrompt({ member, wedgedState, runbookPath });
    return agent(prompt, {
        member_name: member,
        label: `Tier 2 dolt conflict recovery [${wedgedState.stage}]`,
        model,
        timeout_s: 1800,
        max_total_s: 1800,
    });
}

/**
 * Records the wedged state for an escalation and, if an agent() was
 * injected, dispatches Tier 2 with it. If no agent() was injected, the
 * escalation is still recorded and logged (never silently dropped) but
 * `dispatched` is false -- the caller (a test harness, or a scripted context
 * with no agent available) can decide what to do with an un-dispatched
 * escalation, but the wedged state itself is never lost.
 *
 * @param {{
 *   agent?: Function, member: string, clonePath?: string,
 *   conflictShape?: object|null, lastOutput?: string|null, stage: string,
 *   log?: Function, model?: string, runbookPath?: string,
 * }} opts
 * @returns {Promise<{ escalated: true, wedgedState: object, dispatched: boolean, dispatchResult?: unknown }>}
 */
export async function escalateDoltConflict(opts = {}) {
    const { agent, member, clonePath, conflictShape, lastOutput, stage, log = () => {}, model, runbookPath } = opts;
    const wedgedState = recordWedgedState({ member, clonePath, conflictShape, lastOutput, stage });
    log(`[Dolt] Tier 2 ESCALATION for member '${member}' at stage '${stage}': recording wedged state instead of proceeding blind -- ` +
        `clonePath='${wedgedState.clonePath}', lastOutput='${wedgedState.lastOutput}'.`);

    if (typeof agent !== 'function') {
        log(`[Dolt] Tier 2 escalation for member '${member}' recorded but NOT dispatched -- no agent() was injected. ` +
            `See ${runbookPath || DEFAULT_TIER2_RUNBOOK_PATH} for the runbook a real dispatch would receive.`);
        return { escalated: true, wedgedState, dispatched: false };
    }

    const dispatchResult = await dispatchDoltTier2Escalation({ agent, member, wedgedState, log, model, runbookPath });
    return { escalated: true, wedgedState, dispatched: true, dispatchResult };
}

/**
 * The full recovery ladder: Path A (primary, resolve-in-place) -> Path B
 * (fallback, discard-and-re-bootstrap) -> Tier 2 (agent escalation, this
 * module). `pathA`/`pathB` are injected as zero-argument callbacks (the
 * caller closes over whatever command()/sql()/spawnSqlServer/etc. options
 * each path needs -- see dolt-recovery.mjs / dolt-recovery-path-b.mjs) so
 * this orchestrator stays agnostic of their individual wiring and is simple
 * to unit test with mock callbacks.
 *
 * Never proceeds blind past an unrecognized outcome: if Path A does not
 * report `ok:true` (whether by a rejected gate or a thrown operational
 * error), Path B is attempted; if Path B ALSO does not report `ok:true`
 * (whether by a thrown operational error or an unrecognized scripted-step
 * output), this function escalates to Tier 2 rather than returning as if
 * recovery succeeded, or retrying either path again unbounded.
 *
 * @param {{
 *   member: string,
 *   pathA: () => Promise<{ ok: boolean, gate?: object, reason?: string }>,
 *   pathB: () => Promise<{ ok: boolean, reason?: string }>,
 *   agent?: Function,
 *   log?: Function,
 *   model?: string,
 *   clonePath?: string,
 *   runbookPath?: string,
 * }} opts
 * @returns {Promise<{ ok: boolean, tier: 'path-a'|'path-b'|'tier-2', result?: object, escalated?: boolean, escalation?: object }>}
 */
export async function recoverDoltConflict(opts = {}) {
    const { member, pathA, pathB, agent, log = () => {}, model, clonePath, runbookPath } = opts;
    if (!member) throw new Error('recoverDoltConflict requires a member in opts');
    if (typeof pathA !== 'function') throw new Error('recoverDoltConflict requires an injected pathA() in opts');
    if (typeof pathB !== 'function') throw new Error('recoverDoltConflict requires an injected pathB() in opts');

    let pathAResult = null;
    let pathAError = null;
    try {
        pathAResult = await pathA();
    } catch (err) {
        pathAError = err;
    }

    if (pathAResult && pathAResult.ok) {
        return { ok: true, tier: 'path-a', result: pathAResult };
    }

    const conflictShape = pathAResult && pathAResult.gate ? pathAResult.gate : null;
    const pathAReason = pathAError ? pathAError.message : (pathAResult ? pathAResult.reason : 'Path A returned no result');
    log(`[Dolt] Path A did not resolve the conflict for member '${member}' (${pathAReason}) -- falling back to Path B (discard-and-re-bootstrap).`);

    let pathBResult = null;
    let pathBError = null;
    try {
        pathBResult = await pathB();
    } catch (err) {
        pathBError = err;
    }

    if (pathBResult && pathBResult.ok) {
        return { ok: true, tier: 'path-b', result: pathBResult, pathAReason };
    }

    // Both Path A and Path B failed to close the clone -- this is exactly
    // the "gate failed or a scripted step returned unrecognized output"
    // case this module exists for. Never proceed blind: record the wedged
    // state and escalate to Tier 2.
    const pathBReason = pathBError ? pathBError.message : (pathBResult ? pathBResult.reason : 'Path B returned no result');
    const escalation = await escalateDoltConflict({
        agent, member, clonePath, conflictShape, lastOutput: pathBReason,
        stage: 'path-b-exhausted', log, model, runbookPath,
    });

    return { ok: false, tier: 'tier-2', escalated: true, escalation, pathAReason, pathBReason };
}
