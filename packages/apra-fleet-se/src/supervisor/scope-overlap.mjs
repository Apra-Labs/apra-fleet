// =============================================================================
// Auto-sprint supervisor -- issue-scope overlap guard via live-expanded subtree
// recomputation (apra-fleet-eft.5.3, Plan Part 2.2)
// =============================================================================
//
// The reservation ledger (src/supervisor/ledger.mjs) stores each live sprint's
// issue-scope IDENTITY: the root issue id(s) it launched with (`issueRoots`).
// It deliberately does NOT store a frozen list of every descendant, because
// planners and reviewers GROW a sprint's subtree mid-run (they add tasks/tests
// under an already-claimed root). A launch-time snapshot of "everything under
// root R" would therefore go stale the instant a new child is created, letting
// a second sprint claim that brand-new child without detecting the overlap.
//
// So overlap is checked by RE-EXPANDING subtrees LIVE at every launch attempt:
//
//   * For the incoming request, expand its root(s) to the full live subtree.
//   * For every active sprint in the ledger, expand ITS root(s) to the full
//     live subtree, right now -- never a launch-time snapshot.
//   * Intersect. Any nonzero intersection rejects the ENTIRE launch, naming the
//     conflicting sprint and the overlapping bead ids.
//
// There is deliberately NO partial-launch / carve-out path: we do not launch a
// sprint over "its scope minus the already-claimed beads". That would require
// an exclude-set threaded through the runner core loop and is explicitly
// deferred. Overlap is all-or-nothing: any conflict fails the whole launch.
//
// Subtree expansion historically reused the runner.js `bdListScoped`
// discipline (fleet-sprint/runner.js ~1360): `bd list --parent <id>` accepts
// EXACTLY ONE id per invocation (a comma-joined `--parent a,b` is silently
// treated as one nonexistent id and returns []), and is ALSO single-level
// only (it returns direct children, never grandchildren). That meant one `bd`
// subprocess spawn PER DISCOVERED NODE in every checkLaunch() call -- N
// spawns for an N-bead ledger+request tree, every launch attempt.
//
// apra-fleet-72o0: the production path now does ONE bulk fetch per
// checkLaunch() call (`bd list --all --limit 0 --json`, see
// `bdListAllBeadsWithClosed()` below) and builds the parent-child index / BFS
// expansion IN-MEMORY off that single result, reusing backlog.mjs's
// `buildChildIndex()` / `expandScopeInMemory()` (apra-fleet-c4s) -- the SAME
// technique the dashboard Backlog tab already uses to avoid a per-node `bd`
// subprocess walk on every render. `--all` matters here specifically: `bd
// list` hides closed issues by default, so a CLOSED intermediate parent would
// silently orphan its OPEN subtree from this check without it -- two sprints
// with genuinely overlapping open work could otherwise both launch. This is a
// correctness fix, not just a speed one (backlog.mjs's own
// `bdListAllBeadsRaw()` omits `--all`; that is a separate, already-known bug
// there, deliberately NOT touched by this change).
//
// The old per-node async `expandScope()`/`bdListChildren()` pair is KEPT as
// the test seam: `createScopeGuard({ listChildren })` still drives the exact
// same per-root, single-id-per-call `bd list --parent <id>` BFS when a caller
// explicitly injects `listChildren` (existing tests and callers that want a
// stubbed child-lister without a bulk-fetch fixture) -- never a comma-joined
// `--parent`, never a single call expected to return a whole subtree.
//
// KNOWN HOLE (surfaced, not hidden): a `blocks` edge that crosses two disjoint
// claimed scopes is NOT detected here. This guard reasons purely about the
// parent-child grouping subtree of each root; cross-scope ordering edges are
// out of scope for this reservation check.
// =============================================================================

import { validateIssueId } from '../../fleet-sprint/runner.js';
import { execBdAsync } from './lib/exec-bd.mjs';
import { normalizeBead, buildChildIndex, expandScopeInMemory } from './backlog.mjs';

