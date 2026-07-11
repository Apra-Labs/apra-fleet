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
 * kept in sync by hand.
 *
 * @param {Array<{id: string|number, title?: string, description?: string, status?: string, parent?: string|number}>} tasks
 * @returns {string}
 */
export function renderBeadsHtml(tasks) {
    tasks = tasks || [];

    // Build task map and roots
    const map = {};
    const roots = [];
    tasks.forEach((t) => { map[t.id] = { ...t, children: [] }; });

    tasks.forEach((t) => {
        const node = map[t.id];
        if (t.parent && map[t.parent]) {
            map[t.parent].children.push(node);
        } else {
            roots.push(node);
        }
    });

    function renderNode(node, depth) {
        let color = '#a1a1aa';
        if (node.status === 'in-progress') color = 'var(--accent)';
        if (node.status === 'closed') color = 'var(--success)';
        if (node.status === 'blocked') color = 'var(--danger)';
        if (node.status === 'open') color = '#e4e4e7';

        const indent = depth * 20;
        const prefix = depth > 0 ? String.fromCharCode(0x2514, 0x2500) + ' ' : '';

        // Every bead-derived field is escaped before interpolation -- these
        // are the exact fields the original (vulnerable) implementation
        // injected raw.
        const safeId = escapeHtml(node.id);
        const safeTitle = escapeHtml(node.title);
        const safeStatus = escapeHtml(node.status);

        let titleHtml = safeTitle;
        if (node.description) {
            const safeDescription = escapeHtml(node.description);
            titleHtml = '<details><summary style="cursor: pointer; outline: none; list-style-position: inside;">' +
                safeTitle +
                '</summary><div style="margin-top: 6px; padding: 8px; background: rgba(0,0,0,0.15); border-left: 2px solid var(--accent); font-size: 11px; border-radius: 0 4px 4px 0; color: #a1a1aa; white-space: pre-wrap; font-family: monospace;">' +
                safeDescription +
                '</div></details>';
        }

        let html = '<tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">' +
            '<td style="padding: 8px; padding-left: ' + (8 + indent) + 'px; vertical-align: top; width: 120px;">' + prefix + '#' + safeId + '</td>' +
            '<td style="padding: 8px; vertical-align: top;">' + titleHtml + '</td>' +
            '<td style="padding: 8px; font-weight: bold; color: ' + color + '; text-transform: uppercase; font-size: 11px; vertical-align: top; width: 100px;">' + safeStatus + '</td>' +
            '</tr>';

        if (node.children) {
            node.children.forEach((child) => {
                html += renderNode(child, depth + 1);
            });
        }
        return html;
    }

    let html = '<table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 13px;">';
    html += '<tr style="border-bottom: 1px solid rgba(255,255,255,0.1);"><th style="padding: 8px;">ID</th><th style="padding: 8px;">Title</th><th style="padding: 8px;">Status</th></tr>';

    roots.forEach((r) => {
        html += renderNode(r, 0);
    });

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
            container.innerHTML = renderBeadsHtml(data.tasks || []);
        });
    `
};
