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
// re-expanding each active sprint's roots -- the exact same live-subtree
// question eft.5.3's expandScope() (./scope-overlap.mjs) answers for the
// launch-time overlap guard, but computed here IN-MEMORY (apra-fleet-c4s) via
// expandScopeInMemory(), walking a child-index built off the single bulk
// `bd list --json --limit 0` fetch this module already does per render,
// instead of one `bd list --parent <id>` subprocess call per discovered node.
// A bead created after launch, under a claimed root, is claimed the instant
// it exists and never leaks into the Backlog.
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

import { escapeHtml } from '@apralabs/apra-fleet-workflow/viewer/html-utils';
import { WATCHDOG_STATUS } from './watchdog.mjs';
import { renderBeadsHtml } from '../../fleet-sprint/viewer-extensions.mjs';
import { sendJson } from './server.mjs';
import { execBdAsync } from '../../../../scripts/lib/exec-bd.mjs';

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
    // Routed through the shared execBdAsync() helper (apra-fleet-xuo.2) --
    // on Windows it resolves the `bd.cmd` shim directly (no `shell: true`),
    // avoiding both the ENOENT spawn issue a bare `execFileAsync('bd', ...)`
    // would hit AND the metacharacter-injection risk `shell: true` carries.
    // Every argument here is a static literal anyway (none caller-controlled),
    // but the shared helper keeps this call consistent with scope-overlap.mjs's.
    const { stdout } = await execBdAsync(['list', '--json', '--limit', '0']);
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

/**
 * Build a parent-id -> direct-child-ids index off an already-fetched, already-
 * normalized beads list. This is the SAME technique `buildBacklogTree()`
 * (below, `allChildrenOf`) and `computePartialClaimByBead()` already use to
 * derive containment structure from one bulk `bd list` fetch, factored out
 * here so `expandScopeInMemory()` can share it.
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
 * In-memory equivalent of `expandScope()` (./scope-overlap.mjs): expands a set
 * of root issue ids into the full parent-child subtree they span (roots
 * INCLUDED), via the identical breadth-first-walk logic -- but walking a
 * `buildChildIndex()` Map built off an already-fetched flat beads list
 * instead of issuing one `bd list --parent <id>` subprocess call per
 * discovered node. Same roots + same beads list -> IDENTICAL result to the
 * subprocess-based `expandScope()` (apra-fleet-c4s).
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
 * Injects an interactive select/search control into each of the 6 static
 * `<th>` cells `renderBeadsHtml()` emits (ID/Title/Type/Status/Pri/Model), so
 * the Backlog tab's filter controls live IN the column headers themselves
 * instead of a separate filter bar above the table -- ID's header carries the
 * free-text search (matches id OR title, same as `applyBeadFilters()`'s `q`),
 * Title stays a plain label (search already covers title text), and Type/
 * Status/Pri/Model become `<select>`s seeded from `filterOptions`'s REAL
 * observed values. `currentFilters` re-selects/re-fills each control so a
 * table re-render (collapse toggle, a fresh filtered fetch) never resets what
 * the operator had chosen -- this function is called fresh on every
 * `renderTable()` pass client-side, not just once at page load.
 * @param {{ type: string[], status: string[], priority: number[], model: string[] }} filterOptions
 * @param {{ type?: string, status?: string, priority?: string|number, model?: string, q?: string }} [currentFilters]
 * @returns {string}
 */
