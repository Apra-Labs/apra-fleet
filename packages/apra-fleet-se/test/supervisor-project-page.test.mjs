import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createProjectsPageHandler } from '../src/registration/project-page.mjs';
import { PROJECTS_UI_PATH } from '../src/registration/manifest.mjs';
import { PLACEHOLDER_HTML } from '../src/registration/ui-placeholder.mjs';
import { TOKEN_COOKIE_NAME } from '../src/supervisor/auth.mjs';
import { THEME_CSS } from '../src/supervisor/theme.mjs';

// =============================================================================
// apra-fleet-i9ag.17.2.2 -- GET /ui/projects: the real project-folder page.
//
// Two layers, mirroring test/supervisor-dashboard-live-refresh.test.mjs's own
// established "no jsdom in this repo" technique:
//   (a) the HTML the handler itself emits (routing to the real page for
//       PROJECTS_UI_PATH, the unchanged placeholder for every other path,
//       the HttpOnly cookie, no embedded credential), and
//   (b) the ACTUAL embedded client script, extracted verbatim from that HTML
//       and executed against a hand-rolled mock document/fetch -- never a
//       reimplementation of its load/save/render logic, which would drift
//       out of sync with the real client code and stop catching regressions.
// =============================================================================

function mockRes() {
    return {
        statusCode: undefined,
        headers: undefined,
        body: undefined,
        writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
        end(body) { this.body = body; },
    };
}

function ctxFor(pathname) {
    return { url: new URL(pathname, 'http://127.0.0.1:1') };
}

/** Renders the page (or, for a non-projects path, the delegated placeholder)
 *  through the ACTUAL createProjectsPageHandler(), never a hand-copy. */
async function renderPath(pathname, { token } = {}) {
    const handler = createProjectsPageHandler({ token });
    const res = mockRes();
    await handler({ method: 'GET', url: pathname, headers: {} }, res, ctxFor(pathname));
    return { status: res.statusCode, headers: res.headers, html: res.body.toString('utf-8') };
}

/** Extracts the embedded client script verbatim out of the real page HTML. */
function extractScript(html) {
    const start = html.indexOf('(function ()');
    assert.ok(start !== -1, 'the Projects page must embed its client script');
    const end = html.indexOf('</script>', start);
    assert.ok(end !== -1, 'must find the end of the embedded script block');
    return html.slice(start, end);
}

class MockTextEl {
    constructor() { this.textContent = ''; }
}
class MockInputEl {
    constructor() { this.value = ''; }
}
class MockFormEl {
    constructor() { this._listeners = {}; }
    addEventListener(type, cb) { this._listeners[type] = cb; }
    async submit() {
        await this._listeners.submit({ preventDefault() {} });
    }
}

function mockDocument() {
    const els = {
        'current-value': new MockTextEl(),
        'current-source': new MockTextEl(),
        'current-beads': new MockTextEl(),
        message: new MockTextEl(),
        'path-input': new MockInputEl(),
        'save-form': new MockFormEl(),
    };
    return { els, document: { getElementById: (id) => els[id] ?? null } };
}

/** Runs the ACTUAL embedded script (extracted from the real page HTML)
 *  against a mocked document/fetch, mirroring
 *  supervisor-dashboard-live-refresh.test.mjs's runLiveRefreshScript(). */
function runScript(html, { document, fetchImpl }) {
    const script = extractScript(html);
    // eslint-disable-next-line no-new-func
    const fn = new Function('document', 'fetch', script);
    fn(document, fetchImpl);
}

function flushMicrotasks() {
    return new Promise((resolve) => setImmediate(resolve));
}

