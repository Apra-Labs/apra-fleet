// Verdict/newTask text surface for fleet-sprint (apra-fleet-3swo.6.14).
// Extracted out of runner.js; runner.js re-exports every symbol it previously
// exported from this region, so existing importers of fleet-sprint/runner.js
// resolve unchanged.
//
// This module owns:
//   - extractContestedBeadIds: scans a plan-reviewer verdict's free-text
//     `notes` for literal occurrences of in-scope bead ids, so a
//     CHANGES_NEEDED verdict can be told apart from a plan-wide one that
//     merely names specific offenders.
//   - SAFE_TEXT_RE: the newTask-title shell-injection allowlist (still
//     exported, unchanged shape -- see its own header comment below for why).
//   - normalizeTierToken: bead-metadata model-value tier normalization by
//     containment ('cheap'/'standard'/'premium').
//   - trackRejectedNewTaskForResurfacing / clearResubmittedNewTask /
//     reconcilePendingRejectedNewTasks / buildRejectedNewTaskResurfaceLines:
//     the pending-rejected-newTask resurfacing pipeline that feeds the
//     planner prompt (see prompts.mjs's buildPlannerPrompt, which imports
//     buildRejectedNewTaskResurfaceLines back from runner.js's facade).
//
// CROSS-FEATURE HANDOFF: extractContestedBeadIds is scheduled for RETIREMENT
// by a later Phase 5 bead that replaces plan-reviewer prose scraping with a
// structured findings field, and by the Phase 5 bead after that which deletes
// the retired prose-scraper helpers and updates the facade symbol pins. Both
// are blocked behind Phase 4's facade-completeness gate, so they run strictly
// after this extraction. This move relocates it verbatim -- no retirement,
// rewrite or deprecation here.

/**
 * Determines whether a plan-reviewer verdict is CONFINED to specific beads
 * rather than spanning the whole plan. plan-reviewer.md carries no structured
 * per-bead findings field -- `notes` is free text that names the offending
 * bead ids -- so this scans `notes` for literal occurrences of each id already
 * known to be in scope via `taskAssignments`, which plan-reviewer.md requires
 * to be populated on every round including CHANGES_NEEDED.
 *
 * An id matches only at a non-identifier-character boundary (or the string
 * start/end), so a shorter id cannot false-positive inside a longer one that
 * merely extends it.
 *
 * @param {{ notes?: string, taskAssignments?: Array<{ id?: string }> }} verdict
 * @returns {string[]} the subset of taskAssignments ids that notes calls out by name
 */
export function extractContestedBeadIds(verdict) {
    if (!verdict || typeof verdict.notes !== 'string' || !Array.isArray(verdict.taskAssignments)) {
        return [];
    }
    const notes = verdict.notes;
    const allIds = verdict.taskAssignments
        .map((a) => a && a.id)
        .filter((id) => typeof id === 'string' && id.length > 0);
    return allIds.filter((id) => {
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const boundary = '(?:^|[^A-Za-z0-9_-])';
        const endBoundary = '(?:$|[^A-Za-z0-9_-])';
        const re = new RegExp(`${boundary}${escaped}${endBoundary}`);
        return re.test(notes);
    });
}

