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
// Subtree expansion reuses the runner.js `bdListScoped` discipline
// (auto-sprint/runner.js ~1360): `bd list --parent <id>` accepts EXACTLY ONE id
// per invocation (a comma-joined `--parent a,b` is silently treated as one
// nonexistent id and returns []), and is ALSO single-level only (it returns
// direct children, never grandchildren). So we query each root separately and
// BFS every discovered node, merging the results -- never a comma-joined
// `--parent`, never a single call expected to return a whole subtree.
//
// KNOWN HOLE (surfaced, not hidden): a `blocks` edge that crosses two disjoint
// claimed scopes is NOT detected here. This guard reasons purely about the
// parent-child grouping subtree of each root; cross-scope ordering edges are
// out of scope for this reservation check.
// =============================================================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
    const { stdout } = await execFileAsync('bd', ['list', '--parent', parentId, '--json', '--limit', '0']);
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
 * @param {{
 *   ledger: { list: () => Array<{ sprintId: string, issueRoots: string[] }> },
 *   listChildren?: (parentId: string) => Promise<string[]>,
 *   logger?: { log?: Function, error?: Function },
 * }} deps
 */
export function createScopeGuard(deps = {}) {
    const ledger = deps.ledger;
    if (!ledger || typeof ledger.list !== 'function') {
        throw new TypeError('createScopeGuard requires a ledger with a list() method');
    }
    const listChildren = deps.listChildren ?? bdListChildren;

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

        // Live-expand the incoming request's scope once.
        const requestScope = await expandScope(roots, listChildren);

        const conflicts = [];
        for (const reservation of ledger.list()) {
            if (excludeSprintId !== undefined && reservation.sprintId === excludeSprintId) continue;
            const resRoots = Array.isArray(reservation.issueRoots) ? reservation.issueRoots : [];
            if (resRoots.length === 0) continue;
            // Live-expand THIS active sprint's subtree right now, never a
            // launch-time snapshot -- so mid-run subtree growth is seen.
            // eslint-disable-next-line no-await-in-loop -- each active sprint's subtree is expanded independently; ledger sets are small.
            const activeScope = await expandScope(resRoots, listChildren);
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
        expandScope: (roots) => expandScope(roots, listChildren),
        checkLaunch,
        formatScopeConflict,
    };
}
