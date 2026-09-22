// =============================================================================
// PHASE MODULE: Sprint Doctor (design:
// ../docs/escalate-to-llm-design.md sections 1.3 H2, 2.1, 2.2).
//
// The THIRTEENTH phase() boundary, and the only one that does not run on a
// healthy sprint. It is H2 -- the consult point -- and it exists at exactly
// one place in the cycle: inside Cycle Evaluation, immediately after the
// fresh closed-bead read and the progress-score/high-water update, which is
// the one serialized, fresh-state moment per cycle. It runs under its own
// phase() label so a consult is dashboard-visible for free, exactly like
// every other step, rather than happening invisibly inside another phase.
//
// WHY IT IS A PHASE MODULE AT ALL. runSprintCycle builds NO phase() label of
// its own (pinned by test/phase-sequence-order.test.mjs): every phase body
// lives in phases/*. A consult is a phase body -- it dispatches, it logs, it
// has a label -- so it belongs here with the other twelve, not inlined back
// into the cycle loop the decomposition emptied.
//
// WHAT THIS PHASE MAY AND MAY NOT DO. It may ASK. It may not ACT. The whole
// point of the doctor's decision architecture is that the doctor decides and
// the orchestrator does; this module is the asking half, so it assembles
// evidence, dispatches, validates and LOGS a verdict -- and changes nothing.
// It touches no bead, no progress counter, no stall counter and no existing
// outcome, and it cannot throw: doctor.consult() returns null on every
// failure path, so a caller that ignores the result behaves exactly as it did
// before the doctor existed. Executing a verdict's action through the
// runner's own verbs is the executor lane's job, deliberately separate.
//
// WHERE THIS PHASE STARTS AND STOPS. It starts at its own phase() call and
// ends when doctor.consult() returns. The `if (doctor.enabled)` test and the
// trigger EVALUATION that produces its input stay in runner.js's Cycle
// Evaluation, exactly as ./deploy.mjs's `if (hasDeploy)` probe and
// ./re-review.mjs's `if (openAtGoal.length === 0 ...)` branch condition
// stayed behind: those are built from Cycle Evaluation's own freshly-read
// counters and belong to it.
//
// GENERIC BY CONSTRUCTION (see ../../docs/generic-engine-boundary.md): every
// value below arrives from the caller. Nothing here names a target project,
// its repo layout, its tracker prefix or its build commands.
// =============================================================================

// Used by runBlockedReplanPhase at the bottom of this file -- the re-plan
// lane's action executor, the only doctor module that mutates anything.
import { applyReplanVerdict, isReplanAction, REPLAN_ACTION_KINDS } from '../doctor-executor.mjs';

/**
 * Runs ONE sprint-doctor consult for the highest-priority pending trigger.
 *
 * AT MOST ONE CONSULT PER CYCLE EVALUATION, even when several triggers fire
 * together: a cycle that trips T2, T3 and T4 at once is one sick sprint
 * described three ways, not three separate questions worth three premium
 * dispatches -- and the per-sprint consult cap would be spent inside a single
 * cycle if every fire got its own. The first descriptor wins, and
 * evaluateTriggers() returns them in T1..T5 order, i.e. most specific first.
 *
 * @param {{
 *   phase: Function, log: Function, agent: Function, command: Function,
 *   callTool?: Function,
 *   doctor: { consult: Function },
 *   pendingConsults: Array<object>,
 *   cycle: number,
 *   position: object,
 *   openAtGoal: Array<{ id: string, status?: string }>,
 *   closedCount: number,
 *   goalMax: unknown,
 *   consultMember: string|undefined,
 *   orchestratorMember: string|undefined,
 *   sprintLogText: string,
 *   registry?: object[],
 *   maxBeadDetails?: number,
 * }} state
 * @returns {Promise<object|null>} the verdict, or null on any failure/skip
 */
export async function runSprintDoctorPhase(state) {
    const {
        phase, doctor, pendingConsults, cycle, position,
        openAtGoal, closedCount, goalMax,
        agent, command, callTool,
        consultMember, orchestratorMember,
        sprintLogText, registry = [], maxBeadDetails = 10,
    } = state;

    const pending = (pendingConsults || [])[0];
    if (!pending) return null;

    phase(`Sprint Doctor C${cycle}`);

    // Scope summary counts, computed from the read Cycle Evaluation ALREADY
    // did -- this phase issues no beads command of its own, so a consult adds
    // no query load on top of the dispatch it is already paying for.
    const openAtGoalByStatus = {};
    for (const bead of openAtGoal) {
        const status = bead.status || 'unknown';
        openAtGoalByStatus[status] = (openAtGoalByStatus[status] || 0) + 1;
    }

    // Which beads get FULL detail. A bead-scoped trigger names its own; a
    // sprint-scoped one (stagnation, spend) has no single culprit, so the
    // still-open-at-goal beads are the population the verdict would act on --
    // bounded, because a 300-bead sprint must not grow the prompt by 300
    // bead records.
    const detailIds = new Set([
        ...(pending.beadIds || []),
        ...(pending.scope === 'sprint' ? openAtGoal.slice(0, maxBeadDetails).map((b) => b.id) : []),
    ]);

    return doctor.consult(pending, {
        agent,
        command,
        callTool,
        consultMember,
        orchestratorMember,
        position: { ...position, phaseLabel: `Sprint Doctor C${cycle}` },
        beadDetails: openAtGoal.filter((b) => detailIds.has(b.id)),
        scopeSummary: { goalPriorityMax: goalMax, openAtGoalByStatus, closedInScope: closedCount },
        // A sprint-scoped trigger still has to satisfy the role's input
        // contract, which requires at least one bead in scope; the beads that
        // are actually still open at goal priority are the honest answer.
        fallbackBeadIds: openAtGoal.map((b) => b.id),
        sprintLogText,
        registry,
        label: `Sprint Doctor C${cycle}`,
    });
}

