// =============================================================================
// Auto-sprint supervisor -- Backlog-last tree with partial-claim annotations
// (apra-fleet-eft.6.2, Plan Part 2.3)
// =============================================================================
//
// The index page (GET /, dashboard.mjs) renders one section per running sprint
// FIRST, then -- ALWAYS LAST -- the Backlog. The Backlog is the full issue
// tracker MINUS the union of every active sprint's LIVE-expanded issue scope,
// rendered as a TREE (parent-child hierarchy), not a flat list, with per-node
// claim status.
//
// WHY "minus the live-expanded union", not "minus a launch-time snapshot": a
// sprint's subtree grows mid-run (planners/reviewers add tasks under an
// already-claimed root). So the claimed set is recomputed AT RENDER TIME by
// re-expanding each active sprint's roots via eft.5.3's expandScope()
// (./scope-overlap.mjs) -- the exact same live-subtree question the overlap
// guard answers. A bead created after launch, under a claimed root, is claimed
// the instant it exists and never leaks into the Backlog.
//
// NO DUPLICATION across the page (acceptance criterion): a claimed bead appears
// ONLY under its owning sprint's section, NEVER in the Backlog, and NEVER
// twice. Because a claimed scope is a full subtree, claiming a node claims all
// its descendants -- so a claimed node is dropped from the Backlog wholesale.
//
// PARTIAL-CLAIM PARENTS (the subtle case): a sprint can be rooted at SOME of an
// epic's children (not the epic itself). Then the epic is still FREE (unclaimed)
// but a strict subset of its children are claimed. The epic stays visible in the
// Backlog, showing ONLY its free children, and carries a partial-claim
// annotation naming the owning sprint(s) and the claimed/free counts -- e.g.
// "2 of 5 children claimed by sprint-abc123; 3 free" -- steering the operator to
// multi-select exactly the free children. This is UI STEERING ONLY: the server's
// exact-overlap launch policy (createScopeGuard in ./scope-overlap.mjs) is
// unchanged and still rejects any overlapping multi-select. The annotation just
// helps the operator pick a non-overlapping set in the first place.
// =============================================================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { escapeHtml } from '@apralabs/apra-fleet-workflow/viewer/html-utils';
import { expandScope, bdListChildren } from './scope-overlap.mjs';
import { WATCHDOG_STATUS } from './watchdog.mjs';

const execFileAsync = promisify(execFile);

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
 * @param {object} raw
 * @returns {{ id: string, title: string, issueType: string, status: string, parentId: string|null }}
 */
export function normalizeBead(raw) {
    const b = raw || {};
    return {
        id: typeof b.id === 'string' ? b.id : '',
        title: typeof b.title === 'string' ? b.title : '',
        issueType: b.issueType ?? b.issue_type ?? 'task',
        status: b.status ?? 'open',
        parentId: parentIdOf(b),
    };
}

/**
 * Default full-tracker source: `bd list --json --limit 0`, normalized. One call
 * returns every bead with its dependency edges (from which parentIdOf() derives
 * the grouping hierarchy), so no per-node querying is needed to reconstruct the
 * tree here.
 * @returns {Promise<Array<ReturnType<typeof normalizeBead>>>}
 */
async function fetchAllBeadsRaw() {
    // shell: true -- on Windows, `bd` (npm-installed via @beads/bd) resolves to
    // a `bd.cmd` shim, which Node's child_process cannot spawn directly without
    // a shell (spawn ENOENT even though `bd` is on PATH and works from any
    // interactive shell). Safe here: every argument is a static literal, none
    // of it is caller-controlled.
    const { stdout } = await execFileAsync('bd', ['list', '--json', '--limit', '0'], { shell: true });
    const text = stdout && stdout.trim() ? stdout : '[]';
    let rows;
    try {
        rows = JSON.parse(text);
    } catch (err) {
        throw new Error(`[backlog] failed to parse 'bd list --json': ${err.message}`);
    }
    if (!Array.isArray(rows)) return [];
    return rows.filter((b) => b && typeof b.id === 'string' && b.id.length > 0);
}

/**
 * Raw `bd list --json --limit 0` rows, UNNORMALIZED -- every field `bd` emits
 * (dependencies, priority, issue_type, metadata, description, parent, ...) is
 * preserved. `bdListAllBeads()` below builds its minimal tree-node shape from
 * this; `createBacklog().buildBacklogTasks()` uses the SAME call (one `bd`
 * invocation per page render, not two) because it needs the fuller shape to
 * feed fleet-sprint's `renderBeadsHtml()` (type/status/priority/model badges,
 * `blocks`-edge nesting, full descriptions) unchanged.
 * @returns {Promise<Array<object>>}
 */
