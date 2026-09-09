// Beads scope discovery + the shared full-DB snapshot for fleet-sprint
// (apra-fleet-3swo.4.6). Extracted out of runner.js; runner.js re-exports
// every symbol it previously exported from this region, so existing importers
// of fleet-sprint/runner.js resolve unchanged.
//
// This module owns TWO things that used to be spread across runner.js:
//
//   1. ONE BFS scope-discovery implementation (discoverScope below). Before
//      the extraction there were two byte-independent copies of the same
//      rule -- one inside bdListScoped()'s closure and one inside
//      classifyVerifySet() -- kept apart only because classifyVerifySet had
//      to stay pure and testable while bdListScoped lived inside
//      runSprintCycle()'s closure. discoverScope() is pure, so both callers
//      now share it and the two copies cannot drift apart again.
//
//   2. The shared full-DB beads snapshot (createBeadsScope below): the single
//      `bd list --all --limit 0 --json` fetch per phase, its in-flight
//      coalescing, and -- critically -- the choke points that invalidate it.
//
// -----------------------------------------------------------------------------
// SNAPSHOT INVALIDATION CONTRACT (this is what the code ACTUALLY does; earlier
// planning text claiming the snapshot "is only invalidated at planner
// boundaries" was wrong)
// -----------------------------------------------------------------------------
//
// The snapshot lives AT MOST ONE PHASE. It is dropped on ALL of:
//
//   (a) EVERY phase boundary. wrapPhase() invalidates unconditionally on every
//       phase() call, so a new step can never inherit the previous step's
//       view. This is the dominant invalidation in practice -- a snapshot
//       almost never survives more than one phase step.
//   (b) EVERY beads-mutating command issued through the wrapCommand() wrapper.
//       `bd list|show|ready|config` are known reads (BD_READ_ONLY_RE) and keep
//       the snapshot; update/create/close/note/dep/dolt-pull and ANY
//       unrecognized `bd` subcommand are conservatively treated as mutations
//       and drop it. The failure mode is a redundant full fetch, never
//       silently stale data. Non-`bd` commands (git, node probes) never touch
//       beads state.
//   (c) EVERY planner dispatch that returns successfully -- runner.js calls
//       invalidateAllBeadsCache() explicitly right after dispatchPlanner() in
//       both the main Planning Loop and the in-cycle scoped replan. The
//       planner mutates beads on ITS OWN clone via its own `bd create` tool
//       calls, never through this wrapper, so (b) cannot see it; and
//       Execution Prep runs later in the SAME "Plan C{cycle} R{round}" phase
//       (no intervening phase() call), so (a) cannot see it either. Without
//       (c) the planner's freshly created tasks are invisible to the very next
//       Execution Prep step, whose parent-feature filter then finds nothing
//       ready and silently skips Develop for the whole cycle. Deliberately
//       scoped to the PLANNER only: an unconditional per-dispatch
//       invalidation was tried and reverted, because it defeats the
//       "one full-DB fetch per phase" cost control that
//       full-db-fetch-tripwire.test.mjs pins, for every other role
//       (doer/reviewer/deployer/...) that has no same-phase reader depending
//       on its bead mutations.
//
// WHAT THE CONTRACT DOES *NOT* COVER, and the deliberate bypass sites that
// exist because of it: a bead mutation performed INSIDE an agent() dispatch
// (a doer's or the integ runner's own `bd close`) never passes through
// wrapCommand(), so (b) cannot see it. In a topology with no dolt sync remote
// nothing else forces a refresh either (doltPullBefore/After are benign
// no-ops there), so the snapshot can be stale by a full cycle. Three read
// sites in runner.js therefore deliberately BYPASS the snapshot by calling
// bdListScoped() with a non-empty filter -- which always issues a real,
// freshly-scoped `bd list` command (see bdListScoped below) -- instead of
// reading fetchAllBeadsShared():
//
//   1. the per-cycle stall-detection closed-list read (`closedBeadsNow`, the
//      `--status=closed --json` read feeding closedCountHistory),
//   2. the per-cycle verify-set exit check (`closedIdsForExitCheck`), which
//      runs after the Re-Review block may have pushed further mutations this
//      cycle, and
//   3. Final Review's `finalClosedBeads` read, which backs both
//      finalClosedCount and finalUnclosedVerifyIds.
//
// All three are counting/gating reads whose whole job is to observe closures
// an agent made; serving them from the snapshot would let a sprint exit (or
// declare a stall) on a stale count. Do not "optimize" them onto
// fetchAllBeadsShared().
// =============================================================================