function buildFilterHeaderRowHtml(filterOptions, currentFilters) {
    const opts = filterOptions || { type: [], status: [], priority: [], model: [] };
    const f = currentFilters || {};
    const CTRL_STYLE = 'width: 100%; background: rgba(255,255,255,0.06); color: inherit; border: 1px solid var(--border, rgba(255,255,255,0.1)); border-radius: 4px; padding: 3px 6px; font-size: 12px;';

    function selectHtml(field, allLabel, values, current, labelFn) {
        const currentStr = current !== undefined && current !== null ? String(current) : '';
        const optionsHtml = ['<option value="">' + escapeHtml(allLabel) + '</option>']
            .concat((values || []).map((v) => {
                const val = escapeHtml(String(v));
                const label = escapeHtml(labelFn ? String(labelFn(v)) : String(v));
                const selected = String(v) === currentStr ? ' selected' : '';
                return '<option value="' + val + '"' + selected + '>' + label + '</option>';
            }));
        return '<select data-filter-field="' + field + '" style="' + CTRL_STYLE + '">' + optionsHtml.join('') + '</select>';
    }

    const qVal = escapeHtml(f.q || '');
    return '<tr style="border-bottom: 1px solid rgba(255,255,255,0.1);">' +
        '<th style="padding: 8px; width: 110px;">ID</th>' +
        '<th style="padding: 8px;"><input type="text" data-filter-field="q" placeholder="Search ID or Title..." value="' + qVal + '" style="' + CTRL_STYLE + '"/></th>' +
        '<th style="padding: 8px; width: 90px;">' + selectHtml('type', 'Type', opts.type, f.type) + '</th>' +
        '<th style="padding: 8px; width: 100px;">' + selectHtml('status', 'Status', opts.status, f.status) + '</th>' +
        '<th style="padding: 8px; width: 50px;">' + selectHtml('priority', 'Pri', opts.priority, f.priority, (p) => 'P' + p) + '</th>' +
        '<th style="padding: 8px; width: 80px;">' + selectHtml('model', 'Model', opts.model, f.model) + '</th>' +
        '</tr>';
}

/**
 * Splices `headerRowHtml` in place of the static plain-label header row
 * `renderBeadsHtml()` always emits (`<th>ID</th><th>Title</th>...`), WITHOUT
 * modifying the shared function itself -- fleet-sprint's own live viewer
 * calls `renderBeadsHtml()` too and must keep its plain, non-interactive
 * header untouched. First-match-only string replace: the header row renders
 * exactly once, at the top of the `<table>`.
 * @param {string} tableHtml
 * @param {string} headerRowHtml
 * @returns {string}
 */
function injectFilterHeader(tableHtml, headerRowHtml) {
    return tableHtml.replace(/<tr[^>]*>\s*(?:<th[^>]*>[\s\S]*?<\/th>\s*){6}<\/tr>/, headerRowHtml);
}

/**
 * Injects a select-checkbox into every data row's leading ID cell (right
 * after that cell's opening `<td>`, before the tree-toggle/id text) --
 * again via string splice on `renderBeadsHtml()`'s OUTPUT, never by touching
 * the shared renderer, so fleet-sprint's own viewer (which never calls this)
 * is unaffected. `launch-form.mjs`'s client script drives selection off
 * these checkboxes (see its 'change' listener), including cascading a
 * parent's check state onto its visible children by walking sibling rows'
 * indentation depth.
 * @param {string} tableHtml
 * @returns {string}
 */
function injectRowCheckboxes(tableHtml) {
    return tableHtml.replace(/(<tr data-bead-id="([^"]*)"[^>]*>\s*<td[^>]*>)/g, function (match, trAndTd, id) {
        return trAndTd + '<input type="checkbox" class="bead-select-checkbox" data-bead-id="' + id + '" style="margin-right:6px; vertical-align:middle;"/>';
    });
}

/**
 * The Backlog tab's client-side behavior: re-renders `#backlog-table` from
 * `renderBeadsHtml()` on every collapse/expand toggle (mirrors
 * fleet-sprint's beadsExtension client script, minus its live SSE-poll/detail-
 * fetch machinery -- this page has no running workflow to poll and every
 * bead's full `description` is already inlined server-side, so there is
 * nothing to lazy-fetch), and re-fetches `GET /api/backlog/tasks` -- a real
 * network round trip that narrows the row SET server-side (apra-fleet-7xk's
 * "not just UI" requirement) -- whenever a filter control changes.
 * @returns {string}
 */