export async function bdListAllBeadsRaw() {
    return fetchAllBeadsRaw();
}

export async function bdListAllBeads() {
    const rows = await fetchAllBeadsRaw();
    return rows.map(normalizeBead).filter((b) => b.id.length > 0);
}

/** Normalize a claimedBy value (single owner string) into an array of sprint ids. */
function ownersOf(value) {
    if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v.length > 0);
    if (typeof value === 'string' && value.length > 0) return [value];
    return [];
}

/**
 * Build the Backlog forest: the full tracker with every CLAIMED subtree pruned,
 * preserving parent-child hierarchy. A partial-claim parent (free itself, but
 * with a strict subset of claimed children) stays in the forest with only its
 * free children and a `partialClaim` annotation.
 *
 * @param {Array<{ id: string, title: string, issueType: string, status: string, parentId: string|null }>} beads
 * @param {Map<string, string|string[]>} claimedBy - claimed bead id -> owning sprint id(s)
 * @returns {Array<BacklogNode>} root nodes of the free forest
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

    // The partial-claim annotation itself (counts + owning sprints) is the
    // SAME computation the flat beads-tree view needs (buildBacklogTasks()
    // below) -- computePartialClaimByBead() is the one place that logic
    // lives; this function only adds tree STRUCTURE (nesting, pruning
    // claimed subtrees) on top of it.
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

/**
 * Per-bead partial-claim lookup: `Map<freeBeadId, PartialClaim|null>`, keyed
 * off each free bead's OWN direct children. Shared by `buildBacklogTree()`
 * above (which attaches each entry to its tree node) and
 * `createBacklog().buildBacklogTasks()` below (which has no containment tree
 * to hang the annotation off -- its beads-tree view nests by `blocks` edges,
 * not `parent` containment -- so it reads this map directly and renders the
 * annotation inline on the flat row instead).
 * @param {Array<{ id: string, parentId: string|null }>} beads - normalizeBead() shape
 * @param {Map<string, string|string[]>} claimedBy
 * @returns {Map<string, { totalCount: number, claimedCount: number, freeCount: number, sprints: Array<{ sprintId: string, count: number }> }|null>}
 */
