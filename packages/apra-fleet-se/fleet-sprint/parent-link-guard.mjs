// parent-link-guard.mjs -- keeps the sprint's view of parenthood stable
// within a run (a merge loss never turns a parent into a leaf) and detects parent-child links that vanished from the beads DB
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
//     (child -> parent), as is every in-scope id seen.
//   - Edges this run itself changes through the command path (`bd update
//     <child> --parent <p>`, `bd dep remove|rm <child> <parent>`) are noted:
//     a removal is never "restored".
//   - An edge VANISHED when both its child and its parent are still in the
//     DB, the child now has NO parent, and this run did not remove it.
//   - An edge whose child or parent is no longer in the DB at all was
//     DELETED, not dropped by a merge (`bd delete` removes the issue and
//     every edge touching it): it is dropped from the ledger and reported
//     for a WARN, never restored.
//   - A child that now has a DIFFERENT parent was MOVED, not dropped (an
//     agent may legitimately reparent on its own clone): the recorded edge
//     follows it and is never restored.
//   - EXCEPT a child now back under a parent it was moved AWAY from this run
//     (an edge this run removed, or the parent recorded before the current
//     edge): that is a lossy merge keeping the older side, a REVERT. It is
//     restored like a vanished edge, with an ERROR naming both parents.
//   - A bead is a known parent while some recorded edge still points at it.
//     A vanished edge stays recorded (and is restored), so a merge loss can
//     never make a parent look like a leaf; a parent whose children were all
//     deleted or moved away stops being a parent and is routed by the
//     ordinary leaf/verify rules instead of sitting open for the whole run.
//   - An id once in scope stays in scope.
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

/** The ERROR line for one vanished (or reverted) edge that is being restored. */
export function formatVanishedEdgeLog({ child, parent, revertedFrom }) {
    if (revertedFrom) {
        return `ERROR: parent-child link reverted in the beads database: '${child}' is back under '${revertedFrom}', ` +
            `a parent it was moved away from in this run, instead of '${parent}' ` +
            '(a beads merge or another writer brought back an older link). ' +
            `Restoring it with 'bd update ${child} --parent ${parent}'.`;
    }
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
 * The WARN line for one recorded edge dropped because an endpoint was deleted.
 * @param {{ child: string, parent: string, reason: 'child-missing'|'parent-missing'|'both-missing' }} drop
 */
export function formatDroppedEdgeLog({ child, parent, reason }) {
    const gone = reason === 'parent-missing' ? `the parent '${parent}' is`
        : reason === 'child-missing' ? `the child '${child}' is`
            : `both '${child}' and '${parent}' are`;
    return `WARN: parent-child link '${child}' -> parent '${parent}' is no longer tracked: ${gone} no longer in the beads database ` +
        '(deleted). This is not a lost link, so it is not restored.';
}

/**
 * The per-run ledger. All state lives in the closure; nothing is persisted.
 */
export function createParentLinkLedger() {
    /** child -> parent, for every in-scope edge seen. */
    const edges = new Map();
    /** edgeKey(child, parent) for every edge this run removed or moved away from. */
    const removedByRun = new Set();
    const knownScope = new Set();
    /** child -> the parent recorded before its current edge (moved away from this run). */
    const earlierParent = new Map();

    /**
     * Record a snapshot's in-scope edges and ids.
     * @param {object[]} allBeads
     * @param {Set<string>} scopeIds
     */
    function observe(allBeads, scopeIds) {
        for (const id of scopeIds) knownScope.add(id);
        for (const b of (allBeads || [])) {
            if (!hasParent(b) || !scopeIds.has(b.id)) continue;
            edges.set(b.id, b.parent);
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
            if (prev !== undefined && prev !== change.parent) {
                removedByRun.add(edgeKey(change.child, prev));
                earlierParent.set(change.child, prev);
            }
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
        // is not restored (reconcile then forgets it).
        removedByRun.add(edgeKey(change.a, change.b));
        removedByRun.add(edgeKey(change.b, change.a));
    }

    /**
     * Classify every recorded edge against a fresh snapshot, without
     * changing the ledger.
     * @param {object[]} allBeads
     */
    function classify(allBeads) {
        const byId = new Map();
        for (const b of (allBeads || [])) if (b && b.id !== undefined && b.id !== null) byId.set(b.id, b);
        const vanished = [];
        const dropped = [];
        const moved = [];
        const removed = [];
        for (const [child, parent] of edges) {
            const bead = byId.get(child);
            const parentPresent = byId.has(parent);
            if (!bead || !parentPresent) {
                const reason = !bead && !parentPresent ? 'both-missing' : (!bead ? 'child-missing' : 'parent-missing');
                dropped.push({ child, parent, reason });
                continue;
            }
            if (hasParent(bead)) {
                if (bead.parent === parent) continue;
                if (removedByRun.has(edgeKey(child, bead.parent)) || earlierParent.get(child) === bead.parent) {
                    vanished.push({ child, parent, revertedFrom: bead.parent });
                } else {
                    moved.push({ child, from: parent, to: bead.parent });
                }
                continue;
            }
            if (removedByRun.has(edgeKey(child, parent))) { removed.push({ child, parent }); continue; }
            vanished.push({ child, parent });
        }
        return { vanished, dropped, moved, removed };
    }

    /**
     * Reconcile the ledger with a fresh snapshot. Edges with a deleted
     * endpoint, edges whose child moved to another parent and edges this
     * run itself removed are forgotten (their old parent stops being a
     * parent once no recorded edge points at it). Returns the vanished
     * edges the caller must restore and the dropped ones it must WARN about.
     * @param {object[]} allBeads
     * @returns {{ vanished: Array<{child: string, parent: string}>, dropped: Array<{child: string, parent: string, reason: string}>, moved: Array<{child: string, from: string, to: string}> }}
     */
    function reconcile(allBeads) {
        const { vanished, dropped, moved, removed } = classify(allBeads);
        for (const d of dropped) edges.delete(d.child);
        // A moved child is re-recorded under its new parent by observe() when in scope.
        for (const m of moved) {
            edges.delete(m.child);
            earlierParent.set(m.child, m.from);
        }
        for (const r of removed) edges.delete(r.child);
        return { vanished, dropped, moved };
    }

    return {
        observe,
        noteRunEdgeChange,
        reconcile,
        /** Recorded edges to restore: vanished (both endpoints present, child parentless, not removed by this run) or reverted onto a parent the child was moved away from. Read-only. */
        findVanished: (allBeads) => classify(allBeads).vanished,
        /** Every bead some recorded edge still points at. */
        knownParentIds: () => new Set(edges.values()),
        /** Every id seen in scope this run (monotone). */
        knownScopeIds: () => new Set(knownScope),
    };
}
