// =============================================================================
// Verify-routed beads the cycle loop stops waiting for: the
// needs-external-evidence carry-over and the deferred-verify carry-over.
//
// A verify-routed bead (every child closed, awaiting Integration Test
// verification) only closes when the integ runner closes it. Two shapes used
// to hold the cycle loop's exit gate (runner.js stillOpenVerifyIds) forever,
// so the run spun to StalledSprintError and skipped Final Review, Regression,
// Harvest and Publish PR for the work it had closed:
//
//   1. NEEDS EXTERNAL EVIDENCE. The integ runner is dispatched with the bead,
//      leaves it open and files no gap bug under it -- its acceptance needs an
//      environment the sprint members do not have, so it can neither confirm
//      nor refute it. The engine counts this itself (it never trusts an
//      integ-reported "not checkable" field for the count): a cycle is
//      INCONCLUSIVE for a bead when the bead was dispatched to Integration
//      Test, is still open after it, and has no gap bug parented under it.
//      After NEEDS_EXTERNAL_EVIDENCE_CYCLE_LIMIT consecutive inconclusive
//      cycles the bead is carried over: it is not dispatched to verify again
//      and no longer holds the exit gate. It is NOT closed. A cycle in which
//      the bead closes or gets a gap bug resets its count. An integ dispatch
//      that failed for an infrastructure reason produced no verdict at all
//      and neither counts nor resets.
//   2. DEFERRED DURING THE RUN. A verify-routed bead deferred mid-run can
//      never be dispatched again, but the monotone verifyEverIds kept it in
//      the exit gate. It is dropped from the gate and named as a deferred
//      carry-over. Two sub-kinds:
//        - deferred-bounce-cap: the engine's own verify bounce cap deferred
//          it after it kept failing verification (phases/integ-test.mjs,
//          recorded via markBounceCapDeferral).
//        - deferred: deferred by someone else (a human or LLM scope
//          decision), picked up by syncDeferredVerifyIds.
//
// All kinds are named in the verdict notes (and so the PR body). A
// needs-external-evidence carry-over forces the sprint verdict to FAIL: the
// bead's acceptance was never verified. A deferred-bounce-cap carry-over also
// forces FAIL: the bead's acceptance was proven failing on every pass. A
// plain deferred carry-over is named only; the verdict stays with the other
// gates, like any other deferred bead.
//
// Everything here is pure; runner.js and phases/integ-test.mjs gather the
// inputs and own the state (Maps mutated in place).
// =============================================================================

/** Consecutive inconclusive Integration Test cycles before a verify-routed bead is carried over. */
export const NEEDS_EXTERNAL_EVIDENCE_CYCLE_LIMIT = 2;

/** Carry-over kind: verification needs evidence the sprint members cannot produce. */
export const NEEDS_EXTERNAL_EVIDENCE = 'needs-external-evidence';

/** Carry-over kind: verify-routed bead deferred during the run (scope decision; notes only). */
export const DEFERRED_VERIFY = 'deferred';

/** Carry-over kind: verify-routed bead the engine's verify bounce cap deferred (forces FAIL). */
export const DEFERRED_BOUNCE_CAP = 'deferred-bounce-cap';

/**
 * Records a verify-routed bead the engine's verify bounce cap deferred. The
 * entry is marked so the carry-over forces the verdict to FAIL.
 *
 * @param {Map<string, string|{ reason: string, bounceCap: true }>} deferred mutated in place
 * @param {string} id
 * @param {string} reason
 */
export function markBounceCapDeferral(deferred, id, reason) {
    deferred.set(id, { reason, bounceCap: true });
}

const deferredReason = (value) =>
    (value && typeof value === 'object' ? value.reason : value) || 'deferred during the run';
const isBounceCap = (value) => !!(value && typeof value === 'object' && value.bounceCap === true);

/**
 * Updates the per-bead consecutive-inconclusive counts after one Integration
 * Test dispatch and returns the ids that reached the limit this cycle.
 *
 * Only ids in `dispatchedIds` are touched: a closed id or one with a gap bug
 * filed under it this cycle is reset (removed); every other dispatched id is
 * incremented. Ids not dispatched this cycle keep their count.
 *
 * @param {Map<string, number>} counts mutated in place
 * @param {{ dispatchedIds: Iterable<string>, closedIds: Set<string>, gapParentIds?: Iterable<string>, limit?: number }} opts
 * @returns {string[]} ids whose count reached `limit` this cycle (sorted)
 */
