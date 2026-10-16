// Reviewer-verdict bead transitions for fleet-sprint (apra-fleet-3swo.4.7):
// the reopen/replan/close transitions the ORCHESTRATOR -- never the LLM --
// applies to beads after a role returns a verdict. Extracted out of runner.js;
// runner.js re-exports every symbol it previously exported from this region,
// so existing importers of fleet-sprint/runner.js resolve unchanged.
//
// THREE CALL SITES, ONE GUARD. Three places apply a reviewer-shaped verdict to
// beads, and before this extraction only two of them were guarded:
//
//   1. the per-round reviewer inside the Develop/Review loop,
//   2. Final Review, and
//   3. Re-Review (the "0 open beads at goal but the last verdict was not
//      APPROVED" branch) -- which looped over reopenIds issuing
//      `bd update <id> --status=open` with NO goal-scope guard at all.
//
// Site 3's omission was a real hole, not a deliberate exemption: reopening a
// DEFERRED below-goal bead injects work the sprint no longer targets and pins
// the verdict at CHANGES_NEEDED forever -- the exact failure the other two
// sites guard against. All three now go through applyGuardedReopens() below,
// so the guard cannot be forgotten by a fourth site either.
//
// WHAT WAS UNIFIED AND WHAT WAS DELIBERATELY NOT. The GUARD is unified. The
// PAYLOAD SHAPES are not: the three sites take three different reopen-entry
// shapes (site 1 bare string, site 2 `{id, reason}` with BOTH fields
// required, site 3 bare string), each with its own producer on the other end
// of a dispatch contract. Normalising the shape would be a behaviour change
// to those contracts, not a move, so each site keeps its own `parseEntry` and
// its own `buildReopenCommand` while sharing the allowlist, the below-goal
// check, the skip log text and the control flow.
//
// FAIL OPEN, DELIBERATELY. When the scope lookup THROWS, the allowlist is set
// to null and every reopen is applied UNGUARDED rather than dropped. This is
// intentional and must not be "hardened" into a fail-closed drop: a failed
// scope lookup is an infrastructure problem, and silently swallowing a
// reviewer's reopens because of one would lose real review signal with no
// trace. A null allowlist therefore means "apply everything", never "skip
// everything" -- see buildReopenAllowlist() and isDeferredScopeReopen().
// =============================================================================

/**
 * Detects the reviewer contract violation described on
 * `ReviewerContractViolationError`: a `CHANGES_NEEDED` verdict naming nothing
 * to reopen, proposing no follow-up work, AND naming no scoped-replan targets
 * is schema-legal but self-contradictory -- the orchestrator has nothing to
 * act on, so the sprint cannot make progress off of it. A non-empty
 * `replanIds` exempts the verdict from that hard abort even with empty
 * reopenIds/newTasks -- NOT because the field is guaranteed to be consumed
 * (foldReplanIds() below only accepts replanIds entries ALSO named in
 * reopenIds this round), but because a verdict that names a genuine replan
 * intent in `notes` still represents real reviewer signal worth an ordinary
 * next-round retry rather than a hard sprint abort.
 *
 * @param {{ verdict: string, reopenIds?: string[], replanIds?: string[], newTasks?: object[] }} verdict
 * @returns {boolean}
 */
export function isReviewerContractViolation(verdict) {
    return verdict.verdict === 'CHANGES_NEEDED'
        && (!verdict.reopenIds || verdict.reopenIds.length === 0)
        && (!verdict.newTasks || verdict.newTasks.length === 0)
        && (!verdict.replanIds || verdict.replanIds.length === 0)
        // A verdict reporting a red build/test run is actionable on its own:
        // the orchestrator files an in-goal fix task for it (see
        // needsRedBranchFixTask below), so it is not self-contradictory.
        && verdict.buildFailing !== true;
}

// =============================================================================
// RED BRANCH -> ALWAYS A FIX DISPATCH.
//
// A CHANGES_NEEDED verdict reporting a failing build or test run must always
// leave dispatchable work behind. Before this, a reviewer naming only
// below-goal reopenIds (all skipped by the goal-scope guard) -- or none at all
// -- left the develop loop with zero open work on a red branch: it idled or
// exited, and nothing ever fixed the tests. When nothing actionable survived,
// the orchestrator files ONE in-goal fix task carrying the reviewer's notes.
// =============================================================================

/** Fixed title of the orchestrator-filed red-branch fix task (also its dedupe key). */
export const RED_BRANCH_FIX_TITLE = 'Fix the failing build or tests on the sprint branch';

