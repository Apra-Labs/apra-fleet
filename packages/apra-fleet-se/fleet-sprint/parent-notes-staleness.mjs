// =============================================================================
// PARENT-NOTES STALENESS SIGNAL (apra-fleet-fsxg).
//
// A structural, tooling-computed advisory that does NOT depend on the model
// remembering to look: when a bead in the dispatch scope had its NOTES updated
// AFTER its most recently created child, its existing decomposition may predate
// the latest NOTES corrections. The planner/plan-reviewer role prompts already
// TELL the agent to read a bead's NOTES before decomposing/reviewing (see the
// companion role-prompt fixes), but a prompt instruction is the weakest layer:
// it fires only if the model chooses to perform the check, which is exactly the
// failure mode that motivated this -- an original decomposition simply never
// looked at NOTES. This module turns "remember to check for a stale
// decomposition" into "here is a specific bead the tooling already flagged --
// go look", closer to a linter finding than a style-guide reminder.
//
// STRICTLY ADVISORY: nothing here ever blocks a dispatch or fails a plan. A
// fired signal only ADDS a note to the planner/plan-reviewer dispatch context;
// an absent or errored signal changes nothing. A false negative (the bd calls
// fail, or beads exposes no notes-change timestamp) simply falls back to the
// pre-existing prompt-only behaviour.
//
// GENERIC: every string this module emits is product-generic. It names no
// target repo, build command, env var, or bead id -- the only ids that appear
// in its output are interpolated at RUNTIME from the live sprint scope (exactly
// as buildPlannerPrompt already interpolates targetIssues), never written as
// literals. Registered in guarded-modules.mjs; its two command() call sites
// each name member_name explicitly.
//
// WHY `bd history` AND NOT `updated_at`. beads stores `notes` as a single text
// field with no notes-specific timestamp; the bead-level `updated_at` moves on
// ANY mutation (status, priority, claim, close), so using it as a proxy for
// "notes last changed" would false-positive constantly and violate this
// feature's "no false positives on the common case" requirement. `bd history
// <id> --json` returns a per-commit snapshot of the whole issue (including its
// notes text), so walking it oldest-first isolates the exact commit at which
// the notes text last actually changed.
// =============================================================================

/**
 * Derives the timestamp at which a bead's NOTES text last actually changed,
 * from `bd history <id> --json` output. The history is an array of per-commit
 * snapshots, NEWEST first, each shaped `{ CommitDate, Issue: { notes } }`.
 *
 * Walks the snapshots oldest-first, tracking the commit at which the notes
 * text last transitioned to a new value. Returns that commit's date string, or
 * `null` when the bead never carried notes, when the notes text never changed
 * from empty, or when the CURRENT (newest) notes are empty -- an empty final
 * notes field describes no correction, so it is never a staleness signal.
 *
 * @param {Array<{ CommitDate?: string, Issue?: { notes?: unknown } }>} history
 * @returns {string|null} the ISO-ish date string of the last notes change, or null
 */
export function notesLastUpdatedAtFromHistory(history) {
    if (!Array.isArray(history) || history.length === 0) return null;
    // History arrives newest-first; walk it oldest-first so a change is
    // recorded at the commit that INTRODUCED it, not the latest commit that
    // merely carried it forward unchanged.
    const oldestFirst = [...history].reverse();
    let prevNotes = '';
    let lastChangeDate = null;
    for (const entry of oldestFirst) {
        const rawNotes = entry && entry.Issue && typeof entry.Issue.notes === 'string'
            ? entry.Issue.notes
            : '';
        const notes = rawNotes.trim();
        if (notes !== prevNotes) {
            lastChangeDate = entry && typeof entry.CommitDate === 'string' ? entry.CommitDate : lastChangeDate;
            prevNotes = notes;
        }
    }
    // Final notes empty (never set, or explicitly cleared): no correction to be
    // stale against.
    if (prevNotes.length === 0) return null;
    return lastChangeDate;
}

/**
 * Picks the child with the most recent valid `created_at`, or null if none of
 * the children carry a parseable creation timestamp.
 * @param {Array<{ id?: string, created_at?: string }>} children
 * @returns {{ id?: string, created_at: string }|null}
 */
function mostRecentlyCreatedChild(children) {
    if (!Array.isArray(children)) return null;
    let best = null;
    let bestTime = -Infinity;
    for (const child of children) {
        const createdAt = child && typeof child.created_at === 'string' ? child.created_at : null;
        if (!createdAt) continue;
        const time = Date.parse(createdAt);
        if (Number.isNaN(time)) continue;
        if (time > bestTime) {
            bestTime = time;
            best = { id: child && child.id, created_at: createdAt };
        }
    }
    return best;
}

