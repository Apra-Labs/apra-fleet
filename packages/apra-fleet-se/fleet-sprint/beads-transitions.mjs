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
        && (!verdict.replanIds || verdict.replanIds.length === 0);
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
 * @param {Map<string, object>|null} allowlist
 * @param {string} id
 * @param {number|string} goalMax - numeric ceiling, or the 'Pn' string form
 * @returns {{ deferred: boolean, priority: number|null }}
 */
export function isDeferredScopeReopen(allowlist, id, goalMax) {
    const bead = allowlist ? allowlist.get(id) : null;
    const max = normalizeGoalMax(goalMax);
    if (allowlist && bead && typeof bead.priority === 'number' && bead.priority > max) {
        return { deferred: true, priority: bead.priority };
    }
    return { deferred: false, priority: bead && typeof bead.priority === 'number' ? bead.priority : null };
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
 * @returns {Promise<string[]>} the ids ACTUALLY reopened (survived the guard)
 */
export async function applyGuardedReopens(o) {
    const {
        entries, bdListScoped, goalMax, goal, logPrefix, log, command, member,
        parseEntry = parseBareIdEntry, buildReopenCommand, onReopened, onEntryError,
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

        const { deferred, priority } = isDeferredScopeReopen(allowlist, parsed.id, goalMax);
        if (deferred) {
            log(`${logPrefix}: SKIPPED '${parsed.id}' (priority P${priority} is below this sprint's goal ${goal} -- deferred scope, not reopened).`);
            continue;
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