/**
 * Does this verdict need an orchestrator-filed red-branch fix task?
 *
 * @param {object} o
 * @param {{ verdict: string, buildFailing?: boolean }} o.verdict
 * @param {number} o.reopenedCount - reopens that survived the goal-scope guard
 * @param {number} o.inGoalNewTaskCount - newTasks persisted at an in-goal priority
 * @returns {boolean}
 */
export function needsRedBranchFixTask({ verdict, reopenedCount, inGoalNewTaskCount }) {
    return Boolean(verdict)
        && verdict.verdict === 'CHANGES_NEEDED'
        && verdict.buildFailing === true
        && reopenedCount === 0
        && inGoalNewTaskCount === 0;
}

/**
 * Is a newTask priority string ('P2') inside the sprint's goal band?
 *
 * @param {string} priority
 * @param {number|string} goalMax
 * @returns {boolean}
 */
export function isInGoalPriority(priority, goalMax) {
    const p = normalizeGoalMax(String(priority));
    const max = normalizeGoalMax(goalMax);
    return Number.isFinite(p) && Number.isFinite(max) && p <= max;
}

/**
 * Build the red-branch fix task: highest tier named in the goal, a fixed
 * title, and the reviewer's notes (non-printable/non-ASCII characters
 * replaced so newTask validation cannot reject it).
 *
 * @param {object} o
 * @param {string} o.goal - e.g. 'P1/P2'
 * @param {string} o.notes - the reviewer's notes
 * @param {string} o.site - site label for the description, e.g. 'Review C1 R2'
 * @param {string[]} [o.skippedReopenIds] - reopenIds the guard filtered out
 * @returns {{ title: string, description: string, priority: string }}
 */
export function buildRedBranchFixTask({ goal, notes, site, skippedReopenIds = [] }) {
    const tiers = String(goal || '').split('/').map((p) => Number(p.trim().replace(/^[Pp]/, ''))).filter(Number.isFinite);
    const best = tiers.length > 0 ? Math.min(...tiers) : 1;
    const safeNotes = String(notes || '(no reviewer notes)').replace(/[^\t\n\r\x20-\x7E]/g, '?');
    const skipped = skippedReopenIds.length > 0
        ? `\n\nThe reviewer named these beads for rework, but none could be reopened in this sprint: ${skippedReopenIds.join(', ')}.`
        : '';
    return {
        title: RED_BRANCH_FIX_TITLE,
        priority: `P${best}`,
        description:
            `The reviewer (${site}) reported that the build or tests FAIL on the sprint branch, and no reopened ` +
            `or newly filed in-goal task covers the fix. Make the project's build and full test suite pass again ` +
            `without weakening any test, then close this task.${skipped}\n\nReviewer notes:\n${safeNotes}`,
    };
}

/**
 * File the red-branch fix task when the verdict needs one, unless an earlier
 * one is still not closed (one open fix task at a time, never one per round).
 *
 * @param {object} o
 * @param {object} o.verdict - the reviewer verdict
 * @param {number} o.reopenedCount
 * @param {number} o.inGoalNewTaskCount
 * @param {string[]} [o.skippedReopenIds]
 * @param {string} o.goal
 * @param {string} o.site - log/description label, e.g. 'Review C1 R2'
 * @param {(rest: string) => Promise<Array<object>>} o.bdListScoped
 * @param {(task: {title: string, description: string, priority: string}) => Promise<any>} o.createTask - creates the bead; truthy on success
 * @param {(msg: string) => void} o.log
 * @returns {Promise<'not-needed'|'exists'|'created'|'failed'>}
 */
export async function ensureRedBranchFixTask(o) {
    const { verdict, reopenedCount, inGoalNewTaskCount, skippedReopenIds = [], goal, site, bdListScoped, createTask, log } = o;
    if (!needsRedBranchFixTask({ verdict, reopenedCount, inGoalNewTaskCount })) return 'not-needed';
    let existing = null;
    try {
        const scope = await bdListScoped('');
        existing = scope.find((b) => b && b.title === RED_BRANCH_FIX_TITLE && b.status !== 'closed') || null;
    } catch {
        existing = null; // lookup failed -- file the task rather than risk leaving a red branch with no work
    }
    if (existing) {
        log(`${site}: build/tests reported FAILING and no reopen or in-goal newTask survived -- red-branch fix task ${existing.id} is still open, not filing another.`);
        return 'exists';
    }
    const task = buildRedBranchFixTask({ goal, notes: verdict.notes, site, skippedReopenIds });
    const created = await createTask(task);
    if (created) {
        const idText = created && typeof created === 'object' && created.childId ? ` ${created.childId}` : '';
        log(`${site}: build/tests reported FAILING and no reopen or in-goal newTask survived -- filed in-goal red-branch fix task${idText} ("${task.title}", ${task.priority}) so the branch is never left red with zero open work.`);
        return 'created';
    }
    log(`${site}: build/tests reported FAILING and no reopen or in-goal newTask survived -- filing the red-branch fix task FAILED; see the newTask persistence log above.`);
    return 'failed';
}

