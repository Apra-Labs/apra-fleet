// =============================================================================
// ONE-STEP TIER ESCALATION -- a bead the reviewer reopened, or whose doer
// session ended with the bead still open after a real attempt (a verify
// failure), is redone ONE tier up: cheap -> standard -> premium; premium stays
// premium. Only under a tier policy with escalation on (balanced, economy);
// quality never escalates (tier-policy.mjs reproducesPrePolicyTiers).
//
// ONCE PER BEAD PER SPRINT. An escalation is recorded twice:
//   - on the bead, as metadata tierEscalatedFrom=<the planner's tier>. The
//     bead's model metadata is never rewritten (the planner's tier stays
//     visible), and the premium-cap gate (tier-cap.mjs) leaves a bead carrying
//     the key out of its count. A bead that already carries it is never
//     escalated again, so the record survives any runner restart.
//   - on the run context (holdTierEscalations), the same place the run holds
//     its tier policy, so a resume over the same context sees it even before
//     the bead metadata is read back.
//
// WHAT NEVER ESCALATES. Only a reviewer reopen or a verify failure does. A
// verify failure is a doer streak outcome 'failed' with failureReason
// 'left-open' and no dispatch error: the doer's session ran and returned, and
// the engine's own read-back still shows the bead open. Every dispatch error
// -- a usage-limit stop, an empty response, an inactivity timeout, a
// transport error, a sync failure, a claim held elsewhere, a permission
// denial -- carries its own failureReason (and an error), and BLOCKED,
// NEEDS-DECISION and VERIFY-no-change carry theirs, so none of them is a
// verify failure.
//
// Pure apart from applyEscalations(), whose only I/O is the injected
// command(); callers run it inside their own gitSync bracket and D-push.
// =============================================================================

import { normalizeTierToken } from './newtask-text.mjs';
import { isEscalated } from './tier-cap.mjs';
import { reproducesPrePolicyTiers } from './tier-policy.mjs';

/** The tier one step up; premium stays premium. */
const NEXT_TIER = Object.freeze({ cheap: 'standard', standard: 'premium', premium: 'premium' });

export const ESCALATION_REASONS = Object.freeze({
    REOPEN: 'reviewer reopen',
    VERIFY_FAILURE: 'verify failure',
});

/** The doer outcome failureReason that marks a verify failure (see header). */
export const VERIFY_FAILURE_REASON = 'left-open';

function tierToken(raw) {
    const tier = normalizeTierToken(raw);
    return typeof tier === 'string' && Object.prototype.hasOwnProperty.call(NEXT_TIER, tier) ? tier : null;
}

/** The tier one step above `tier`, or null when `tier` names no tier. */
export function escalatedTier(tier) {
    const t = tierToken(tier);
    return t ? NEXT_TIER[t] : null;
}

/**
 * The escalations a run holds for its whole life (bead id -> { from, to,
 * reason }), kept on the run context like the tier policy, so a runner resume
 * over the same context never escalates a bead a second time.
 * @param {object} context the run context
 * @returns {Map<string, {from: string, to: string, reason: string}>}
 */
export function holdTierEscalations(context) {
    return (context.tierEscalations ??= new Map());
}

/** The bead's planner-declared tier (metadata.model), or null. */
export function declaredBeadTier(bead) {
    return tierToken(bead && bead.metadata && bead.metadata.model);
}

/**
 * The tier a bead runs at now: its escalated tier when it was escalated (this
 * run, or earlier -- metadata.tierEscalatedFrom), else its declared tier.
 * @param {object} bead
 * @param {Map<string, {to: string}>} [escalations]
 * @returns {'cheap'|'standard'|'premium'|null}
 */
export function effectiveBeadTier(bead, escalations) {
    const held = escalations && bead ? escalations.get(String(bead.id)) : undefined;
    if (held && held.to) return held.to;
    if (isEscalated(bead)) {
        const up = escalatedTier(bead.metadata.tierEscalatedFrom);
        if (up) return up;
    }
    return declaredBeadTier(bead);
}

