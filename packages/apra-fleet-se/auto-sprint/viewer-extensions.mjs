export const beadsExtension = {
    id: 'beads',
    title: 'Beads Tasks',
    js: `
        document.addEventListener('workflow:state:beads', (e) => {
            const data = e.detail;
            const container = document.getElementById('extension-beads');
            if (!container) return;
            
            const tasks = data.tasks || [];
            
            // Build task map and roots
            const map = {};
            const roots = [];
            tasks.forEach(t => { map[t.id] = { ...t, children: [] }; });
            
            tasks.forEach(t => {
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
                const prefix = depth > 0 ? '└─ ' : '';
                
                let titleHtml = node.title;
                if (node.description) {
                    titleHtml = \\\`<details><summary style="cursor: pointer; outline: none; list-style-position: inside;">\\\${node.title}</summary><div style="margin-top: 6px; padding: 8px; background: rgba(0,0,0,0.15); border-left: 2px solid var(--accent); font-size: 11px; border-radius: 0 4px 4px 0; color: #a1a1aa; white-space: pre-wrap; font-family: monospace;">\\\${node.description}</div></details>\\\`;
                }
                
                let html = \\\`<tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <td style="padding: 8px; padding-left: \\\${8 + indent}px; vertical-align: top; width: 120px;">\\\${prefix}#\\\${node.id}</td>
                    <td style="padding: 8px; vertical-align: top;">\\\${titleHtml}</td>
                    <td style="padding: 8px; font-weight: bold; color: \\\${color}; text-transform: uppercase; font-size: 11px; vertical-align: top; width: 100px;">\\\${node.status}</td>
                </tr>\\\`;
                
                if (node.children) {
                    node.children.forEach(child => {
                        html += renderNode(child, depth + 1);
                    });
                }
                return html;
            }
            
            let html = '<table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 13px;">';
            html += '<tr style="border-bottom: 1px solid rgba(255,255,255,0.1);"><th style="padding: 8px;">ID</th><th style="padding: 8px;">Title</th><th style="padding: 8px;">Status</th></tr>';
            
            roots.forEach(r => {
                html += renderNode(r, 0);
            });
            
            html += '</table>';
            container.innerHTML = html;
        });
    `
};
