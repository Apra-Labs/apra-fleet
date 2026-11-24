// =============================================================================
// PREMIUM-CAP GATE -- the engine check that a sprint plan's share of
// premium-tier task beads stays inside its tier policy's premiumCapPct
// (tier-policy.mjs), run after plan approval and before the first Develop
// round of every cycle.
//
// WHAT IS COUNTED (countPremiumCap)
//   Every in-scope task bead of ANY status except deferred/tombstone (open AND
//   closed, so the count persists across re-plans and cycles -- it is never
//   just the beads a re-plan created). Not counted, in either the premium
//   count or the total:
//     - non-task beads and decomposed containers (a bead some in-scope bead
//       names as its parent) -- they are never dispatched to a doer;
//     - escalated beads: metadata.tierEscalatedFrom is set (the escalation
//       records the tier it escalated from). Their premium tier is the
//       engine's escalation, not the planner's choice. Absent = not escalated;
//     - [test] beads riding an impl lane: a bead whose title starts with
//       "[test]" and whose metadata.streak is also the streak of a non-[test]
//       task bead. It runs inside that impl lane at the lane's tier, so it is
//       not a tier choice of its own.
//   A bead is premium when normalizeTierToken(metadata.model) === 'premium'
//   (the planner-set model metadata; '-tier' spellings normalize the same).
//
// ROUNDING (premiumAllowance)
//   allowed = floor(premiumCapPct x total / 100), computed in integers. The
//   plan is OVER the cap when premium > allowed. Rounding DOWN means a small
//   plan may hold no premium bead at all (cap 20% of 4 tasks allows 0): the
//   cap is a ceiling the plan must not exceed, never one it may round past.
//
// THE GATE (runPremiumCapGate)
//   quality (premiumCapPct null): a no-op -- no count, no log line.
//   Within the cap: one log line naming the premium beads.
//   Over the cap: a scoped re-plan whose prompt names the premium beads and
//   how many must move, at most MAX_PREMIUM_CAP_REPLANS times per SPRINT (the
//   count lives on sprintState.premiumCap, so later cycles share it), each
//   followed by a recount. Still over after the last one: an operator
//   decision naming every premium bead, the cap and the fixes (raise the cap
//   via tierOverrides, accept, or re-plan), and Develop waits for the answer
//   (awaitDecision). The decision is raised at most once per run; a later
//   cycle that is still over the cap logs that and proceeds.
//   The engine NEVER rewrites a bead's model metadata: only the planner (in a
//   re-plan) or the operator changes a tier.
//
// I/O is injected (listScope, replan, raiseDecision, awaitDecision), so this
// module issues no command() or agent() call of its own.
// =============================================================================

import { normalizeTierToken } from './newtask-text.mjs';

/** Scoped re-plans the gate may run per sprint before it asks an operator. */
export const MAX_PREMIUM_CAP_REPLANS = 2;

const UNCOUNTED_STATUSES = new Set(['deferred', 'tombstone']);
const TEST_TITLE_RE = /^\s*\[test\]/i;

/**
 * floor(capPct x total / 100) in integer arithmetic.
 * @param {number} capPct integer 0..100
 * @param {number} total counted task beads
 * @returns {number}
 */
export function premiumAllowance(capPct, total) {
    return Math.floor((capPct * total) / 100);
}

function meta(bead) {
    return bead && bead.metadata && typeof bead.metadata === 'object' ? bead.metadata : {};
}

function isTestTitle(bead) {
    return TEST_TITLE_RE.test(String((bead && bead.title) || ''));
}

/** Whether the bead records an escalation marker. */
export function isEscalated(bead) {
    const from = meta(bead).tierEscalatedFrom;
    return from !== undefined && from !== null && String(from).trim() !== '';
}

/**
 * Counts the premium task beads of a scope (see this file's header).
 *
 * @param {Array<object>} scopeBeads every in-scope bead, any status
 * @param {number|null} capPct the policy's premiumCapPct; null = no cap
 * @returns {{ capPct: number|null, total: number, premiumIds: string[], allowed: number|null,
 *   over: boolean, mustMove: number, excludedEscalated: string[], excludedRidingTests: string[] }}
 */