// ---------------------------------------------------------------------------
// newTasks validation. Reviewer-authored newTasks are LLM output, and the
// reviewer's context includes the diff under review, so an adversarial
// diff/commit could try to steer it into emitting text crafted to break out of
// a shell command.
//
// SAFE_TEXT_RE (title only) deliberately excludes: backtick, `$`,
// double-quote (the command's own quoting delimiter -- allowing it back in
// would let a title close the quote early regardless of any other
// restriction), and backslash (blocks a trailing-backslash "escape the
// closing quote" trick as well as any other backslash-based escape
// sequence). The allowed punctuation (`.,:;!?()'-_/+[]` plus space) covers
// realistic task titles while remaining inert as shell syntax in both POSIX
// and Windows member shells.
//
// apra-fleet-v75: `[`, `]` and `+` are allowed. The title is interpolated as
// `bd create "${title}"` -- inside double quotes, brackets never glob and `+`
// has no meaning, in POSIX shells or PowerShell. Excluding them rejected this
// project's own bead-title convention ([bug]/[epic]/[test] prefixes), which
// `bd create` itself accepts; a real reviewer follow-up was dropped mid-sprint
// on exactly that. The characters that ARE live inside double quotes --
// `"`, `\`, backtick, `$` -- remain excluded, which is what this guard is for.
//
// `description` no longer reaches this shell-interpolation risk at all
// (apra-fleet-eft.56.1, transport hardened in eft.73.1):
// createChildBeadWithAllocatedId() stages it to a member-local temp file
// (base64-carried, member-side) and hands that path to `bd create
// --body-file`, never interpolating it into a command string. That removed
// the injection
// surface SAFE_TEXT_RE existed to close for descriptions, so
// SAFE_DESCRIPTION_RE only enforces the repo's own ASCII-only convention
// (plus non-empty) -- legitimate technical characters ('=', '&', '+', '"',
// backticks-as-text, '%', '#', '[', ']', etc.) are allowed again.
export const SAFE_TEXT_RE = /^[A-Za-z0-9 .,:;!?()'_/+[\]-]+$/;

/**
 * Normalizes a bead-metadata model value by CONTAINMENT: a value that
 * (case-insensitively) contains exactly ONE of the three tier names --
 * 'cheap', 'standard', 'premium' -- becomes that bare tier name, so
 * 'standard-tier', 'tier-standard' and 'Standard (default)' all resolve to
 * 'standard'. A value containing zero tier names (an explicit provider model
 * id) or more than one (ambiguous) passes through unchanged. This is the
 * single read site for that metadata: an un-normalized alias would reach the
 * dispatch as a literal provider model name and fail it outright.
 * @param {unknown} raw
 * @returns {unknown}
 */
export function normalizeTierToken(raw) {
    if (typeof raw !== 'string') return raw;
    const lowered = raw.toLowerCase();
    const matches = ['cheap', 'standard', 'premium'].filter((tier) => lowered.includes(tier));
    return matches.length === 1 ? matches[0] : raw;
}

// ---------------------------------------------------------------------------
// Resurfacing rejected newTasks into the next planning dispatch
// ---------------------------------------------------------------------------
//
// A note appended by appendRejectedFindingToParentNotes() is readable by a
// human but invisible to the planner, which is dispatched without resume and
// never reads bead notes. These helpers instead track the current set of
// not-yet-resubmitted rejected newTasks in run state so the planner prompt can
// carry them as explicit "previously rejected, fix and resubmit" items, and
// drop each one once resubmitted so the list cannot grow without bound. All
// are pure: the caller owns the array and none of these mutate it in place.

/**
 * Records a newly-rejected newTask into the pending resurface list, keyed by
 * title -- a newTask rejected twice under the same title keeps only the
 * LATEST rejection reason/cycle (dedup by title), so a repeatedly-resubmitted-
 * and-repeatedly-rejected item cannot grow the list unboundedly.
 * @param {Array<{title: string, description: string, reason: string, cycle: number|string}>} pending
 * @param {{title: unknown, description: unknown, reason: string, cycle: number|string}} rejected
 * @returns {Array<{title: string, description: string, reason: string, cycle: number|string}>} a NEW array
 */
export function trackRejectedNewTaskForResurfacing(pending, rejected) {
    const title = String((rejected && rejected.title) || '(untitled)');
    const description = String((rejected && rejected.description) || '');
    const entry = { title, description, reason: String(rejected && rejected.reason), cycle: rejected && rejected.cycle };
    const withoutDup = (Array.isArray(pending) ? pending : []).filter((p) => p.title !== title);
    return [...withoutDup, entry];
}

/**
 * Drops any pending rejected-newTask entries matching a newTask that has now
 * been successfully created.
 *
 * `resubmitted` may be a bare title string (title-only match) or a
 * `{title, description}` object, in which case a match on EITHER the title OR
 * a non-empty description clears the entry. Description matching is what
 * clears a resubmission whose title was corrected in response to the
 * rejection reason -- title-only matching would leave such an item pending
 * forever.
 * @param {Array<{title: string, description?: string}>} pending
 * @param {string|{title?: string, description?: string}} resubmitted
 * @returns {Array<{title: string}>} a NEW array
 */
export function clearResubmittedNewTask(pending, resubmitted) {
    const list = Array.isArray(pending) ? pending : [];
    const title = typeof resubmitted === 'string' ? resubmitted : String((resubmitted && resubmitted.title) || '');
    const description = (resubmitted && typeof resubmitted === 'object' && resubmitted.description)
        ? String(resubmitted.description) : '';
    return list.filter((p) => {
        const titleMatches = p.title === title;
        const descriptionMatches = description.length > 0 && String((p && p.description) || '') === description;
        return !(titleMatches || descriptionMatches);
    });
}

/**
 * Reconciles the pending resurface list against the parent bead's CURRENT
 * children, matching purely on description and ignoring titles. The planner
 * resubmits a corrected finding directly via `bd create` and never calls
 * clearResubmittedNewTask(), so without this pass a planner resubmission would
 * stay pending and reappear in every later planning prompt of the run. Call it
 * after any phase that may have created children under the parent (chiefly the
 * Plan phase), passing the live child list.
 * @param {Array<{title: string, description?: string}>} pending
 * @param {Array<{description?: string}>} currentChildren
 * @returns {Array<{title: string, description?: string}>} a NEW array
 */
export function reconcilePendingRejectedNewTasks(pending, currentChildren) {
    const list = Array.isArray(pending) ? pending : [];
    if (list.length === 0) return list;
    const children = Array.isArray(currentChildren) ? currentChildren : [];
    const childDescriptions = new Set(
        children
            .map((c) => String((c && c.description) || '').trim())
            .filter((d) => d.length > 0)
    );
    if (childDescriptions.size === 0) return list;
    return list.filter((p) => {
        const description = String((p && p.description) || '').trim();
        return description.length === 0 || !childDescriptions.has(description);
    });
}

/**
 * Formats the pending rejected-newTask items as explicit "previously rejected,
 * fix and resubmit" prompt lines for the planner prompt. Returns `[]` when
 * nothing is pending, so the prompt is unchanged in that case.
 * @param {Array<{title: string, description: string, reason: string, cycle: number|string}>} pending
 * @returns {string[]}
 */
export function buildRejectedNewTaskResurfaceLines(pending) {
    if (!Array.isArray(pending) || pending.length === 0) return [];
    const lines = [
        `${pending.length} previously REJECTED newTask(s) from an earlier round must be fixed and ` +
        're-submitted this planning pass. Verbatim title/description below, plus why each was ' +
        'rejected -- correct the stated defect (do not just resend the item unchanged), then create ' +
        'it via bd create as normal:',
    ];
    pending.forEach((r, i) => {
        lines.push(`${i + 1}. Title: "${r.title}"\nDescription: ${r.description}\nRejected because: ${r.reason} (cycle ${r.cycle})`);
    });
    return lines;
}