/**
 * Default `listChildren`: return the DIRECT child bead ids of a single parent
 * id via `bd list --parent <id> --json`. One id per call -- never a
 * comma-joined multi-parent query (bd silently treats that as one nonexistent
 * id and returns []). Single-level only by design; the BFS in expandScope()
 * walks it to full depth.
 * @param {string} parentId
 * @returns {Promise<string[]>}
 */
export async function bdListChildren(parentId) {
    // Routed through the shared execBdAsync() helper (apra-fleet-xuo.2), which
    // resolves the platform `bd` command directly (`bd.cmd` on win32) instead
    // of shelling out via `{ shell: true }` -- so no shell is invoked at all,
    // and no shell metacharacter in `parentId` can reach one. validateIssueId()
    // below is kept as defense in depth (letters/digits/'.'/'_'/'-' -only
    // charset, same as the launch API boundary's runner.js ISSUE_ID_PATTERN)
    // in case some future caller forgets to validate upstream.
    validateIssueId(parentId);
    const { stdout } = await execBdAsync(['list', '--parent', parentId, '--json', '--limit', '0']);
    const text = stdout && stdout.trim() ? stdout : '[]';
    let rows;
    try {
        rows = JSON.parse(text);
    } catch (err) {
        throw new Error(`[scope-overlap] failed to parse 'bd list --parent ${parentId} --json': ${err.message}`);
    }
    if (!Array.isArray(rows)) return [];
    return rows
        .map((b) => (b && typeof b.id === 'string' ? b.id : null))
        .filter((id) => id !== null);
}

/**
 * Expand a set of root issue ids into the full live parent-child subtree they
 * span (roots INCLUDED). Each node is queried at most once via `listChildren`,
 * one id per call, and the frontier is walked breadth-first so grandchildren
 * (and deeper) are reached even though `bd list --parent` is single-level.
 *
 * The roots themselves are part of the scope: two sprints launched with the
 * same root, or a request rooted at a bead already inside an active scope, must
 * both surface that shared id.
 *
 * @param {Iterable<string>} roots
 * @param {(parentId: string) => Promise<string[]>} listChildren
 * @returns {Promise<Set<string>>} every bead id in the live subtree, roots included
 */
export async function expandScope(roots, listChildren) {
    const scope = new Set();
    const frontier = [];
    for (const r of roots) {
        if (typeof r === 'string' && r.length > 0 && !scope.has(r)) {
            scope.add(r);
            frontier.push(r);
        }
    }
    while (frontier.length > 0) {
        const id = frontier.shift();
        // eslint-disable-next-line no-await-in-loop -- BFS must query each node one --parent id at a time (bd rejects comma-joined multi-parent).
        const children = await listChildren(id);
        for (const child of children) {
            if (typeof child === 'string' && child.length > 0 && !scope.has(child)) {
                scope.add(child);
                frontier.push(child);
            }
        }
    }
    return scope;
}

/**
 * Default `listAllBeads` for the bulk path (apra-fleet-72o0): every bead,
 * OPEN AND CLOSED, in one call -- `bd list --all --limit 0 --json`.
 * Deliberately its own small fetcher (not a reuse of backlog.mjs's
 * `bdListAllBeadsRaw()`) because that helper omits `--all` -- a separate,
 * already-known bug there this change must not copy or silently "fix" as a
 * side effect. `--all` is required HERE: a CLOSED intermediate parent must
 * still surface its OPEN descendants to the overlap check, or that subtree
 * silently falls out of both the request's and an active sprint's live scope.
 * @returns {Promise<object[]>} raw `bd list` rows, unnormalized
 */
export async function bdListAllBeadsWithClosed() {
    // Routed through the shared execBdAsync() helper (apra-fleet-xuo.2), same
    // as bdListChildren() below and backlog.mjs's fetchAllBeadsRaw() -- no
    // shell metacharacter risk, consistent cross-platform `bd` resolution.
    const { stdout } = await execBdAsync(['list', '--all', '--limit', '0', '--json']);
    const text = stdout && stdout.trim() ? stdout : '[]';
    let rows;
    try {
        rows = JSON.parse(text);
    } catch (err) {
        throw new Error(`[scope-overlap] failed to parse 'bd list --all --json': ${err.message}`);
    }
    if (!Array.isArray(rows)) return [];
    return rows.filter((b) => b && typeof b.id === 'string' && b.id.length > 0);
}

