import { escapeHtml } from '@apralabs/apra-fleet-workflow/viewer/html-utils';

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
 * than one independent top-level item at once.
 *
 * The panel always shows two top-level sections: "Sprint" (the dependency
 * tree above, built from `sprintTasks`) and "Backlog" (`backlogTasks` --
 * open/deferred beads the sprint is certainly NOT addressing this run,
 * which may belong to an entirely different epic or never have gone
 * through a planning phase at all). Backlog is rendered as a flat, sorted
 * list rather than a tree: it can contain arbitrary, unrelated beads with
 * no assumed relationship to each other or to the sprint's dependency
 * graph, so nesting them would imply a structure that isn't there.
 *
 * Every rendering decision here (status/type badges, tree placement) is
 * defensive by construction: unrecognized/missing status, type, model, or
 * priority values fall back to a generic, still-visible label rather than
 * throwing or rendering blank, and a cycle-guard plus an end-of-pass sweep
 * for any task that never got attached to the tree (should not happen with
 * well-formed bd data, but is not assumed) guarantees every task in the
 * input is rendered exactly once, never silently dropped.
 *
 * @param {Array<{id: string|number, title?: string, description?: string, status?: string, issue_type?: string, ready?: boolean, priority?: number, metadata?: {model?: string}, dependencies?: Array<{depends_on_id: string|number, type: string}>}>} sprintTasks
 * @param {Array<{id: string|number, title?: string, description?: string, status?: string, issue_type?: string, priority?: number, metadata?: {model?: string}}>} [backlogTasks]
 * @returns {string}
 */
export function renderBeadsHtml(sprintTasks, backlogTasks) {
    sprintTasks = sprintTasks || [];
    backlogTasks = backlogTasks || [];

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

    function sectionHeaderRow(label) {
        return '<tr><td colspan="6" style="padding: 10px 8px 4px; font-size: 11px; font-weight: bold; letter-spacing: 0.5px; color: #a1a1aa; border-bottom: 1px solid rgba(255,255,255,0.1);">' + escapeHtml(label) + '</td></tr>';
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

    const roots = sprintTasks
        .filter((t) => !(t.parent !== undefined && t.parent !== null && map[t.parent]))
        .map((t) => t.id);

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

        let html = '<tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">' +
            '<td style="padding: 8px; padding-left: ' + (8 + indent) + 'px; vertical-align: top; width: 110px; color: ' + titleColor(node.status) + ';">' + prefix + '#' + safeId + '</td>' +
            '<td style="padding: 8px; vertical-align: top; color: ' + titleColor(node.status) + ';">' + titleHtml + extraBlockedByHtml + '</td>' +
            '<td style="padding: 8px; vertical-align: top; width: 90px;">' + typeBadge(node.issue_type, node.title) + '</td>' +
            '<td style="padding: 8px; vertical-align: top; width: 100px;">' + statusBadgeForNode(node) + '</td>' +
            '<td style="padding: 8px; vertical-align: top; width: 50px;">' + priorityBadge(node.priority) + '</td>' +
            '<td style="padding: 8px; vertical-align: top; width: 80px;">' + modelBadge(node.metadata) + '</td>' +
            '</tr>';

        const children = (childrenOf[nodeId] || []).slice().sort();
        children.forEach((childId) => {
            html += renderNode(childId, depth + 1, rendered);
        });
        return html;
    }

    // Backlog rows are flat (no tree/blockedBy tracking) -- these beads
    // have no assumed relationship to each other or to the sprint's
    // dependency graph, so nesting them would imply a structure that
    // isn't there. Reuses the same badges/escaping as sprint rows for
    // visual consistency.
    function renderFlatRow(task) {
        const safeId = escapeHtml(task.id);
        const safeTitle = escapeHtml(task.title);

        const titleHtml = descriptionDetailsHtml(task, safeId, safeTitle);

        return '<tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">' +
            '<td style="padding: 8px; vertical-align: top; width: 110px; color: ' + titleColor(task.status) + ';">#' + safeId + '</td>' +
            '<td style="padding: 8px; vertical-align: top; color: ' + titleColor(task.status) + ';">' + titleHtml + '</td>' +
            '<td style="padding: 8px; vertical-align: top; width: 90px;">' + typeBadge(task.issue_type, task.title) + '</td>' +
            '<td style="padding: 8px; vertical-align: top; width: 100px;">' + statusBadgeForNode(task) + '</td>' +
            '<td style="padding: 8px; vertical-align: top; width: 50px;">' + priorityBadge(task.priority) + '</td>' +
            '<td style="padding: 8px; vertical-align: top; width: 80px;">' + modelBadge(task.metadata) + '</td>' +
            '</tr>';
    }

    let html = '<table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 13px;">';
    html += '<tr style="border-bottom: 1px solid rgba(255,255,255,0.1);">' +
        '<th style="padding: 8px;">ID</th><th style="padding: 8px;">Title</th><th style="padding: 8px;">Type</th>' +
        '<th style="padding: 8px;">Status</th><th style="padding: 8px;">Pri</th><th style="padding: 8px;">Model</th></tr>';

    html += sectionHeaderRow('Sprint');
    if (sprintTasks.length === 0) {
        html += emptySectionRow('No sprint tasks.');
    } else {
        const rendered = new Set();
        roots.forEach((rootId) => {
            html += renderNode(rootId, 0, rendered);
        });
        // Safety net: any task that never got attached (should not happen
        // with well-formed data, but is not assumed) still renders, as its
        // own root, rather than being silently dropped.
        sprintTasks.forEach((t) => {
            if (!rendered.has(t.id)) {
                html += renderNode(t.id, 0, rendered);
            }
        });
    }

    html += sectionHeaderRow('Backlog');
    if (backlogTasks.length === 0) {
        html += emptySectionRow('No backlog items.');
    } else {
        // Sorted for stable, scannable ordering -- priority first (P1
        // before P4; missing/invalid priority sorts last), then id.
        const sortedBacklog = backlogTasks.slice().sort((a, b) => {
            const pa = (typeof a.priority === 'number' && Number.isFinite(a.priority)) ? a.priority : 99;
            const pb = (typeof b.priority === 'number' && Number.isFinite(b.priority)) ? b.priority : 99;
            if (pa !== pb) return pa - pb;
            return String(a.id).localeCompare(String(b.id));
        });
        sortedBacklog.forEach((t) => {
            html += renderFlatRow(t);
        });
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

        document.addEventListener('workflow:state:beads', (e) => {
            const data = e.detail;
            const container = document.getElementById('extension-beads');
            if (!container) return;
            container.innerHTML = renderBeadsHtml(data.sprintTasks || [], data.backlogTasks || []);
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
