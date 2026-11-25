import { test, describe } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { EventEmitter } from 'events';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createDashboardViewer } from '../src/viewer/index.mjs';

// Served page: header text is selectable, the disclosure marker is not, and the
// shipped click handler consults the suppression decision before toggling.
// Manual browser check (Chrome/Edge/Firefox/Safari) is outside this gate.

function getHtml(port) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/`, (res) => {
            let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d));
        }).on('error', reject);
    });
}

function ruleFor(css, selector) {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?:^|[\\s}])${esc}\\s*\\{([^}]*)\\}`, 'm').exec(css);
    return m ? m[1] : null;
}

describe('served viewer: header text selection', () => {
    test('headers allow selection, marker does not, handler calls the decision before toggling', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-hdr-sel-'));
        const cwd = process.cwd();
        process.chdir(tmp);
        const server = createDashboardViewer(new EventEmitter(), { port: 0, runId: 'hdr-sel', stateSnapshotDir: path.join(tmp, 's'), debouncedStatePath: path.join(tmp, 'st.json') });
        await new Promise((r) => server.listening ? r() : server.once('listening', r));
        try {
            const html = await getHtml(server.address().port);
            for (const sel of ['.group-header', '.phase-header', 'summary.activity-header']) {
                const rule = ruleFor(html, sel);
                assert.ok(rule, `rule for ${sel}`);
                assert.ok(!/user-select:\s*none/.test(rule), `${sel} must not be user-select: none`);
                assert.match(rule, /user-select:\s*text/);
            }
            const marker = ruleFor(html, '.toggle-icon');
            assert.match(marker, /user-select:\s*none/);
            const handlerStart = html.indexOf("document.addEventListener('click'");
            assert.ok(handlerStart > 0, 'click handler present');
            const handler = html.slice(handlerStart, handlerStart + 900);
            assert.ok(handler.indexOf('shouldSuppressToggle(') > 0 && handler.indexOf('preventDefault()') > handler.indexOf('shouldSuppressToggle('), 'decision runs before preventDefault');
            assert.ok(html.includes('function shouldSuppressToggle('));
        } finally {
            await new Promise((r) => server.close(() => r()));
            await new Promise((r) => setTimeout(r, 350));
            process.chdir(cwd);
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