export function recordInconclusiveVerifyCycle(counts, { dispatchedIds, closedIds, gapParentIds = [], limit = NEEDS_EXTERNAL_EVIDENCE_CYCLE_LIMIT }) {
    const closed = closedIds instanceof Set ? closedIds : new Set();
    const gaps = new Set(gapParentIds || []);
    const tripped = [];
    for (const id of new Set(dispatchedIds || [])) {
        if (closed.has(id) || gaps.has(id)) {
            counts.delete(id);
            continue;
        }
        const next = (counts.get(id) ?? 0) + 1;
        counts.set(id, next);
        if (next >= limit) tripped.push(id);
    }
    return tripped.sort();
}

/**
 * The verify-routed ids the exit gate still waits on: routed to verify this
 * run, not closed, and not carried over (needs external evidence or deferred).
 *
 * @param {{ verifyEverIds: Iterable<string>, closedIds: Set<string>, needsEvidence?: Map<string, unknown>, deferred?: Map<string, unknown> }} opts
 * @returns {string[]}
 */
export function stillOpenVerifyIdsForExit({ verifyEverIds, closedIds, needsEvidence = new Map(), deferred = new Map() }) {
    const closed = closedIds instanceof Set ? closedIds : new Set();
    return [...(verifyEverIds || [])].filter((id) => !closed.has(id) && !needsEvidence.has(id) && !deferred.has(id));
}

/**
 * Records, from one full-project bead snapshot, every verify-routed id now in
 * status `deferred` (added with a generic reason unless a more specific one is
 * already recorded) and drops any recorded id now back in a not-done,
 * non-deferred status (reopened by someone).
 *
 * @param {Map<string, string|{ reason: string, bounceCap: true }>} deferred mutated in place, id -> reason
 * @param {{ beads: Array<{ id: string, status?: string }>, verifyEverIds: Set<string> }} opts
 */
export function syncDeferredVerifyIds(deferred, { beads, verifyEverIds }) {
    for (const b of beads || []) {
        if (!b || !verifyEverIds.has(b.id)) continue;
        if (b.status === 'deferred') {
            if (!deferred.has(b.id)) deferred.set(b.id, 'deferred during the run');
        } else if (b.status !== 'closed') {
            deferred.delete(b.id);
        }
    }
}

/**
 * The verify carry-over handed to Final Review, or null when nothing was
 * carried over.
 *
 * @param {{ needsEvidence?: Map<string, { reason: string, cycles: number }>, deferred?: Map<string, string|{ reason: string, bounceCap: true }>, closedIds?: Set<string>, atGoalIds?: Set<string> }} opts
 *   closedIds: a carried-over id that closed after all (the runner did close
 *   it on a later pass) is not carried over.
 *   atGoalIds: the ids of the not-done beads (open, in_progress, blocked or
 *   deferred) at/above the sprint goal priority. When given, a carried-over
 *   bead NOT in it is below goal: still named, but not in needsEvidenceIds or
 *   bounceCapIds, so it cannot force FAIL; it is listed in belowGoalIds. When
 *   omitted every carried-over bead counts as at/above goal.
 * @returns {{ entries: { id: string, kind: string, reason: string, belowGoal?: true }[], needsEvidenceIds: string[], deferredIds: string[], bounceCapIds: string[], belowGoalIds: string[] } | null}
 *   needsEvidenceIds / bounceCapIds hold only the at/above-goal ids that force
 *   FAIL; deferredIds holds every deferred id (both sub-kinds).
 */
