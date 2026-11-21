// Run-scoped "set aside" bookkeeping: the immediate-stall decision and the
// "Set aside this run" report section.
//
// Two things can be set aside for the rest of a sprint run, both recorded on
// the per-sprint `sprintState`:
//   - beads a doer reported BLOCKED, plus their open 'blocks' dependents:
//     `sprintState.doctorBlockedIds`, a Map id -> { kind, blockedBy, reason,
//     cycle, round } (written by phases/develop.mjs);
//   - beads a doer or reviewer returned NEEDS-DECISION on, plus their open
//     'blocks' dependents: the same Map, kind 'needs-decision' (the dependents
//     kind 'dependent'), with the decision's ids and the FULL question as the
//     reason (written by decisions.mjs recordPendingDecision);
//   - a bead whose doer streak returned VERIFY but closed none of its beads:
//     the same Map, kind VERIFY_NO_CHANGE_KIND (written by phases/develop.mjs);
//   - the deploy itself, when it failed at the deploy.md Permissions pre-step:
//     `sprintState.deploySetAside` = { reason, notes, cycle } (written by
//     phases/deploy.mjs).
//
// When nothing is ready and every open in-scope bead is set aside -- or can
// only close through Integration Test while the deploy is set aside -- no
// further round or cycle can make progress. What happens then depends on
// whether this run already closed work:
//   - zero beads this run dispatched or routed to verify are closed: the
//     cycle loop throws the existing StalledSprintError at once (instead of
//     after STALL_CYCLE_LIMIT empty cycles), naming every blocker;
//   - at least one is closed: the run must not throw away that work. The
//     set-aside beads are a CARRY-OVER (buildSetAsideCarryOver): the cycle
//     loop exits to Finalization (Final Review, Regression, Harvest, Publish
//     PR) with the carry-over list, and Final Review forces the verdict to
//     FAIL while any at/above-goal bead is carried over
//     (applyCarryOverVerdictGate). At the start of a Develop round the same
//     condition only ends the Develop loop, so Deploy and Integration Test
//     still run for the work closed earlier in the cycle.
// Everything here is pure; runner.js gathers the inputs.
//
// A bead a doer reported BLOCKED while it still had an open prerequisite in
// the sprint is not set aside: it WAITS (`sprintState.waitingIds`, a Map id
// -> { on, cycle, round }, written by phases/develop.mjs). A waiting bead --
// or any open bead held behind a prerequisite -- counts as stuck for the
// stall decision only when one of its prerequisites cannot close in this run
// (set aside, itself stuck, or, for a waiting bead, outside the sprint
// scope); while they can still close it keeps the run going. Waits are
// reported on their own line ("Waited this run"), never as set-asides.

import { unmetPrerequisites } from './beads-scope.mjs';

/**
 * The set-aside kind for a bead whose doer streak returned VERIFY but closed
 * none of its beads (phases/develop.mjs): re-dispatching it would only repeat
 * the same answer, so it is set aside after one round and carried over.
 */
export const VERIFY_NO_CHANGE_KIND = 'verify-no-change';
/** The streak outcome failureReason recorded for such a streak. */
export const VERIFY_NO_CHANGE_REASON = 'verify-no-change';

/** The pseudo-id naming the set-aside deploy in blockerIds/blockerReasons. */
export const DEPLOY_SET_ASIDE_ID = 'deploy';

/**
 * Every set-aside record of this run, beads first (ordered by first seen,
 * then id), then the deploy. Empty when nothing was set aside.
 *
 * @param {{ doctorBlockedIds?: Map<string, object>, deploySetAside?: object|null }|null|undefined} sprintState
 * @returns {{ id: string, kind: string, blockedBy?: string, reason: string, cycle: number|null, round: number|null, decisionId?: string, decisionBeadId?: string }[]}
 */
