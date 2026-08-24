import { escapeHtml } from '@apralabs/apra-fleet-workflow/viewer/html-utils';
import { computeSprintProgress } from './sprint-progress.mjs';

/**
 * apra-fleet-x8r.1: pure HTML-string builder for the beads-closed/required
 * progress-bar widget in the single-sprint viewer's extension area. Takes
 * the ALREADY-COMPUTED `{ closed, required, fraction }` shape
 * `computeSprintProgress()` returns -- never re-derives scope or counts
 * itself -- and renders a horizontal bar that fills left-to-right by
 * `fraction`, plus the numeric 'M/N' text. Styled with the viewer's existing
 * `--bg`/`--bg-glass`/`--accent` CSS variables. `required === 0` renders a
 * flat, empty bar and 'Required: 0/0' text rather than dividing by zero or
 * throwing.
 *
 * apra-fleet-vk0a.1: the 'M/N' text carries an explicit `Required: ` label
 * (closed/required, goal+decomposedParentIds-filtered per
 * computeSprintProgress()) -- this widget is reused as-is by BOTH the
 * fleet-sprint per-sprint viewer's Tasks tab (renderBeadsPanel() below --
 * apra-fleet-vk0a.2 pins it into the FIXED panel-header row, next to the
 * 'Tasks' label, rather than the top of the scrollable tree below, so it
 * never scrolls out of view alongside renderBeadsHtml()'s OWN,
 * differently-scoped 'All tasks (incl. backlog)' count -- see that widget's
 * doc comment) AND the supervisor dashboard's Sprint Stack card
 * (dashboard.mjs's renderSprintProgressHtml(), next to its OWN
 * differently-scoped 'N total in scope' count -- apra-fleet-vk0a.3).
 * Labeling it once, here, keeps both pairings unambiguous without a second
 * implementation.
 *
 * @param {{ closed: number, required: number, fraction: number }} progress
 * @returns {string}
 */
export function renderProgressBarHtml(progress) {
    const p = progress || { closed: 0, required: 0, fraction: 0 };
    const closed = typeof p.closed === 'number' && Number.isFinite(p.closed) ? p.closed : 0;
    const required = typeof p.required === 'number' && Number.isFinite(p.required) ? p.required : 0;
    const fraction = typeof p.fraction === 'number' && Number.isFinite(p.fraction) ? p.fraction : 0;
    const pct = Math.max(0, Math.min(1, fraction)) * 100;
    return (
        '<div class="sprint-progress" style="display: flex; align-items: center; gap: 8px; padding: 8px; font-size: 12px;">' +
        '<div style="flex: 1; height: 8px; background: var(--bg); border: 1px solid var(--bg-glass); border-radius: 4px; overflow: hidden;">' +
        '<div style="width: ' + pct + '%; height: 100%; background: var(--accent);"></div>' +
        '</div>' +
        '<div style="color: #a1a1aa; white-space: nowrap;">Required: ' + closed + '/' + required + '</div>' +
        '</div>'
    );
}

/**
 * Pure HTML-string builder for the beads task tree (apra-fleet-unw.10,
 * F9/A7-viewer).
 *
 * Bead `id`/`title`/`description`/`status` are LLM-authored (or otherwise
 * untrusted) and were previously interpolated into `innerHTML` unescaped --
 * an XSS risk, since the same dashboard page also exposes the `/stop`
 * capability. Every bead-derived field is now run through the shared
 * `escapeHtml()` (packages/apra-fleet-workflow/src/viewer/html-utils.mjs)
 * before being placed into the returned HTML string.
 *
 * This function only builds and returns a string via concatenation -- it
 * never touches `document` -- so it can be (and is, see
 * test/viewer-extensions.test.mjs) unit-tested directly under Node without a
 * browser/DOM/jsdom dependency.
 *
 * The identical implementation also has to run in the browser, inside the
 * extension's plain (non-module) `<script>` tag, which cannot `import` this
 * file at runtime. Rather than hand-duplicating the logic, its source text
 * is embedded into that `<script>` tag via `.toString()` (see `js` below),
 * the same pattern `escapeHtml` itself uses -- one implementation, not two
 * kept in sync by hand. All helper functions (badge builders, tree
 * construction) are nested INSIDE renderBeadsHtml rather than module-level,
 * so that single `.toString()` embed captures everything -- no second
 * function needs its own embed.
 *
 * Tree is built from each task's `parent` field (bd's real parent-child
 * containment, e.g. a `[test]` task nested under its owning bug/feature),
 * not from `blocks`-type dependency edges -- the user-facing goal is "show
 * me epic->task nesting" (containment), not "show me what unblocks what"
 * (ordering). A task with no in-dataset parent is a root. `blocks`-type
 * edges are a real DAG (a task can have multiple blockers) with no bearing
 * on tree placement; every blocker is instead listed inline as a compact
 * "blocked by" badge on the row, so no dependency/ordering information is
 * lost even though it is no longer used for nesting. Multiple top-level
 * roots (tasks with no in-dataset parent) render as multiple top-level
 * rows -- this is expected, not an error, whenever a sprint targets more
 * than one independent top-level item at once. apra-fleet-eft.52.1.2: those
 * TOP-LEVEL roots are ordered by status urgency first (In-progress -> Open
 * -> Blocked -> Closed, priority-then-id breaking ties within a status);
 * this is non-recursive -- each root's own children keep their existing
 * natural DAG order (see `childrenOf[nodeId].slice().sort()` in
 * `renderNode`), unaffected by their parent's status.
 *
 * The panel shows up to two top-level sections: "Sprint" (the containment
 * tree above, built from `sprintTasks`) and "Backlog" (`backlogTasks` --
 * open/deferred beads the sprint is certainly NOT addressing this run,
 * which may belong to an entirely different epic or never have gone
 * through a planning phase at all). Each section (header + body) is
 * rendered ONLY when that section has at least one task (apra-fleet-eft.89):
 * an empty `sprintTasks`/`backlogTasks` array skips its section entirely
 * rather than showing a header with a "No sprint tasks."/"No backlog
 * items." placeholder row. This lets a caller that only ever supplies one
 * of the two lists (e.g. the supervisor's viewer, which always calls
 * `renderBeadsHtml([], tasks, ...)`) render a single, focused section with
 * no always-empty sibling section cluttering the panel. The 6-column
 * header row and outer `<table>` wrapper always render regardless of which
 * (if either) section has content.
 *
 * apra-fleet-k7s: Backlog nests the same way Sprint does -- by `parent`
 * containment FIRST (an in-set parent-child edge, e.g. an epic's children
 * that never made it into a sprint run) -- falling back to `blocks`-type
 * dependency edges BETWEEN backlog items only for a genuinely parent-less
 * item (e.g. two unplanned beads under the same stale epic, one blocking
 * the other, with the epic itself out of this dataset). When a blocks-edge
 * fallback fires, it drives nesting the same way `renderNode` nests Sprint
 * rows: the blocker renders as the parent row, the blocked item nests as
 * its child, using the identical indent/prefix/cycle-guard mechanics. A
 * backlog item with neither an in-set parent nor a blocks-edge to another
 * IN-SET backlog item remains a flat, top-level row -- nesting is only
 * ever drawn when a real edge justifies it, never implied. Root rows
 * (including every item with no in-set parent/blocker) are still sorted
 * priority-then-id for scannability; a nested item's DEPTH in the tree is
 * what shows structure, not its position in that sort.
 *
 * Every rendering decision here (status/type badges, tree placement) is
 * defensive by construction: unrecognized/missing status, type, model, or
 * priority values fall back to a generic, still-visible label rather than
 * throwing or rendering blank, and a cycle-guard plus an end-of-pass sweep
 * for any task that never got attached to the tree (should not happen with
 * well-formed bd data, but is not assumed) guarantees every task in the
 * input is rendered exactly once, never silently dropped.
 *
 * apra-fleet-4p5: every tree node that has children (and either top-level
 * "Sprint"/"Backlog" section header that is actually rendered, per the
 * conditional-section rule above) renders a `[-]`/`[+]` toggle (a
 * `.tree-toggle` span carrying a `data-toggle-id`,
 * same round-trip-through-the-DOM pattern the `bead-desc` `data-bead-id`
 * attribute already uses) so a user can fold away a subtree. A node id in
 * `collapsedIds` is rendered collapsed: its own row still shows (with the
 * `[+]` toggle), but none of its descendants' rows are emitted at all --
 * they are still walked (so the cycle-guard/`rendered` bookkeeping stays
 * correct and the end-of-pass safety-net sweep does not re-attach a hidden
 * descendant as a spurious extra root), just not concatenated into the
 * returned HTML. The two sections use the synthetic ids `'section:sprint'`
 * / `'section:backlog'` in the same `collapsedIds` set, since neither can
 * ever collide with a real bd id. This function stays a pure, synchronous
 * string builder either way -- collapse is a rendering decision driven
 * entirely by the `collapsedIds` input, not by any DOM/document access.
 *
 * @param {Array<{id: string|number, title?: string, description?: string, status?: string, issue_type?: string, ready?: boolean, priority?: number, metadata?: {model?: string}, dependencies?: Array<{depends_on_id: string|number, type: string}>}>} sprintTasks
 * @param {Array<{id: string|number, title?: string, description?: string, status?: string, issue_type?: string, priority?: number, metadata?: {model?: string}}>} [backlogTasks]
 * @param {Set<string>|string[]} [collapsedIds] ids (real bead ids, or the synthetic 'section:sprint'/'section:backlog') currently collapsed
 * @returns {string}
 */