// =============================================================================
// PHASE MODULE: Sprint Doctor Re-plan (design: ../docs/escalate-to-llm-
// design.md sections 2.1 and 2.5).
//
// THE SECOND doctor phase body, and the FIRST one that is allowed to act.
// runSprintDoctorPhase above may only ASK; this one asks and then APPLIES,
// because the incident it answers is different in kind.
//
// A doer that reports BLOCKED has finished its turn and is stating it cannot
// do the work from its seat. Nothing the observation lane can do helps: a
// retry re-runs the same refusal, a re-lane runs it on another member, and
// leaving the bead in the ready pool re-dispatches it unchanged until the
// sprint stalls. The only answer is to change the BEAD -- so this phase is
// deliberately not strictly-additive, and its acting half is confined to the
// executor's table of existing verbs.
//
// WHAT IT STILL MAY NOT DO. It does not edit a bead itself: it dispatches the
// zero-tool doctor, receives a schema-validated payload, and hands that to
// doctor-executor.mjs, which is the single actor. It runs at most ONE consult
// per bead per cycle (the caller's own per-cycle set), it re-dispatches a
// bead only when the executor reports its content actually changed, and every
// failure -- no verdict, a non-re-plan action, a refused application -- leaves
// the bead exactly as excluded as it already was.
// =============================================================================


/**
 * Consults the doctor about ONE bead a doer reported BLOCKED on, then applies
 * the verdict through existing verbs.
 *
 * @param {{
 *   phase: Function, log: Function, agent: Function, command: Function,
 *   callTool?: Function,
 *   doctor: { consult: Function },
 *   pending: object,
 *   beadId: string,
 *   blockedReason: string,
 *   cycle: number|string,
 *   roundLabel?: string,
 *   position: object,
 *   beadDetails?: object[],
 *   scopeSummary?: object,
 *   consultMember: string|undefined,
 *   orchestratorMember: string|undefined,
 *   sprintLogText: string,
 *   registry?: object[],
 *   stageBody?: Function,
 *   createChild?: Function,
 *   provisionGrant?: Function,
 * }} state
 * @returns {Promise<object|null>} the executor result, or null when no re-plan
 *   was produced (in which case the caller changes nothing)
 */
export async function runBlockedReplanPhase(state) {
    const {
        phase, log, doctor, pending, beadId, blockedReason, cycle, roundLabel,
        position, beadDetails, scopeSummary,
        agent, command, callTool, consultMember, orchestratorMember,
        sprintLogText, registry = [],
        stageBody, createChild, provisionGrant,
    } = state;

    const label = `Sprint Doctor Re-plan C${cycle}${roundLabel ? ` ${roundLabel}` : ''}`;
    phase(label);

    const verdict = await doctor.consult(pending, {
        agent,
        command,
        callTool,
        consultMember,
        orchestratorMember,
        position: { ...position, phaseLabel: label },
        beadDetails: beadDetails || [],
        scopeSummary,
        fallbackBeadIds: [beadId],
        sprintLogText,
        registry,
        label,
        // The one field that makes this a re-plan rather than an incident
        // consult (see doctor-consult.mjs's buildReplanConsultInput).
        replan: { beadId, blockedReason },
    });

    // Every consult failure path already logged its own reason and returned
    // null. Nothing changes here: the bead stays excluded from re-lane, which
    // is exactly the behaviour the BLOCKED capture lane established.
    if (!verdict) return null;

    if (!isReplanAction(verdict.action && verdict.action.kind)) {
        log(
            `[sprint-doctor] re-plan consult for ${beadId} returned action `
            + `'${(verdict.action && verdict.action.kind) || 'none'}', which is not one of the re-plan kinds `
            + `[${REPLAN_ACTION_KINDS.join(', ')}]. Nothing is applied and the bead stays excluded from re-lane.`
        );
        return null;
    }

    return applyReplanVerdict(verdict, {
        command,
        member: orchestratorMember,
        log,
        cycle,
        beadIds: [beadId],
        stageBody,
        createChild,
        provisionGrant,
    });
}