export function collectSetAsideEntries(sprintState) {
    const out = [];
    const blocked = sprintState && sprintState.doctorBlockedIds instanceof Map ? sprintState.doctorBlockedIds : new Map();
    for (const [id, e] of blocked) {
        out.push({
            id,
            kind: e.kind || 'blocked',
            blockedBy: e.blockedBy || id,
            reason: e.reason || 'set aside',
            cycle: Number.isInteger(e.cycle) ? e.cycle : null,
            round: Number.isInteger(e.round) ? e.round : null,
            ...(e.decisionId ? { decisionId: e.decisionId } : {}),
            ...(e.decisionBeadId ? { decisionBeadId: e.decisionBeadId } : {}),
        });
    }
    const kindRank = (k) => (k === 'dependent' ? 1 : 0);
    out.sort((a, b) => (a.cycle ?? 0) - (b.cycle ?? 0) || (a.round ?? 0) - (b.round ?? 0)
        || kindRank(a.kind) - kindRank(b.kind) || a.id.localeCompare(b.id));
    const deploy = sprintState ? sprintState.deploySetAside : null;
    if (deploy) {
        out.push({
            id: DEPLOY_SET_ASIDE_ID,
            kind: 'deploy',
            reason: deploy.notes ? `${deploy.reason} (${deploy.notes})` : String(deploy.reason || 'deploy set aside'),
            cycle: Number.isInteger(deploy.cycle) ? deploy.cycle : null,
            round: null,
        });
    }
    return out;
}

/**
 * "C1 R2" / "C1" / "unknown" for an entry's first-seen point.
 * @param {{ cycle: number|null, round: number|null }} entry
 * @returns {string}
 */
export function formatFirstSeen(entry) {
    if (!entry || entry.cycle === null || entry.cycle === undefined) return 'unknown';
    return entry.round === null || entry.round === undefined ? `C${entry.cycle}` : `C${entry.cycle} R${entry.round}`;
}

/**
 * The "Set aside this run" report lines (one list item per entry: bead,
 * reason, first seen; a needs-decision entry is marked as such and carries
 * the whole question). Empty array when nothing was set aside, so callers
 * omit the section entirely.
 *
 * @param {ReturnType<typeof collectSetAsideEntries>} entries
 * @returns {string[]}
 */
export function formatSetAsideItems(entries) {
    return (entries || []).map((e) => `${e.id}: ${e.kind === 'needs-decision' ? '[needs-decision] ' : ''}${e.reason} (first seen ${formatFirstSeen(e)})`);
}

/**
 * The immediate-stall decision. Returns null unless EVERY open in-scope bead
 * at goal priority is set aside: in doctorBlockedIds, publish blocked by a
 * permission-scope push failure (permissionBlockedIds), stuck behind a
 * prerequisite that cannot close in this run (stuckIds), or -- while the deploy
 * is set aside -- bound to Integration Test (verify-routed, or blocked only by
 * verify-routed beads). With nothing open at all this returns null (that is
 * completion, not a stall; the deploy-failure verdict gate handles it).
 *
 * @param {object} opts
 * @param {string[]} opts.openIds open, non-deferred leaf beads at goal priority
 * @param {string[]} [opts.integBoundIds] open verify-routed beads (close only through Integration Test)
 * @param {string[]} [opts.verifyBlockedIds] open beads whose only unmet blockers are verify-routed
 * @param {Map<string, object>} [opts.doctorBlockedIds]
 * @param {object|null} [opts.deploySetAside]
 * @param {Map<string, string>} [opts.stuckIds] open beads that are not set aside but wait on a
 *   prerequisite that cannot close in this run (stuckBehindSetAside), id -> reason
 * @param {Map<string, string>} [opts.permissionBlockedIds] open beads whose publish was blocked by a
 *   permission-scope push failure this run (sprintState.permissionScopeBlockedBeads), id -> error;
 *   never re-dispatched this run, so they count as set aside here
 * @returns {null | { blockerIds: string[], blockerReasons: Record<string, string>, entries: ReturnType<typeof collectSetAsideEntries> }}
 */