function backlogPanelClientScript() {
    return `
(function () {
    var container = document.getElementById('backlog-table');
    var indicator = document.getElementById('backlog-active-filters');
    var totalCountEl = document.getElementById('backlog-total-count');
    var clearBtn = document.getElementById('backlog-filter-clear');
    if (!container) return;

    // apra-fleet-eft.90: keep the persistent total-item count in sync with
    // whatever lastTasks currently is -- called once up front (server-
    // rendered value may already match, but this stays the single source of
    // truth) and again every time lastTasks is reassigned below.
    function updateTotalCount() {
        if (totalCountEl) totalCountEl.textContent = lastTasks.length + ' bead(s)';
    }

    var collapsedBeadIds = new Set();
    var lastTasks = window.__backlogTasks || [];
    var filterOptions = window.__backlogFilterOptions || { type: [], status: [], priority: [], model: [] };
    var currentFilters = {};

    ${escapeHtml.toString()}
    ${renderBeadsHtml.toString()}
    ${injectRowCheckboxes.toString()}
    ${buildFilterHeaderRowHtml.toString()}
    ${injectFilterHeader.toString()}

    function wireHeaderControls() {
        container.querySelectorAll('[data-filter-field]').forEach(function (el) {
            var field = el.getAttribute('data-filter-field');
            var evt = el.tagName === 'SELECT' ? 'change' : 'change';
            el.addEventListener(evt, function () {
                currentFilters[field] = el.value;
                applyFilters();
            });
        });
    }

    function renderTable() {
        var raw = renderBeadsHtml([], lastTasks, collapsedBeadIds);
        var headerRow = buildFilterHeaderRowHtml(filterOptions, currentFilters);
        container.innerHTML = injectRowCheckboxes(injectFilterHeader(raw, headerRow));
        wireHeaderControls();
        // Re-apply any launch-form checkbox selection (see launch-form.mjs)
        // that a fresh innerHTML would otherwise wipe -- the two scripts
        // cooperate via this one small window-scoped hook rather than
        // sharing a closure.
        if (window.__fleetSeLaunch && typeof window.__fleetSeLaunch.isSelected === 'function') {
            container.querySelectorAll('input.bead-select-checkbox').forEach(function (cb) {
                if (window.__fleetSeLaunch.isSelected(cb.getAttribute('data-bead-id'))) {
                    cb.checked = true;
                    var tr = cb.closest('tr');
                    if (tr) tr.classList.add('bead-row-selected');
                }
            });
        }
    }

    container.addEventListener('click', function (e) {
        var toggle = e.target && e.target.closest ? e.target.closest('.tree-toggle') : null;
        if (!toggle) return;
        var id = toggle.dataset.toggleId;
        if (!id) return;
        if (collapsedBeadIds.has(id)) collapsedBeadIds.delete(id);
        else collapsedBeadIds.add(id);
        renderTable();
    });

    function applyFilters() {
        var params = new URLSearchParams();
        Object.keys(currentFilters).forEach(function (k) {
            var v = currentFilters[k];
            if (v) params.set(k, v);
        });
        fetch('/api/backlog/tasks?' + params.toString())
            .then(function (r) { return r.json(); })
            .then(function (data) {
                lastTasks = (data && Array.isArray(data.tasks)) ? data.tasks : [];
                window.__backlogTasks = lastTasks;
                if (data && data.filterOptions) filterOptions = data.filterOptions;
                collapsedBeadIds.clear();
                renderTable();
                updateTotalCount();
                var entries = Object.keys(currentFilters)
                    .filter(function (k) { return currentFilters[k]; })
                    .map(function (k) { return k + ': ' + currentFilters[k]; });
                if (indicator) indicator.textContent = entries.length ? ('Filtering by ' + entries.join(', ') + ' -- ' + lastTasks.length + ' of ' + (data.total || lastTasks.length) + ' shown') : '';
            })
            .catch(function () { /* leave the last-known-good table in place */ });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', function () {
            currentFilters = {};
            applyFilters();
        });
    }

    wireHeaderControls();
    updateTotalCount();
})();
`;
}