export function countPremiumCap(scopeBeads, capPct) {
    const beads = (Array.isArray(scopeBeads) ? scopeBeads : []).filter((b) => b && b.id !== undefined && b.id !== null);
    const parentIds = new Set(beads.map((b) => b.parent).filter(Boolean).map(String));
    const tasks = beads.filter((b) => (!b.issue_type || b.issue_type === 'task')
        && !parentIds.has(String(b.id))
        && !UNCOUNTED_STATUSES.has(b.status));
    const implStreaks = new Set(tasks
        .filter((b) => !isTestTitle(b) && meta(b).streak !== undefined && meta(b).streak !== null && String(meta(b).streak) !== '')
        .map((b) => String(meta(b).streak)));
    const excludedEscalated = [];
    const excludedRidingTests = [];
    const counted = [];
    for (const b of tasks) {
        if (isEscalated(b)) { excludedEscalated.push(String(b.id)); continue; }
        const streak = meta(b).streak;
        if (isTestTitle(b) && streak !== undefined && streak !== null && implStreaks.has(String(streak))) {
            excludedRidingTests.push(String(b.id));
            continue;
        }
        counted.push(b);
    }
    const premiumIds = counted
        .filter((b) => normalizeTierToken(meta(b).model) === 'premium')
        .map((b) => String(b.id))
        .sort();
    const total = counted.length;
    if (capPct === null || capPct === undefined) {
        return { capPct: null, total, premiumIds, allowed: null, over: false, mustMove: 0, excludedEscalated, excludedRidingTests };
    }
    const allowed = premiumAllowance(capPct, total);
    const over = premiumIds.length > allowed;
    return { capPct, total, premiumIds, allowed, over, mustMove: over ? premiumIds.length - allowed : 0, excludedEscalated, excludedRidingTests };
}

/**
 * The smallest premiumCapPct under which `count` would be within its cap.
 * @param {{ premiumIds: string[], total: number }} count
 * @returns {number}
 */
export function capPctToFit(count) {
    if (count.total === 0) return 100;
    for (let pct = 0; pct <= 100; pct++) {
        if (premiumAllowance(pct, count.total) >= count.premiumIds.length) return pct;
    }
    return 100;
}

/** One-line description of a count, naming the premium beads. */
export function describePremiumCount(count) {
    const ids = count.premiumIds.length > 0 ? count.premiumIds.join(', ') : 'none';
    return `${count.premiumIds.length} of ${count.total} counted task bead(s) premium [${ids}]; ` +
        `cap ${count.capPct}% allows ${count.allowed} (floor(${count.capPct}% x ${count.total}))`;
}

/**
 * The operator decision raised when the plan is still over the cap after the
 * last scoped re-plan. Its beadId is the first premium bead; the question
 * names every premium bead, the cap and the fixes.
 *
 * @param {ReturnType<typeof countPremiumCap>} count
 * @param {{ replans: number }} opts
 */
export function buildPremiumCapDecision(count, { replans }) {
    const fitPct = capPctToFit(count);
    return {
        beadId: count.premiumIds[0],
        question:
            `The plan is over its premium-tier cap after ${replans} scoped re-plan(s): ${describePremiumCount(count)}, ` +
            `so at least ${count.mustMove} of the premium bead(s) [${count.premiumIds.join(', ')}] must move to a lower ` +
            'tier to fit. The engine never changes a bead\'s model tier itself. Develop does not start until this is answered. ' +
            'How should the sprint proceed?',
        options: [
            {
                id: 'a',
                text: `Accept: run the plan as it is, with all ${count.premiumIds.length} premium bead(s) at the premium tier, ` +
                    'over the cap for this run.',
            },
            {
                id: 'b',
                text: `Raise the cap: stop this run and relaunch it with tierOverrides {"premiumCapPct": ${fitPct}} ` +
                    `(the smallest cap that fits ${count.premiumIds.length} premium of ${count.total}).`,
            },
            {
                id: 'c',
                text: `Re-plan by hand: lower at least ${count.mustMove} of [${count.premiumIds.join(', ')}] to standard ` +
                    '(bd update <id> --set-metadata model=standard), then answer; the gate recounts before Develop.',
            },
        ],
        recommendation: 'c, it keeps the sprint inside its tier policy; choose a when those beads genuinely need the premium tier.',
    };
}