export function evaluateSetAsideStall({ openIds, integBoundIds = [], verifyBlockedIds = [], doctorBlockedIds = new Map(), deploySetAside = null, stuckIds = new Map(), permissionBlockedIds = new Map() }) {
    const integBound = new Set(integBoundIds);
    const verifyBlocked = new Set(verifyBlockedIds);
    const candidates = [...new Set([...(openIds || []), ...integBound])];
    if (candidates.length === 0) return null;
    const blocked = doctorBlockedIds instanceof Map ? doctorBlockedIds : new Map();
    const stuck = stuckIds instanceof Map ? stuckIds : new Map();
    const perm = permissionBlockedIds instanceof Map ? permissionBlockedIds : new Map();
    const covered = (id) => blocked.has(id) || stuck.has(id) || perm.has(id)
        || (!!deploySetAside && (integBound.has(id) || verifyBlocked.has(id)));
    if (!candidates.every(covered)) return null;

    const entries = collectSetAsideEntries({ doctorBlockedIds: blocked, deploySetAside });
    const blockerReasons = {};
    for (const e of entries) blockerReasons[e.id] = `${e.reason} (first seen ${formatFirstSeen(e)})`;
    for (const id of candidates) {
        if (blockerReasons[id]) continue;
        if (perm.has(id)) { blockerReasons[id] = `publish blocked by a permission-scope push failure (${perm.get(id)})`; continue; }
        if (stuck.has(id) && !integBound.has(id)) { blockerReasons[id] = stuck.get(id); continue; }
        blockerReasons[id] = integBound.has(id)
            ? `can only close through Integration Test, which cannot run while the deploy is set aside`
            : `blocked only by bead(s) that can only close through Integration Test, which cannot run while the deploy is set aside`;
    }
    // Set-aside beads first (first-seen order), then the remaining open
    // candidates, then the deploy pseudo-id last.
    const blockerIds = [
        ...entries.filter((e) => e.id !== DEPLOY_SET_ASIDE_ID).map((e) => e.id),
        ...candidates.filter((id) => !blocked.has(id)).sort(),
    ];
    const unique = [...new Set(blockerIds)];
    if (deploySetAside) unique.push(DEPLOY_SET_ASIDE_ID);
    return { blockerIds: unique, blockerReasons, entries };
}

/**
 * The StalledSprintError message for an immediate set-aside stall.
 *
 * @param {{ blockerIds: string[], blockerReasons: Record<string, string> }} stall
 * @param {{ where: string, scope: string }} ctx
 * @returns {string}
 */
export function formatSetAsideStallMessage(stall, { where, scope }) {
    const blockers = stall.blockerIds.map((id) => `${id} -- ${stall.blockerReasons[id]}`).join('; ');
    return `Sprint stalled (${where}): nothing is ready and every open in-scope bead in scope '${scope}' is set aside ` +
        `for this run, so no further round or cycle can make progress. Set aside: ${blockers}. ` +
        'Fix these blockers and re-run the sprint. Aborting now rather than burning the remaining cycles.';
}

/** The one named cycle-loop exit reason for a set-aside stall with work closed this run. */
export const SET_ASIDE_CARRY_OVER_EXIT = 'set-aside-carry-over';

/**
 * Ids this run dispatched to a doer or routed to verify that are now closed.
 * A non-empty result turns a set-aside stall into a carry-over exit instead
 * of a SPRINT_STALLED abort.
 *
 * @param {{ workedOnIds?: Iterable<string>, verifyEverIds?: Iterable<string>, closedIds: Set<string> }} opts
 * @returns {string[]} sorted
 */
export function closedWorkThisRun({ workedOnIds = [], verifyEverIds = [], closedIds }) {
    const closed = closedIds instanceof Set ? closedIds : new Set();
    const ids = new Set([...(workedOnIds || []), ...(verifyEverIds || [])]);
    return [...ids].filter((id) => closed.has(id)).sort();
}

/**
 * The carry-over handed to Finalization when a set-aside stall fires after
 * this run already closed work: the exit reason, where it fired, the closed
 * work it preserves, and every carried-over item (set-aside bead, bead stuck
 * behind one, or the set-aside deploy) with its reason.
 *
 * Every carried-over bead is open at/above goal priority (the stall only
 * considers those), so `atGoalIds` is every entry except the deploy pseudo-id.
 *
 * @param {{ blockerIds: string[], blockerReasons: Record<string, string> }} stall evaluateSetAsideStall's result
 * @param {{ where: string, cycle: number, closedIds: string[] }} ctx
 * @returns {{ reason: string, where: string, cycle: number, closedIds: string[], entries: { id: string, reason: string }[], atGoalIds: string[] }}
 */
export function buildSetAsideCarryOver(stall, { where, cycle, closedIds }) {
    const entries = (stall.blockerIds || []).map((id) => ({ id, reason: stall.blockerReasons[id] || 'set aside' }));
    return {
        reason: SET_ASIDE_CARRY_OVER_EXIT,
        where,
        cycle,
        closedIds: [...(closedIds || [])],
        entries,
        atGoalIds: entries.map((e) => e.id).filter((id) => id !== DEPLOY_SET_ASIDE_ID),
    };
}

/** The cycle-loop exit reason for a plan the plan-reviewer never approved, after work closed this run. */
export const PLAN_REJECTED_CARRY_OVER_EXIT = 'plan-rejected-carry-over';

/** Longest plan-reviewer finding text kept per carried-over bead. */
const PLAN_FINDING_MAX_CHARS = 600;