export function computePartialClaimByBead(beads, claimedBy) {
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
 * Human-readable partial-claim annotation, e.g.
 * "2 of 5 children claimed by sprint-abc123; 3 free".
 * @param {{ totalCount: number, claimedCount: number, freeCount: number, sprints: Array<{ sprintId: string, count: number }> }} pc
 * @returns {string}
 */
export function formatPartialClaim(pc) {
    const sprintLabel = pc.sprints.length === 0
        ? 'an active sprint'
        : pc.sprints.map((s) => (pc.sprints.length > 1 ? `${s.sprintId} (${s.count})` : s.sprintId)).join(', ');
    return `${pc.claimedCount} of ${pc.totalCount} children claimed by ${sprintLabel}; ${pc.freeCount} free`;
}

/** Renders one Backlog tree node (and its free descendants) as a nested <li>. */
function renderBacklogNode(node) {
    const id = escapeHtml(node.id);
    const title = escapeHtml(node.title || '(untitled)');
    const type = escapeHtml(node.issueType || 'task');
    const status = escapeHtml(node.status || 'open');
    const annotation = node.partialClaim
        ? ' <span data-partial-claim="true" style="color:#f59e0b; font-size: 12px; font-style: italic;">(' +
          escapeHtml(formatPartialClaim(node.partialClaim)) + ')</span>'
        : '';
    const childrenHtml = node.children && node.children.length > 0
        ? '<ul style="list-style: none; margin: 2px 0 2px 16px; padding: 0;">' +
          node.children.map(renderBacklogNode).join('') + '</ul>'
        : '';
    return (
        '<li data-bead-id="' + id + '" style="margin: 2px 0;">' +
        '<span style="font-family: monospace; color:#a1a1aa;">' + id + '</span> ' +
        '<span>' + title + '</span> ' +
        '<span style="color:#71717a; font-size: 11px;">[' + type + ' - ' + status + ']</span>' +
        annotation +
        childrenHtml +
        '</li>'
    );
}

/**
 * Render the full Backlog tree. An empty forest renders an explicit empty-state
 * message (never a blank/throw). The hierarchy is nested <ul>/<li>, never a flat
 * list (acceptance criterion).
 * @param {BacklogNode[]} [tree]
 * @returns {string}
 */
export function renderBacklogTreeHtml(tree) {
    const roots = Array.isArray(tree) ? tree : [];
    if (roots.length === 0) {
        return '<p style="color:#71717a; font-style: italic;">No unclaimed work in the backlog.</p>';
    }
    return '<ul style="list-style: none; margin: 0; padding: 0;">' +
        roots.map(renderBacklogNode).join('') + '</ul>';
}

/**
 * @typedef {object} BacklogNode
 * @property {string} id
 * @property {string} title
 * @property {string} issueType
 * @property {string} status
 * @property {{ totalCount: number, claimedCount: number, freeCount: number, sprints: Array<{ sprintId: string, count: number }> }|null} partialClaim
 * @property {BacklogNode[]} children
 */

/**
 * apra-fleet-7xk-style server-side narrowing: filters a flat raw-bead-row
 * array (the same shape `bdListAllBeadsRaw()` returns, plus this module's
 * `partialClaim` field) down to the rows matching every supplied criterion,
 * AND reports which distinct values are actually present (so a caller can
 * populate Type/Status/Priority/Model filter controls from real data, not a
 * guessed enum). Pure/synchronous -- narrows the SET before it is ever handed
 * to a renderer, not a client-side hide/show pass over an already-fetched
 * full set (that distinction is the acceptance criterion this mirrors).
 * @param {Array<object>} rows
 * @param {{ type?: string, status?: string, priority?: string|number, model?: string, q?: string }} [filters]
 * @returns {{ tasks: object[], total: number, filterOptions: { type: string[], status: string[], priority: number[], model: string[] } }}
 */
export function applyBeadFilters(rows, filters) {
    const list = Array.isArray(rows) ? rows : [];
    const typeOf = (r) => (r.issue_type ?? r.issueType ?? '').toString();
    const modelOf = (r) => (r.metadata && r.metadata.model) || '';

    const filterOptions = {
        type: [...new Set(list.map(typeOf).filter((v) => v.length > 0))].sort(),
        status: [...new Set(list.map((r) => (r.status ?? '').toString()).filter((v) => v.length > 0))].sort(),
        priority: [...new Set(list.map((r) => r.priority).filter((p) => typeof p === 'number' && Number.isFinite(p)))].sort((a, b) => a - b),
        model: [...new Set(list.map(modelOf).filter((v) => v.length > 0))].sort(),
    };

    const f = filters || {};
    const norm = (v) => (typeof v === 'string' && v.length > 0 ? v.trim().toLowerCase() : undefined);
    const type = norm(f.type);
    const status = norm(f.status);
    const model = norm(f.model);
    const q = norm(f.q);
    const priority = f.priority !== undefined && f.priority !== null && f.priority !== ''
        ? Number(f.priority)
        : undefined;
    const hasPriorityFilter = priority !== undefined && Number.isFinite(priority);

    const tasks = list.filter((r) => {
        if (type && typeOf(r).toLowerCase() !== type) return false;
        if (status && (r.status ?? '').toString().toLowerCase() !== status) return false;
        if (hasPriorityFilter && r.priority !== priority) return false;
        if (model && modelOf(r).toLowerCase() !== model) return false;
        if (q) {
            const haystack = (String(r.id) + ' ' + String(r.title ?? '')).toLowerCase();
            if (!haystack.includes(q)) return false;
        }
        return true;
    });

    return { tasks, total: list.length, filterOptions };
}

/**
 * Create the Backlog seam. Collaborators injected for unit testing without a
 * real `bd` / live sprints.
 *
 * @param {{
 *   ledger: { list: () => Array<{ sprintId: string, issueRoots: string[] }> },
 *   listAllBeads?: () => Promise<Array<object>>|Array<object>,
 *   listChildren?: (parentId: string) => Promise<string[]>,
 *   expandScope?: (roots: string[]) => Promise<Set<string>>,
 *   watchdog?: { classifySprint: (entry: object) => Promise<{ status: string }> },
 *   logger?: { log?: Function, error?: Function },
 * }} deps
 */
export function createBacklog(deps = {}) {
    const ledger = deps.ledger;
    if (!ledger || typeof ledger.list !== 'function') {
        throw new TypeError('createBacklog requires a ledger with a list() method');
    }
    const logger = deps.logger ?? console;
    const logError = (...a) => (logger.error ?? logger.log)?.(...a);
    const listChildren = deps.listChildren ?? bdListChildren;
    const expand = deps.expandScope ?? ((roots) => expandScope(roots, listChildren));
    // Raw rows by default -- buildTree() below normalizes whatever this
    // returns itself (normalizeBead() is idempotent on already-normalized
    // input), and buildBacklogTasks() needs the FULLER raw shape (priority,
    // dependencies, metadata, description) that a normalized row drops. One
    // `bd` call per render either way -- never two.
    const listAllBeads = deps.listAllBeads ?? bdListAllBeadsRaw;
    const watchdog = deps.watchdog ?? null;

    /**
     * The active (non-finished) reservations whose scopes are subtracted from
     * the Backlog. When a watchdog is injected, sprints it classifies `finished`
     * are dropped -- their beads belong back in the Backlog (their section is
     * gone from the live stack too). A classifier error keeps the reservation
     * (fail safe: do not surface an in-flight sprint's beads as free).
     * @returns {Promise<Array<{ sprintId: string, issueRoots: string[] }>>}
     */
    async function activeReservations() {
        const entries = ledger.list();
        if (!watchdog || typeof watchdog.classifySprint !== 'function') return entries;
        const kept = [];
        await Promise.all(entries.map(async (entry) => {
            try {
                const c = await watchdog.classifySprint(entry);
                if (c.status !== WATCHDOG_STATUS.FINISHED) kept.push(entry);
            } catch (err) {
                logError(`[backlog] classifySprint failed for sprint '${entry.sprintId}':`, err);
                kept.push(entry);
            }
        }));
        return kept;
    }

    /**
     * Build the claimed-id -> owning-sprint map by LIVE-expanding every active
     * sprint's roots right now. First writer wins per id (exact-overlap policy
     * guarantees no two active sprints share a bead anyway). A per-sprint
     * expansion failure is isolated -- that one sprint contributes no claims
     * rather than taking the whole Backlog down.
     * @returns {Promise<Map<string, string>>}
     */
    async function buildClaimedBy() {
        const claimedBy = new Map();
        const reservations = await activeReservations();
        await Promise.all(reservations.map(async (r) => {
            try {
                const scope = await expand(r.issueRoots ?? []);
                for (const id of scope) {
                    if (!claimedBy.has(id)) claimedBy.set(id, r.sprintId);
                }
            } catch (err) {
                logError(`[backlog] scope expansion failed for sprint '${r.sprintId}':`, err);
            }
        }));
        return claimedBy;
    }

    /** Build the Backlog forest (full tracker minus live-claimed subtrees). */
    async function buildTree() {
        const [rawBeads, claimedBy] = await Promise.all([listAllBeads(), buildClaimedBy()]);
        const beads = (Array.isArray(rawBeads) ? rawBeads : []).map(normalizeBead).filter((b) => b.id.length > 0);
        return buildBacklogTree(beads, claimedBy);
    }

    /** Render the Backlog section HTML (never throws -- degrades to empty state). */
    async function renderHtml() {
        try {
            return renderBacklogTreeHtml(await buildTree());
        } catch (err) {
            logError('[backlog] render failed:', err);
            return renderBacklogTreeHtml([]);
        }
    }

    /**
     * The flat, unclaimed bead set -- fleet-sprint's `renderBeadsHtml()` shape
     * (raw `bd list --json` rows, plus a `partialClaim` field this module adds
     * so the epic-with-some-children-claimed case, eft.6.2's original point,
     * still surfaces even though this view has no containment tree of its own
     * to hang the annotation off). `filters` narrows the SET ITSELF (not just
     * what gets rendered from an already-fetched set) -- see applyBeadFilters().
     * @param {{ type?: string, status?: string, priority?: string|number, model?: string, q?: string }} [filters]
     * @returns {Promise<{ tasks: object[], total: number, filterOptions: object }>}
     */
    async function buildBacklogTasks(filters) {
        const [rawBeads, claimedBy] = await Promise.all([listAllBeads(), buildClaimedBy()]);
        const rows = (Array.isArray(rawBeads) ? rawBeads : [])
            .filter((b) => b && typeof b.id === 'string' && b.id.length > 0);
        const normalized = rows.map(normalizeBead);
        const partialClaimById = computePartialClaimByBead(normalized, claimedBy);
        const free = rows
            .filter((b) => !claimedBy.has(b.id))
            .map((b) => ({ ...b, partialClaim: partialClaimById.get(b.id) ?? null }));
        return applyBeadFilters(free, filters);
    }

    return {
        name: 'backlog',
        buildClaimedBy,
        buildTree,
        buildBacklogTasks,
        renderHtml,
    };
}