describe('GET /ui/projects (apra-fleet-i9ag.17.2.2)', () => {
    test('renders the real page for exactly PROJECTS_UI_PATH -- the placeholder string never appears', async () => {
        const { status, html } = await renderPath(PROJECTS_UI_PATH, { token: null });
        assert.equal(status, 200);
        assert.ok(!html.includes('arrives in a later sprint'), 'the placeholder string must not appear for /ui/projects');
        assert.ok(html.includes('id="save-form"'), 'expected the real save form');
    });

    test('every other path (including the two-segment panel path) still delegates to the unchanged placeholder', async () => {
        for (const other of ['/ui', '/ui/kb', '/ui/code', '/ui/sprints', '/ui/panels/git']) {
            // eslint-disable-next-line no-await-in-loop
            const { status, html } = await renderPath(other, { token: null });
            assert.equal(status, 200, other);
            assert.equal(html, PLACEHOLDER_HTML, `expected ${other} to answer the byte-identical placeholder`);
        }
    });

    test('a supervisor token is handed back as an HttpOnly se_token cookie, never embedded in the HTML body', async () => {
        const token = 'x'.repeat(64);
        const { headers, html } = await renderPath(PROJECTS_UI_PATH, { token });
        assert.ok(headers['set-cookie'].startsWith(`${TOKEN_COOKIE_NAME}=${token};`), headers['set-cookie']);
        assert.ok(headers['set-cookie'].includes('HttpOnly'));
        assert.ok(!html.includes(token), 'the raw token must never appear in the HTML body');
    });

    test('no token configured -> no set-cookie header at all', async () => {
        const { headers } = await renderPath(PROJECTS_UI_PATH, { token: null });
        assert.equal(headers['set-cookie'], undefined);
    });

    test('client script: a configured folder renders the folder, its source, and hasBeadsDb', async () => {
        const { html } = await renderPath(PROJECTS_UI_PATH, { token: null });
        const { els, document } = mockDocument();
        const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ projectDir: '/srv/proj', source: 'config', hasBeadsDb: true, flagActive: false }) });
        runScript(html, { document, fetchImpl });
        await flushMicrotasks();

        assert.equal(els['current-value'].textContent, '/srv/proj');
        assert.equal(els['current-source'].textContent, 'config');
        assert.equal(els['current-beads'].textContent, 'found');
    });

    test('client script: an explicit none-configured payload renders a state that names what to do, not a blank value', async () => {
        const { html } = await renderPath(PROJECTS_UI_PATH, { token: null });
        const { els, document } = mockDocument();
        const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ projectDir: null, source: null, hasBeadsDb: false, flagActive: false }) });
        runScript(html, { document, fetchImpl });
        await flushMicrotasks();

        assert.notEqual(els['current-value'].textContent, '', 'must never be blank');
        assert.match(els['current-value'].textContent, /none configured/i);
    });

    test('client script: a load failure (unreachable API) degrades to an explicit unknown state, never an unhandled rejection', async () => {
        const { html } = await renderPath(PROJECTS_UI_PATH, { token: null });
        const { els, document } = mockDocument();
        const fetchImpl = async () => { throw new Error('network down'); };
        runScript(html, { document, fetchImpl });
        await flushMicrotasks();

        assert.match(els['current-value'].textContent, /unknown/i);
        assert.match(els['current-value'].textContent, /network down/);
    });

    test('client script: a successful save calls POST with the submitted value, renders the new state, and states the note (restart required)', async () => {
        const { html } = await renderPath(PROJECTS_UI_PATH, { token: null });
        const { els, document } = mockDocument();
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, init });
            if (!init) {
                // load()'s initial GET.
                return { ok: true, status: 200, json: async () => ({ projectDir: null, source: null, hasBeadsDb: false, flagActive: false }) };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    projectDir: '/srv/new-proj', source: 'config', hasBeadsDb: false, flagActive: false,
                    restartRequired: true, note: 'saved; restart the supervisor for this to take effect',
                }),
            };
        };
        runScript(html, { document, fetchImpl });
        await flushMicrotasks();

        els['path-input'].value = '/srv/new-proj';
        await els['save-form'].submit();
        await flushMicrotasks();

        assert.equal(calls.length, 2, 'expected the initial load() GET plus one save() POST');
        assert.equal(calls[1].init.method, 'POST');
        assert.deepEqual(JSON.parse(calls[1].init.body), { projectDir: '/srv/new-proj' });
        assert.equal(els['current-value'].textContent, '/srv/new-proj');
        assert.equal(els['message'].textContent, 'saved; restart the supervisor for this to take effect');
        assert.equal(els['path-input'].value, '', 'expected the input to clear after a successful save');
    });

    test('client script: a rejected save shows the server message inline and leaves the displayed current value unchanged', async () => {
        const { html } = await renderPath(PROJECTS_UI_PATH, { token: null });
        const { els, document } = mockDocument();
        const fetchImpl = async (url, init) => {
            if (!init) {
                return { ok: true, status: 200, json: async () => ({ projectDir: '/srv/existing', source: 'config', hasBeadsDb: true, flagActive: false }) };
            }
            return { ok: false, status: 400, json: async () => ({ error: "--beads-dir '/nope' does not exist or is not a directory" }) };
        };
        runScript(html, { document, fetchImpl });
        await flushMicrotasks();
        assert.equal(els['current-value'].textContent, '/srv/existing');

        els['path-input'].value = '/nope';
        await els['save-form'].submit();
        await flushMicrotasks();

        assert.equal(els['current-value'].textContent, '/srv/existing', 'a rejected submission must leave the displayed current value unchanged');
        assert.match(els['message'].textContent, /rejected:/);
        assert.ok(els['message'].textContent.includes('/nope'), els['message'].textContent);
    });

    test('client script: a save while the flag is active surfaces the flag-override note verbatim', async () => {
        const { html } = await renderPath(PROJECTS_UI_PATH, { token: null });
        const { els, document } = mockDocument();
        const note = 'saved, but the --beads-dir flag is currently overriding this setting; it will not take effect until the flag is removed and the supervisor is restarted';
        const fetchImpl = async (url, init) => {
            if (!init) {
                return { ok: true, status: 200, json: async () => ({ projectDir: '/srv/old', source: 'flag', hasBeadsDb: true, flagActive: true }) };
            }
            return { ok: true, status: 200, json: async () => ({ projectDir: '/srv/new', source: 'flag', hasBeadsDb: false, flagActive: true, restartRequired: true, note }) };
        };
        runScript(html, { document, fetchImpl });
        await flushMicrotasks();

        els['path-input'].value = '/srv/new';
        await els['save-form'].submit();
        await flushMicrotasks();

        assert.equal(els['message'].textContent, note);
    });

    test('Projects page HTML carries the shared theme tokens from theme.mjs and applies themed background and text (apra-fleet-i9ag.20.2)', async () => {
        const { status, html } = await renderPath(PROJECTS_UI_PATH, { token: null });
        assert.equal(status, 200);
        // Single source of truth: tokens emitted must match the imported THEME_CSS
        assert.ok(html.includes(THEME_CSS), 'Projects page HTML must contain the theme tokens imported from theme.mjs');
        assert.match(html, /<style>[\s\S]*<\/style>/, 'must contain a <style> block');
        // Page applies themed background and foreground tokens
        assert.match(html, /body\s*\{[^}]*background:\s*var\(--bg\)/, 'body background must use --bg token');
        assert.match(html, /body\s*\{[^}]*color:\s*var\(--text\)/, 'body color must use --text token');
        assert.match(html, /dt[^{]*\{[^}]*color:\s*var\(--text-muted\)/, 'dt text must use --text-muted token');
        assert.match(html, /label[^{]*\{[^}]*color:\s*var\(--text-muted\)/, 'label text must use --text-muted token');
        // Must not fall back to browser-default unstyled colors
        assert.ok(!html.includes('<head><meta charset="utf-8"><title>Projects</title></head>'), 'must not emit bare unstyled head');
    });

    test('single source of truth: project-page.mjs imports THEME_CSS and does not duplicate token definitions (apra-fleet-i9ag.20.2)', () => {
        const projectPagePath = fileURLToPath(new URL('../src/registration/project-page.mjs', import.meta.url));
        const src = fs.readFileSync(projectPagePath, 'utf-8');
        assert.match(src, /import\s*\{[^}]*THEME_CSS[^}]*\}\s*from\s*['"]\.\.\/supervisor\/theme\.mjs['"]/, 'must import THEME_CSS from shared theme module');
        assert.ok(!src.includes('--text-muted:'), 'project-page.mjs must not duplicate theme token declarations');
        assert.ok(!src.includes('--bg:'), 'project-page.mjs must not duplicate theme token declarations');
    });

    test('placeholder page HTML carries THEME_CSS and contains a style block (apra-fleet-i9ag.22.1.2)', () => {
        assert.ok(PLACEHOLDER_HTML.includes(THEME_CSS), 'PLACEHOLDER_HTML must contain THEME_CSS byte-for-byte');
        assert.match(PLACEHOLDER_HTML, /<style>[\s\S]*<\/style>/, 'PLACEHOLDER_HTML must contain a <style> block');
    });

    test('placeholder page does not emit bare unstyled head (apra-fleet-i9ag.22.1.2)', () => {
        assert.ok(!PLACEHOLDER_HTML.includes('<head><meta charset="utf-8"><title>fleet-supervisor UI</title></head>'), 'must not emit the old bare unstyled head string');
    });

    test('placeholder page served at /ui carries THEME_CSS in the HTML (apra-fleet-i9ag.22.1.2)', async () => {
        const handler = createProjectsPageHandler({ token: null });
        const res = mockRes();
        await handler({ method: 'GET', url: '/ui', headers: {} }, res, ctxFor('/ui'));
        const html = res.body.toString('utf-8');
        assert.ok(html.includes(THEME_CSS), 'GET /ui must carry THEME_CSS');
        assert.ok(html.includes('fleet-supervisor UI arrives in a later sprint'), 'GET /ui must contain the placeholder text');
    });

    test('placeholder page served at two-segment path /ui/panels/git carries THEME_CSS (apra-fleet-i9ag.22.1.2)', async () => {
        const handler = createProjectsPageHandler({ token: null });
        const res = mockRes();
        await handler({ method: 'GET', url: '/ui/panels/git', headers: {} }, res, ctxFor('/ui/panels/git'));
        const html = res.body.toString('utf-8');
        assert.ok(html.includes(THEME_CSS), 'GET /ui/panels/git must carry THEME_CSS');
        assert.ok(html.includes('fleet-supervisor UI arrives in a later sprint'), 'GET /ui/panels/git must contain the placeholder text');
    });

    test('placeholder page served at single-segment path /ui/sprints carries THEME_CSS (apra-fleet-i9ag.22.1.2)', async () => {
        const handler = createProjectsPageHandler({ token: null });
        const res = mockRes();
        await handler({ method: 'GET', url: '/ui/sprints', headers: {} }, res, ctxFor('/ui/sprints'));
        const html = res.body.toString('utf-8');
        assert.ok(html.includes(THEME_CSS), 'GET /ui/sprints must carry THEME_CSS');
        assert.ok(html.includes('fleet-supervisor UI arrives in a later sprint'), 'GET /ui/sprints must contain the placeholder text');
    });

    test('placeholder page body applies background and text color vars (apra-fleet-i9ag.22.1.2)', () => {
        // The THEME_CSS itself includes the body rule with background: var(--bg) and color: var(--text),
        // plus a page-local body rule with padding. Verify the placeholder HTML includes both.
        assert.ok(PLACEHOLDER_HTML.includes('background: var(--bg)'), 'THEME_CSS must include background: var(--bg)');
        assert.ok(PLACEHOLDER_HTML.includes('color: var(--text)'), 'THEME_CSS must include color: var(--text)');
        assert.match(PLACEHOLDER_HTML, /body\s*\{\s*padding:/, 'must have a page-local body rule with padding');
    });

    test('single source of truth: ui-placeholder.mjs imports THEME_CSS and does not duplicate token definitions (apra-fleet-i9ag.22.1.2)', () => {
        const uiPlaceholderPath = fileURLToPath(new URL('../src/registration/ui-placeholder.mjs', import.meta.url));
        const src = fs.readFileSync(uiPlaceholderPath, 'utf-8');
        assert.match(src, /import\s*\{[^}]*THEME_CSS[^}]*\}\s*from\s*['"]\.\.\/supervisor\/theme\.mjs['"]/, 'must import THEME_CSS from shared theme module');
        assert.ok(!src.includes('--text-muted:'), 'ui-placeholder.mjs must not duplicate theme token declarations');
        assert.ok(!src.includes('--bg:'), 'ui-placeholder.mjs must not duplicate theme token declarations');
    });
});

