// =============================================================================
// NEEDS-DECISION: a doer or reviewer asks a human operator to choose.
//
// A doer (status) or reviewer (verdict) may return NEEDS-DECISION with a
// `decision` object -- { beadId, question, options: [{ id, text }, ...],
// recommendation } (doer-output.json / reviewer-output.json). The bead cannot
// go on until an operator chooses, so re-dispatching it only burns dispatches.
// recordPendingDecision() below:
//
//   1. files a dedicated DECISION bead for the operator: labelled `human`,
//      type `decision`, status `deferred`, carrying the full question and
//      every option verbatim, linked to the work bead by a `discovered-from`
//      edge. It is NEVER the work bead itself: `bd human respond <id>` adds a
//      comment AND CLOSES the bead it is given (reason "Responded"), so a
//      `human` label on the work bead would let an operator's answer close
//      unfinished work. It is not a child of anything and has no blocks edge,
//      so it is never sprint work; the deferred status keeps it out of
//      `bd ready` and out of the open-bead counts even in a sprint whose
//      scope is the whole database. `bd human list` still lists it.
//   2. appends the full request to the work bead's notes (`bd note --file`,
//      which appends; never `bd update --notes`, which replaces);
//   3. records the decision on `sprintState.pendingDecisions` (Map
//      decisionId -> { decisionId, beadId, question, options, recommendation,
//      decisionBeadId, raisedBy, cycle, round, notification: {} });
//   4. sets the work bead aside for the rest of the run on
//      `sprintState.doctorBlockedIds` with kind 'needs-decision' (and its open
//      blocks-edge dependents with kind 'dependent'), exactly like a doer
//      BLOCKED report, so it is excluded from every later round's streaks and
//      counts as set aside for the stall decision and the "Set aside this
//      run" report.
//
// The question and options are never truncated anywhere on this path: the
// set-aside reason carries the whole question.
//
// Every bd write is best-effort: a failed decision-bead create or note
// append is logged and the bead is still set aside (re-dispatching it would
// not answer the question either).
// =============================================================================

import { stageCommandBodyMemberSide } from './member-provisioning.mjs';
import { openBlocksDependents } from './beads-scope.mjs';
import { createDecisionBead } from './beads-children.mjs';

/** The doer status / reviewer verdict asking for an operator decision. */
export const NEEDS_DECISION = 'NEEDS-DECISION';

/** The set-aside kind recorded on sprintState.doctorBlockedIds for it. */
export const NEEDS_DECISION_KIND = 'needs-decision';

/** The label `bd human list` / `bd human respond` select on. */
export const DECISION_BEAD_LABEL = 'human';

const BEAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Checks a NEEDS-DECISION request beyond the schema: trimmed non-empty
 * question and recommendation, at least two options each with an id and
 * text, unique option ids, and a bead id safe to put on a command line.
 * Returns the normalized request (strings trimmed, nothing shortened).
 *
 * @param {unknown} decision
 * @returns {{ ok: true, decision: { beadId: string, question: string, options: { id: string, text: string }[], recommendation: string } } | { ok: false, reason: string }}
 */
export function validateDecisionRequest(decision) {
    if (!decision || typeof decision !== 'object') return { ok: false, reason: 'no decision object' };
    const beadId = typeof decision.beadId === 'string' ? decision.beadId.trim() : '';
    if (!BEAD_ID_RE.test(beadId)) return { ok: false, reason: `decision.beadId ${JSON.stringify(decision.beadId)} is not a bead id` };
    const question = typeof decision.question === 'string' ? decision.question.trim() : '';
    if (!question) return { ok: false, reason: 'decision.question is empty' };
    const recommendation = typeof decision.recommendation === 'string' ? decision.recommendation.trim() : '';
    if (!recommendation) return { ok: false, reason: 'decision.recommendation is empty' };
    const rawOptions = Array.isArray(decision.options) ? decision.options : [];
    const options = [];
    for (const o of rawOptions) {
        const id = o && typeof o.id === 'string' ? o.id.trim() : '';
        const text = o && typeof o.text === 'string' ? o.text.trim() : '';
        if (!id || !text) return { ok: false, reason: 'every decision option needs an id and a text' };
        options.push({ id, text });
    }
    if (options.length < 2) return { ok: false, reason: `decision needs at least 2 options, got ${options.length}` };
    if (new Set(options.map((o) => o.id)).size !== options.length) return { ok: false, reason: 'decision option ids must be unique' };
    return { ok: true, decision: { beadId, question, options, recommendation } };
}

