// Regression: HTML_TEMPLATE joins per-extension tab buttons, panels and
// <script> blocks server-side. They must be joined with a real newline, not
// a literal backslash-n, which would render as visible "\n" text in the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HTML_TEMPLATE } from '../src/viewer/index.mjs';

const exts = [
    { id: 'beads', title: 'Tasks', js: 'window.__a = 1;' },
    { id: 'kb', title: 'Knowledge & Code Intel', js: 'window.__b = 2;' },
];

test('two dashboard extensions: no literal backslash-n between tabs, panels or scripts', () => {
    const html = HTML_TEMPLATE(exts);

    assert.match(html, /switchTab\('beads'\)">Tasks<\/button>/);
    assert.match(html, /switchTab\('kb'\)">Knowledge & Code Intel<\/button>/);
    assert.ok(html.includes('id="extension-beads"') && html.includes('id="extension-kb"'));
    assert.ok(html.includes('window.__a = 1;') && html.includes('window.__b = 2;'));

    assert.ok(!/<\/button>\\n<button/.test(html), 'tab buttons must not be joined by literal \\n');
    assert.ok(!/<\/script>\\n<script>/.test(html), 'extension scripts must not be joined by literal \\n');

    // Panels: no literal \n between the first extension's header and the second's.
    const a = html.indexOf('id="panel-header-beads"');
    const b = html.indexOf('id="panel-header-kb"');
    assert.ok(a !== -1 && b > a);
    assert.ok(!html.slice(a, b).includes('\\n'), 'extension panels must not be joined by literal \\n');
});