/**
 * `bd` subcommands that can never change beads state, so they must not drop a
 * cached full-DB snapshot. Anything else starting with `bd` is conservatively
 * treated as a mutation. Mirrored (deliberately, as an independent copy) by
 * full-db-fetch-guard.mjs, which judges the same rule from a command log.
 */
export const BD_READ_ONLY_RE = /^bd\s+(list|show|ready|config)\b/i;

/**
 * True iff `cmdStr` is a `bd` command that must invalidate the shared full-DB
 * snapshot -- see clause (b) of the invalidation contract above.
 *
 * @param {string} cmdStr - a command string, already trimmed or not
 * @returns {boolean}
 */
export function isBeadsMutatingCommand(cmdStr) {
    if (typeof cmdStr !== 'string') return false;
    const trimmed = cmdStr.trim();
    return /^bd\b/i.test(trimmed) && !BD_READ_ONLY_RE.test(trimmed);
}

/**
 * Build the id->bead and parent->children indexes every scope walk needs.
 *
 * A bead is a child iff its `parent` field is a non-empty id: `undefined`,
 * `null` and `''` all mean "no parent" and must never create a `Map` entry
 * keyed on an empty string (which would then look like a real parent id to
 * the BFS).
 *
 * @param {Array<object>} allBeads - the FULL, unfiltered project bead list
 * @returns {{ byId: Map<string, object>, childrenOf: Map<string, object[]> }}
 */
export function buildBeadGraph(allBeads) {
    const beads = allBeads || [];
    const byId = new Map();
    const childrenOf = new Map();
    for (const b of beads) {
        if (!b) continue;
        if (b.id !== undefined && b.id !== null) byId.set(b.id, b);
        if (b.parent !== undefined && b.parent !== null && b.parent !== '') {
            if (!childrenOf.has(b.parent)) childrenOf.set(b.parent, []);
            childrenOf.get(b.parent).push(b);
        }
    }
    return { byId, childrenOf };
}

/**
 * THE scope-discovery rule -- the single implementation both former call
 * sites (bdListScoped and classifyVerifySet) now share.
 *
 * Scope cannot be built on `bd list --parent`: that flag accepts exactly one
 * id per invocation (a comma-joined list is treated as one nonexistent id and
 * returns `[]`) and is single-level only -- direct children, never
 * grandchildren -- so a level-3+ descendant would be invisible to the
 * dispatch scope, not just the dashboard tree. Instead this is an IN-MEMORY
 * BFS over the full project bead list: build a parent->children map, then
 * walk outward from every target issue to find every descendant at any depth,
 * regardless of status. That subsumes the multi-target union case without a
 * separate code path.
 *
 * Every target issue's OWN id is seeded into the result UNCONDITIONALLY. The
 * BFS only ever adds descendants, so without the seed a childless leaf
 * target's scope would be empty and every query would short-circuit to `[]`.
 * The seed used to be conditional on the target having no children, on the
 * theory that a target WITH children is a pure grouping node whose own status
 * never matters -- that is false: a target with pre-existing children (a
 * verify-routed parent) can itself transition open->closed, and
 * status-counting queries need to see that transition. Excluding it silently
 * dropped such a parent's own closure from the stall-detection progress
 * score.
 *
 * A childful target is STILL excluded from dispatch (readyLeafBeads()) and
 * from the exit-gate open-at-goal counts, via a separate structural
 * "is this someone's .parent" check that is independent of scope membership
 * -- so seeding here does not let a still-open childful target masquerade as
 * done, nor block dispatch as if it were a leaf.
 *
 * @param {Array<object>} allBeads - the FULL, unfiltered project bead list
 * @param {string[]} targetIssues - the sprint's target issue root id(s)
 * @returns {{ byId: Map<string, object>, childrenOf: Map<string, object[]>, scopeIds: Set<string> }}
 */
