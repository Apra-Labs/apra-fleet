import { test, describe } from 'node:test';
import assert from 'node:assert';
import { beadsExtension, renderBeadsHtml } from '../auto-sprint/viewer-extensions.mjs';

// Unit tests for apra-fleet-unw.10 (F9/A7-viewer): the beads dashboard
// extension used to inject `node.title`/`node.description` into `innerHTML`
// unescaped (XSS risk -- bead titles/descriptions are LLM-authored, and the
// dashboard page also exposes the /stop capability). `renderBeadsHtml()` is
// a pure string-builder (no `document` access), so its escaping behavior
// can be verified directly under Node without a browser/DOM/jsdom.

describe('renderBeadsHtml: XSS escaping', () => {
    test('a malicious bead title is rendered inert (no live <script> tag survives)', () => {
        const malicious = [{ id: 1, title: '<script>alert(1)</script>', status: 'open' }];
        const html = renderBeadsHtml(malicious);

        assert.ok(!html.includes('<script>alert(1)</script>'), 'the raw payload must not survive verbatim');
        assert.ok(!/<script>/i.test(html), 'no live <script> tag may appear in the rendered output');
        assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the payload must appear HTML-escaped');
    });

    test('a malicious bead description is rendered inert', () => {
        const malicious = [{ id: 2, title: 'normal title', description: '<img src=x onerror=alert(2)>', status: 'open' }];
        const html = renderBeadsHtml(malicious);

        assert.ok(!/<img[^>]*onerror=/i.test(html), 'no live onerror-bearing tag may appear in the rendered output');
        assert.ok(html.includes('&lt;img src=x onerror=alert(2)&gt;'));
    });

    test('a malicious bead id and status are also escaped', () => {
        const malicious = [{ id: '"><script>alert(3)</script>', title: 't', status: '<b>weird</b>' }];
        const html = renderBeadsHtml(malicious);

        assert.ok(!/<script>/i.test(html));
        assert.ok(!html.includes('<b>weird</b>'));
        assert.ok(html.includes('&lt;b&gt;weird&lt;/b&gt;'));
    });

    test('benign tasks still render their id/title/status as plain text', () => {
        const html = renderBeadsHtml([{ id: 'BD-1', title: 'Fix the thing', status: 'closed' }]);
        assert.ok(html.includes('#BD-1'));
        assert.ok(html.includes('Fix the thing'));
        assert.ok(html.includes('closed'));
    });

    test('handles an empty/undefined task list without throwing', () => {
        assert.doesNotThrow(() => renderBeadsHtml([]));
        assert.doesNotThrow(() => renderBeadsHtml(undefined));
    });

    test('nested (parent/child) tasks are all escaped, not just roots', () => {
        const tasks = [
            { id: 'root', title: 'root <script>alert(4)</script>', status: 'open' },
            { id: 'child', parent: 'root', title: 'child <script>alert(5)</script>', status: 'open' }
        ];
        const html = renderBeadsHtml(tasks);
        assert.ok(!/<script>/i.test(html));
        assert.ok(html.includes('&lt;script&gt;alert(4)&lt;/script&gt;'));
        assert.ok(html.includes('&lt;script&gt;alert(5)&lt;/script&gt;'));
    });
});

describe('beadsExtension.js: embedded browser script is syntactically valid and self-contained', () => {
    test('parses as a valid function body (no leftover template-literal escaping bugs)', () => {
        assert.doesNotThrow(() => new Function('document', beadsExtension.js));
    });

    test('embeds a working renderBeadsHtml() that escapes malicious input when invoked as a plain function', () => {
        // Extract and invoke renderBeadsHtml exactly as the browser would --
        // proves the .toString()-embedded copy behaves identically to the
        // directly-imported one tested above.
        const factory = new Function(`
            ${beadsExtension.js.replace(/document\.addEventListener[\s\S]*$/, '')}
            return renderBeadsHtml;
        `);
        const embeddedRenderBeadsHtml = factory();
        const html = embeddedRenderBeadsHtml([{ id: 1, title: '<script>alert(1)</script>', status: 'open' }]);
        assert.ok(!/<script>/i.test(html));
        assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    });
});
