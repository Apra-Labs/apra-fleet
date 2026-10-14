// =============================================================================
// IN-RUN ORPHANED-CLAIM TRACKING (GitHub #715).
//
// A doer of THIS sprint claims its beads (`bd update --claim`, by the engine
// and/or the doer itself), so a doer that then dies, exhausts its resumes or
// returns BLOCKED leaves the bead 'in_progress'. `bd ready` never offers an
// in_progress bead, so the bead -- and every bead its `blocks` chain hides --
// is stuck for the rest of the sprint. reclaimStaleInProgress in runner.js
// cannot help: it only reclaims claims that PREDATE the sprint launch.
//
// This module is the pure bookkeeping half of the fix. It records, per bead
// id, the latest streak outcome a doer dispatch of THIS run produced, and
// answers "which of those beads is an orphan candidate right now". It issues
// no command of its own: runner.js owns the fresh read, the session stop and
// the write, so every bd/fleet call stays inside the guarded runner surface.
//
// RULES (each one is a reason a bead is NOT a candidate):
//   - its latest outcome closed it, or it was never failed -> nothing to do;
//   - its streak failed because every bead was already claimed by ANOTHER
//     sprint (structured reason CLAIMED_ELSEWHERE_REASON, carried on the
//     outcome, never matched from message text) -> that claim belongs to the
//     other sprint and is never touched;
//   - its streak COMPLETED but the post-dispatch sync failed (including the
//     permission-scope publish-blocked case) -> the work is committed on the
//     doer's clone and the engine has already decided not to re-dispatch it;
//   - the cached snapshot does not show it in_progress -> nothing to reclaim.
//     The snapshot is only a PRE-FILTER that saves a fresh read on the common
//     path; it never authorizes a write (runner.js re-reads before writing);
//   - it has already been reclaimed ORPHAN_RECLAIM_LIMIT times -> capped and
//     surfaced instead of bounced again.
//
// A reclaimed id is DROPPED from the tracker (forget/markReclaimed): it is
// only re-added when a doer of this run is dispatched on it again, so a later
// claim of the same bead by another actor is never reset at a cycle top.
//
// GUARD COVERAGE: registered in guarded-modules.mjs. It carries no command()
// or agent() call site.
// =============================================================================

/** Re-dispatch bound per bead, across the whole sprint. */
export const ORPHAN_RECLAIM_LIMIT = 2;

/**
 * The structured `reason` develop.mjs carries on a streak outcome whose
 * claim found every bead already held by another sprint.
 */
export const CLAIMED_ELSEWHERE_REASON = 'all-beads-already-claimed';

/**
 * @param {{ limit?: number }} [opts]
 */
export function createOrphanClaimTracker(opts = {}) {
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : ORPHAN_RECLAIM_LIMIT;
    // id -> { doerMember, failureReason, workCompleted }
    const failedById = new Map();
    const reclaimCounts = new Map();
    const cappedIds = new Set();

    return {
        /**
         * Fold one Develop round's streak outcomes in. Every bead a doer of
         * this run was dispatched on is recorded by its LATEST outcome: a
         * closed bead is dropped, a still-open bead of a failed streak is
         * recorded as failed with the streak's structured failure reason.
         * @param {object[]} streakOutcomes develop.mjs's per-streak outcomes
         */
        recordOutcomes(streakOutcomes) {
            for (const o of streakOutcomes || []) {
                const unclosed = new Set(o.unclosedIds || []);
                for (const id of o.beadIds || []) {
                    if (o.outcome !== 'failed' || !unclosed.has(id)) {
                        failedById.delete(id);
                        continue;
                    }
                    failedById.set(id, {
                        doerMember: o.doerMember || null,
                        failureReason: o.failureReason || null,
                        workCompleted: o.publishBlocked === true || o.postDispatchSyncFailed === true,
                    });
                }
            }
        },

        /** True when at least one tracked bead's latest streak failed. */
        hasFailed() {
            return failedById.size > 0;
        },

        /**
         * Orphan candidates against a (possibly stale) beads snapshot. The
         * snapshot only narrows the set; the caller must confirm each
         * candidate with a fresh read before writing.
         * @param {object[]} snapshotBeads full or scoped `bd list` records
         * @returns {{ candidates: { id: string, doerMember: string|null }[], newlyCappedIds: string[] }}
         */
        candidates(snapshotBeads) {
            const statusById = new Map((snapshotBeads || []).map((b) => [b.id, b.status]));
            const candidates = [];
            const newlyCappedIds = [];
            for (const [id, rec] of [...failedById.entries()]) {
                if (rec.failureReason === CLAIMED_ELSEWHERE_REASON || rec.workCompleted) {
                    failedById.delete(id);
                    continue;
                }
                const status = statusById.get(id);
                if (status === 'closed') {
                    failedById.delete(id);
                    continue;
                }
                if (status !== 'in_progress') continue;
                if ((reclaimCounts.get(id) ?? 0) >= limit) {
                    failedById.delete(id);
                    if (!cappedIds.has(id)) {
                        cappedIds.add(id);
                        newlyCappedIds.push(id);
                    }
                    continue;
                }
                candidates.push({ id, doerMember: rec.doerMember });
            }
            return { candidates, newlyCappedIds };
        },

        /** Drop an id without counting a reclaim (e.g. a fresh read found it closed). */
        forget(id) {
            failedById.delete(id);
        },

        /**
         * Record a successful reclaim: the id leaves the tracker (re-added
         * only on re-dispatch) and its per-bead count grows.
         * @returns {number} the attempt number just used (1-based)
         */
        markReclaimed(id) {
            failedById.delete(id);
            const n = (reclaimCounts.get(id) ?? 0) + 1;
            reclaimCounts.set(id, n);
            return n;
        },

        /** Ids that hit the per-bead cap this sprint, in the order they hit it. */
        cappedIds() {
            return [...cappedIds];
        },

        /** Whether `id` is currently tracked as a failed dispatch of this run. */
        isTracked(id) {
            return failedById.has(id);
        },

        limit,
    };
}