/**
 * Look up the beads currently in sprint scope, as the goal-scope allowlist
 * every reopen is checked against.
 *
 * FAILS OPEN BY DESIGN: any throw from the scope lookup yields `null`, which
 * isDeferredScopeReopen() reads as "apply every reopen unguarded". Dropping a
 * reviewer's reopens because a `bd list` failed would silently lose review
 * signal; a redundant unguarded reopen is the far cheaper failure.
 *
 * @param {(rest: string) => Promise<Array<object>>} bdListScoped
 * @returns {Promise<Map<string, object>|null>} the allowlist, or null on lookup failure
 */
export async function buildReopenAllowlist(bdListScoped) {
    try {
        const inScopeNow = await bdListScoped('');
        return new Map(inScopeNow.map((b) => [b.id, b]));
    } catch {
        return null; // lookup failed -- apply reopens unguarded rather than dropping them
    }
}

/**
 * Coerce a goal-priority ceiling to the NUMBER the priority comparison needs.
 *
 * runner.js's `goalMax` closure variable is goalPriorityMax(goal), which
 * returns the STRING form ('P2') because its other consumers want exactly
 * that: `bd list --priority-max=P2` and the human-facing log text. A bead's
 * own `priority`, though, is a NUMBER (3).
 *
 * That mismatch was a live, silent bug in the pre-extraction guard, which
 * compared them directly:
 *
 *     bead.priority > goalMax     // 3 > 'P2'  ->  NaN comparison  ->  false
 *
 * `>` coerces the string to a number, `Number('P2')` is NaN, and every
 * comparison against NaN is false -- so the goal-scope guard NEVER skipped
 * anything, at ANY site, for ANY priority (even a P9 bead in a P1 sprint
 * returned false). The two "guarded" sites were guarded in appearance only.
 * runner.js already knew the numeric form was required elsewhere and derived
 * it explicitly (`Number(goalPriorityMax(goal).slice(1))` in
 * partitionByGoalMembership and in the dashboard payload); only this guard
 * missed it.
 *
 * Accepts either form so callers may pass the string ceiling they already
 * have; returns NaN for anything unparseable, which -- since every comparison
 * against NaN is false -- degrades to the historical never-skip behaviour
 * rather than to skipping everything.
 *
 * @param {number|string} goalMax - e.g. 2 or 'P2'
 * @returns {number}
 */
export function normalizeGoalMax(goalMax) {
    if (typeof goalMax === 'number') return goalMax;
    if (typeof goalMax === 'string') return Number(goalMax.replace(/^[Pp]/, ''));
    return NaN;
}

/**
 * The goal-scope check itself: is `id` a bead this sprint has DEFERRED below
 * its goal priority, and therefore must not reopen?
 *
 * Every clause matters. A null `allowlist` (lookup failed) is never a skip --
 * see buildReopenAllowlist. A bead absent from the allowlist is never a skip
 * either: it is out-of-scope or brand new, and the pre-extraction sites
 * deliberately let those through rather than guessing. Only a bead the
 * allowlist KNOWS about, with a NUMERIC priority strictly worse (higher) than
 * the goal max, is refused -- and `goalMax` is normalized to a number first,
 * because comparing against the raw 'P2' string is what made this guard inert
 * (see normalizeGoalMax).
 *
 * WORKED-ON EXEMPTION. A below-goal bead THIS SPRINT already dispatched or
 * closed is never deferred: the sprint's own commits for it are on the branch
 * under review, so a reviewer reopening it is asking the sprint to repair its
 * own work (typically a red build or test run) -- not to pull deferred scope
 * back in. Skipping that reopen left a red branch with nothing dispatched to
 * fix it. `belowGoal` is still reported so the caller can log WHY the bead
 * was kept.
 *
 * @param {Map<string, object>|null} allowlist
 * @param {string} id
 * @param {number|string} goalMax - numeric ceiling, or the 'Pn' string form
 * @param {Set<string>|Iterable<string>|null} [workedOnIds] - bead ids this sprint dispatched or closed
 * @returns {{ deferred: boolean, priority: number|null, belowGoal: boolean, workedOn: boolean }}
 */
