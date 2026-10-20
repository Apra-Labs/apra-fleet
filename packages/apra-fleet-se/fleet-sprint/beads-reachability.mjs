// =============================================================================
// Pure helpers for the PRE-LAUNCH stale-claim reclaim (reclaimStaleInProgress
// in runner.js) and for naming what any reclaim unblocks.
//
// Nothing here issues a command: every function takes beads the caller
// already holds (the shared snapshot, a fresh `bd list`, or a fresh `bd show`)
// and returns plain data. runner.js owns every read and write.
//
//   - isPreLaunchReclaimCandidate: the pre-launch rule itself -- in_progress,
//     no unmet `blocks` dependency, claimed before this sprint launched (or
//     with no parseable started_at), and not an id this run already took
//     over (settledIds: reclaimed once already, or dispatched to a doer of
//     this run -- from then on its claims belong to the in-run tracker).
//   - confirmPreLaunchCandidates: the fresh-read gate. A candidate picked from
//     the cached snapshot (which can lag a cycle behind agent-made closes) is
//     only written to if a FRESH read still shows it in_progress under the
//     same assignee. The snapshot pre-filters; it never authorizes a write.
//   - downstreamDependentIds: the beads waiting on a reclaimed bead through a
//     `blocks` edge, for the reclaim log line.
//
// WHY settledIds AND NOT started_at. bd stamps started_at on a bead's FIRST
// claim only; re-claiming a reopened bead keeps the old stamp. So once this
// run reclaims a pre-launch bead and a doer of this run claims it again, its
// started_at still predates the launch, and the pre-launch rule alone would
// treat this run's own claim as stale. Excluding every id this run has
// reclaimed or dispatched is the only reliable boundary.
//
// GUARD COVERAGE: registered in guarded-modules.mjs. No command() or agent()
// call site.
// =============================================================================

const isBlocksEdge = (d) => d && d.type === 'blocks' && typeof d.depends_on_id === 'string';

/**
 * True when `startedAt` (an ISO string, or absent) predates `sprintLaunchTime`
 * (epoch ms). A missing or unparseable value counts as predating the launch:
 * `bd update --claim` always stamps started_at, so a claim with none can only
 * be orphaned state from something else.
 * @param {string|undefined|null} startedAt
 * @param {number} sprintLaunchTime
 */
export function claimPredatesLaunch(startedAt, sprintLaunchTime) {
    const startedAtMs = startedAt ? Date.parse(startedAt) : NaN;
    return Number.isNaN(startedAtMs) || startedAtMs < sprintLaunchTime;
}

/**
 * The pre-launch reclaim rule for one bead.
 * @param {object} bead
 * @param {{ notDoneIds: Set<string>, sprintLaunchTime: number, settledIds?: Set<string> }} ctx
 *   notDoneIds: ids that still count as unmet blockers.
 *   settledIds: ids this run already reclaimed or dispatched; never candidates.
 */
export function isPreLaunchReclaimCandidate(bead, { notDoneIds, sprintLaunchTime, settledIds = new Set() }) {
    if (!bead || bead.status !== 'in_progress') return false;
    if (settledIds.has(bead.id)) return false;
    const hasUnmetBlocker = (bead.dependencies || [])
        .some((d) => isBlocksEdge(d) && notDoneIds.has(d.depends_on_id));
    if (hasUnmetBlocker) return false;
    return claimPredatesLaunch(bead.started_at, sprintLaunchTime);
}

/**
 * Splits snapshot-picked candidates by what a fresh read says now. Confirmed
 * means the fresh bead is still in_progress AND still held by the assignee
 * the snapshot showed. A bead that closed or reopened since the snapshot, or
 * was claimed by a different actor in between (bd keeps the original
 * started_at on a re-claim, so the assignee is the only visible signal), is
 * rejected.
 * @param {object[]} candidates beads picked from the snapshot
 * @param {object[]} freshBeads the fresh `bd show` result for those ids
 * @returns {{ confirmed: object[], rejected: Array<{ id: string, status: string|null, reason: string }> }}
 *   confirmed carries the FRESH bead objects, in candidate order. Each
 *   reason is a full clause ("the fresh read shows 'closed'").
 */
export function confirmPreLaunchCandidates(candidates, freshBeads) {
    const freshById = new Map((Array.isArray(freshBeads) ? freshBeads : [])
        .filter((b) => b && typeof b.id === 'string')
        .map((b) => [b.id, b]));
    const assigneeOf = (b) => (b && typeof b.assignee === 'string' ? b.assignee : '');
    const confirmed = [];
    const rejected = [];
    for (const c of candidates) {
        const fresh = freshById.get(c.id);
        if (!fresh) {
            rejected.push({ id: c.id, status: null, reason: 'it is missing from the fresh read' });
            continue;
        }
        if (fresh.status !== 'in_progress') {
            rejected.push({ id: c.id, status: fresh.status || null, reason: `the fresh read shows '${fresh.status || 'unknown'}'` });
            continue;
        }
        if (assigneeOf(fresh) !== assigneeOf(c)) {
            rejected.push({ id: c.id, status: fresh.status, reason: `the fresh read shows it claimed by '${assigneeOf(fresh) || '(none)'}', not '${assigneeOf(c) || '(none)'}' as in the snapshot` });
            continue;
        }
        confirmed.push(fresh);
    }
    return { confirmed, rejected };
}

/**
 * Ids of the not-closed beads in `beads` that have a `blocks` dependency on
 * `id` -- the beads a reclaim of `id` puts back on the path to ready.
 * @param {object[]} beads
 * @param {string} id
 * @returns {string[]} in input order.
 */
export function downstreamDependentIds(beads, id) {
    return (beads || [])
        .filter((b) => b && b.status !== 'closed')
        .filter((b) => (b.dependencies || []).some((d) => isBlocksEdge(d) && d.depends_on_id === id))
        .map((b) => b.id);
}

/**
 * The log suffix naming what a reclaim of `id` unblocks.
 * @param {object[]} beads
 * @param {string} id
 */
export function downstreamSuffix(beads, id) {
    const downstream = downstreamDependentIds(beads, id);
    return downstream.length > 0
        ? ` Downstream bead(s) waiting on it: ${downstream.join(', ')}.`
        : ' No downstream bead is waiting on it.';
}