/**
 * Decides whether a single bead's NOTES are newer than its most recently
 * created child and, if so, returns a generic, advisory staleness note naming
 * the bead; otherwise returns null.
 *
 * Returns null (NO false positive) when the bead has no children, when no child
 * carries a parseable creation timestamp, when the notes-updated timestamp is
 * absent/unparseable, or when the notes are NOT strictly newer than the most
 * recently created child (the common case: notes predate the decomposition).
 *
 * @param {{ id: string, notesUpdatedAt: string|null, children: Array<{ id?: string, created_at?: string }> }} args
 * @returns {string|null}
 */
export function computeParentNotesStalenessNote({ id, notesUpdatedAt, children }) {
    if (typeof notesUpdatedAt !== 'string' || notesUpdatedAt.length === 0) return null;
    const notesTime = Date.parse(notesUpdatedAt);
    if (Number.isNaN(notesTime)) return null;

    const child = mostRecentlyCreatedChild(children);
    if (!child) return null;
    const childTime = Date.parse(child.created_at);
    if (Number.isNaN(childTime)) return null;

    // Strictly newer: notes exactly co-timed with the last child are not stale.
    if (notesTime <= childTime) return null;

    const childLabel = child.id ? `${child.id}, created ${child.created_at}` : `created ${child.created_at}`;
    return (
        `Bead ${id}: its NOTES were last updated (${notesUpdatedAt}) AFTER its most recently ` +
        `created child (${childLabel}). Its existing decomposition may predate the latest NOTES ` +
        `entries -- read this bead's full NOTES and verify its existing children are still consistent ` +
        `with them before proceeding, treating any later correction/amendment recorded in NOTES as ` +
        `authoritative over stale DESCRIPTION text or any child that contradicts it.`
    );
}

/**
 * Formats a set of per-bead staleness notes into one prominent, advisory block
 * for injection into a planner/plan-reviewer dispatch prompt. Returns null when
 * there is nothing to surface, so the prompt is unchanged in the common case.
 * @param {string[]} notes
 * @returns {string|null}
 */
export function formatStalenessBlock(notes) {
    if (!Array.isArray(notes) || notes.length === 0) return null;
    const header =
        'TOOLING-COMPUTED STALENESS SIGNAL -- the dispatch tooling detected, without relying on you ' +
        'to remember to check, that the following in-scope bead(s) had their NOTES updated AFTER their ' +
        'most recently created child. Their existing decomposition may therefore predate the latest ' +
        'NOTES corrections. This is ADVISORY ONLY: it never blocks planning and is not itself a defect, ' +
        'but treat each as a specific bead to inspect first:';
    return [header, ...notes.map((n, i) => `${i + 1}. ${n}`)].join('\n\n');
}

/**
 * Computes the parent-NOTES staleness notes for a set of scope bead ids by
 * reading each bead's children (`bd list --parent <id> --json`) and, when it
 * has children, its notes-change history (`bd history <id> --json`). Pure
 * fetch-and-compute: never mutates beads, never blocks, and swallows per-bead
 * bd failures (advisory feature -- a failed probe simply yields no note).
 *
 * @param {{
 *   command: (label: string, opts: object) => Promise<unknown>,
 *   member: string,
 *   rootIds: string[],
 *   parseBdJson: (raw: unknown, label: string) => unknown,
 *   log?: (msg: string) => void,
 * }} args
 * @returns {Promise<string[]>} one note per stale bead, in rootIds order
 */
export async function collectParentNotesStalenessNotes({ command, member, rootIds, parseBdJson, log }) {
    const notes = [];
    const ids = Array.isArray(rootIds) ? rootIds : [];
    for (const id of ids) {
        if (!id) continue;
        let children;
        try {
            const label = `bd list --parent ${id} --json`;
            const raw = await command(label, { member_name: member, silent: true });
            children = parseBdJson(raw, label);
        } catch (err) {
            if (log) log(`[fleet-sprint] parent-NOTES staleness: child listing for '${id}' FAILED (non-fatal, skipped): ${err.message}`);
            continue;
        }
        if (!Array.isArray(children) || children.length === 0) continue;

        let notesUpdatedAt = null;
        try {
            const hLabel = `bd history ${id} --json`;
            const hRaw = await command(hLabel, { member_name: member, silent: true });
            const history = parseBdJson(hRaw, hLabel);
            notesUpdatedAt = notesLastUpdatedAtFromHistory(history);
        } catch (err) {
            if (log) log(`[fleet-sprint] parent-NOTES staleness: history read for '${id}' FAILED (non-fatal, skipped): ${err.message}`);
            continue;
        }

        const note = computeParentNotesStalenessNote({ id, notesUpdatedAt, children });
        if (note) notes.push(note);
    }
    return notes;
}