/**
 * Runs the premium-cap gate for one cycle (see this file's header).
 *
 * @param {object} opts
 * @param {{ name: string, premiumCapPct: number|null }} opts.policy the run's held tier policy
 * @param {object} opts.sprintState holds premiumCap = { replans, decisionRaised, decisionId }
 * @param {number} opts.cycle
 * @param {() => Promise<Array<object>>} opts.listScope every in-scope bead, any status, fresh
 * @param {(req: { count: object, attempt: number, maxReplans: number }) => Promise<unknown>} opts.replan
 * @param {(req: { count: object, decision: object }) => Promise<object|null>} opts.raiseDecision
 *   records the decision and sets the premium beads aside; returns the pending record or null
 * @param {(req: { record: object|null, count: object }) => Promise<unknown>} [opts.awaitDecision]
 *   holds Develop until the decision is answered
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{ status: 'no-cap'|'within'|'already-raised'|'decision', count: object|null, replans: number }>}
 */
export async function runPremiumCapGate({ policy, sprintState, cycle, listScope, replan, raiseDecision, awaitDecision = null, log = () => {} }) {
    const capPct = policy ? policy.premiumCapPct : null;
    if (capPct === null || capPct === undefined) return { status: 'no-cap', count: null, replans: 0 };
    const state = (sprintState.premiumCap ??= { replans: 0, decisionRaised: false, decisionId: null });
    const prefix = `[tier-cap] C${cycle} premium-cap gate (${policy.name})`;

    let count = countPremiumCap(await listScope(), capPct);
    if (!count.over) {
        log(`${prefix}: ${describePremiumCount(count)} -- within cap.`);
        return { status: 'within', count, replans: state.replans };
    }
    if (state.decisionRaised) {
        log(`${prefix}: ${describePremiumCount(count)} -- over cap by ${count.mustMove}, but this run already raised ` +
            `its premium-cap operator decision${state.decisionId ? ` (${state.decisionId})` : ''}; it is not raised twice -- ` +
            'proceeding to Develop with the operator\'s answer (or, while it is unanswered, with the premium bead(s) set aside).');
        return { status: 'already-raised', count, replans: state.replans };
    }
    while (count.over && state.replans < MAX_PREMIUM_CAP_REPLANS) {
        state.replans += 1;
        log(`${prefix}: ${describePremiumCount(count)} -- over cap by ${count.mustMove}. Fix: scoped re-plan ` +
            `${state.replans} of ${MAX_PREMIUM_CAP_REPLANS} asking the planner to move at least ${count.mustMove} of ` +
            `[${count.premiumIds.join(', ')}] to a lower tier.`);
        await replan({ count, attempt: state.replans, maxReplans: MAX_PREMIUM_CAP_REPLANS });
        count = countPremiumCap(await listScope(), capPct);
        if (!count.over) {
            log(`${prefix}: after scoped re-plan ${state.replans}: ${describePremiumCount(count)} -- within cap; Develop starts.`);
            return { status: 'within', count, replans: state.replans };
        }
    }
    const decision = buildPremiumCapDecision(count, { replans: state.replans });
    log(`${prefix}: still over cap after ${state.replans} scoped re-plan(s): ${describePremiumCount(count)} -- over by ` +
        `${count.mustMove}. Raising an operator decision naming [${count.premiumIds.join(', ')}]; fixes: accept, raise the ` +
        `cap via tierOverrides {"premiumCapPct": ${capPctToFit(count)}}, or lower at least ${count.mustMove} of them to standard. ` +
        'Develop waits for the answer.');
    const record = await raiseDecision({ count, decision });
    state.decisionId = record && record.decisionId ? record.decisionId : null;
    state.decisionRaised = true;
    if (typeof awaitDecision === 'function') await awaitDecision({ record, count });
    return { status: 'decision', count, replans: state.replans };
}
