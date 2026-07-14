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
 * Tree is built from `blocks`-type dependency edges (task.dependencies),
 * not `parent`/containment -- the user-facing goal is "show me what
 * unblocks what", not "show me epic->task nesting" (a task's own epic
 * parent isn't itself in this dataset and carries no ordering information).
 * A task can have multiple blockers (a real DAG, not a strict tree); to
 * keep the rendering a simple, readable nested list, each task is nested
 * under exactly one PRIMARY blocker (deterministic: lexicographically
 * smallest in-scope blocker id) and any additional blockers are listed
 * inline as a "blocked by" badge so no dependency information is lost.
 * Multiple top-level roots (tasks with no in-scope blocker) render as
 * multiple top-level rows -- this is expected, not an error, whenever a
 * sprint targets more than one independent top-level item at once.
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
 * @param {Array<{id: string|number, title?: string, description?: string, status?: string, priority?: number, metadata?: {model?: string}, dependencies?: Array<{depends_on_id: string|number, type: string}>}>} sprintTasks
 * @param {Array<{id: string|number, title?: string, description?: string, status?: string, priority?: number, metadata?: {model?: string}}>} [backlogTasks]
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

    function typeBadge(title) {
        const match = /^\[([A-Za-z0-9_-]+)\]/.exec(title || '');
        const key = match ? match[1].toLowerCase() : '';
        const known = TYPE_BADGES[key];
        const label = known ? known.label : (match ? escapeHtml(match[1]).toUpperCase() : 'MISC');
        const color = known ? known.color : '#71717a';
        return '<span style="color: ' + color + '; font-size: 10px; border: 1px solid ' + color + '; border-radius: 3px; padding: 1px 5px; white-space: nowrap;">' + label + '</span>';
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

    function sectionHeaderRow(label) {
        return '<tr><td colspan="6" style="padding: 10px 8px 4px; font-size: 11px; font-weight: bold; letter-spacing: 0.5px; color: #a1a1aa; border-bottom: 1px solid rgba(255,255,255,0.1);">' + escapeHtml(label) + '</td></tr>';
    }

    function emptySectionRow(message) {
        return '<tr><td colspan="6" style="padding: 8px; font-size: 12px; color: #71717a; font-style: italic;">' + escapeHtml(message) + '</td></tr>';
    }

    // --- Build a dependency tree from `blocks`-type edges, not `parent` ---
    const map = {};
    sprintTasks.forEach((t) => { map[t.id] = { ...t, children: [], blockedBy: [] }; });

    const childrenOf = {}; // blockerId -> [taskId, ...] (this blocker unblocks these)
    sprintTasks.forEach((t) => {
        const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
        const blockerIds = deps
            .filter((d) => d && d.type === 'blocks' && map[d.depends_on_id])
            .map((d) => d.depends_on_id);
        map[t.id].blockedBy = blockerIds;
        if (blockerIds.length > 0) {
            // Deterministic primary parent: lexicographically smallest
            // in-scope blocker id. Any remaining blockers are still listed
            // via the "blocked by" badge below -- not lost, just not used
            // for tree placement (a task can only live in one place in a
            // simple nested list).
            const primary = blockerIds.slice().sort()[0];
            (childrenOf[primary] = childrenOf[primary] || []).push(t.id);
        }
    });

    const roots = sprintTasks.filter((t) => map[t.id].blockedBy.length === 0).map((t) => t.id);

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

        let titleHtml = safeTitle;
        if (node.description) {
            const safeDescription = escapeHtml(node.description);
            titleHtml = '<details><summary style="cursor: pointer; outline: none; list-style-position: inside;">' +
                safeTitle +
                '</summary><div style="margin-top: 6px; padding: 8px; background: rgba(0,0,0,0.15); border-left: 2px solid var(--accent); font-size: 11px; border-radius: 0 4px 4px 0; color: #a1a1aa; white-space: pre-wrap; font-family: monospace;">' +
                safeDescription +
                '</div></details>';
        }

        // Additional blockers beyond the one used for tree placement --
        // only shown when there's more than one, so the common (single
        // blocker or none) case stays uncluttered.
        let extraBlockedByHtml = '';
        if (node.blockedBy.length > 1) {
            const others = node.blockedBy.slice().sort().slice(1).map((id) => '#' + escapeHtml(id)).join(', ');
            extraBlockedByHtml = '<div style="margin-top: 4px; font-size: 10px; color: #71717a;">also blocked by: ' + others + '</div>';
        }

        let html = '<tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">' +
            '<td style="padding: 8px; padding-left: ' + (8 + indent) + 'px; vertical-align: top; width: 110px; color: ' + titleColor(node.status) + ';">' + prefix + '#' + safeId + '</td>' +
            '<td style="padding: 8px; vertical-align: top; color: ' + titleColor(node.status) + ';">' + titleHtml + extraBlockedByHtml + '</td>' +
            '<td style="padding: 8px; vertical-align: top; width: 90px;">' + typeBadge(node.title) + '</td>' +
            '<td style="padding: 8px; vertical-align: top; width: 100px;">' + statusBadge(node.status) + '</td>' +
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

        let titleHtml = safeTitle;
        if (task.description) {
            const safeDescription = escapeHtml(task.description);
            titleHtml = '<details><summary style="cursor: pointer; outline: none; list-style-position: inside;">' +
                safeTitle +
                '</summary><div style="margin-top: 6px; padding: 8px; background: rgba(0,0,0,0.15); border-left: 2px solid var(--accent); font-size: 11px; border-radius: 0 4px 4px 0; color: #a1a1aa; white-space: pre-wrap; font-family: monospace;">' +
                safeDescription +
                '</div></details>';
        }

        return '<tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">' +
            '<td style="padding: 8px; vertical-align: top; width: 110px; color: ' + titleColor(task.status) + ';">#' + safeId + '</td>' +
            '<td style="padding: 8px; vertical-align: top; color: ' + titleColor(task.status) + ';">' + titleHtml + '</td>' +
            '<td style="padding: 8px; vertical-align: top; width: 90px;">' + typeBadge(task.title) + '</td>' +
            '<td style="padding: 8px; vertical-align: top; width: 100px;">' + statusBadge(task.status) + '</td>' +
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

export const beadsExtension = {
    id: 'beads',
    title: 'Beads Tasks',
    js: `
        ${escapeHtml.toString()}
        ${renderBeadsHtml.toString()}

        document.addEventListener('workflow:state:beads', (e) => {
            const data = e.detail;
            const container = document.getElementById('extension-beads');
            if (!container) return;
            container.innerHTML = renderBeadsHtml(data.sprintTasks || [], data.backlogTasks || []);
        });
    `
};