export function buildVerifyCarryOver({
    needsEvidence = new Map(), deferred = new Map(), closedIds = new Set(), atGoalIds,
} = {}) {
    const open = (id) => !closedIds.has(id);
    const belowGoal = (id) => atGoalIds instanceof Set && !atGoalIds.has(id);
    const allNeedsEvidenceIds = [...needsEvidence.keys()].filter(open).sort();
    const deferredIds = [...deferred.keys()].filter((id) => open(id) && !needsEvidence.has(id)).sort();
    if (allNeedsEvidenceIds.length === 0 && deferredIds.length === 0) return null;
    const entries = [
        ...allNeedsEvidenceIds.map((id) => {
            const rec = needsEvidence.get(id);
            return {
                id,
                ...(belowGoal(id) ? { belowGoal: true } : {}),
                kind: NEEDS_EXTERNAL_EVIDENCE,
                reason: `left open by Integration Test with no gap bug filed on ${rec.cycles} consecutive cycle(s)` +
                    (rec.reason ? `; integ runner: ${rec.reason}` : ''),
            };
        }),
        ...deferredIds.map((id) => ({
            id,
            ...(belowGoal(id) ? { belowGoal: true } : {}),
            kind: isBounceCap(deferred.get(id)) ? DEFERRED_BOUNCE_CAP : DEFERRED_VERIFY,
            reason: deferredReason(deferred.get(id)),
        })),
    ];
    const needsEvidenceIds = allNeedsEvidenceIds.filter((id) => !belowGoal(id));
    const bounceCapIds = deferredIds.filter((id) => isBounceCap(deferred.get(id)) && !belowGoal(id));
    const belowGoalIds = entries.filter((e) => e.belowGoal).map((e) => e.id);
    return { entries, needsEvidenceIds, deferredIds, bounceCapIds, belowGoalIds };
}

/**
 * The verify carry-over paragraph: logged at the exit and put in the verdict
 * notes (and so in the PR body).
 *
 * @param {NonNullable<ReturnType<typeof buildVerifyCarryOver>>} carryOver
 * @returns {string}
 */
export function formatVerifyCarryOverNotes(carryOver) {
    const parts = [];
    const needs = carryOver.entries.filter((e) => e.kind === NEEDS_EXTERNAL_EVIDENCE);
    const deferred = carryOver.entries.filter((e) => e.kind === DEFERRED_VERIFY);
    if (needs.length > 0) {
        parts.push(
            `Carried over as ${NEEDS_EXTERNAL_EVIDENCE} (verification could not run on the sprint members; the bead stays open ` +
            `and needs evidence from an environment outside this sprint): ` +
            needs.map((e) => `${e.id} -- ${e.reason}`).join('; ') + '.'
        );
    }
    const bounceCap = carryOver.entries.filter((e) => e.kind === DEFERRED_BOUNCE_CAP);
    if (bounceCap.length > 0) {
        parts.push(
            `Carried over as ${DEFERRED_BOUNCE_CAP} (verify-routed bead kept failing Integration Test verification and the ` +
            `engine deferred it; its acceptance is not met and it stays open): ` +
            bounceCap.map((e) => `${e.id} -- ${e.reason}`).join('; ') + '.'
        );
    }
    if (deferred.length > 0) {
        parts.push(
            'Carried over as deferred (verify-routed bead deferred during the run, so it was not waited on): ' +
            deferred.map((e) => `${e.id} -- ${e.reason}`).join('; ') + '.'
        );
    }
    return parts.join(' ');
}

/**
 * Puts the verify carry-over at the top of the verdict notes and forces the
 * verdict to FAIL while any at/above-goal needs-external-evidence or
 * deferred-bounce-cap bead is carried over (needsEvidenceIds / bounceCapIds
 * hold only those; see buildVerifyCarryOver). A below-goal one, and a plain
 * deferred-only carry-over, is named but leaves the verdict to the other
 * gates.
 *
 * @param {object|null} verdictResult
 * @param {ReturnType<typeof buildVerifyCarryOver>} carryOver
 * @returns {object|null}
 */
export function applyVerifyCarryOverVerdictGate(verdictResult, carryOver) {
    if (!carryOver) return verdictResult;
    const prior = verdictResult && typeof verdictResult.notes === 'string' ? verdictResult.notes : '';
    const force = carryOver.needsEvidenceIds.length > 0 || (carryOver.bounceCapIds || []).length > 0;
    const overridden = force && (!verdictResult || verdictResult.verdict === 'PASS');
    return {
        ...(verdictResult || {}),
        ...(force ? { verdict: 'FAIL' } : {}),
        notes: formatVerifyCarryOverNotes(carryOver) +
            (overridden ? ' (Final Review returned PASS; the engine overrode it to FAIL.)' : '') +
            (prior ? `\n\n${prior}` : ''),
    };
}