/**
 * Renders the Backlog tab's full content: the beads table itself, server-
 * rendered via fleet-sprint's `renderBeadsHtml()` with an empty `sprintTasks`
 * (the supervisor has no single sprint's containment tree to show here --
 * only the cross-sprint free set), then two supervisor-only post-processing
 * passes over that same markup: `injectFilterHeader()` swaps the plain ID/
 * Title/Type/Status/Pri/Model header row for one carrying live filter
 * controls (search folded into the ID column, Type/Status/Pri/Model as
 * `<select>`s seeded from `filterOptions`'s real observed values -- apra-
 * fleet-7xk), and `injectRowCheckboxes()` adds a select-checkbox to every row
 * (driven by launch-form.mjs's selection/cascade logic). Neither pass touches
 * the shared `renderBeadsHtml()` itself, so fleet-sprint's own live viewer
 * (which also calls it) is unaffected.
 * @param {object[]} tasks
 * @param {{ type: string[], status: string[], priority: number[], model: string[] }} filterOptions
 * @returns {string}
 */
export function renderBacklogPanelHtml(tasks, filterOptions) {
    const opts = filterOptions || { type: [], status: [], priority: [], model: [] };
    const rawTable = renderBeadsHtml([], tasks, new Set());
    const headerRow = buildFilterHeaderRowHtml(opts, {});
    const tableHtml = injectRowCheckboxes(injectFilterHeader(rawTable, headerRow));
    const tasksJson = JSON.stringify(Array.isArray(tasks) ? tasks : []).replace(/</g, '\\u003c');
    const filterOptionsJson = JSON.stringify(opts).replace(/</g, '\\u003c');
    // apra-fleet-eft.90: a persistent total-item count, always visible at
    // the top of the tab -- INDEPENDENT of #backlog-active-filters (which
    // stays empty with no filter active, per that indicator's own
    // long-standing contract). Server-rendered from `tasks` (the already-
    // narrowed set this render actually shows, whether a filter is active or
    // not) and kept in sync client-side by backlogPanelClientScript()'s
    // renderTable()/applyFilters() whenever `lastTasks` changes -- so a
    // filter change updates this number too, not just the '...shown' text
    // inside #backlog-active-filters.
    const totalTaskCount = Array.isArray(tasks) ? tasks.length : 0;
    return (
        '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom: 6px;">' +
        '<span id="backlog-total-count" style="font-size: 12px; color: #a1a1aa;">' + totalTaskCount + ' bead(s)</span>' +
        '<div style="display:flex; align-items:center; gap:8px;">' +
        '<span id="backlog-active-filters" style="font-size: 12px; color: var(--accent, #3b82f6);"></span>' +
        '<button type="button" id="backlog-filter-clear" class="btn btn-secondary" style="padding: 3px 10px; font-size: 12px;">Clear filters</button>' +
        '</div>' +
        '</div>' +
        '<div id="backlog-table">' + tableHtml + '</div>' +
        '<script>window.__backlogTasks = ' + tasksJson + '; window.__backlogFilterOptions = ' + filterOptionsJson + ';</script>' +
        '<script>' + backlogPanelClientScript() + '</script>'
    );
}

/**
 * Registers `GET /api/backlog/tasks` -- the flat, filterable beads-tree data
 * source for the Backlog tab's client-side filter re-fetch (see
 * backlogPanelClientScript() above). Deliberately separate from the existing
 * `GET /api/backlog` (api.mjs, the nested BacklogNode[] shape other callers
 * may already depend on) -- this is an additive endpoint, not a replacement.
 * @param {{ route: (method: string, path: string, handler: Function) => void }} supervisor
 * @param {ReturnType<typeof createBacklog>} backlog
 */