export function renderBeadsHtml(sprintTasks, backlogTasks, collapsedIds) {
    sprintTasks = sprintTasks || [];
    backlogTasks = backlogTasks || [];

    // apra-fleet-eft.52.1.3: a server-computed `placement` flag ('sprint' |
    // 'backlog') on a task is AUTHORITATIVE for which section it renders in --
    // runner.js decides Sprint vs Backlog by goal membership (goal-priority
    // band + a blocks-edge exception), not this browser-side view, and never
    // by hiding a row with CSS. When any task carries `placement`, re-derive
    // both section lists from the flag so a below-goal top-level item lands in
    // the Backlog container even if it arrived in the sprintTasks array (and
    // vice versa). Tasks with no `placement` (every pre-existing caller and
    // fixture) are left in whichever array the caller passed them -- this
    // normalization is a no-op for them, so behavior is unchanged.
    const anyPlacement = sprintTasks.some((t) => t && t.placement) || backlogTasks.some((t) => t && t.placement);
    if (anyPlacement) {
        const all = sprintTasks.concat(backlogTasks);
        // A flag-less item defaults to Sprint (in-scope work of unknown rank
        // is sprint work, mirroring runner.js's server-side default).
        sprintTasks = all.filter((t) => t && t.placement !== 'backlog');
        backlogTasks = all.filter((t) => t && t.placement === 'backlog');
    }

    // Accept a Set (the browser-side embed's long-lived collapse state) or
    // a plain array (e.g. a future caller reconstructing it from
    // persisted/serialized state) -- never throws on either shape.
    collapsedIds = collapsedIds instanceof Set ? collapsedIds : new Set(Array.isArray(collapsedIds) ? collapsedIds : []);

    // ASCII-only badges throughout (project convention) -- bracketed text
    // tags with inline color, not unicode glyphs/emoji.
    // Color signals "needs attention", not "good/bad": closed work is done
    // and should recede (grey), not celebrate (green); open work hasn't
    // been started and should draw the eye (red), same urgency register as
    // blocked.
    const STATUS_BADGES = {
        open: { label: 'OPEN', color: 'var(--danger)' },
        in_progress: { label: 'IN PROGRESS', color: 'var(--accent)' },
        closed: { label: 'CLOSED', color: '#71717a' },
        blocked: { label: 'BLOCKED', color: 'var(--danger)' },
        deferred: { label: 'DEFERRED', color: '#71717a' },
    };
    // Keys serve double duty: some are real bd `issue_type` values (bug,
    // chore, epic, decision), checked first below; others are only
    // title-prefix conventions (test, impl, feat, fix, doc, design, spike,
    // ci) that carry no `issue_type` of their own -- `task`/`feature` beads
    // commonly use these prefixes to say what KIND of task/feature work this
    // is, which is more informative than the bare issue_type, so those two
    // real types are deliberately left OUT of this map: leaving them out is
    // what lets the title-prefix fallback below run for them instead of
    // being short-circuited to a bare TASK/FEATURE badge.
    const TYPE_BADGES = {
        bug: { label: 'BUG', color: 'var(--danger)' },
        test: { label: 'TEST', color: '#22d3ee' },
        impl: { label: 'IMPL', color: 'var(--accent)' },
        feat: { label: 'FEAT', color: 'var(--accent)' },
        fix: { label: 'FIX', color: 'var(--danger)' },
        doc: { label: 'DOC', color: '#a78bfa' },
        docs: { label: 'DOC', color: '#a78bfa' },
        design: { label: 'DESIGN', color: '#a78bfa' },
        spike: { label: 'SPIKE', color: '#f59e0b' },
        ci: { label: 'CI', color: '#71717a' },
        chore: { label: 'CHORE', color: '#71717a' },
        epic: { label: 'EPIC', color: '#e4e4e7' },
        decision: { label: 'DECISION', color: '#a78bfa' },
    };

    // Never throws: an unrecognized or missing status/type always resolves
    // to a visible, styled fallback rather than a blank cell or an
    // exception that would take the whole panel down with it.
    function statusBadge(status) {
        const key = (status || '').toString().toLowerCase();
        const known = STATUS_BADGES[key];
        const label = known ? known.label : (status ? escapeHtml(status.toString().toUpperCase()) : 'UNKNOWN');
        const color = known ? known.color : '#a1a1aa';
        return '<span style="color: ' + color + '; font-weight: bold; font-size: 10px; border: 1px solid ' + color + '; border-radius: 3px; padding: 1px 5px; white-space: nowrap;">' + label + '</span>';
    }

    // Reads the authoritative `issue_type` first (bd's real, stored field);
    // only falls back to guessing from a `[prefix]` title convention when
    // issue_type is absent or isn't one of the types with its own dedicated
    // badge above (this is the common case for `task`/`feature` beads,
    // which rely on the title prefix to say what kind of task/feature this
    // is -- see the comment on TYPE_BADGES).
    function typeBadge(issueType, title) {
        const typeKey = (issueType || '').toString().toLowerCase();
        const knownType = TYPE_BADGES[typeKey];
        if (knownType) {
            return '<span style="color: ' + knownType.color + '; font-size: 10px; border: 1px solid ' + knownType.color + '; border-radius: 3px; padding: 1px 5px; white-space: nowrap;">' + knownType.label + '</span>';
        }
        const match = /^\[([A-Za-z0-9_-]+)\]/.exec(title || '');
        const prefixKey = match ? match[1].toLowerCase() : '';
        const knownPrefix = TYPE_BADGES[prefixKey];
        const label = knownPrefix ? knownPrefix.label : (match ? escapeHtml(match[1]).toUpperCase() : 'MISC');
        const color = knownPrefix ? knownPrefix.color : '#71717a';
        return '<span style="color: ' + color + '; font-size: 10px; border: 1px solid ' + color + '; border-radius: 3px; padding: 1px 5px; white-space: nowrap;">' + label + '</span>';
    }

    // apra-fleet-xbu.C6: a bead with stored status 'open' that is NOT in
    // this update's `--ready` set (see updateDashboard() in runner.js,
    // which now threads a per-bead `ready` boolean computed from the same
    // `--ready` query dispatch decisions are already based on) is blocked,
    // not merely unstarted -- render it distinctly instead of conflating it
    // with genuinely-ready OPEN work. Beads with no `ready` field at all
    // (e.g. backlog rows, or an older caller that hasn't been updated)
    // fall back to the plain stored-status badge, unchanged.
    function statusBadgeForNode(node) {
        const status = (node.status || '').toString().toLowerCase();
        if (status === 'open' && node.ready === false) {
            return statusBadge('blocked');
        }
        return statusBadge(node.status);
    }

    // apra-fleet-eft.52.1.2: rank used to order Sprint's TOP-LEVEL roots only
    // (see sprintRootSort below) -- in-progress work surfaces first, closed
    // work sinks to the bottom. Mirrors statusBadgeForNode's 'open' +
    // ready===false ==> effectively-blocked distinction above, so a root
    // row's rank always agrees with its own rendered status badge. Anything
    // outside these four (e.g. 'deferred', or a future/unrecognized status)
    // ranks after 'closed' rather than throwing or being treated as one of
    // the four.
    const STATUS_ORDER = { in_progress: 0, open: 1, blocked: 2, closed: 3 };
    function statusRank(node) {
        const status = (node.status || '').toString().toLowerCase();
        const effective = (status === 'open' && node.ready === false) ? 'blocked' : status;
        const rank = STATUS_ORDER[effective];
        return typeof rank === 'number' ? rank : STATUS_ORDER.closed + 1;
    }

    function priorityBadge(priority) {
        const label = (typeof priority === 'number' && Number.isFinite(priority)) ? 'P' + priority : 'P?';
        return '<span style="color: #a1a1aa; font-size: 10px;">' + label + '</span>';
    }

    // Closed items' titles are dimmed so completed work visually recedes
    // rather than competing for attention with what's still open/blocked.
    function titleColor(status) {
        return (status || '').toString().toLowerCase() === 'closed' ? '#71717a' : '#e4e4e7';
    }

    function modelBadge(metadata) {
        const model = metadata && metadata.model;
        return '<span style="color: #a1a1aa; font-size: 10px;">' + (model ? escapeHtml(model) : 'n/a') + '</span>';
    }

    // apra-fleet supervisor's Backlog view (src/supervisor/backlog.mjs) has no
    // containment tree of its own to hang a partial-claim annotation off (its
    // beads-tree nests by `blocks` edges, not `parent`), so it attaches the
    // annotation directly onto the flat row object it hands this renderer as
    // `node.partialClaim`. Every fleet-sprint caller leaves this field
    // undefined, so this is a no-op there -- same "defensive, never throws on
    // an absent/unrecognized field" rule the badge builders above already
    // follow.
    function partialClaimAnnotationHtml(partialClaim) {
        if (!partialClaim) return '';
        const sprintLabel = partialClaim.sprints.length === 0
            ? 'an active sprint'
            : partialClaim.sprints.map((s) => (partialClaim.sprints.length > 1 ? s.sprintId + ' (' + s.count + ')' : s.sprintId)).join(', ');
        const text = partialClaim.claimedCount + ' of ' + partialClaim.totalCount + ' children claimed by ' + sprintLabel + '; ' + partialClaim.freeCount + ' free';
        return '<div data-partial-claim="true" style="margin-top: 4px; font-size: 10px; color: #f59e0b; font-style: italic;">' + escapeHtml(text) + '</div>';
    }

    // apra-fleet-eft.27.2: descriptions are no longer inlined into the
    // dashboard's recurring poll payload -- apra-fleet-eft.27.1's lean
    // list-state transform (src/viewer/lean-state.mjs) strips every bead's
    // full `description` down to a short `summary` before GET /state ever
    // serves it, so the real running dashboard only ever has `summary`
    // here. The full text is instead fetched on demand, exactly once per
    // (bead id, updatedAt) pair, the moment a user expands the row -- see
    // GET /extensions/beads/detail/:itemId (src/viewer/index.mjs, generic
    // route delegating to this module's `beadsExtension.detailLookup`,
    // apra-fleet-eft.37.4) and the fetch + localStorage-cache logic wired up
    // below in `js`.
    //
    // A caller that already has the full `description` inline (this
    // module's own unit tests, a History-view's frozen/unleaned snapshot,
    // or any future non-leaned data source) still gets it rendered
    // immediately with no fetch at all -- `data-loaded="true"` marks that
    // case so the client-side expand handler never re-fetches something it
    // was already given. `summary` is only used as the short initial
    // preview when the full field isn't present.
    function descriptionDetailsHtml(task, safeId, safeTitle) {
        const preview = task.description || task.summary;
        if (!preview) return safeTitle;
        const safePreview = escapeHtml(preview);
        const safeUpdatedAt = escapeHtml(task.updated_at || task.updatedAt || '');
        const hasFull = task.description ? 'true' : 'false';
        return '<details class="bead-desc" data-bead-id="' + safeId + '" data-updated-at="' + safeUpdatedAt + '">' +
            '<summary style="cursor: pointer; outline: none; list-style-position: inside;">' + safeTitle + '</summary>' +
            '<div class="bead-desc-body" data-loaded="' + hasFull + '" style="margin-top: 6px; padding: 8px; background: rgba(0,0,0,0.15); border-left: 2px solid var(--accent); font-size: 11px; border-radius: 0 4px 4px 0; color: #a1a1aa; white-space: pre-wrap; font-family: monospace;">' +
            safePreview +
            '</div></details>';
    }

    // A childless node/section gets an invisible same-width spacer instead
    // of a toggle, so id/label columns still line up whether or not a
    // given row happens to have anything to fold away. `id` is the raw
    // (unescaped) node id or synthetic section key -- escaped here, once,
    // for the `data-toggle-id` attribute; the browser round-trips it back
    // to the original string when read via `.dataset.toggleId` (HTML
    // entity decoding), exactly like the existing `data-bead-id` attribute
    // on `.bead-desc` already relies on.
    function treeToggleHtml(id, hasChildren, collapsed) {
        if (!hasChildren) {
            return '<span style="display: inline-block; width: 16px;"></span>';
        }
        const safeToggleId = escapeHtml(id);
        const label = collapsed ? '[+]' : '[-]';
        const title = collapsed ? 'Expand' : 'Collapse';
        return '<span class="tree-toggle" data-toggle-id="' + safeToggleId + '" title="' + title + '" ' +
            'style="cursor: pointer; display: inline-block; width: 16px; user-select: none; color: #a1a1aa;">' + label + '</span>';
    }

    // apra-fleet-eft.52.1.1: `variant` distinguishes the Backlog header from
    // the Sprint header, both in DOM (a stable `backlog-header`/
    // `backlog-section` class not present on Sprint) and visually (a muted
    // band + more prominent header), so the two regions are no longer
    // rendered via an identical, indistinguishable code path.
    function sectionHeaderRow(label, sectionKey, collapsed, variant) {
        const isBacklog = variant === 'backlog';
        const rowClass = isBacklog ? 'section-header backlog-section' : 'section-header';
        const cellStyle = isBacklog
            ? 'padding: 10px 8px; font-size: 12px; font-weight: bold; letter-spacing: 0.5px; text-transform: uppercase; color: #e4e4e7; background: rgba(161,161,170,0.12); border-top: 1px solid rgba(255,255,255,0.15); border-bottom: 1px solid rgba(255,255,255,0.15);'
            : 'padding: 10px 8px 4px; font-size: 11px; font-weight: bold; letter-spacing: 0.5px; color: #a1a1aa; border-bottom: 1px solid rgba(255,255,255,0.1);';
        const headerClass = isBacklog ? ' backlog-header' : '';
        return '<tr class="' + rowClass + '"><td colspan="6" class="section-header-cell' + headerClass + '" style="' + cellStyle + '">' +
            treeToggleHtml(sectionKey, true, collapsed) + ' ' + escapeHtml(label) + '</td></tr>';
    }

    function emptySectionRow(message) {
        return '<tr><td colspan="6" style="padding: 8px; font-size: 12px; color: #71717a; font-style: italic;">' + escapeHtml(message) + '</td></tr>';
    }

    // --- Build a containment tree from each task's `parent` field, not
    // from `blocks`-type dependency edges (see module doc-comment above) ---
    const map = {};
    sprintTasks.forEach((t) => { map[t.id] = { ...t, children: [], blockedBy: [] }; });

    const childrenOf = {}; // parentId -> [taskId, ...] (parent-containment, not blocking)
    sprintTasks.forEach((t) => {
        // 'blocks'-type dependency edges are still captured here -- they no
        // longer decide tree placement, but every blocker is preserved and
        // rendered as an inline annotation below so no dependency
        // information is lost.
        const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
        const blockerIds = deps
            .filter((d) => d && d.type === 'blocks' && map[d.depends_on_id])
            .map((d) => d.depends_on_id);
        map[t.id].blockedBy = blockerIds;

        // Only an in-dataset parent contributes to nesting -- a `parent`
        // value pointing outside sprintTasks (e.g. an epic not itself part
        // of this sprint run) leaves the task a root, same as having no
        // parent at all.
        const parentId = t.parent;
        if (parentId !== undefined && parentId !== null && map[parentId]) {
            (childrenOf[parentId] = childrenOf[parentId] || []).push(t.id);
        }
    });

    // apra-fleet-eft.52.1.2: TOP-LEVEL Sprint roots only are primarily
    // ordered by status urgency (statusRank above) -- In-progress -> Open ->
    // Blocked -> Closed -- falling back to the existing priority-then-id
    // ordering only to break ties within the same status. This is
    // deliberately NOT applied recursively: `childrenOf[nodeId]` in
    // renderNode below keeps its own unrelated (natural DAG / id) order, so
    // a subtree's hierarchy stays legible rather than being scrambled by
    // status.
    function sprintRootSort(aId, bId) {
        const a = map[aId];
        const b = map[bId];
        const ra = statusRank(a);
        const rb = statusRank(b);
        if (ra !== rb) return ra - rb;
        const pa = (typeof a.priority === 'number' && Number.isFinite(a.priority)) ? a.priority : 99;
        const pb = (typeof b.priority === 'number' && Number.isFinite(b.priority)) ? b.priority : 99;
        if (pa !== pb) return pa - pb;
        return String(aId).localeCompare(String(bId));
    }

    const roots = sprintTasks
        .filter((t) => !(t.parent !== undefined && t.parent !== null && map[t.parent]))
        .map((t) => t.id)
        .sort(sprintRootSort);

    function renderNode(nodeId, depth, rendered) {
        if (rendered.has(nodeId)) return ''; // cycle-guard: never render twice
        rendered.add(nodeId);
        const node = map[nodeId];

        const indent = depth * 20;
        const prefix = depth > 0 ? String.fromCharCode(0x2514, 0x2500) + ' ' : '';

        // Every bead-derived field is escaped before interpolation -- these
        // are the exact fields the original (vulnerable) implementation
        // injected raw.
        const safeId = escapeHtml(node.id);
        const safeTitle = escapeHtml(node.title);

        const titleHtml = descriptionDetailsHtml(node, safeId, safeTitle);

        // 'blocks'-type dependency edges no longer decide tree placement
        // (nesting now comes from `parent`), so every blocker -- not just
        // ones beyond a former "primary" -- must be listed here or the
        // information would be lost.
        let extraBlockedByHtml = '';
        if (node.blockedBy.length > 0) {
            const blockers = node.blockedBy.slice().sort().map((id) => '#' + escapeHtml(id)).join(', ');
            extraBlockedByHtml = '<div style="margin-top: 4px; font-size: 10px; color: #71717a;">blocked by: ' + blockers + '</div>';
        }
        extraBlockedByHtml += partialClaimAnnotationHtml(node.partialClaim);

        const children = (childrenOf[nodeId] || []).slice().sort();
        const isCollapsed = children.length > 0 && collapsedIds.has(String(nodeId));
        const toggleHtml = treeToggleHtml(nodeId, children.length > 0, isCollapsed);

        // data-bead-id round-trips the raw (unescaped) id back via HTML entity
        // decoding, same convention as .bead-desc's data-bead-id / .tree-toggle's
        // data-toggle-id above -- lets a host page (e.g. the supervisor's Launch
        // Sprint form) wire row click-to-select without parsing rendered text.
        let html = '<tr data-bead-id="' + safeId + '" style="border-bottom: 1px solid rgba(255,255,255,0.05);">' +
            '<td style="padding: 8px; padding-left: ' + (8 + indent) + 'px; vertical-align: top; width: 110px; color: ' + titleColor(node.status) + ';">' + toggleHtml + prefix + '#' + safeId + '</td>' +
            '<td style="padding: 8px; vertical-align: top; color: ' + titleColor(node.status) + ';">' + titleHtml + extraBlockedByHtml + '</td>' +
            '<td style="padding: 8px; vertical-align: top; width: 90px;">' + typeBadge(node.issue_type, node.title) + '</td>' +
            '<td style="padding: 8px; vertical-align: top; width: 100px;">' + statusBadgeForNode(node) + '</td>' +
            '<td style="padding: 8px; vertical-align: top; width: 50px;">' + priorityBadge(node.priority) + '</td>' +
            '<td style="padding: 8px; vertical-align: top; width: 80px;">' + modelBadge(node.metadata) + '</td>' +
            '</tr>';

        // Always recurse (even when collapsed) so every descendant still
        // gets added to `rendered` -- otherwise the end-of-pass safety-net
        // sweep below would mistake a hidden-but-known descendant for an
        // orphan and re-attach it as a spurious extra root. Only the
        // concatenation into the returned HTML is conditional on collapse.
        const childrenHtml = children.map((childId) => renderNode(childId, depth + 1, rendered)).join('');
        if (!isCollapsed) {
            html += childrenHtml;
        }
        return html;
    }

    // apra-fleet-k7s: Backlog is built into a tree from `parent` containment
    // FIRST, `blocks`-type dependency edges BETWEEN backlog items SECOND
    // (mirrors the doc-comment above and reuses renderNode's own indent/
    // prefix/cycle-guard mechanics, just keyed off a separate `backlogMap`/
    // `backlogChildrenOf` rather than Sprint's `map`/`childrenOf`). A parent
    // or blocker outside the backlog set (e.g. it's actually in this run's
    // Sprint, or not part of this dataset at all) does not count -- same
    // "only an in-dataset edge nests" rule Sprint applies to `parent`.
    const backlogMap = {};
    backlogTasks.forEach((t) => { backlogMap[t.id] = { ...t, blockedBy: [] }; });

    const backlogChildrenOf = {}; // blockerId -> [taskId, ...] (blocks-edge, not containment)
    const nestedBacklogIds = new Set(); // ids nested under a blocker -- excluded from the root list

    backlogTasks.forEach((t) => {
        const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
        const blockerIds = deps
            .filter((d) => d && d.type === 'blocks' && backlogMap[d.depends_on_id])
            .map((d) => d.depends_on_id);
        backlogMap[t.id].blockedBy = blockerIds;

        // apra-fleet: containment (`parent`, in-set) nests FIRST, mirroring
        // Sprint's `map`/`childrenOf` above -- most backlog beads have a real
        // parent-child edge (an epic's children that never made it into a
        // sprint run), and nesting those under a `blocks` edge instead left
        // every parent-child-only bead rendering as a flat root alongside
        // its own epic. `blocks`-edge nesting is now the FALLBACK, used only
        // for a genuinely parent-less backlog item that still blocks/is
        // blocked by another in-set item.
        const parentId = t.parent;
        if (parentId !== undefined && parentId !== null && backlogMap[parentId]) {
            (backlogChildrenOf[parentId] = backlogChildrenOf[parentId] || []).push(t.id);
            nestedBacklogIds.add(t.id);
        } else if (blockerIds.length > 0) {
            // A node renders exactly once (cycle-guard below), so with
            // multiple in-set blockers only one can be the tree-parent --
            // the lowest-sorted blocker id wins, for deterministic output.
            // Every blocker (not just the nesting one) still appears in the
            // inline "blocked by" annotation, so no edge is silently lost.
            const primaryBlockerId = blockerIds.slice().sort()[0];
            (backlogChildrenOf[primaryBlockerId] = backlogChildrenOf[primaryBlockerId] || []).push(t.id);
            nestedBacklogIds.add(t.id);
        }
    });

    function priorityThenId(aId, bId) {
        const a = backlogMap[aId];
        const b = backlogMap[bId];
        const pa = (typeof a.priority === 'number' && Number.isFinite(a.priority)) ? a.priority : 99;
        const pb = (typeof b.priority === 'number' && Number.isFinite(b.priority)) ? b.priority : 99;
        if (pa !== pb) return pa - pb;
        return String(aId).localeCompare(String(bId));
    }

    const backlogRoots = backlogTasks
        .map((t) => t.id)
        .filter((id) => !nestedBacklogIds.has(id))
        .sort(priorityThenId);

    function renderBacklogNode(nodeId, depth, rendered) {
        if (rendered.has(nodeId)) return ''; // cycle-guard: never render twice
        rendered.add(nodeId);
        const node = backlogMap[nodeId];

        const indent = depth * 20;
        const prefix = depth > 0 ? String.fromCharCode(0x2514, 0x2500) + ' ' : '';

        const safeId = escapeHtml(node.id);
        const safeTitle = escapeHtml(node.title);

        const titleHtml = descriptionDetailsHtml(node, safeId, safeTitle);

        let extraBlockedByHtml = '';
        if (node.blockedBy.length > 0) {
            const blockers = node.blockedBy.slice().sort().map((id) => '#' + escapeHtml(id)).join(', ');
            extraBlockedByHtml = '<div style="margin-top: 4px; font-size: 10px; color: #71717a;">blocked by: ' + blockers + '</div>';
        }
        extraBlockedByHtml += partialClaimAnnotationHtml(node.partialClaim);

        const children = (backlogChildrenOf[nodeId] || []).slice().sort(priorityThenId);
        const isCollapsed = children.length > 0 && collapsedIds.has(String(nodeId));
        const toggleHtml = treeToggleHtml(nodeId, children.length > 0, isCollapsed);

        let html = '<tr data-bead-id="' + safeId + '" style="border-bottom: 1px solid rgba(255,255,255,0.05);">' +
            '<td style="padding: 8px; padding-left: ' + (8 + indent) + 'px; vertical-align: top; width: 110px; color: ' + titleColor(node.status) + ';">' + toggleHtml + prefix + '#' + safeId + '</td>' +
            '<td style="padding: 8px; vertical-align: top; color: ' + titleColor(node.status) + ';">' + titleHtml + extraBlockedByHtml + '</td>' +
            '<td style="padding: 8px; vertical-align: top; width: 90px;">' + typeBadge(node.issue_type, node.title) + '</td>' +
            '<td style="padding: 8px; vertical-align: top; width: 100px;">' + statusBadgeForNode(node) + '</td>' +
            '<td style="padding: 8px; vertical-align: top; width: 50px;">' + priorityBadge(node.priority) + '</td>' +
            '<td style="padding: 8px; vertical-align: top; width: 80px;">' + modelBadge(node.metadata) + '</td>' +
            '</tr>';

        // Same "always recurse, conditionally concatenate" rule as
        // renderNode above -- keeps the safety-net sweep below from
        // re-attaching a hidden-but-known descendant as a spurious root.
        const childrenHtml = children.map((childId) => renderBacklogNode(childId, depth + 1, rendered)).join('');
        if (!isCollapsed) {
            html += childrenHtml;
        }
        return html;
    }

    // apra-fleet-eft.90: a persistent item count at the top of the panel --
    // N = every rendered bead across BOTH sections (Sprint + Backlog), M =
    // how many of those are not closed (open, in_progress, blocked, etc).
    // Parent and child beads each count as their own item toward both
    // numbers -- these are flat counts over the input arrays themselves,
    // never deduped/collapsed by tree hierarchy (a bead present in
    // `sprintTasks`/`backlogTasks` counts exactly once regardless of how
    // many descendants it has). An empty panel (both lists empty) renders
    // 'All tasks (incl. backlog): 0 open / 0 total', never NaN/throwing.
    //
    // apra-fleet-vk0a.1: labeled 'All tasks (incl. backlog)' -- explicitly
    // distinct from the DIFFERENT scope/definition of renderProgressBarHtml()'s
    // 'Required: M/N' widget (goal+decomposedParentIds-filtered, sprintTasks
    // only), which apra-fleet-vk0a.2 pins into the Tasks tab's FIXED
    // panel-header row (renderBeadsPanel() below) rather than rendering it
    // here at the top of this scrollable panel. Before the vk0a.1 label, the
    // two counts read as a bug (same-looking 'M/N' pair, different
    // denominators AND inverted numerator polarity -- this one is
    // open-count, that one is closed-count) rather than two intentionally
    // different, both-useful numbers.
    const countedTasks = sprintTasks.concat(backlogTasks);
    const totalBeadCount = countedTasks.length;
    const openBeadCount = countedTasks.filter((t) => t && (t.status || '').toString().toLowerCase() !== 'closed').length;
    const countHtml = '<div class="beads-count" style="padding: 4px 8px; font-size: 12px; color: #a1a1aa;">' +
        'All tasks (incl. backlog): ' + openBeadCount + ' open / ' + totalBeadCount + ' total</div>';

    let html = countHtml + '<table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 13px;">';
    html += '<tr style="border-bottom: 1px solid rgba(255,255,255,0.1);">' +
        '<th style="padding: 8px;">ID</th><th style="padding: 8px;">Title</th><th style="padding: 8px;">Type</th>' +
        '<th style="padding: 8px;">Status</th><th style="padding: 8px;">Pri</th><th style="padding: 8px;">Model</th></tr>';

    // The two top-level section headers are themselves collapsible via the
    // same synthetic-id convention as any other .tree-toggle: folding a
    // section hides its ENTIRE body (all root rows and their subtrees),
    // not just direct children -- there is no safety-net concern here
    // (unlike node-level collapse) since a section's rows have nowhere
    // else in the output they could spuriously reappear.
    //
    // apra-fleet-eft.89: a section (header + body) is only emitted when it
    // has at least one task -- an empty sprintTasks/backlogTasks list skips
    // that entire section (no header, no "No sprint tasks."/"No backlog
    // items." placeholder row), rather than always rendering both. This
    // keeps a caller that only ever supplies one of the two lists (e.g. the
    // supervisor's renderBeadsHtml([], tasks, ...)) from showing an
    // always-empty sibling section.
    const sprintCollapsed = collapsedIds.has('section:sprint');
    if (sprintTasks.length > 0) {
        html += sectionHeaderRow('Sprint', 'section:sprint', sprintCollapsed);
        if (!sprintCollapsed) {
            const rendered = new Set();
            roots.forEach((rootId) => {
                html += renderNode(rootId, 0, rendered);
            });
            // Safety net: any task that never got attached (should not
            // happen with well-formed data, but is not assumed) still
            // renders, as its own root, rather than being silently dropped.
            sprintTasks.forEach((t) => {
                if (!rendered.has(t.id)) {
                    html += renderNode(t.id, 0, rendered);
                }
            });
        }
    }

    const backlogCollapsed = collapsedIds.has('section:backlog');
    if (backlogTasks.length > 0) {
        html += sectionHeaderRow('Backlog', 'section:backlog', backlogCollapsed, 'backlog');
        if (!backlogCollapsed) {
            // Roots (items with no in-set blocker, or whose blocker isn't
            // part of this backlog dataset) are sorted priority-then-id for
            // stable, scannable ordering; any item nested under a blocker
            // (see `backlogChildrenOf` above) renders under that blocker
            // instead, not flattened into this top-level sort.
            const renderedBacklog = new Set();
            backlogRoots.forEach((rootId) => {
                html += renderBacklogNode(rootId, 0, renderedBacklog);
            });
            // Safety net: any backlog task never attached (e.g. a
            // blocks-cycle among backlog items -- should not happen with
            // well-formed bd data, but is not assumed) still renders, as
            // its own root, rather than being silently dropped.
            backlogTasks.forEach((t) => {
                if (!renderedBacklog.has(t.id)) {
                    html += renderBacklogNode(t.id, 0, renderedBacklog);
                }
            });
        }
    }

    // Both lists empty: neither section rendered above, so the table would
    // otherwise be just the 6-column header row with no body at all. That
    // is well-formed on its own, but a single graceful placeholder row
    // reads better than a header with nothing under it.
    if (sprintTasks.length === 0 && backlogTasks.length === 0) {
        html += emptySectionRow('No tasks to display.');
    }

    html += '</table>';
    return html;
}

