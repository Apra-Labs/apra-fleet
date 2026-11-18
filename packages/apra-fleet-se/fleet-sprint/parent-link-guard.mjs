// parent-link-guard.mjs -- keeps the sprint's view of parenthood MONOTONE
// within a run and detects parent-child links that vanished from the beads DB
// without this run removing them.
//
// WHY: a beads merge (a conflicting `bd dolt pull`, run by a sprint member OR
// by an operator on any clone sharing the remote) can auto-resolve by keeping
// one side's dependency table wholesale, silently DELETING parent-child edges.
// From then on the engine's BFS scope no longer reaches the descendants: the
// root looks like a childless leaf and is dispatched to a doer, nothing is
// verify-routed, the closed count never moves and the run stalls. The guard
// must hold whoever ran the merge.
//
// This module is PURE (no command calls). createBeadsScope (beads-scope.mjs)
// owns the ledger, feeds it every fresh full-DB snapshot, issues the restore
// commands through the normal command path, and logs/throws.
//
// Rules:
//   - Every in-scope parent-child edge seen in a snapshot is recorded
//     (child -> parent), as are every parent and every in-scope id seen.
//   - Edges this run itself changes through the command path (`bd update
//     <child> --parent <p>`, `bd dep remove|rm <child> <parent>`) are noted:
//     a removal is never "restored".
//   - An edge VANISHED when its child is still in the DB but now has NO
//     parent, and this run did not remove it. A child that now has a
//     DIFFERENT parent was moved, not dropped (an agent may legitimately
//     reparent on its own clone), so it is not restored.
//   - A bead once seen as a parent stays a parent for the rest of the run,
//     and an id once in scope stays in scope.
//
// ASCII only.

/** Thrown when a vanished parent-child link could not be restored. */
export class ParentLinkRestoreError extends Error {
    constructor(message, { edges = [], cause } = {}) {
        super(message);
        this.name = 'ParentLinkRestoreError';
        this.edges = edges;
        if (cause !== undefined) this.cause = cause;
    }
}

const edgeKey = (child, parent) => `${child}\u0000${parent}`;
const hasParent = (b) => b && b.parent !== undefined && b.parent !== null && b.parent !== '';

// `bd update <id> ... --parent <p>` / `--parent=<p>` / `--parent ""` (removal).
const UPDATE_PARENT_RE = /^bd\s+update\s+(\S+)\b.*?\s--parent(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S*))/i;
// `bd dep remove|rm <a> <b>` -- drops whatever edge joins the two.
const DEP_REMOVE_RE = /^bd\s+dep\s+(?:remove|rm)\s+(\S+)\s+(\S+)/i;

/**
 * Parse a LOGICAL bd command (env prefix already stripped) for a
 * parent-child change it makes.
 *
 * @param {string} cmd
 * @returns {{ kind: 'reparent', child: string, parent: string } | { kind: 'remove', a: string, b: string } | null}
 *   reparent with parent '' means "parent removed".
 */
export function parseRunEdgeChange(cmd) {
    if (typeof cmd !== 'string') return null;
    const text = cmd.trim();
    const up = UPDATE_PARENT_RE.exec(text);
    if (up) {
        const parent = up[2] ?? up[3] ?? up[4] ?? '';
        return { kind: 'reparent', child: up[1], parent: parent.startsWith('--') ? '' : parent };
    }
    const rm = DEP_REMOVE_RE.exec(text);
    if (rm) return { kind: 'remove', a: rm[1], b: rm[2] };
    return null;
}

/** The ERROR line for one vanished edge that is being restored. */
export function formatVanishedEdgeLog({ child, parent }) {
    return `ERROR: parent-child link vanished from the beads database: '${child}' is no longer a child of '${parent}', ` +
        'and this run did not remove it (a beads merge or another writer dropped it). ' +
        `Restoring it with 'bd update ${child} --parent ${parent}'.`;
}

/** The ERROR line (and error message) when restoring an edge failed. */
export function formatRestoreFailure({ child, parent }, reason) {
    return `ERROR: could not restore the vanished parent-child link '${child}' -> parent '${parent}': ${reason}. ` +
        'The sprint scope can no longer be trusted (the parent would look like a leaf and its children would drop out of scope); ' +
        `stopping. Re-link it by hand with 'bd update ${child} --parent ${parent}' and re-run the sprint.`;
}

/**
 * The per-run ledger. All state lives in the closure; nothing is persisted.
 */
export function createParentLinkLedger() {
    /** child -> parent, for every in-scope edge seen. */
    const edges = new Map();
    /** edgeKey(child, parent) for every edge this run removed or moved away from. */
    const removedByRun = new Set();
    const knownParents = new Set();
    const knownScope = new Set();

    /**
     * Record a snapshot's in-scope edges, parents and ids.
     * @param {object[]} allBeads
     * @param {Set<string>} scopeIds
     */
    function observe(allBeads, scopeIds) {
        for (const id of scopeIds) knownScope.add(id);
        for (const b of (allBeads || [])) {
            if (!hasParent(b) || !scopeIds.has(b.id)) continue;
            edges.set(b.id, b.parent);
            knownParents.add(b.parent);
        }
    }

    /**
     * Note a parent-child change this run made through the command path.
     * @param {ReturnType<typeof parseRunEdgeChange>} change
     */
    function noteRunEdgeChange(change) {
        if (!change) return;
        if (change.kind === 'reparent') {
            const prev = edges.get(change.child);
            if (prev !== undefined && prev !== change.parent) removedByRun.add(edgeKey(change.child, prev));
            if (change.parent) {
                edges.set(change.child, change.parent);
                removedByRun.delete(edgeKey(change.child, change.parent));
            } else {
                edges.delete(change.child);
            }
            return;
        }
        // `bd dep remove a b`: either direction may be the child, and the
        // removed dependency may be a blocks edge rather than the parent
        // link (the pre-sprint blocks-cycle auto-repair). Only mark the pair:
        // if the parent link is then found gone, this run removed it and it
        // is not restored; the recorded edge itself is kept.
        removedByRun.add(edgeKey(change.a, change.b));
        removedByRun.add(edgeKey(change.b, change.a));
    }

    /**
     * Recorded edges whose child is still in `allBeads` but now has no
     * parent, and which this run did not remove.
     * @param {object[]} allBeads
     * @returns {Array<{ child: string, parent: string }>}
     */
    function findVanished(allBeads) {
        const byId = new Map();
        for (const b of (allBeads || [])) if (b && b.id !== undefined && b.id !== null) byId.set(b.id, b);
        const vanished = [];
        for (const [child, parent] of edges) {
            const bead = byId.get(child);
            if (!bead || hasParent(bead)) continue;
            if (removedByRun.has(edgeKey(child, parent))) continue;
            vanished.push({ child, parent });
        }
        return vanished;
    }

    return {
        observe,
        noteRunEdgeChange,
        findVanished,
        /** Every bead seen as a parent this run (monotone). */
        knownParentIds: () => new Set(knownParents),
        /** Every id seen in scope this run (monotone). */
        knownScopeIds: () => new Set(knownScope),
    };
}
