// =============================================================================
// Pure reachability helpers over an already-fetched bead list.
//
// Nothing here issues a command: every function takes the beads the caller
// already holds (the shared full-DB snapshot or a scoped list derived from it)
// and returns plain data. runner.js decides what to log, mutate or refuse.
//
// Two questions live here:
//   1. Which in_progress claims may the sprint reset to open
//      (selectReclaimCandidates), and which beads does each reset unblock
//      (downstreamDependentIds)?
//   2. Which not-done beads can never become ready because every unmet
//      `blocks` dependency they have is a verify-routed bead
//      (findUnreachableVerifyBlocks), and what exact bd dep commands would
//      break that shape (verifyBlockFixCommands)?
// =============================================================================

const isBlocksEdge = (d) => d && d.type === 'blocks' && typeof d.depends_on_id === 'string';

/**
 * Not-done beads whose ONLY unmet `blocks` dependencies are verify-routed
 * beads. A verify-routed bead (classifyVerifySet in beads-scope.mjs) closes
 * only through the integ-test phase; with no integ-test playbook that phase
 * never runs, so such a bead can never close and anything waiting solely on
 * it can never become ready.
 *
 * A bead is reported iff it is not closed, not deferred, not itself
 * verify-routed, has at least one unmet `blocks` blocker, and every unmet
 * blocker is in `verifyIds`. Only `blocks` edges count; `related` and
 * `parent-child` edges never gate readiness.
 *
 * @param {object[]} notDoneBeads - beads to inspect (closed ones are skipped).
 * @param {Iterable<string>} verifyIds - ids classified as verify-routed.
 * @param {{ isUnmet?: (id: string) => boolean }} [opts] - decides whether a
 *   blocker is still unmet. Defaults to "the blocker is in notDoneBeads".
 *   Callers whose list is a filtered subset (e.g. goal-priority only) pass a
 *   predicate backed by the closed-id set instead.
 * @returns {Array<{ id: string, blockerIds: string[] }>} in input order, with
 *   blockers in dependency order.
 */
export function findUnreachableVerifyBlocks(notDoneBeads, verifyIds, { isUnmet } = {}) {
    const verify = new Set(verifyIds);
    const notDoneIds = new Set(notDoneBeads.filter((b) => b.status !== 'closed').map((b) => b.id));
    const unmet = typeof isUnmet === 'function' ? isUnmet : (id) => notDoneIds.has(id);

    const hits = [];
    for (const bead of notDoneBeads) {
        if (bead.status === 'closed' || bead.status === 'deferred') continue;
        if (verify.has(bead.id)) continue;
        const blockerIds = [];
        for (const d of bead.dependencies || []) {
            if (!isBlocksEdge(d)) continue;
            if (!unmet(d.depends_on_id)) continue;
            if (!blockerIds.includes(d.depends_on_id)) blockerIds.push(d.depends_on_id);
        }
        if (blockerIds.length === 0) continue;
        if (!blockerIds.every((id) => verify.has(id))) continue;
        hits.push({ id: bead.id, blockerIds });
    }
    return hits;
}

/**
 * The exact commands that turn each verify-routed `blocks` edge of a hit into
 * a `related` edge, so the bead becomes ready while keeping the link. Returned
 * for the operator to run; the engine never rewrites the DAG itself.
 * @param {{ id: string, blockerIds: string[] }} hit
 * @returns {string[]}
 */
export function verifyBlockFixCommands(hit) {
    const out = [];
    for (const blockerId of hit.blockerIds) {
        out.push(`bd dep remove ${hit.id} ${blockerId}`);
        out.push(`bd dep add ${hit.id} ${blockerId} --type related`);
    }
    return out;
}

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
