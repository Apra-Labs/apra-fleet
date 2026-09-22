// =============================================================================
// Pure beads normalization/tree helpers (apra-fleet-972p.1.2, C3/DQ-26).
//
// Copied verbatim (behavior-for-behavior) from
// packages/apra-fleet-se/src/supervisor/backlog.mjs, which remains the
// canonical implementation the fleet-sprint supervisor imports from --
// backlog.mjs itself is left untouched by this change; swapping its import to
// this subpath export is a later sprint's job. This module exists so any
// caller of @apralabs/apra-fleet-client (not just the supervisor) can reuse
// the same parent-child grouping-edge parsing, bead normalization, and
// in-memory scope/tree expansion without depending on the supervisor package
// or its `bd` subprocess plumbing -- everything here is a pure function over
// plain data, no I/O.
// =============================================================================

/**
 * Extract a bead's parent id from a raw `bd list --json` row. The parent-child
 * grouping edge is a dependency whose `type` is `parent-child` and whose
 * `issue_id` is the bead itself; `depends_on_id` is the PARENT (grouping edges
 * point child -> parent). Returns null when the bead is a tracker root.
 * @param {object} raw
 * @returns {string|null}
 */
export function parentIdOf(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.parentId === 'string' && raw.parentId.length > 0) return raw.parentId;
    if (typeof raw.parent === 'string' && raw.parent.length > 0) return raw.parent;
    const deps = Array.isArray(raw.dependencies) ? raw.dependencies : [];
    for (const d of deps) {
        if (d && d.type === 'parent-child' && d.issue_id === raw.id && typeof d.depends_on_id === 'string') {
            return d.depends_on_id;
        }
    }
    return null;
}

/**
 * Normalize a raw `bd list --json` row (or an already-normalized object) into
 * the minimal shape the tree builder/renderer needs.
 *
 * `priority` is preserved (not dropped) because downstream consumers filter
 * on it. Preserved as `null` (never a numeric default like 0) when
 * absent/non-numeric, so "no priority filtering for this bead" stays
 * unambiguous downstream.
 * @param {object} raw
 * @returns {{ id: string, title: string, issueType: string, status: string, parentId: string|null, priority: number|null }}
 */
export function normalizeBead(raw) {
    const b = raw || {};
    const rawPriority = b.priority;
    const normalized = {
        id: typeof b.id === 'string' ? b.id : '',
        title: typeof b.title === 'string' ? b.title : '',
        issueType: b.issueType ?? b.issue_type ?? 'task',
        status: b.status ?? 'open',
        parentId: parentIdOf(b),
        priority: typeof rawPriority === 'number' && Number.isFinite(rawPriority) ? rawPriority : null,
    };
    // A server-computed `placement` ('sprint' | 'backlog') is passed through
    // when present -- raw `bd list` rows never carry it.
    if (typeof b.placement === 'string') normalized.placement = b.placement;
    return normalized;
}

/**
 * Build a parent-id -> direct-child-ids index off an already-fetched, already-
 * normalized beads list.
 * @param {Array<{ id: string, parentId: string|null }>} beads - normalizeBead() shape
 * @returns {Map<string, string[]>}
 */
export function buildChildIndex(beads) {
    const idx = new Map();
    for (const b of Array.isArray(beads) ? beads : []) {
        const pid = b && b.parentId;
        if (!pid) continue;
        if (!idx.has(pid)) idx.set(pid, []);
        idx.get(pid).push(b.id);
    }
    return idx;
}

/**
 * In-memory equivalent of a subprocess-based `expandScope()`: expands a set
 * of root issue ids into the full parent-child subtree they span (roots
 * INCLUDED), via a breadth-first walk over a `buildChildIndex()` Map built
 * off an already-fetched flat beads list -- no per-node querying needed.
 * @param {Iterable<string>} roots
 * @param {Map<string, string[]>} childIndex - from buildChildIndex()
 * @returns {Set<string>} every bead id in the subtree, roots included
 */
export function expandScopeInMemory(roots, childIndex) {
    const idx = childIndex instanceof Map ? childIndex : new Map();
    const scope = new Set();
    const frontier = [];
    for (const r of roots ?? []) {
        if (typeof r === 'string' && r.length > 0 && !scope.has(r)) {
            scope.add(r);
            frontier.push(r);
        }
    }
    while (frontier.length > 0) {
        const id = frontier.shift();
        const children = idx.get(id) ?? [];
        for (const child of children) {
            if (typeof child === 'string' && child.length > 0 && !scope.has(child)) {
                scope.add(child);
                frontier.push(child);
            }
        }
    }
    return scope;
}