export function registerBacklogRoutes(supervisor, backlog) {
    supervisor.route('GET', '/api/backlog/tasks', async (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            const filters = {
                type: url.searchParams.get('type') || undefined,
                status: url.searchParams.get('status') || undefined,
                priority: url.searchParams.get('priority') || undefined,
                model: url.searchParams.get('model') || undefined,
                q: url.searchParams.get('q') || undefined,
            };
            const result = await backlog.buildBacklogTasks(filters);
            sendJson(res, 200, result);
        } catch (err) {
            sendJson(res, 500, { error: 'failed to build backlog tasks' });
        }
    });
}

/**
 * Create the Backlog seam. Collaborators injected for unit testing without a
 * real `bd` / live sprints.
 *
 * @param {{
 *   ledger: { list: () => Array<{ sprintId: string, issueRoots: string[] }> },
 *   listAllBeads?: () => Promise<Array<object>>|Array<object>,
 *   expandScope?: (roots: string[]) => Promise<Set<string>>|Set<string>,
 *   watchdog?: { classifySprint: (entry: object) => Promise<{ status: string }> },
 *   logger?: { log?: Function, error?: Function },
 * }} deps
 *
 * `expandScope`, if supplied, fully overrides claimed-scope computation (used
 * by tests to stub scope expansion deterministically without a real `bd` /
 * beads fixture). When omitted (the production default -- apra-fleet-c4s),
 * claimed scope is computed IN-MEMORY via `expandScopeInMemory()`, walking a
 * `buildChildIndex()` built off the SAME `listAllBeads()` result `buildTree()`
 * / `buildBacklogTasks()` already fetch in the same render pass -- zero extra
 * `bd` subprocess calls, never the old per-node `expandScope()` (./scope-
 * overlap.mjs) subprocess walker.
 */
export function createBacklog(deps = {}) {
    const ledger = deps.ledger;
    if (!ledger || typeof ledger.list !== 'function') {
        throw new TypeError('createBacklog requires a ledger with a list() method');
    }
    const logger = deps.logger ?? console;
    const logError = (...a) => (logger.error ?? logger.log)?.(...a);
    // Only used when a caller (test) explicitly overrides claimed-scope
    // computation wholesale -- the production default path below never calls
    // this (apra-fleet-c4s: no per-node `bd` subprocess walk on every render).
    const explicitExpand = deps.expandScope ?? null;
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
     * Build the claimed-id -> owning-sprint map by expanding every active
     * sprint's roots to their live full subtree. First writer wins per id
     * (exact-overlap policy guarantees no two active sprints share a bead
     * anyway). A per-sprint expansion failure is isolated -- that one sprint
     * contributes no claims rather than taking the whole Backlog down.
     *
     * Production default (no `deps.expandScope` override, apra-fleet-c4s):
     * computed purely IN-MEMORY via `expandScopeInMemory()` off a
     * `buildChildIndex()` built from `rawBeadsArg` if the caller already
     * fetched it this render (buildTree()/buildBacklogTasks() below always
     * do), or from one `listAllBeads()` call otherwise -- never a per-node
     * `bd` subprocess walk.
     * @param {Array<object>} [rawBeadsArg] - already-fetched `listAllBeads()`
     *        result, reused to avoid a second bulk fetch in the same render.
     * @returns {Promise<Map<string, string>>}
     */
    async function buildClaimedBy(rawBeadsArg) {
        const claimedBy = new Map();
        const reservations = await activeReservations();
        if (reservations.length === 0) return claimedBy;

        let childIndex = null;
        if (!explicitExpand) {
            const rawBeads = rawBeadsArg ?? await listAllBeads();
            const beads = (Array.isArray(rawBeads) ? rawBeads : []).map(normalizeBead).filter((b) => b.id.length > 0);
            childIndex = buildChildIndex(beads);
        }

        await Promise.all(reservations.map(async (r) => {
            try {
                const roots = r.issueRoots ?? [];
                const scope = explicitExpand ? await explicitExpand(roots) : expandScopeInMemory(roots, childIndex);
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
        const rawBeads = await listAllBeads();
        const claimedBy = await buildClaimedBy(rawBeads);
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
        const rawBeads = await listAllBeads();
        const claimedBy = await buildClaimedBy(rawBeads);
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