/**
 * The full, untruncated decision request text: the body of the decision
 * bead and of the note appended to the work bead.
 *
 * @param {{ beadId: string, question: string, options: { id: string, text: string }[], recommendation: string }} decision
 * @param {{ raisedBy?: string, cycle?: number, round?: number, decisionBeadId?: string|null }} [meta]
 * @returns {string}
 */
export function formatDecisionRequest(decision, { raisedBy, cycle, round, decisionBeadId } = {}) {
    const where = Number.isInteger(cycle) ? ` in C${cycle}${Number.isInteger(round) ? ` R${round}` : ''}` : '';
    const lines = [
        `[fleet-sprint] NEEDS-DECISION on ${decision.beadId}${raisedBy ? ` (raised by ${raisedBy}${where})` : where}`,
        '',
        'Question:',
        decision.question,
        '',
        'Options:',
        ...decision.options.map((o) => `(${o.id}) ${o.text}`),
        '',
        'Recommendation:',
        decision.recommendation,
    ];
    if (decisionBeadId) {
        lines.push('', `Answer with: bd human respond ${decisionBeadId} "<chosen option id and any instructions>"`);
    }
    return lines.join('\n');
}

/** The decision bead's title (inline on the command line: bead ids only). */
export function decisionBeadTitle(beadId) {
    return `Decision needed for ${beadId}`;
}

/** The set-aside reason for the work bead: names the decision bead and carries the whole question. */
export function needsDecisionReason({ decision, raisedBy, decisionBeadId }) {
    const where = decisionBeadId
        ? ` (decision bead ${decisionBeadId})`
        : ' (the decision bead could NOT be filed, so this run has no bd human respond path for it: ' +
          'record the decision in this bead\'s notes and re-run)';
    return `awaiting an operator decision${where} raised by ${raisedBy}: ${decision.question}`;
}

// Deletes a member-side staged body file once bd has read it. Best-effort:
// a failure only leaves one temp file behind. No backticks or `$`, like the
// staging script itself, so it is inert on every member shell.
export async function removeStagedBody({ command, member, file, log = () => {} }) {
    if (!file) return;
    try {
        await command(
            `node -e "require('fs').rmSync(process.argv[1],{force:true})" "${file}"`,
            { member_name: member, silent: true, label: 'Remove staged decision body' },
        );
    } catch (err) {
        log(`NEEDS-DECISION: could not remove staged body file (non-fatal): ${err.message}`);
    }
}

function normalizePriority(priority) {
    const n = Number(String(priority ?? '').replace(/^P/i, ''));
    return Number.isInteger(n) && n >= 0 && n <= 4 ? n : 2;
}

/**
 * Records one NEEDS-DECISION request (see this file's header). A bead with a
 * decision already pending this run is not filed twice.
 *
 * @param {object} opts
 * @param {object} opts.sprintState
 * @param {object} opts.decision a request that passed validateDecisionRequest()
 * @param {string} opts.raisedBy e.g. "doer on member 'm1'"
 * @param {number} opts.cycle
 * @param {number|null} [opts.round]
 * @param {Function} opts.command the workflow command() seam
 * @param {string} opts.member the member whose beads clone the engine writes through
 * @param {Array<object>} [opts.scopeBeads] every in-scope bead (for blocks-edge dependents and the priority)
 * @param {Function} [opts.log]
 * @returns {Promise<object|null>} the pending-decision record, or null when one was already pending
 */