/**
 * Human-readable rejection message naming every conflicting sprint and the
 * overlapping bead ids, for surfacing to the launch caller / API response.
 * @param {Array<{ sprintId: string, overlappingIds: string[] }>} conflicts
 * @returns {string}
 */
export function formatScopeConflict(conflicts) {
    const parts = conflicts.map(
        (c) => `sprint '${c.sprintId}' already claims [${c.overlappingIds.join(', ')}]`,
    );
    return `issue-scope overlap rejects launch: ${parts.join('; ')}`;
}

/**
 * Create the issue-scope overlap guard. Collaborators are injected so tests can
 * drive an in-memory ledger and a stub child-lister without a real `bd`.
 *
 * Two expansion paths, chosen once at construction (apra-fleet-72o0):
 *   - `deps.listChildren` supplied (explicit test seam): every expansion goes
 *     through the OLD per-node async BFS (`expandScope()` above) -- one
 *     `bd list --parent <id>`-shaped call per discovered node, exactly the
 *     pre-existing behavior existing tests/callers already rely on.
 *   - `deps.listChildren` omitted (the production default): `checkLaunch()`
 *     does ONE bulk `deps.listAllBeads()` fetch (default
 *     `bdListAllBeadsWithClosed()`, i.e. `bd list --all --limit 0 --json`) up
 *     front, builds a `buildChildIndex()` off it ONCE, and expands BOTH the
 *     request's roots and every ledger sprint's `issueRoots` from that same
 *     in-memory index via `expandScopeInMemory()` -- zero additional `bd`
 *     subprocess spawns per node. Mirrors backlog.mjs's `createBacklog()`
 *     `explicitExpand` seam (same shape, same reasoning: an injected
 *     collaborator overrides wholesale, the production default never calls
 *     the injected-only path).
 *
 * @param {{
 *   ledger: { list: () => Array<{ sprintId: string, issueRoots: string[] }> },
 *   listChildren?: (parentId: string) => Promise<string[]>,
 *   listAllBeads?: () => Promise<object[]>,
 *   logger?: { log?: Function, error?: Function },
 * }} deps
 */
