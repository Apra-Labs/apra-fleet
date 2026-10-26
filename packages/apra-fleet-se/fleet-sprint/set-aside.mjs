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
 * at goal priority is set aside: in doctorBlockedIds, or -- while the deploy
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
 * @returns {null | { blockerIds: string[], blockerReasons: Record<string, string>, entries: ReturnType<typeof collectSetAsideEntries> }}
 */
export function evaluateSetAsideStall({ openIds, integBoundIds = [], verifyBlockedIds = [], doctorBlockedIds = new Map(), deploySetAside = null }) {
    const integBound = new Set(integBoundIds);
    const verifyBlocked = new Set(verifyBlockedIds);
    const candidates = [...new Set([...(openIds || []), ...integBound])];
    if (candidates.length === 0) return null;
    const blocked = doctorBlockedIds instanceof Map ? doctorBlockedIds : new Map();
    const covered = (id) => blocked.has(id)
        || (!!deploySetAside && (integBound.has(id) || verifyBlocked.has(id)));
    if (!candidates.every(covered)) return null;

    const entries = collectSetAsideEntries({ doctorBlockedIds: blocked, deploySetAside });
    const blockerReasons = {};
    for (const e of entries) blockerReasons[e.id] = `${e.reason} (first seen ${formatFirstSeen(e)})`;
    for (const id of candidates) {
        if (blockerReasons[id]) continue;
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