export function discoverScope(allBeads, targetIssues) {
    const { byId, childrenOf } = buildBeadGraph(allBeads);
    const targets = targetIssues || [];

    const scopeIds = new Set();
    const frontier = [...targets];
    while (frontier.length > 0) {
        const id = frontier.shift();
        for (const child of (childrenOf.get(id) || [])) {
            if (!scopeIds.has(child.id)) {
                scopeIds.add(child.id);
                frontier.push(child.id);
            }
        }
    }
    for (const id of targets) scopeIds.add(id);

    return { byId, childrenOf, scopeIds };
}

/**
 * Classify beads whose every child is closed as ready for the `verify` route:
 * implementation-complete parents that must be excluded from
 * Plan/Develop/Review and verified against the live deployed product, never
 * administratively closed on child-closure alone -- see
 * docs/fleet-sprint-phase-routing-design.md for the design.
 *
 * Pure: derives the verify set fresh from `allBeads` on every call. There is
 * no persisted list -- callers re-invoke this at each classification point
 * (pre-sprint validation, cycle top, IntegTest dispatch) rather than caching,
 * so a crash-restart re-derives it for free and nothing can drift out of sync
 * with the beads DB.
 *
 * Eligibility (a bead qualifies iff ALL of):
 *   1. in scope: is itself one of `targetIssues`, or is a BFS descendant of
 *      one -- via discoverScope() above, the same rule bdListScoped uses.
 *   2. status is 'open' or 'in_progress' (not already closed/deferred).
 *   3. has at least one child. Childless beads are leaves -- they route
 *      through the normal Plan/Develop pipeline, never verify. A parent with
 *      NO children is never eligible, regardless of anything else.
 *   4. EVERY child (any issue_type) has status 'closed', checked against the
 *      FULL unfiltered `allBeads` list, not a scope-filtered subset -- an
 *      out-of-scope open child must still block eligibility. Partial closure
 *      never qualifies.
 *   5. no unmet 'blocks' dependency: a parent whose blocker is still being
 *      implemented in this same run must not be verified against today's
 *      incomplete state.
 *
 * @param {Array<object>} allBeads - the FULL, unfiltered project bead list.
 * @param {string[]} targetIssues - the sprint's target issue root id(s).
 * @returns {{ verifyIds: string[], ineligible: Array<{id: string, reason: string}> }}
 */
export function classifyVerifySet(allBeads, targetIssues) {
    const { byId, childrenOf, scopeIds } = discoverScope(allBeads, targetIssues);

    const verifyIds = [];
    const ineligible = [];
    for (const id of scopeIds) {
        const bead = byId.get(id);
        if (!bead) continue;
        if (bead.status !== 'open' && bead.status !== 'in_progress') continue;

        const kids = childrenOf.get(id) || [];
        if (kids.length === 0) continue; // leaf -- normal pipeline, not eligible

        if (!kids.every((k) => k.status === 'closed')) continue; // partial closure never qualifies

        const unmetBlockerIds = (bead.dependencies || [])
            .filter((d) => d.type === 'blocks')
            .map((d) => d.depends_on_id)
            .filter((depId) => {
                const dep = byId.get(depId);
                return dep && dep.status !== 'closed';
            });
        if (unmetBlockerIds.length > 0) {
            ineligible.push({ id, reason: `unmet blocker(s): ${unmetBlockerIds.join(', ')}` });
            continue;
        }

        verifyIds.push(id);
    }

    return { verifyIds, ineligible };
}