/** Normalize a claimedBy value (single owner string) into an array of sprint ids. */
function ownersOf(value) {
    if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v.length > 0);
    if (typeof value === 'string' && value.length > 0) return [value];
    return [];
}

/**
 * Per-bead partial-claim lookup: `Map<freeBeadId, PartialClaim|null>`, keyed
 * off each free bead's OWN direct children. Internal helper `buildBacklogTree`
 * below depends on -- not part of this module's public five-function surface,
 * but copied alongside it because `buildBacklogTree` cannot compute correct
 * partial-claim annotations without it.
 * @param {Array<{ id: string, parentId: string|null }>} beads - normalizeBead() shape
 * @param {Map<string, string|string[]>} claimedBy
 * @returns {Map<string, { totalCount: number, claimedCount: number, freeCount: number, sprints: Array<{ sprintId: string, count: number }> }|null>}
 */
function computePartialClaimByBead(beads, claimedBy) {
    const list = Array.isArray(beads) ? beads : [];
    const claims = claimedBy instanceof Map ? claimedBy : new Map();
    const byId = new Map(list.map((b) => [b.id, b]));
    const isClaimed = (id) => claims.has(id);

    const allChildrenOf = new Map();
    for (const b of list) {
        const pid = b.parentId;
        if (pid && byId.has(pid)) {
            if (!allChildrenOf.has(pid)) allChildrenOf.set(pid, []);
            allChildrenOf.get(pid).push(b);
        }
    }

    const result = new Map();
    for (const b of list) {
        if (isClaimed(b.id)) continue;
        const kids = allChildrenOf.get(b.id) ?? [];
        const claimedKids = kids.filter((c) => isClaimed(c.id));
        if (claimedKids.length === 0) {
            result.set(b.id, null);
            continue;
        }
        const sprintCounts = new Map();
        for (const c of claimedKids) {
            for (const owner of ownersOf(claims.get(c.id))) {
                sprintCounts.set(owner, (sprintCounts.get(owner) ?? 0) + 1);
            }
        }
        result.set(b.id, {
            totalCount: kids.length,
            claimedCount: claimedKids.length,
            freeCount: kids.length - claimedKids.length,
            sprints: [...sprintCounts.entries()].map(([sprintId, count]) => ({ sprintId, count })),
        });
    }
    return result;
}

/**
 * Build the Backlog forest: the full tracker with every CLAIMED subtree pruned,
 * preserving parent-child hierarchy. A partial-claim parent (free itself, but
 * with a strict subset of claimed children) stays in the forest with only its
 * free children and a `partialClaim` annotation.
 *
 * @param {Array<{ id: string, title: string, issueType: string, status: string, parentId: string|null }>} beads
 * @param {Map<string, string|string[]>} claimedBy - claimed bead id -> owning sprint id(s)
 * @returns {Array<{ id: string, title: string, issueType: string, status: string, partialClaim: object|null, children: object[] }>} root nodes of the free forest
 */
export function buildBacklogTree(beads, claimedBy) {
    const list = Array.isArray(beads) ? beads : [];
    const claims = claimedBy instanceof Map ? claimedBy : new Map();
    const byId = new Map(list.map((b) => [b.id, b]));
    const isClaimed = (id) => claims.has(id);

    // Full-tracker child index (INCLUDING claimed children) -- buildNode()
    // below needs the complete direct-child set to split into free/claimed,
    // not just the free ones.
    const allChildrenOf = new Map();
    for (const b of list) {
        const pid = b.parentId;
        if (pid && byId.has(pid)) {
            if (!allChildrenOf.has(pid)) allChildrenOf.set(pid, []);
            allChildrenOf.get(pid).push(b);
        }
    }

    const partialClaimById = computePartialClaimByBead(list, claims);

    function buildNode(bead) {
        const kids = allChildrenOf.get(bead.id) ?? [];
        const freeKids = kids.filter((c) => !isClaimed(c.id));
        return {
            id: bead.id,
            title: bead.title,
            issueType: bead.issueType,
            status: bead.status,
            partialClaim: partialClaimById.get(bead.id) ?? null,
            children: freeKids.map(buildNode),
        };
    }

    // A free bead roots the Backlog forest when it has no parent, or its parent
    // is claimed / absent from the tracker (defensive re-rooting: in a valid
    // full-subtree claim a free node's parent is always free too, but never
    // silently drop a free node whose ancestor chain is broken).
    const roots = list.filter((b) => {
        if (isClaimed(b.id)) return false;
        const pid = b.parentId;
        return !(pid && byId.has(pid) && !isClaimed(pid));
    });
    return roots.map(buildNode);
}
