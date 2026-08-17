// apra-fleet-x8r.1: closed/required bead-count derivation for the
// beads-closed/required progress-bar widget.
//
// Deliberately does NOT re-walk the parent-edge BFS runner.js's
// bdListScoped()/decomposedParentIds() already perform to discover "what is
// in scope for this sprint" -- that would be a second, independently
// maintained definition of "in scope" that could silently drift from the
// completion gate's own. Instead this takes the ALREADY-SCOPED bead list the
// caller already has on hand (dashboard.mjs's `sprintTasks`, itself built
// from `bdListScoped('')` -- see runner.js's updateDashboard()) and only
// derives the two counts a viewer needs from it: how many of those beads are
// closed, and how many total. Pure/sync, no I/O -- takes data, returns data.
//
// apra-fleet-4p5-style: also embedded verbatim (via `.toString()`) into
// viewer-extensions.mjs's browser-side `<script>` alongside renderBeadsHtml,
// so the exact function under test here is the exact function that renders
// the widget in the browser -- never a hand-duplicated copy.
//
// apra-fleet-x8r.4: `required` originally defaulted to `beads.length` --
// EVERY bead in the sprint's scope, regardless of priority or structure. But
// runner.js's real completion gate (~line 8134) computes
// `openAtGoal = bdListScoped('--status=<NOT_DONE> --priority-max=<goalMax>')
// MINUS decomposedParentIds()`: below-goal-priority beads and decomposed
// parent (grouping) nodes are NOT part of the required-to-close set that
// actually gates sprint exit. Left unfiltered, a sprint whose scope contains
// either could legitimately complete while this widget still showed less
// than N/N -- the opposite of "how much of this sprint's required work is
// done". `opts` is ADDITIVE-OPTIONAL (a bare `computeSprintProgress(beads)`
// call -- e.g. a caller that has not been plumbed a goalMax/decomposed set
// yet -- keeps its original all-of-scope behavior) so every existing/future
// call site stays valid without redesigning this signature again.
//
// Both fields are plumbed in from the SAME server-side sources runner.js's
// gate itself uses (goalPriorityMax(validated.goal), decomposedParentIds())
// -- never re-derived here or client-side, so there is exactly one
// "what does this sprint still need to close" definition in the package.

// apra-fleet-x8r.8: runner.js's partitionByGoalMembership() (eft.52.1.3) can
// place a below-goal-priority bead in the Sprint section via a documented
// blocks-edge exception -- a bead that BLOCKS an in-goal bead is admitted
// into 'sprint' placement even though its own priority is below goalMax. That
// server-computed decision is tagged verbatim onto the row as `placement`
// ('sprint' | 'backlog') and is exactly what the beads TREE (renderBeadsHtml)
// honors when deciding which section a row renders in. Before this fix,
// computeSprintProgress() re-derived membership from raw numeric priority
// alone (`priority > goalMax` -> excluded), ignoring `placement` -- so a
// blocks-exception bead could render as an open Sprint row in the tree while
// being silently excluded from the 'M/N' count directly above it (the bar
// reads N/N while a visibly-open row sits right below). Reusing `placement`
// when present (rather than re-deriving from priority) makes the bar and the
// tree agree on exactly the same admitted set.
/**
 * @param {Array<{id?: string, status?: string, priority?: number, placement?: string}>} beads the
 *   sprint's already-scoped bead list (e.g. dashboard.mjs's `sprintTasks`,
 *   sourced from `bdListScoped('')`)
 * @param {{ goalMax?: number, decomposedParentIds?: Iterable<string> }} [opts]
 *   `goalMax` is the NUMERIC worst priority tier named in the sprint's goal
 *   (e.g. `goalPriorityMax('P1/P2')` -> `'P2'` -> `goalMax: 2`) -- a bead
 *   whose `priority` is a finite number strictly greater than `goalMax` is
 *   below-goal and excluded from `required`/`closed`, UNLESS that bead
 *   carries a server-computed `placement` field (apra-fleet-eft.52.1.3),
 *   in which case `placement` decides membership instead (`'backlog'` ->
 *   excluded, anything else, e.g. `'sprint'` -> included) so the bar can
 *   never disagree with the tree it sits above (apra-fleet-x8r.8). Rows with
 *   no `placement` field (dashboard.mjs's listAllBeads-sourced rows never
 *   carry one) fall back to the plain numeric filter, unchanged.
 *   `decomposedParentIds` is the set of bead ids that are themselves someone
 *   else's `.parent` (any status) -- excluded the same way runner.js's exit
 *   gate excludes them, regardless of `placement`.
 *   Omitting `opts` (or either field) applies no filtering on that axis,
 *   preserving the pre-x8r.4 "every bead in scope" behavior.
 * @returns {{ closed: number, required: number, fraction: number }}
 *   `fraction` is `closed / required`, clamped to 0 when `required` is 0
 *   (never NaN/Infinity from a divide-by-zero).
 */
export function computeSprintProgress(beads, opts) {
    const list = Array.isArray(beads) ? beads : [];
    const goalMax = opts && typeof opts.goalMax === 'number' && Number.isFinite(opts.goalMax)
        ? opts.goalMax
        : null;
    const decomposedParentIds = opts && opts.decomposedParentIds
        ? new Set(opts.decomposedParentIds)
        : null;
    const filtered = list.filter((b) => {
        if (!b) return false;
        if (decomposedParentIds && decomposedParentIds.has(b.id)) return false;
        if (typeof b.placement === 'string') {
            // Server-computed placement already decided which section this
            // bead belongs to (including the blocks-edge exception) -- reuse
            // it verbatim instead of re-deriving from priority, so the bar
            // agrees with the tree exactly.
            return b.placement !== 'backlog';
        }
        if (goalMax !== null && typeof b.priority === 'number' && b.priority > goalMax) return false;
        return true;
    });
    const required = filtered.length;
    const closed = filtered.filter((b) => String(b.status).toLowerCase() === 'closed').length;
    const fraction = required > 0 ? closed / required : 0;
    return { closed, required, fraction };
}