/**
 * The per-sprint beads scope client: the shared full-DB snapshot, the two
 * invalidation choke points that keep it correct (wrapCommand/wrapPhase), and
 * the scoped query helper every caller reads beads through.
 *
 * The wrappers are returned rather than applied by the caller so the
 * invalidation contract documented at the top of this file is implemented
 * HERE, in one place, instead of being re-derived at each call site. runner.js
 * installs both before any other statement in runSprintCycle() uses `command`
 * or `phase`, so every direct call -- and every helper that receives
 * `command` via an options object -- transparently goes through them.
 *
 * `getOrchestratorMember` is a getter, not a value, because the orchestrator
 * member is resolved from the role->member mapping well after this client is
 * constructed (the snapshot must exist before the `command` wrapper does,
 * and the wrapper must exist before anything can resolve members). No fetch
 * can happen before that point, so the getter is always called on a resolved
 * value.
 *
 * @param {object} opts
 * @param {string[]} opts.targetIssues - the sprint's target issue root id(s)
 * @param {string|null} [opts.assignee] - `--assignee` narrowing for filtered queries
 * @param {(raw: string, label: string) => any} opts.parseBdJson - bd JSON parser (injected to avoid an import cycle back into runner.js)
 * @param {() => string} opts.getOrchestratorMember - resolves the member every read is dispatched to
 */