/** Whether a bead was escalated (this run or recorded on the bead). */
export function beadWasEscalated(bead, escalations) {
    return Boolean(bead) && ((escalations && escalations.has(String(bead.id))) || isEscalated(bead));
}

/**
 * Whether a per-round review over `beads` must run premium: the round holds a
 * bead running at premium, or an escalated bead.
 */
export function roundHasPremiumOrEscalated(beads, escalations) {
    return (Array.isArray(beads) ? beads : []).some((b) =>
        beadWasEscalated(b, escalations) || effectiveBeadTier(b, escalations) === 'premium');
}

/** Whether a doer streak outcome is a verify failure (see header). */
export function isVerifyFailureOutcome(outcome) {
    return Boolean(outcome) && outcome.outcome === 'failed'
        && outcome.failureReason === VERIFY_FAILURE_REASON
        && !outcome.error && !outcome.postDispatchSyncFailed && !outcome.publishBlocked;
}

/**
 * Decides which of `beads` escalate for `reason` under `policy`.
 * @param {{ beads: object[], policy: object|null, escalations: Map, reason: string }} o
 * @returns {{ escalate: Array<{id: string, from: string, to: string, reason: string}>,
 *   skipped: Array<{id: string, why: string}> }}
 */
export function planEscalations({ beads, policy, escalations, reason }) {
    const escalate = [];
    const skipped = [];
    if (reproducesPrePolicyTiers(policy) || !policy.escalation) return { escalate, skipped };
    for (const bead of Array.isArray(beads) ? beads : []) {
        if (!bead || bead.id === undefined || bead.id === null) continue;
        const id = String(bead.id);
        if (beadWasEscalated(bead, escalations)) {
            skipped.push({ id, why: 'already escalated once this sprint -- no second escalation' });
            continue;
        }
        const from = declaredBeadTier(bead);
        if (!from) {
            skipped.push({ id, why: 'no declared tier' });
            continue;
        }
        if (from === 'premium') {
            skipped.push({ id, why: 'already premium -- premium stays premium' });
            continue;
        }
        escalate.push({ id, from, to: NEXT_TIER[from], reason });
    }
    return { escalate, skipped };
}

/** The bd write that records an escalation on its bead. */
export function escalationCommand(e) {
    return `bd update ${e.id} --set-metadata tierEscalatedFrom=${e.from}`;
}

/** The log line for one escalation: the planner's tier and the escalated one. */
export function formatEscalationLog(e) {
    return `[tier-escalation] bead ${e.id} escalated ${e.from} -> ${e.to} (${e.reason}); the planner's tier ` +
        `${e.from} stays on the bead, recorded as tierEscalatedFrom=${e.from}. Its redo runs at ${e.to}.`;
}

/**
 * Plans and applies the escalations for `beads`: writes tierEscalatedFrom on
 * each escalated bead through the injected command(), records it on
 * `escalations`, and logs every escalation and every skip. Returns the
 * escalations applied.
 */
export async function applyEscalations({ beads, policy, escalations, reason, command, member, log }) {
    const { escalate, skipped } = planEscalations({ beads, policy, escalations, reason });
    for (const s of skipped) {
        if (s.why !== 'no declared tier') log(`[tier-escalation] bead ${s.id} not escalated on ${reason}: ${s.why}.`);
    }
    const applied = [];
    for (const e of escalate) {
        // Recorded on the run first: the redo runs escalated even when the
        // bead write fails (logged loudly); the bead record is what a later
        // run reads.
        escalations.set(e.id, { from: e.from, to: e.to, reason: e.reason });
        try {
            await command(escalationCommand(e), {
                member_name: member, silent: true, label: `Record tier escalation of ${e.id}`,
            });
        } catch (err) {
            log(`[tier-escalation] WARN: could not record tierEscalatedFrom on bead ${e.id} (${err && err.message ? err.message : err}); ` +
                'the escalation holds for this run only.');
        }
        log(formatEscalationLog(e));
        applied.push(e);
    }
    return applied;
}