export function isDeferredScopeReopen(allowlist, id, goalMax, workedOnIds = null) {
    const bead = allowlist ? allowlist.get(id) : null;
    const max = normalizeGoalMax(goalMax);
    const priority = bead && typeof bead.priority === 'number' ? bead.priority : null;
    const belowGoal = Boolean(allowlist && bead && priority !== null && priority > max);
    const workedOn = toIdSet(workedOnIds).has(id);
    return { deferred: belowGoal && !workedOn, priority, belowGoal, workedOn };
}

/**
 * Normalise an optional worked-on id collection (Set, array, any iterable, or
 * absent) to a Set. Absent means "the sprint has worked on nothing yet", which
 * keeps the guard's historical behaviour exactly.
 *
 * @param {Set<string>|Iterable<string>|null|undefined} ids
 * @returns {Set<string>}
 */
function toIdSet(ids) {
    if (ids instanceof Set) return ids;
    if (ids && typeof ids[Symbol.iterator] === 'function' && typeof ids !== 'string') return new Set(ids);
    return new Set();
}

/**
 * The single reopen-entry parser for the two sites whose reopenIds are BARE
 * STRINGS carrying no reason (the per-round reviewer and Re-Review).
 *
 * @param {unknown} entry
 * @returns {{ id: string, reason: string }|{ error: string }}
 */
export function parseBareIdEntry(entry) {
    const id = typeof entry === 'string' ? entry.trim() : '';
    if (!id) return { error: `expected a bead id string -- ${JSON.stringify(entry)}` };
    return { id, reason: '' };
}

/**
 * Final Review's reopen-entry parser: `{id, reason}` with BOTH fields
 * required. Unlike the per-round reviewer's single blanket `notes` string
 * shared across every id, each Final Review entry carries its OWN reason, so
 * an entry missing either field has nothing usable to record and is refused.
 *
 * @param {unknown} entry
 * @returns {{ id: string, reason: string }|{ error: string }}
 */
export function parseIdWithReasonEntry(entry) {
    const id = entry && typeof entry.id === 'string' ? entry.id.trim() : '';
    const reason = entry && typeof entry.reason === 'string' ? entry.reason.trim() : '';
    if (!id || !reason) {
        return { error: `a malformed entry (both id and reason are required) -- ${JSON.stringify(entry)}` };
    }
    return { id, reason };
}

/**
 * Apply a verdict's reopenIds to beads, behind the shared goal-scope guard.
 * This is the ONE path all three verdict sites now take.
 *
 * The below-goal skip emits the identical "deferred scope, not reopened"
 * outcome at every site -- that exact phrasing is what makes the guard
 * greppable in a run log and is asserted by the extraction's tests, so keep
 * it verbatim if you touch this.
 *
 * @param {object} o
 * @param {Array<unknown>} o.entries - the verdict's raw reopenIds, in its own shape
 * @param {(rest: string) => Promise<Array<object>>} o.bdListScoped - scope lookup for the allowlist
 * @param {number} o.goalMax - worst (numerically highest) priority this sprint targets
 * @param {string} o.goal - the goal label, for log text (e.g. 'P1/P2')
 * @param {string} o.logPrefix - site label for log lines (e.g. 'Reviewer reopenIds')
 * @param {(msg: string) => void} o.log
 * @param {(cmd: string, opts: object) => Promise<any>} o.command
 * @param {string} o.member - the member every `bd` command here is dispatched to
 * @param {(entry: unknown) => {id: string, reason: string}|{error: string}} [o.parseEntry]
 * @param {(e: {id: string, reason: string}) => {cmd: string, label: string}|null} o.buildReopenCommand
 * @param {(e: {id: string, reason: string}) => void} [o.onReopened] - per-bead side effects (thrash counters, feedback routing)
 * @param {(e: {id: string, reason: string}, err: Error) => void} [o.onEntryError] - when present, a throwing entry is non-fatal and reported here
 * @param {Set<string>|Iterable<string>} [o.workedOnIds] - bead ids this sprint dispatched or closed; a below-goal reopen of one of these is APPLIED (see isDeferredScopeReopen)
 * @returns {Promise<string[]>} the ids ACTUALLY reopened (survived the guard)
 */