export function createBeadsScope(opts = {}) {
    const targetIssues = opts.targetIssues || [];
    const assignee = opts.assignee || null;
    const parseBdJson = opts.parseBdJson;
    const getOrchestratorMember = opts.getOrchestratorMember;
    if (typeof parseBdJson !== 'function') {
        throw new TypeError('createBeadsScope({ parseBdJson }): parseBdJson must be a function');
    }
    if (typeof getOrchestratorMember !== 'function') {
        throw new TypeError('createBeadsScope({ getOrchestratorMember }): getOrchestratorMember must be a function');
    }

    let allBeadsSnapshot = null; // { beads } -- cleared by invalidateAllBeadsCache()
    let allBeadsInFlight = null;
    let command = null; // installed by wrapCommand(); see fetchAllBeadsShared

    /** Drop the shared snapshot. Cheap and idempotent. */
    function invalidateAllBeadsCache() { allBeadsSnapshot = null; }

    /** Whether a snapshot is currently cached -- diagnostics/tests only. */
    function hasCachedSnapshot() { return allBeadsSnapshot !== null; }

    /**
     * Wrap the raw `command()` seam so clause (b) of the invalidation
     * contract holds for every orchestrator-side command, and remember the
     * wrapped function as the one this module issues its own reads through
     * (so a scope read can never sneak past its own invalidation seam).
     *
     * `onCommand(trimmedCmd, opts)` is an optional post-command hook for
     * concerns that are NOT beads-snapshot related but need the same single
     * choke point (runner.js uses it for DoltSync's per-member sync.remote
     * memo invalidation). It runs after the invalidation decision, matching
     * the pre-extraction ordering.
     */
    function wrapCommand(rawCommand, wrapOpts = {}) {
        if (typeof rawCommand !== 'function') {
            throw new TypeError('beadsScope.wrapCommand(rawCommand): rawCommand must be a function');
        }
        const onCommand = typeof wrapOpts.onCommand === 'function' ? wrapOpts.onCommand : null;
        const wrapped = async (cmdStr, cmdOpts) => {
            const result = await rawCommand(cmdStr, cmdOpts);
            if (typeof cmdStr === 'string') {
                const trimmed = cmdStr.trim();
                if (isBeadsMutatingCommand(trimmed)) {
                    invalidateAllBeadsCache();
                }
                if (onCommand) onCommand(trimmed, cmdOpts);
            }
            return result;
        };
        command = wrapped;
        return wrapped;
    }

    /**
     * Wrap the raw `phase()` seam so clause (a) of the invalidation contract
     * holds: a new step never inherits the previous step's snapshot.
     */
    function wrapPhase(rawPhase) {
        if (typeof rawPhase !== 'function') {
            throw new TypeError('beadsScope.wrapPhase(rawPhase): rawPhase must be a function');
        }
        return (title) => {
            invalidateAllBeadsCache();
            return rawPhase(title);
        };
    }

    /**
     * The one full-DB fetch. Serves from the snapshot whenever one is still
     * valid -- the snapshot survives across separate, non-overlapping calls
     * (see the invalidation contract at the top of this file for what drops
     * it) -- and otherwise coalesces concurrent callers onto a single
     * in-flight request.
     *
     * Coalescing matters beyond saving a round trip: the command text is
     * identical for every caller, and the bd-replay test shim matches
     * recorded responses FIFO per exact command string, so N indistinguishable
     * concurrent commands have no reliable replay order.
     *
     * `--all` because `bd list` excludes closed issues by default, which would
     * drop a closed node's parent link and orphan its whole subtree from
     * discovery; `--limit 0` because the default row cap could silently
     * truncate a larger scope.
     */
    async function fetchAllBeadsShared() {
        if (allBeadsSnapshot) return allBeadsSnapshot.beads;
        if (!command) {
            throw new Error('beadsScope.fetchAllBeadsShared(): wrapCommand() must be installed before any beads read');
        }
        if (!allBeadsInFlight) {
            const allLabel = 'bd list --all --limit 0 --json';
            allBeadsInFlight = command(allLabel, { member_name: getOrchestratorMember(), silent: true })
                .then((raw) => parseBdJson(raw, allLabel))
                .then((beads) => {
                    allBeadsSnapshot = { beads };
                    return beads;
                })
                .finally(() => { allBeadsInFlight = null; });
        }
        return allBeadsInFlight;
    }

    /**
     * Scope-filtered `bd list`. With no extra args this is the pure in-memory
     * path (the already-fetched project-wide any-status dump filtered to
     * scope, no new command issued).
     *
     * With extra args it ALWAYS issues a real, fresh `bd list` -- the caller's
     * filter flags (--ready/--status/--type/--priority-max/etc) express
     * bd-side computed properties, readiness in particular, that a plain
     * in-memory filter over the snapshot cannot reliably replicate. That
     * freshness is also exactly why the three deliberate cache-bypass sites
     * documented at the top of this file call this with a filter instead of
     * reading fetchAllBeadsShared(). When an assignee is configured,
     * `--assignee` narrows that query to this sprint's claimed beads so two
     * sprints never select the same one.
     *
     * Note the asymmetry, which is deliberate: the SCOPE always comes from
     * the (possibly cached) snapshot, while the FILTER result is always
     * fresh. Scope membership is structural and changes only when beads are
     * created/reparented; status is what moves under the sprint's feet.
     */
    async function bdListScoped(restArgs) {
        const rest = restArgs ? restArgs.trim() : '';

        const allBeads = await fetchAllBeadsShared();
        const { scopeIds } = discoverScope(allBeads, targetIssues);

        if (scopeIds.size === 0) return [];

        if (!rest) {
            return allBeads.filter((b) => b && scopeIds.has(b.id));
        }

        let filterArgs = rest;
        if (assignee) {
            filterArgs = `${rest} --assignee ${assignee}`;
        }
        const filterLabel = `bd list ${filterArgs} --limit 0`;
        const filterRaw = await command(filterLabel, { member_name: getOrchestratorMember(), silent: true });
        return parseBdJson(filterRaw, filterLabel).filter((b) => b && scopeIds.has(b.id));
    }

    return {
        invalidateAllBeadsCache,
        hasCachedSnapshot,
        wrapCommand,
        wrapPhase,
        fetchAllBeadsShared,
        bdListScoped,
    };
}
