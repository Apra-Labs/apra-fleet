// Run-scoped "set aside" bookkeeping: the immediate-stall decision and the
// "Set aside this run" report section.
//
// Two things can be set aside for the rest of a sprint run, both recorded on
// the per-sprint `sprintState`:
//   - beads a doer reported BLOCKED, plus their open 'blocks' dependents:
//     `sprintState.doctorBlockedIds`, a Map id -> { kind, blockedBy, reason,
//     cycle, round } (written by phases/develop.mjs);
//   - the deploy itself, when it failed at the deploy.md Permissions pre-step:
//     `sprintState.deploySetAside` = { reason, notes, cycle } (written by
//     phases/deploy.mjs).
//
// When nothing is ready and every open in-scope bead is set aside -- or can
// only close through Integration Test while the deploy is set aside -- no
// further round or cycle can make progress, so the cycle loop throws the
// existing StalledSprintError at once instead of after STALL_CYCLE_LIMIT
// empty cycles. Everything here is pure; runner.js gathers the inputs.
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

/** The pseudo-id naming the set-aside deploy in blockerIds/blockerReasons. */
export const DEPLOY_SET_ASIDE_ID = 'deploy';

/**
 * Every set-aside record of this run, beads first (ordered by first seen,
 * then id), then the deploy. Empty when nothing was set aside.
 *
 * @param {{ doctorBlockedIds?: Map<string, object>, deploySetAside?: object|null }|null|undefined} sprintState
 * @returns {{ id: string, kind: string, blockedBy?: string, reason: string, cycle: number|null, round: number|null }[]}
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
        });
    }
    const kindRank = (k) => (k === 'blocked' ? 0 : 1);
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
 * reason, first seen). Empty array when nothing was set aside, so callers
 * omit the section entirely.
 *
 * @param {ReturnType<typeof collectSetAsideEntries>} entries
 * @returns {string[]}
 */
export function formatSetAsideItems(entries) {
    return (entries || []).map((e) => `${e.id}: ${e.reason} (first seen ${formatFirstSeen(e)})`);
}

/**
 * The immediate-stall decision. Returns null unless EVERY open in-scope bead
 * at goal priority is set aside: in doctorBlockedIds, stuck behind a
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
 * @returns {null | { blockerIds: string[], blockerReasons: Record<string, string>, entries: ReturnType<typeof collectSetAsideEntries> }}
 */
export function evaluateSetAsideStall({ openIds, integBoundIds = [], verifyBlockedIds = [], doctorBlockedIds = new Map(), deploySetAside = null, stuckIds = new Map() }) {
    const integBound = new Set(integBoundIds);
    const verifyBlocked = new Set(verifyBlockedIds);
    const candidates = [...new Set([...(openIds || []), ...integBound])];
    if (candidates.length === 0) return null;
    const blocked = doctorBlockedIds instanceof Map ? doctorBlockedIds : new Map();
    const stuck = stuckIds instanceof Map ? stuckIds : new Map();
    const covered = (id) => blocked.has(id) || stuck.has(id)
        || (!!deploySetAside && (integBound.has(id) || verifyBlocked.has(id)));
    if (!candidates.every(covered)) return null;

    const entries = collectSetAsideEntries({ doctorBlockedIds: blocked, deploySetAside });
    const blockerReasons = {};
    for (const e of entries) blockerReasons[e.id] = `${e.reason} (first seen ${formatFirstSeen(e)})`;
    for (const id of candidates) {
        if (blockerReasons[id]) continue;
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

/**
 * Open beads that are not set aside but cannot run in this sprint because a
 * prerequisite of theirs cannot close: an unmet in-scope prerequisite (an
 * open 'blocks' dependency or an open lower-order lane-mate) that is set
 * aside or itself stuck, transitively; or, for a bead that is WAITING after a
 * BLOCKED report, an open prerequisite outside the sprint scope. A
 * file-conflict edge onto a set-aside bead is satisfied (that dependent is
 * dispatchable), so it never makes a bead stuck. A bead whose prerequisites
 * can all still close is not stuck: it keeps the run going.
 *
 * @param {object} opts
 * @param {Array<object>} opts.scopeBeads every in-scope bead, any status
 * @param {Array<object>} [opts.allBeads] every bead, any status
 * @param {Map<string, object>} [opts.doctorBlockedIds]
 * @param {Map<string, object>} [opts.waitingIds]
 * @returns {Map<string, string>} stuck id -> reason
 */
export function stuckBehindSetAside({ scopeBeads, allBeads = [], doctorBlockedIds = new Map(), waitingIds = new Map() }) {
    const blocked = doctorBlockedIds instanceof Map ? doctorBlockedIds : new Map();
    const waiting = waitingIds instanceof Map ? waitingIds : new Map();
    const out = new Map();
    if (blocked.size === 0 && waiting.size === 0) return out;
    const open = (Array.isArray(scopeBeads) ? scopeBeads : [])
        .filter((b) => b && b.status !== 'closed' && !blocked.has(String(b.id)));
    const pre = new Map(open.map((b) => [String(b.id), unmetPrerequisites(b, { scopeBeads, allBeads, setAsideIds: blocked })]));
    let changed = true;
    while (changed) {
        changed = false;
        for (const b of open) {
            const id = String(b.id);
            if (out.has(id)) continue;
            const p = pre.get(id);
            const stuckOn = p.inScope.filter((x) => blocked.has(x) || out.has(x));
            if (stuckOn.length > 0) {
                out.set(id, `${waiting.has(id) ? 'waiting' : 'held'} on ${stuckOn.join(', ')}, which cannot close in this run (set aside, or itself waiting on a set-aside bead)`);
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
            ? unmetPrerequisites(bead, { scopeBeads, allBeads, setAsideIds: blocked })
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