export async function applyGuardedReopens(o) {
    const {
        entries, bdListScoped, goalMax, goal, logPrefix, log, command, member,
        parseEntry = parseBareIdEntry, buildReopenCommand, onReopened, onEntryError,
        workedOnIds = null,
    } = o;

    const list = Array.isArray(entries) ? entries : [];
    // Short-circuit an empty verdict WITHOUT issuing the scope lookup: the
    // pre-extraction sites both guarded the lookup on a non-empty reopenIds,
    // and a `bd list` per empty verdict is real dispatch cost.
    if (list.length === 0) return [];

    const allowlist = await buildReopenAllowlist(bdListScoped);
    const reopenedIds = [];

    for (const entry of list) {
        const parsed = parseEntry(entry);
        if (parsed.error) {
            log(`${logPrefix}: SKIPPED ${parsed.error}`);
            continue;
        }

        const { deferred, priority, belowGoal } = isDeferredScopeReopen(allowlist, parsed.id, goalMax, workedOnIds);
        if (deferred) {
            log(`${logPrefix}: SKIPPED '${parsed.id}' (priority P${priority} is below this sprint's goal ${goal} -- deferred scope, not reopened).`);
            continue;
        }
        if (belowGoal) {
            log(`${logPrefix}: KEPT '${parsed.id}' (priority P${priority} is below this sprint's goal ${goal}, but this sprint already dispatched or closed it -- reopening so the sprint repairs its own work).`);
        }

        try {
            const built = buildReopenCommand(parsed);
            // A builder may refuse an entry it cannot render safely (Final
            // Review's reason sanitizing to empty); it has already logged why.
            if (!built) continue;
            await command(built.cmd, { member_name: member, silent: true, label: built.label });
            reopenedIds.push(parsed.id);
            if (onReopened) onReopened(parsed);
        } catch (err) {
            if (!onEntryError) throw err;
            onEntryError(parsed, err);
        }
    }

    return reopenedIds;
}

/**
 * Fold a round's reviewer `replanIds` into the cycle's running replan union.
 * Only the per-round reviewer site uses this; Final Review and Re-Review have
 * no scoped-replan machinery to feed.
 *
 * Two independent refusals, each logged so the drop is visible in the run log
 * rather than vanishing with no trace:
 *
 *   1. NOT ALSO REOPENED. An id named in replanIds without ALSO being named
 *      in (and surviving the guard on) this round's reopenIds is DROPPED and
 *      never reaches the scoped-replan machinery. buildReviewerPrompt
 *      requires replanIds to be a subset of reopenIds; this is the
 *      enforcement side. Note the subset is checked against ids ACTUALLY
 *      reopened, so a below-goal id skipped by the scope guard cannot sneak
 *      back in through replanIds.
 *   2. ALREADY REPLANNED THIS CYCLE. A bead that has already been through one
 *      in-cycle scoped replan is refused a SECOND: it stays reopened (real
 *      dev feedback still applies) but is not re-added, so the develop loop
 *      never dispatches a second scoped planner pass for it -- it is handed
 *      to the next cycle's planner instead. This is what makes "max one
 *      scoped replan per bead per cycle" hold regardless of the round budget.
 *
 * @param {object} o
 * @param {string[]|undefined} o.replanIds - the verdict's replanIds (absent on verdicts that do not use it)
 * @param {Set<string>} o.reopenedIds - ids actually reopened this round
 * @param {Set<string>} o.replannedThisCycle - beads already scoped-replanned this cycle
 * @param {number|string} o.cycle - cycle label, for log text
 * @param {(msg: string) => void} o.log
 * @returns {string[]} the ids accepted into the cycle's replan union
 */
export function foldReplanIds(o) {
    const { replanIds, reopenedIds, replannedThisCycle, cycle, log } = o;
    const accepted = [];
    for (const id of (replanIds || [])) {
        if (!reopenedIds.has(id)) {
            log(
                `[fleet-sprint] replanIds: DROPPED '${id}' -- not also named in this round's reopenIds ` +
                `(reviewer prompt requires replanIds to be a subset of reopenIds), so it never reaches the ` +
                `scoped-replan machinery.`
            );
            continue;
        }
        if (replannedThisCycle.has(id)) {
            log(
                `[fleet-sprint] replan loop guard: bead ${id} was already scoped-replanned once this cycle ` +
                `(C${cycle}) and a reviewer has flagged it for replan AGAIN -- refusing a second in-cycle scoped ` +
                `replan (max one per bead per cycle). It stays reopened and is handed off to the next cycle's ` +
                `planner rather than re-planned again now.`
            );
            continue;
        }
        accepted.push(id);
    }
    return accepted;
}
