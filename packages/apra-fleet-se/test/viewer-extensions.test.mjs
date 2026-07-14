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
        // Unknown statuses fall back to an uppercased, escaped label --
        // uppercasing happens BEFORE escaping (not after), so HTML entities
        // stay valid (&lt; not &LT;, which browsers would not decode).
        assert.ok(html.includes('&lt;B&gt;WEIRD&lt;/B&gt;'));
    });

    test('benign tasks still render their id/title/status as plain text', () => {
        const html = renderBeadsHtml([{ id: 'BD-1', title: 'Fix the thing', status: 'closed' }]);
        assert.ok(html.includes('#BD-1'));
        assert.ok(html.includes('Fix the thing'));
        // Known statuses render as an uppercased badge label, not the raw
        // lowercase string -- see the STATUS_BADGES map.
        assert.ok(html.includes('CLOSED'));
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

describe('renderBeadsHtml: dependency tree (blocks-based, not parent-based)', () => {
    test('nests a task under its blocking dependency, not a parent field', () => {
        const tasks = [
            { id: 'A', title: '[impl] first', status: 'closed', dependencies: [] },
            { id: 'B', title: '[impl] second', status: 'open', dependencies: [{ depends_on_id: 'A', type: 'blocks' }] },
        ];
        const html = renderBeadsHtml(tasks);
        // B must render (be reachable), and must appear after A in source order
        // (a real assertion on indentation depth would be brittle against
        // markup changes -- position-after-blocker is the load-bearing check).
        assert.ok(html.indexOf('#A') < html.indexOf('#B'), 'blocker A must render before the task it blocks, B');
    });

    test('multiple top-level roots render as multiple top-level rows, not an error', () => {
        const tasks = [
            { id: 'ROOT1', title: '[impl] root one', status: 'open', dependencies: [] },
            { id: 'ROOT2', title: '[impl] root two', status: 'open', dependencies: [] },
        ];
        assert.doesNotThrow(() => renderBeadsHtml(tasks));
        const html = renderBeadsHtml(tasks);
        assert.ok(html.includes('#ROOT1'));
        assert.ok(html.includes('#ROOT2'));
    });

    test('a task with multiple blockers is rendered exactly once, with extra blockers noted', () => {
        const tasks = [
            { id: 'A', title: '[impl] a', status: 'closed', dependencies: [] },
            { id: 'B', title: '[impl] b', status: 'closed', dependencies: [] },
            { id: 'C', title: '[impl] c', status: 'open', dependencies: [{ depends_on_id: 'A', type: 'blocks' }, { depends_on_id: 'B', type: 'blocks' }] },
        ];
        const html = renderBeadsHtml(tasks);
        assert.strictEqual((html.match(/#C</g) || []).length, 1, 'C must appear exactly once, not once per blocker');
        assert.ok(html.includes('also blocked by'));
    });

    test('a dependency cycle does not crash rendering or infinite-loop (cycle-guard)', () => {
        const tasks = [
            { id: 'A', title: '[impl] a', status: 'open', dependencies: [{ depends_on_id: 'B', type: 'blocks' }] },
            { id: 'B', title: '[impl] b', status: 'open', dependencies: [{ depends_on_id: 'A', type: 'blocks' }] },
        ];
        assert.doesNotThrow(() => renderBeadsHtml(tasks));
        const html = renderBeadsHtml(tasks);
        assert.ok(html.includes('#A') && html.includes('#B'), 'both nodes in the cycle must still render via the safety-net sweep');
    });
});

describe('renderBeadsHtml: status/type badges are defensive (never blank, never throw)', () => {
    test('in_progress (bd\'s real status string, underscore) gets its accent-colored badge, not the generic fallback', () => {
        const html = renderBeadsHtml([{ id: 1, title: '[impl] active work', status: 'in_progress', dependencies: [] }]);
        assert.ok(html.includes('IN PROGRESS'));
    });

    test('an unrecognized status still renders a visible fallback label, not blank', () => {
        const html = renderBeadsHtml([{ id: 1, title: 't', status: 'some_future_status', dependencies: [] }]);
        assert.ok(html.includes('SOME_FUTURE_STATUS'));
    });

    test('a missing status renders UNKNOWN rather than throwing or rendering blank', () => {
        assert.doesNotThrow(() => renderBeadsHtml([{ id: 1, title: 't', dependencies: [] }]));
        const html = renderBeadsHtml([{ id: 1, title: 't', dependencies: [] }]);
        assert.ok(html.includes('UNKNOWN'));
    });

    test('a recognized [type] title prefix gets its specific badge', () => {
        const html = renderBeadsHtml([{ id: 1, title: '[bug] something broke', status: 'open', dependencies: [] }]);
        assert.ok(html.includes('>BUG<'));
    });

    test('an unrecognized or missing [type] prefix falls back to a visible MISC label, never blank or throwing', () => {
        const withUnknownBracket = renderBeadsHtml([{ id: 1, title: '[frobnicate] something', status: 'open', dependencies: [] }]);
        assert.ok(withUnknownBracket.includes('FROBNICATE'));

        assert.doesNotThrow(() => renderBeadsHtml([{ id: 1, title: 'no bracket prefix at all', status: 'open', dependencies: [] }]));
        const withoutBracket = renderBeadsHtml([{ id: 1, title: 'no bracket prefix at all', status: 'open', dependencies: [] }]);
        assert.ok(withoutBracket.includes('MISC'));
    });

    test('priority and model metadata render with safe fallbacks when present or absent', () => {
        const withBoth = renderBeadsHtml([{ id: 1, title: 't', status: 'open', priority: 1, metadata: { model: 'premium' }, dependencies: [] }]);
        assert.ok(withBoth.includes('P1'));
        assert.ok(withBoth.includes('premium'));

        assert.doesNotThrow(() => renderBeadsHtml([{ id: 1, title: 't', status: 'open', dependencies: [] }]));
        const withNeither = renderBeadsHtml([{ id: 1, title: 't', status: 'open', dependencies: [] }]);
        assert.ok(withNeither.includes('P?'));
        assert.ok(withNeither.includes('n/a'));
    });
});

describe('renderBeadsHtml: Sprint / Backlog two-section layout', () => {
    test('always renders both a Sprint and a Backlog section header, even when both are empty', () => {
        assert.doesNotThrow(() => renderBeadsHtml());
        const html = renderBeadsHtml();
        assert.ok(html.includes('Sprint'));
        assert.ok(html.includes('Backlog'));
        assert.ok(html.includes('No sprint tasks.'));
        assert.ok(html.includes('No backlog items.'));
    });

    test('backlog items render flat (no indentation-based nesting) and sorted by priority then id', () => {
        const sprintTasks = [{ id: 'S1', title: '[impl] in the sprint', status: 'open', dependencies: [] }];
        const backlogTasks = [
            { id: 'B-low', title: '[bug] low priority backlog item', status: 'open', priority: 4 },
            { id: 'B-high', title: '[bug] high priority backlog item', status: 'deferred', priority: 1 },
        ];
        const html = renderBeadsHtml(sprintTasks, backlogTasks);
        assert.ok(html.includes('#S1'));
        assert.ok(html.includes('#B-low'));
        assert.ok(html.includes('#B-high'));
        assert.ok(html.indexOf('#B-high') < html.indexOf('#B-low'), 'P1 backlog item must sort before P4');
    });

    test('backlog rendering never throws even with minimal/missing fields on backlog items', () => {
        const backlogTasks = [{ id: 'X', title: 'no status, no priority, no metadata, no dependencies' }];
        assert.doesNotThrow(() => renderBeadsHtml([], backlogTasks));
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