export async function recordPendingDecision({ sprintState, decision, raisedBy, cycle, round = null, command, member, scopeBeads = [], log = () => {} }) {
    sprintState.pendingDecisions = sprintState.pendingDecisions instanceof Map ? sprintState.pendingDecisions : new Map();
    sprintState.doctorBlockedIds = sprintState.doctorBlockedIds instanceof Map ? sprintState.doctorBlockedIds : new Map();
    const pending = sprintState.pendingDecisions;
    const blocked = sprintState.doctorBlockedIds;
    const beadId = decision.beadId;
    for (const existing of pending.values()) {
        if (existing.beadId === beadId) {
            log(`NEEDS-DECISION on '${beadId}' from ${raisedBy}: a decision is already pending for this bead (${existing.decisionId}) -- not filing a second one.`);
            return null;
        }
    }
    sprintState.decisionSeq = (Number.isInteger(sprintState.decisionSeq) ? sprintState.decisionSeq : 0) + 1;
    const decisionId = `decision-${sprintState.decisionSeq}-${beadId}`;
    const workBead = (scopeBeads || []).find((b) => b && String(b.id) === beadId);
    const priority = normalizePriority(workBead && workBead.priority);

    let decisionBeadId = null;
    let bodyFile = null;
    try {
        bodyFile = await stageCommandBodyMemberSide({
            command, member,
            content: formatDecisionRequest(decision, { raisedBy, cycle, round }),
            label: `Stage decision request for ${beadId}`,
        });
        const out = await createDecisionBead({
            command, member, workBeadId: beadId, title: decisionBeadTitle(beadId), bodyFile, priority,
            labelName: DECISION_BEAD_LABEL, label: `File decision bead for ${beadId}`,
        });
        const id = String(out ?? '').trim().split(/\s+/).pop() || '';
        decisionBeadId = BEAD_ID_RE.test(id) ? id : null;
        if (!decisionBeadId) log(`NEEDS-DECISION on '${beadId}': bd create returned no bead id (${JSON.stringify(String(out ?? ''))}).`);
    } catch (err) {
        log(`NEEDS-DECISION on '${beadId}': filing the decision bead FAILED (non-fatal, the bead is still set aside): ${err.message}`);
    }
    await removeStagedBody({ command, member, file: bodyFile, log });

    let noteFile = null;
    try {
        noteFile = await stageCommandBodyMemberSide({
            command, member,
            content: formatDecisionRequest(decision, { raisedBy, cycle, round, decisionBeadId }),
            label: `Stage decision note for ${beadId}`,
        });
        await command(
            `bd note ${beadId} --file "${noteFile}"`,
            { member_name: member, silent: true, label: `Append decision request to ${beadId} notes` },
        );
    } catch (err) {
        log(`NEEDS-DECISION on '${beadId}': appending the request to its notes FAILED (non-fatal): ${err.message}`);
    }
    await removeStagedBody({ command, member, file: noteFile, log });

    const record = {
        decisionId, beadId,
        question: decision.question,
        options: decision.options.map((o) => ({ id: o.id, text: o.text })),
        recommendation: decision.recommendation,
        decisionBeadId, raisedBy, cycle,
        round: Number.isInteger(round) ? round : null,
        notification: {},
    };
    pending.set(decisionId, record);

    const where = { cycle, round: record.round };
    blocked.set(beadId, {
        kind: NEEDS_DECISION_KIND, blockedBy: beadId,
        reason: needsDecisionReason({ decision, raisedBy, decisionBeadId }),
        decisionId, decisionBeadId,
        ...where,
    });
    const dependents = [];
    for (const [id, root] of openBlocksDependents([beadId], scopeBeads || [])) {
        if (blocked.has(id)) continue;
        blocked.set(id, {
            kind: 'dependent', blockedBy: root,
            reason: `depends (via blocks edges) on bead '${root}', which awaits an operator decision${decisionBeadId ? ` (${decisionBeadId})` : ''}`,
            decisionId,
            ...where,
        });
        dependents.push(id);
    }
    log(
        `NEEDS-DECISION set-aside C${cycle}${record.round !== null ? ` R${record.round}` : ''}: bead '${beadId}' awaits an operator decision ` +
        `(${decisionId}, decision bead ${decisionBeadId || 'NOT FILED'}); set aside for the rest of this run with its open dependent(s) ` +
        `[${dependents.join(', ')}] and not re-dispatched while the decision is pending. Request: ${JSON.stringify(record)}`,
    );
    // Tell the operator (decision-notify.mjs). Injected by the runner as
    // sprintState.notifyDecision; it never throws, and a failure here must
    // never change the sprint, so this guard is belt and braces.
    if (typeof sprintState.notifyDecision === 'function') {
        try {
            await sprintState.notifyDecision(record);
        } catch (err) {
            log(`NOTIFICATION FAILED for decision ${decisionId}: ${err && err.message}. The sprint continues unchanged.`);
        }
    }
    return record;
}