/**
 * One line of plan-reviewer finding text: whitespace collapsed, capped.
 * @param {unknown} text
 * @returns {string}
 */
function oneLineFinding(text) {
    const flat = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
    if (flat.length <= PLAN_FINDING_MAX_CHARS) return flat;
    return `${flat.slice(0, PLAN_FINDING_MAX_CHARS - 3)}...`;
}

/**
 * The carry-over handed to Finalization when the Plan phase ends without an
 * approved plan (whole plan contested, or the contested beads deferred and
 * nothing left ready) after this run already closed work. Each carried-over
 * bead's reason is the plan-reviewer finding: the structured finding naming
 * that bead when the verdict has one, else the verdict notes.
 *
 * Pure: no I/O. The caller decides which beads are at/above goal priority.
 *
 * @param {{ where: string, cycle: number, planningRounds?: number, closedIds: string[], contestedIds: string[],
 *   verdictNotes?: string|null, findings?: Array<{ id?: string, detail?: string }>|null, atGoalIds?: string[] }} opts
 * @returns {{ reason: string, where: string, cycle: number, planningRounds: number|null, closedIds: string[], entries: { id: string, reason: string }[], atGoalIds: string[] }}
 */
export function buildPlanRejectedCarryOver({ where, cycle, planningRounds = null, closedIds = [], contestedIds = [], verdictNotes = null, findings = null, atGoalIds = [] }) {
    const notes = oneLineFinding(verdictNotes);
    const byId = new Map();
    for (const f of Array.isArray(findings) ? findings : []) {
        if (!f || typeof f.id !== 'string' || !f.id) continue;
        const detail = oneLineFinding(f.detail);
        if (detail) byId.set(f.id, byId.has(f.id) ? `${byId.get(f.id)} / ${detail}` : detail);
    }
    const ids = [...new Set((contestedIds || []).map(String))];
    const entries = ids.map((id) => {
        const finding = byId.get(id) || notes || 'no finding text returned';
        return { id, reason: `plan-reviewer finding: ${finding}` };
    });
    const goal = new Set((atGoalIds || []).map(String));
    return {
        reason: PLAN_REJECTED_CARRY_OVER_EXIT,
        where,
        cycle,
        planningRounds: Number.isFinite(planningRounds) ? planningRounds : null,
        closedIds: [...(closedIds || [])],
        entries,
        atGoalIds: ids.filter((id) => goal.has(id)),
    };
}

/**
 * The one-paragraph carry-over text: logged at the exit and put in the
 * verdict notes (and so in the PR body).
 *
 * @param {ReturnType<typeof buildSetAsideCarryOver>} carryOver
 * @returns {string}
 */
export function formatCarryOverNotes(carryOver) {
    const items = carryOver.entries.map((e) => `${e.id} -- ${e.reason}`).join('; ');
    if (carryOver.reason === PLAN_REJECTED_CARRY_OVER_EXIT) {
        return `Carried over (${carryOver.where}): the plan-reviewer did not approve the plan after ` +
            `${carryOver.planningRounds ?? '?'} round(s), so the sprint went on to Final Review with the work it closed ` +
            `(${carryOver.closedIds.join(', ')}) instead of aborting. Not finished this run: ${items}.`;
    }
    return `Carried over (${carryOver.where}): nothing is ready and every open in-scope bead is set aside for this run, ` +
        `so the sprint went on to Final Review with the work it closed (${carryOver.closedIds.join(', ')}) ` +
        `instead of aborting. Not finished this run: ${items}.`;
}

/**
 * Forces the sprint verdict to FAIL while any at/above-goal bead is carried
 * over, and puts the carry-over list at the top of the verdict notes. A
 * carry-over of only the deploy pseudo-id still adds the notes but leaves the
 * verdict to the other gates (the deploy-failure gate owns that case).
 *
 * @param {object|null} verdictResult
 * @param {ReturnType<typeof buildSetAsideCarryOver>|null} carryOver
 * @returns {object|null}
 */
export function applyCarryOverVerdictGate(verdictResult, carryOver) {
    if (!carryOver) return verdictResult;
    const prior = verdictResult && typeof verdictResult.notes === 'string' ? verdictResult.notes : '';
    const force = carryOver.atGoalIds.length > 0;
    const overridden = force && (!verdictResult || verdictResult.verdict === 'PASS');
    return {
        ...(verdictResult || {}),
        ...(force ? { verdict: 'FAIL' } : {}),
        notes: formatCarryOverNotes(carryOver) +
            (overridden ? ' (Final Review returned PASS; the engine overrode it to FAIL.)' : '') +
            (prior ? `\n\n${prior}` : ''),
    };
}