/**
 * apra-fleet-eft.37.3: pure HTML-string builder for the auto-sprint verdict
 * badge + PR link, moved OUT of the generic workflow core (which used to
 * mint `state.verdict`/`state.prUrl` by name -- see
 * docs/workflow-core-boundary-refactoring.md M2) and into this se-owned
 * extension. Core now only stores the workflow script's own return value
 * WHOLESALE and opaquely as `state.result`, and renders its top-level
 * SCALAR fields as a generic, unstyled key/value strip (src/viewer/
 * index.mjs's `#result-strip`). This function reads the SAME
 * `state.result` object, but knows the two keys that are meaningful for an
 * auto-sprint run specifically -- `verdict` (colored by outcome) and
 * `prUrl` (link-ified) -- exactly the se-domain knowledge that has no
 * business living in the generic engine.
 *
 * Returns '' when `result` carries neither key (e.g. a non-auto-sprint
 * workflow, or a run that hasn't finished yet), so the caller can hide its
 * container entirely rather than show an empty badge strip.
 *
 * @param {{ verdict?: string|null, prUrl?: string|null }|null|undefined} result
 * @returns {string}
 */
export function renderResultExtrasHtml(result) {
    const verdict = result && typeof result === 'object' ? result.verdict : undefined;
    const prUrl = result && typeof result === 'object' ? result.prUrl : undefined;
    // Nothing se-meaningful to show (non-auto-sprint workflow, or a run that
    // hasn't finished yet) -- let the caller hide its container entirely.
    if (verdict == null && prUrl == null) return '';

    // Color signals outcome, same register as the beads status badges above:
    // a clean PASS/MERGED/APPROVED recedes to green, anything that means
    // "this needs a human's attention" (FAIL/CHANGES_NEEDED/ABORTED) draws
    // the eye in red; an unrecognized verdict string still renders, just in
    // a neutral grey, rather than being silently dropped.
    const VERDICT_COLORS = {
        PASS: 'var(--success)',
        MERGED: 'var(--success)',
        APPROVED: 'var(--success)',
        FAIL: 'var(--danger)',
        CHANGES_NEEDED: 'var(--danger)',
        ABORTED: 'var(--danger)',
    };
    let verdictHtml = '';
    if (verdict != null) {
        const key = String(verdict).toUpperCase();
        const color = VERDICT_COLORS[key] || '#a1a1aa';
        verdictHtml = '<span style="color: ' + color + '; font-weight: 700; font-size: 11px; ' +
            'border: 1px solid ' + color + '; border-radius: 4px; padding: 2px 6px; white-space: nowrap;">' +
            escapeHtml(String(verdict)) + '</span>';
    }

    let prHtml = '';
    if (typeof prUrl === 'string' && prUrl.length > 0) {
        prHtml = '<a href="' + escapeHtml(prUrl) + '" target="_blank" rel="noopener noreferrer" ' +
            'style="color: var(--accent); font-size: 11px; text-decoration: none; white-space: nowrap;">PR -&gt;</a>';
    }

    return verdictHtml + prHtml;
}