/**
 * Every pending decision of this run, in raise order.
 * @param {{ pendingDecisions?: Map<string, object> }|null|undefined} sprintState
 * @returns {object[]}
 */
export function collectPendingDecisions(sprintState) {
    const pending = sprintState && sprintState.pendingDecisions instanceof Map ? sprintState.pendingDecisions : new Map();
    return [...pending.values()];
}

/**
 * The reopen entries for a reviewer verdict: its `reopenIds`, plus -- for a
 * usable NEEDS-DECISION naming a bead in this review's scope -- that bead, so
 * a closed bead is reopened through the SAME guarded reopen call as every
 * other reopen of the verdict (applyGuardedReopens in
 * beads-transitions.mjs). Reopening a bead that is already open is a no-op.
 *
 * @param {{ verdict: string, reopenIds?: string[], decision?: object }} verdict
 * @param {string[]} scopeIds bead ids this review covered
 * @returns {string[]}
 */
export function reviewerReopenEntries(verdict, scopeIds) {
    const entries = Array.isArray(verdict && verdict.reopenIds) ? [...verdict.reopenIds] : [];
    if (!verdict || verdict.verdict !== NEEDS_DECISION) return entries;
    const checked = validateDecisionRequest(verdict.decision);
    if (!checked.ok || !(scopeIds || []).map(String).includes(checked.decision.beadId)) return entries;
    if (!entries.includes(checked.decision.beadId)) entries.push(checked.decision.beadId);
    return entries;
}

/**
 * Applies a reviewer NEEDS-DECISION verdict (per-round Review and
 * Re-Review), AFTER the caller applied the verdict's reopens with
 * reviewerReopenEntries(): the named bead must be in this review's scope and
 * open now (it was open already, or the guarded reopen just reopened it);
 * the decision is then recorded exactly as for a doer
 * (recordPendingDecision). A non-NEEDS-DECISION verdict is a no-op.
 *
 * @param {object} opts
 * @param {{ verdict: string, decision?: object }} opts.verdict
 * @param {string[]} opts.scopeIds bead ids this review covered
 * @param {Set<string>} opts.reopenedIds ids the guarded reopen actually reopened
 * @param {object} opts.sprintState
 * @param {Function} opts.command
 * @param {string} opts.member
 * @param {Function} opts.bdListScoped
 * @param {number} opts.cycle
 * @param {number|null} [opts.round]
 * @param {string} opts.site e.g. 'Review C1 R2'
 * @param {Function} [opts.log]
 * @returns {Promise<object|null>} the pending-decision record, or null
 */
export async function applyReviewerDecision({ verdict, scopeIds, reopenedIds = new Set(), sprintState, command, member, bdListScoped, cycle, round = null, site, log = () => {} }) {
    if (!verdict || verdict.verdict !== NEEDS_DECISION) return null;
    const checked = validateDecisionRequest(verdict.decision);
    if (!checked.ok) {
        log(`${site}: reviewer returned NEEDS-DECISION with an unusable decision (${checked.reason}) -- nothing is set aside.`);
        return null;
    }
    const decision = checked.decision;
    if (!(scopeIds || []).map(String).includes(decision.beadId)) {
        log(`${site}: reviewer returned NEEDS-DECISION on '${decision.beadId}', which is not in this review's scope -- nothing is set aside.`);
        return null;
    }
    const reopened = reopenedIds instanceof Set && reopenedIds.has(decision.beadId);
    const scopeBeads = (await bdListScoped(''))
        .map((b) => (b && reopened && String(b.id) === decision.beadId ? { ...b, status: 'open' } : b));
    const bead = scopeBeads.find((b) => b && String(b.id) === decision.beadId);
    if (!bead) {
        log(`${site}: reviewer returned NEEDS-DECISION on '${decision.beadId}', which is not in the sprint scope -- nothing is set aside.`);
        return null;
    }
    if (bead.status === 'closed') {
        log(`${site}: reviewer returned NEEDS-DECISION on closed bead '${decision.beadId}', which the guarded reopen did not reopen -- nothing is set aside.`);
        return null;
    }
    return recordPendingDecision({
        sprintState, decision,
        raisedBy: `reviewer (${site})`,
        cycle, round, command, member, scopeBeads, log,
    });
}