export function createScopeGuard(deps = {}) {
    const ledger = deps.ledger;
    if (!ledger || typeof ledger.list !== 'function') {
        throw new TypeError('createScopeGuard requires a ledger with a list() method');
    }
    // Only set when a caller (test, or a future explicit-stub consumer)
    // injects a child-lister wholesale -- the production default path below
    // never calls it (apra-fleet-72o0: no per-node `bd` subprocess walk on
    // every checkLaunch()).
    const explicitListChildren = deps.listChildren ?? null;
    const listAllBeads = deps.listAllBeads ?? bdListAllBeadsWithClosed;

    /**
     * Expand `roots` under the currently-selected path: the injected
     * per-node lister if one was supplied at construction, else a fresh bulk
     * fetch + in-memory BFS. Used by the guard's standalone `expandScope()`
     * export below (called outside a `checkLaunch()` batch, so it cannot
     * reuse a shared child index).
     * @param {Iterable<string>} roots
     * @returns {Promise<Set<string>>}
     */
    async function expandScopeStandalone(roots) {
        if (explicitListChildren) return expandScope(roots, explicitListChildren);
        const rawBeads = await listAllBeads();
        const beads = (Array.isArray(rawBeads) ? rawBeads : []).map(normalizeBead).filter((b) => b.id.length > 0);
        return expandScopeInMemory(roots, buildChildIndex(beads));
    }

    /**
     * Check whether launching a sprint with `requestRoots` would overlap any
     * currently-active sprint's live-expanded issue subtree. Re-expands BOTH
     * the request's and every active sprint's roots AT CALL TIME -- never a
     * frozen snapshot -- so a bead created after an earlier launch, under an
     * already-claimed root, is still detected.
     *
     * Any nonzero intersection with ANY active sprint rejects the ENTIRE
     * launch (no partial/carve-out path). `conflicts` lists every offending
     * sprint and the overlapping bead ids.
     *
     * @param {string[]} requestRoots - the incoming sprint's root issue id(s)
     * @param {{ excludeSprintId?: string }} [opts] - ignore one sprint (e.g. a
     *        re-adoption / self-check that should not conflict with itself)
     * @returns {Promise<{ ok: boolean, requestScope: string[], conflicts: Array<{ sprintId: string, overlappingIds: string[] }> }>}
     */
    async function checkLaunch(requestRoots, opts = {}) {
        const roots = Array.isArray(requestRoots) ? requestRoots : [];
        if (roots.length === 0) {
            throw new TypeError('checkLaunch requires a non-empty array of request root issue ids');
        }
        const excludeSprintId = opts.excludeSprintId;

        // Validate the REQUEST's root ids before they are used (dolt sync
        // budget review round 2, item 6). The old per-node path validated
        // every root inside bdListChildren(); the bulk in-memory path never
        // calls it, so a malformed root id silently expanded to just itself
        // and was then reported as non-overlapping -- an invalid launch
        // request accepted rather than rejected. This is a correctness/UX
        // restoration, not an injection guard (the bulk fetch passes no root
        // id to `bd` at all). Only the request's own roots are validated:
        // ledger roots were validated when their sprint launched, and
        // re-rejecting them here would turn one bad historical record into a
        // hard failure of every subsequent launch.
        if (!explicitListChildren) {
            for (const root of roots) validateIssueId(root);
        }

        // Build the child index ONCE per checkLaunch() call (bulk path only)
        // -- one `bd` subprocess spawn total, however many roots/ledger
        // sprints there are to expand. The explicit-listChildren seam has no
        // shared index; each expansion issues its own per-node calls, same
        // as before apra-fleet-72o0.
        let childIndex = null;
        if (!explicitListChildren) {
            const rawBeads = await listAllBeads();
            const beads = (Array.isArray(rawBeads) ? rawBeads : []).map(normalizeBead).filter((b) => b.id.length > 0);
            childIndex = buildChildIndex(beads);
        }

        const expand = (rs) => (explicitListChildren
            ? expandScope(rs, explicitListChildren)
            : Promise.resolve(expandScopeInMemory(rs, childIndex)));

        // Live-expand the incoming request's scope once.
        const requestScope = await expand(roots);

        const conflicts = [];
        for (const reservation of ledger.list()) {
            if (excludeSprintId !== undefined && reservation.sprintId === excludeSprintId) continue;
            const resRoots = Array.isArray(reservation.issueRoots) ? reservation.issueRoots : [];
            if (resRoots.length === 0) continue;
            // Live-expand THIS active sprint's subtree right now, never a
            // launch-time snapshot -- so mid-run subtree growth is seen. In
            // the bulk path this reuses the SAME childIndex built above (no
            // extra `bd` call); in the explicit-listChildren seam it issues
            // its own per-node BFS, same as before.
            // eslint-disable-next-line no-await-in-loop -- explicit-listChildren seam expands each active sprint's subtree independently; ledger sets are small. (Bulk path resolves synchronously, so this never actually awaits a pending promise.)
            const activeScope = await expand(resRoots);
            const overlappingIds = [];
            for (const id of requestScope) {
                if (activeScope.has(id)) overlappingIds.push(id);
            }
            if (overlappingIds.length > 0) {
                overlappingIds.sort();
                conflicts.push({ sprintId: reservation.sprintId, overlappingIds });
            }
        }

        return {
            ok: conflicts.length === 0,
            requestScope: [...requestScope].sort(),
            conflicts,
        };
    }

    return {
        name: 'scope-guard',
        expandScope: (roots) => expandScopeStandalone(roots),
        checkLaunch,
        formatScopeConflict,
    };
}
