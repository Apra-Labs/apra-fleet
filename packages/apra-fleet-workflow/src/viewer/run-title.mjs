import { escapeHtml } from './html-utils.mjs';

/**
 * apra-fleet-dm5.1: builds a short, human-readable "run title" sentence for
 * the workflow viewer's header -- e.g.
 * "win-dev1 working apra-fleet-x8r, apra-fleet-dm5 (P1/P2/P3)" for a
 * fleet-sprint run -- instead of the bare workflow name the header showed
 * before this.
 *
 * Reads `state.args` (apra-fleet-eft.2.2's `launchArgs`-derived field,
 * currently populated only where a caller opts in -- apra-fleet-dm5.2 wires
 * fleet-sprint's own runner.js to actually publish it). Deliberately reads
 * only three plain, additive fields off it -- `members` (string[]),
 * `targetIssues` (string[], the sprint's issue-root ids), `goal` (string,
 * e.g. 'P1/P2') -- so this stays workflow-agnostic: any OTHER workflow's
 * `args` shape (or no `args` at all) simply doesn't have these three fields
 * and falls through to the plain workflow-name fallback below, never
 * throwing and never rendering 'undefined'/an empty parenthetical/a
 * dangling separator.
 *
 * Returns an ALREADY HTML-ESCAPED string (every user-supplied piece --
 * member names, bead ids, the goal string -- is run through the shared
 * `escapeHtml()` before being embedded into the sentence), safe to assign
 * directly to an element's `innerHTML` in the browser-side render code
 * below. This function's OWN source text is also embedded verbatim (via
 * `.toString()`) into that same client-side `<script>`, same pattern as
 * `renderBeadsHtml`/`escapeHtml` elsewhere in this codebase, so the exact
 * code under test here is the exact code that renders in the browser.
 *
 * @param {{ workflowName?: string, args?: { members?: string[], targetIssues?: string[], goal?: string } } | null | undefined} state
 * @returns {string}
 */
export function buildRunTitle(state) {
    const s = (state && typeof state === 'object') ? state : {};
    const fallback = escapeHtml(
        (typeof s.workflowName === 'string' && s.workflowName.length > 0) ? s.workflowName : 'Apra Fleet Workflow'
    );

    const args = (s.args && typeof s.args === 'object') ? s.args : null;
    if (!args) return fallback;

    const members = Array.isArray(args.members)
        ? args.members.filter((m) => typeof m === 'string' && m.length > 0)
        : [];
    const targetIssues = Array.isArray(args.targetIssues)
        ? args.targetIssues.filter((i) => typeof i === 'string' && i.length > 0)
        : [];
    const goal = (typeof args.goal === 'string' && args.goal.length > 0) ? args.goal : '';

    // Every field is required to build the full sentence -- a partial set
    // (e.g. members known but no goal yet) degrades cleanly to the plain
    // workflow name rather than rendering a sentence with a missing clause.
    if (members.length === 0 || targetIssues.length === 0 || goal.length === 0) return fallback;

    const membersText = escapeHtml(members.join(', '));
    const issuesText = escapeHtml(targetIssues.join(', '));
    const goalText = escapeHtml(goal);

    return `${membersText} working ${issuesText} (${goalText})`;
}