/**
 * Why each in-scope bead "cannot close in this run" at the root of the stuck
 * accounting, id -> short reason naming why: set aside (doer BLOCKED, a
 * dependent of one, or awaiting an operator decision), publish blocked by a
 * permission-scope push failure, or deferred (status 'deferred', e.g. a
 * plan-cap deferral -- the dispatcher never offers a deferred bead, yet lane
 * order and 'blocks' edges still count it as an open prerequisite).
 *
 * Pure: no I/O.
 * @param {{ scopeBeads?: Array<object>, doctorBlockedIds?: Map<string, object>, permissionBlockedIds?: Map<string, string> }} opts
 * @returns {Map<string, string>}
 */
export function cannotCloseThisRun({ scopeBeads = [], doctorBlockedIds = new Map(), permissionBlockedIds = new Map() }) {
    const out = new Map();
    const blocked = doctorBlockedIds instanceof Map ? doctorBlockedIds : new Map();
    for (const [id, e] of blocked) {
        const kind = e && e.kind;
        out.set(String(id), kind === 'needs-decision' ? 'set aside, awaiting an operator decision'
            : kind === 'dependent' ? `set aside, a dependent of ${(e && e.blockedBy) || 'a BLOCKED bead'}`
                : kind === VERIFY_NO_CHANGE_KIND ? 'set aside, doer returned VERIFY with no change'
                    : 'set aside, reported BLOCKED');
    }
    const perm = permissionBlockedIds instanceof Map ? permissionBlockedIds : new Map();
    for (const id of perm.keys()) {
        if (!out.has(String(id))) out.set(String(id), 'publish blocked by a permission-scope push failure');
    }
    for (const b of Array.isArray(scopeBeads) ? scopeBeads : []) {
        if (b && b.status === 'deferred' && !out.has(String(b.id))) out.set(String(b.id), 'deferred');
    }
    return out;
}

/**
 * Open beads that are not set aside but cannot run in this sprint because a
 * prerequisite of theirs cannot close: an unmet in-scope prerequisite (an
 * open 'blocks' dependency or an open lower-order lane-mate) that cannot
 * close in this run (cannotCloseThisRun: set aside, publish blocked by a
 * permission-scope push failure, or deferred) or is itself stuck,
 * transitively; or, for a bead that is WAITING after a BLOCKED report, an
 * open prerequisite outside the sprint scope. The reason names each such
 * prerequisite and why it cannot close. A bead whose prerequisites can all
 * still close is not stuck: it keeps the run going.
 *
 * @param {object} opts
 * @param {Array<object>} opts.scopeBeads every in-scope bead, any status
 * @param {Array<object>} [opts.allBeads] every bead, any status
 * @param {Map<string, object>} [opts.doctorBlockedIds]
 * @param {Map<string, object>} [opts.waitingIds]
 * @param {Map<string, string>} [opts.permissionBlockedIds] sprintState.permissionScopeBlockedBeads
 * @returns {Map<string, string>} stuck id -> reason
 */
export function stuckBehindSetAside({ scopeBeads, allBeads = [], doctorBlockedIds = new Map(), waitingIds = new Map(), permissionBlockedIds = new Map() }) {
    const waiting = waitingIds instanceof Map ? waitingIds : new Map();
    const roots = cannotCloseThisRun({ scopeBeads, doctorBlockedIds, permissionBlockedIds });
    const out = new Map();
    if (roots.size === 0 && waiting.size === 0) return out;
    const open = (Array.isArray(scopeBeads) ? scopeBeads : [])
        .filter((b) => b && b.status !== 'closed' && !roots.has(String(b.id)));
    const pre = new Map(open.map((b) => [String(b.id), unmetPrerequisites(b, { scopeBeads, allBeads })]));
    const why = (x) => (roots.has(x) ? roots.get(x) : 'itself held behind a bead that cannot close in this run');
    let changed = true;
    while (changed) {
        changed = false;
        for (const b of open) {
            const id = String(b.id);
            if (out.has(id)) continue;
            const p = pre.get(id);
            const stuckOn = p.inScope.filter((x) => roots.has(x) || out.has(x));
            if (stuckOn.length > 0) {
                out.set(id, `${waiting.has(id) ? 'waiting' : 'held'} on ${stuckOn.map((x) => `${x} (${why(x)})`).join(', ')}, which cannot close in this run`);
                changed = true;
            } else if (waiting.has(id) && p.outOfScope.length > 0) {
                out.set(id, `waiting on ${p.outOfScope.join(', ')}, outside this sprint's scope, which cannot close in this run`);
                changed = true;
            }
        }
    }
    return out;
}

