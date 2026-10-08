// =============================================================================
// Pure reachability helpers over an already-fetched bead list.
//
// Nothing here issues a command: every function takes the beads the caller
// already holds (the shared full-DB snapshot or a scoped list derived from it)
// and returns plain data. runner.js decides what to log, mutate or refuse.
//
// The question answered here: which in_progress claims may the sprint
// reset to open (selectReclaimCandidates), and which beads does each reset
// unblock (downstreamDependentIds)?
// =============================================================================

const isBlocksEdge = (d) => d && d.type === 'blocks' && typeof d.depends_on_id === 'string';

/**
 * In_progress beads the sprint may reset to open.
 *
 * - 'orphan': this run dispatched the bead (its id is in `dispatchedIds`) and
 *   it is still in_progress after every dispatch returned, so no live
 *   dispatch owns the claim. Always a candidate, whatever its started_at or
 *   blockers say.
 * - 'pre-launch': only when `includePreLaunch` is true. The claim predates
 *   this sprint's launch (started_at earlier than `sprintLaunchTime`, or
 *   missing/unparseable) and the bead has no unmet `blocks` dependency
 *   within `notDoneBeads`, so it is not waiting on anything. A bead claimed
 *   after launch that this run never dispatched may belong to a concurrent
 *   sprint and is never selected.
 *
 * @param {{ notDoneBeads: object[], sprintLaunchTime: number,
 *   dispatchedIds?: Set<string>, includePreLaunch?: boolean }} opts
 * @returns {Array<{ bead: object, kind: 'orphan' | 'pre-launch' }>} in input order.
 */
export function selectReclaimCandidates({ notDoneBeads, sprintLaunchTime, dispatchedIds = new Set(), includePreLaunch = false }) {
    const notDoneIds = new Set(notDoneBeads.map((b) => b.id));
    const hasUnmetBlocker = (bead) => (bead.dependencies || [])
        .some((d) => isBlocksEdge(d) && notDoneIds.has(d.depends_on_id));

    const picked = [];
    for (const bead of notDoneBeads) {
        if (bead.status !== 'in_progress') continue;
        if (dispatchedIds.has(bead.id)) {
            picked.push({ bead, kind: 'orphan' });
            continue;
        }
        if (!includePreLaunch) continue;
        if (hasUnmetBlocker(bead)) continue;
        const startedAtMs = bead.started_at ? Date.parse(bead.started_at) : NaN;
        if (Number.isNaN(startedAtMs) || startedAtMs < sprintLaunchTime) {
            picked.push({ bead, kind: 'pre-launch' });
        }
    }
    return picked;
}

/**
 * Ids of the beads in `notDoneBeads` that have a `blocks` dependency on `id`
 * -- the beads a reclaim of `id` puts back on the path to ready.
 * @param {object[]} notDoneBeads
 * @param {string} id
 * @returns {string[]} in input order.
 */
export function downstreamDependentIds(notDoneBeads, id) {
    return notDoneBeads
        .filter((b) => (b.dependencies || []).some((d) => isBlocksEdge(d) && d.depends_on_id === id))
        .map((b) => b.id);
}