// apra-fleet-eft.37.4 (M3, docs/workflow-core-boundary-refactoring.md):
// relocated verbatim from packages/apra-fleet-workflow/src/viewer/index.mjs's
// former findBeadById() -- that was the one place core reached into
// `state.extensions.beads.sprintTasks/backlogTasks` by name, a deliberate
// domain leak the eft.27.2 comment it replaced called out explicitly. Core
// now only knows the generic `detailLookup(state, id)` hook shape (see
// `beadsExtension.detailLookup` below); this function is the se-owned
// knowledge of the beads extension's own data shape.
//
// Runs server-side (Node), invoked by core's GET
// /extensions/beads/detail/:itemId route -- never embedded into the
// browser-side `js` string below, unlike renderBeadsHtml/renderResultExtrasHtml.
function findBeadById(state, id) {
    const beadsExt = state.extensions && state.extensions.beads;
    if (!beadsExt) return null;
    const pools = [beadsExt.sprintTasks, beadsExt.backlogTasks];
    for (const pool of pools) {
        if (!Array.isArray(pool)) continue;
        const match = pool.find((t) => t && String(t.id) === String(id));
        if (match) return match;
    }
    return null;
}

export const beadsExtension = {
    id: 'beads',
    title: 'Tasks',
    // apra-fleet-eft.37.4 (M3): the beads extension's detailLookup hook,
    // called by core's generic GET /extensions/beads/detail/:itemId route
    // (packages/apra-fleet-workflow/src/viewer/index.mjs) against the LIVE,
    // full-fidelity `state` object. Returns the shape the hook contract
    // requires -- `{text, updatedAt} | null` -- never the raw bead object,
    // so core stays ignorant of bd's own field names (`description`,
    // `updated_at`).
    detailLookup(state, id) {
        const bead = findBeadById(state, id);
        if (!bead) return null;
        return {
            text: bead.description || '',
            updatedAt: bead.updated_at || bead.updatedAt || null
        };
    },
    js: `
        ${escapeHtml.toString()}
        ${renderBeadsHtml.toString()}
        ${renderResultExtrasHtml.toString()}
        ${computeSprintProgress.toString()}
        ${renderProgressBarHtml.toString()}

        // apra-fleet-eft.37.3: mounts the auto-sprint verdict badge + PR
        // link into the header, next to core's generic (unstyled)
        // #result-strip -- see viewer/index.mjs's 'workflow:result'
        // CustomEvent, dispatched on every renderState() with
        // state.result (core's opaque, workflow-declared result) as its
        // detail. The container is created lazily on first non-empty
        // render and removed again whenever there is nothing se-specific
        // to show (e.g. before a run has finished).
        function renderResultExtras(result) {
            const html = renderResultExtrasHtml(result);
            let el = document.getElementById('se-result-extras');
            if (!html) {
                if (el) el.remove();
                return;
            }
            if (!el) {
                const headerActions = document.querySelector('.header-actions');
                if (!headerActions) return;
                el = document.createElement('div');
                el.id = 'se-result-extras';
                el.style.display = 'flex';
                el.style.gap = '8px';
                el.style.alignItems = 'center';
                headerActions.insertBefore(el, headerActions.firstChild);
            }
            el.innerHTML = html;
        }

        // apra-fleet-eft.27.2 / apra-fleet-eft.37.4 (M3): on-demand
        // bead-description fetch + browser localStorage cache. GET /state
        // now serves only a short \`summary\` per bead (apra-fleet-eft.27.1)
        // -- the full text is fetched here, from the GENERIC
        // GET /extensions/beads/detail/:itemId route (src/viewer/index.mjs,
        // delegating to this extension's own \`detailLookup\` above -- the
        // old sprint-named /beads/:id/description route is now core's
        // one-release BOUNDARY-COMPAT alias, no longer called from here),
        // the moment a user actually expands a row, and cached under the
        // bead's id. Each cache entry also carries the \`updatedAt\` it was
        // fetched against, so a later lean-state poll reporting a NEW
        // updatedAt for that bead transparently invalidates the cache and
        // triggers a refetch instead of ever serving stale text.
        const BEAD_DESC_CACHE_PREFIX = 'apra-fleet-bead-desc:';

        function beadDescCacheKey(id) { return BEAD_DESC_CACHE_PREFIX + id; }

        function readBeadDescCache(id, updatedAt) {
            try {
                const raw = localStorage.getItem(beadDescCacheKey(id));
                if (!raw) return null;
                const parsed = JSON.parse(raw);
                if (parsed && parsed.updatedAt === updatedAt) return parsed.description;
            } catch (e) {
                // Corrupt or unavailable cache entry -- treat as a miss,
                // never let a caching problem break the expand action.
            }
            return null;
        }

        function writeBeadDescCache(id, updatedAt, description) {
            try {
                localStorage.setItem(beadDescCacheKey(id), JSON.stringify({ updatedAt: updatedAt, description: description }));
            } catch (e) {
                // localStorage full/unavailable (quota, private browsing) --
                // non-fatal: the fetch itself already succeeded and rendered.
            }
        }

        async function loadBeadDescription(detailsEl) {
            const bodyEl = detailsEl.querySelector('.bead-desc-body');
            // Already showing the full text (either a prior fetch/cache hit,
            // or a caller that inlined the full description up front) --
            // no network request on a repeat expand.
            if (!bodyEl || bodyEl.dataset.loaded === 'true') return;

            const id = detailsEl.dataset.beadId;
            const updatedAt = detailsEl.dataset.updatedAt || '';

            const cached = readBeadDescCache(id, updatedAt);
            if (cached !== null) {
                bodyEl.textContent = cached;
                bodyEl.dataset.loaded = 'true';
                return;
            }

            bodyEl.textContent = 'Loading...';
            try {
                const res = await fetch('/extensions/beads/detail/' + encodeURIComponent(id));
                if (!res.ok) { bodyEl.textContent = '(description unavailable)'; return; }
                const data = await res.json();
                const description = data.text || '(no description)';
                bodyEl.textContent = description;
                bodyEl.dataset.loaded = 'true';
                writeBeadDescCache(id, updatedAt, description);
            } catch (e) {
                bodyEl.textContent = '(failed to load description)';
            }
        }

        // The 'toggle' event does not bubble in every browser, but it IS
        // still observable during the capture phase regardless of bubbling
        // -- a single document-level capture listener therefore catches
        // every <details class="bead-desc"> toggle, including rows
        // recreated by the full innerHTML rebuild below on each poll, with
        // no per-row listener wiring or cleanup needed.
        document.addEventListener('toggle', function (e) {
            const el = e.target;
            if (el && el.tagName === 'DETAILS' && el.classList && el.classList.contains('bead-desc') && el.open) {
                loadBeadDescription(el);
            }
        }, true);

        // apra-fleet-4p5: collapse state lives here, in this closure -- not
        // on any DOM node -- so it survives the full innerHTML rebuild each
        // 'workflow:state:beads' tick performs (the exact same rebuild that
        // would otherwise silently reset every DETAILS element's \`open\`
        // attribute, if bead descriptions relied on that instead of the
        // cache above). \`lastBeadsData\` caches the most recent poll's
        // payload so a pure collapse/expand click can re-render immediately
        // without waiting on (or synthesizing) a new server payload.
        const collapsedBeadIds = new Set();
        let lastBeadsData = { sprintTasks: [], backlogTasks: [] };

        function renderBeadsPanel() {
            const container = document.getElementById('extension-beads');
            if (!container) return;
            // apra-fleet-x8r.1: the progress bar reflects THIS sprint's own
            // scope (sprintTasks -- already the bdListScoped('') scope walk
            // threaded through by runner.js/dashboard.mjs, never re-derived
            // here), not the Backlog list alongside it.
            // apra-fleet-x8r.4: goalMax/decomposedParentIds are runner.js-
            // computed (updateDashboard()'s payload -- the SAME two axes its
            // own completion gate filters on) and threaded through verbatim,
            // never re-derived client-side.
            const progress = computeSprintProgress(lastBeadsData.sprintTasks || [], {
                goalMax: lastBeadsData.goalMax,
                decomposedParentIds: lastBeadsData.decomposedParentIds,
            });
            const progressHtml = renderProgressBarHtml(progress);
            // apra-fleet-vk0a.2: pinned into the FIXED panel-header row (a
            // sibling of the 'Tasks' label, core's generic per-extension
            // header hook -- \`id="panel-header-\${ext.id}-extra"\`, see
            // viewer/index.mjs) instead of re-rendered at the top of the
            // SCROLLABLE #extension-beads container on every poll -- so it
            // stays visible regardless of scroll position in a long task
            // list. Falls back to the pre-vk0a.2 inline placement when the
            // hook is absent (an older/mismatched core template), rather
            // than silently dropping the widget.
            const headerExtra = document.getElementById('panel-header-beads-extra');
            if (headerExtra) {
                headerExtra.innerHTML = progressHtml;
                container.innerHTML = renderBeadsHtml(lastBeadsData.sprintTasks || [], lastBeadsData.backlogTasks || [], collapsedBeadIds);
            } else {
                container.innerHTML = progressHtml
                    + renderBeadsHtml(lastBeadsData.sprintTasks || [], lastBeadsData.backlogTasks || [], collapsedBeadIds);
            }
        }

        // Single document-level click-delegation listener (same rationale
        // as the capture-phase 'toggle' listener above) catches every
        // \`.tree-toggle\` click, including toggles on rows recreated by the
        // innerHTML rebuild on each poll -- no per-row listener wiring or
        // cleanup needed. \`data-toggle-id\` round-trips back to the original
        // (unescaped) bead id or synthetic section key via HTML entity
        // decoding, the same way \`data-bead-id\` already does above.
        document.addEventListener('click', function (e) {
            const toggle = e.target && e.target.closest ? e.target.closest('.tree-toggle') : null;
            if (!toggle) return;
            const id = toggle.dataset.toggleId;
            if (!id) return;
            if (collapsedBeadIds.has(id)) {
                collapsedBeadIds.delete(id);
            } else {
                collapsedBeadIds.add(id);
            }
            renderBeadsPanel();
        });

        document.addEventListener('workflow:state:beads', (e) => {
            lastBeadsData = e.detail || {};
            renderBeadsPanel();
        });

        // apra-fleet-eft.37.3: mounts the auto-sprint verdict badge + PR
        // link into the header, next to core's generic (unstyled)
        // #result-strip -- see viewer/index.mjs's 'workflow:result'
        // CustomEvent, dispatched on every renderState() with
        // state.result (core's opaque, workflow-declared result) as its
        // detail.
        document.addEventListener('workflow:result', (e) => {
            renderResultExtras(e.detail);
        });
    `
};