/**
 * Every bead that waited this run (a BLOCKED report while it still had an
 * open in-sprint prerequisite), with the prerequisites it waited on, in
 * first-seen order then id.
 *
 * @param {{ waitingIds?: Map<string, object> }|null|undefined} sprintState
 * @returns {{ id: string, on: string[], cycle: number|null, round: number|null }[]}
 */
export function collectWaitEntries(sprintState) {
    const waiting = sprintState && sprintState.waitingIds instanceof Map ? sprintState.waitingIds : new Map();
    const out = [];
    for (const [id, e] of waiting) {
        out.push({
            id,
            on: Array.isArray(e.on) ? e.on.map(String) : [],
            cycle: Number.isInteger(e.cycle) ? e.cycle : null,
            round: Number.isInteger(e.round) ? e.round : null,
        });
    }
    out.sort((a, b) => (a.cycle ?? 0) - (b.cycle ?? 0) || (a.round ?? 0) - (b.round ?? 0) || a.id.localeCompare(b.id));
    return out;
}

/**
 * The one-line "Waited this run" summary, or null when nothing waited. Waits
 * are ordering, not blocking, so they never appear under "Set aside this run".
 *
 * @param {ReturnType<typeof collectWaitEntries>} entries
 * @returns {string|null}
 */
export function formatWaitedLine(entries) {
    const list = entries || [];
    if (list.length === 0) return null;
    return `Waited this run: ${list.map((e) => `${e.id} on ${e.on.join(', ') || '(unknown)'}`).join('; ')}`;
}

/**
 * Wait vs set-aside for the beads a doer reported BLOCKED, decided
 * mechanically from the bead graph (never from the report's notes):
 *   - an open prerequisite OUTSIDE the sprint scope -> set aside, naming it
 *     (it cannot close in this run);
 *   - an open in-scope prerequisite (an open 'blocks' dependency or an open
 *     lower-order lane-mate) and no earlier wait -> WAIT on those ids;
 *   - otherwise -> set aside (a genuine blocker); a bead that already waited
 *     once is set aside now, which bounds the retry to one extra dispatch.
 * Beads already set aside are skipped. `suffix` is appended to the doer's
 * reason when set aside.
 *
 * @param {object} opts
 * @param {string[]} opts.blockedIds
 * @param {Array<object>} opts.scopeBeads every in-scope bead, any status
 * @param {Array<object>} [opts.allBeads] every bead, any status
 * @param {Map<string, object>} [opts.doctorBlockedIds]
 * @param {Map<string, object>} [opts.waitingIds]
 * @returns {{ wait: Array<{ id: string, on: string[] }>, setAside: Array<{ id: string, suffix: string }> }}
 */
export function classifyBlockedReport({ blockedIds, scopeBeads, allBeads = [], doctorBlockedIds = new Map(), waitingIds = new Map() }) {
    const blocked = doctorBlockedIds instanceof Map ? doctorBlockedIds : new Map();
    const waiting = waitingIds instanceof Map ? waitingIds : new Map();
    const scopeById = new Map((scopeBeads || []).filter(Boolean).map((b) => [String(b.id), b]));
    const wait = [];
    const setAside = [];
    for (const raw of blockedIds || []) {
        const id = String(raw);
        if (blocked.has(id)) continue;
        const bead = scopeById.get(id);
        const pre = bead
            ? unmetPrerequisites(bead, { scopeBeads, allBeads })
            : { inScope: [], outOfScope: [] };
        const priorWait = waiting.get(id);
        if (pre.outOfScope.length > 0) {
            setAside.push({ id, suffix: ` -- open prerequisite(s) outside this sprint's scope, which cannot close in this run: ${pre.outOfScope.join(', ')}` });
        } else if (pre.inScope.length > 0 && !priorWait) {
            wait.push({ id, on: [...pre.inScope] });
        } else {
            setAside.push({
                id,
                suffix: priorWait ? ` (reported BLOCKED again after waiting on ${(priorWait.on || []).join(', ')})` : '',
            });
        }
    }
    return { wait, setAside };
}
