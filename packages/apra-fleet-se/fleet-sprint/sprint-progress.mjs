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

/**
 * @param {Array<{status?: string}>} beads the sprint's already-scoped bead
 *   list (e.g. dashboard.mjs's `sprintTasks`, sourced from `bdListScoped('')`)
 * @returns {{ closed: number, required: number, fraction: number }}
 *   `fraction` is `closed / required`, clamped to 0 when `required` is 0
 *   (never NaN/Infinity from a divide-by-zero).
 */
export function computeSprintProgress(beads) {
    const list = Array.isArray(beads) ? beads : [];
    const required = list.length;
    const closed = list.filter((b) => b && String(b.status).toLowerCase() === 'closed').length;
    const fraction = required > 0 ? closed / required : 0;
    return { closed, required, fraction };
}
