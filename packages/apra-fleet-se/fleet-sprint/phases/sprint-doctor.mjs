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
