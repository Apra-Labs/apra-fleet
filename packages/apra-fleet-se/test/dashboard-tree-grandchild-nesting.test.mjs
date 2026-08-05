import { test, describe } from 'node:test';
import assert from 'node:assert';
import { renderBeadsHtml } from '../fleet-sprint/viewer-extensions.mjs';

// auto-sprint-11 (BUG): the dashboard Sprint tree used to nest by `blocks`-type
// dependency edges instead of bd's real `parent` (containment) edges -- a
// grandchild (task under a feature, subtask under that task) with NO `blocks`
// edges at all would render as a flat, unnested, top-level row alongside its
// ancestors instead of nested underneath them. auto-sprint-11.3 fixed
// renderBeadsHtml to build its tree from `parent` instead; this file is the
// regression test for that fix.
//
// Unlike the string-`.includes(childPrefix)` assertions in
// viewer-extensions.test.mjs, this test parses the rendered markup at the
// HTML/DOM level: it extracts each row's element structure (id-cell text and
// its `padding-left` indent, the actual layout signal a real DOM/browser
// would use to visually nest one row under another) rather than only
// matching a literal prefix substring. That makes it sensitive to the exact
// failure mode described in the bug: pre-fix, a 3-level `parent`-only chain
// (no `blocks` edges between any of the three beads) rendered every row at
// the same (root) indent -- i.e. as flat top-level siblings, not a nested
// tree.
describe('renderBeadsHtml: DOM-level nesting of a 3-level parent chain (grandchild)', () => {
    // Each row is `<tr>...<td style="padding: 8px; padding-left: Npx; ...">`
    // for the id cell. Extract, per row, the bead id and its indent (px) --
    // this is the actual structural/layout property a rendered DOM would
    // expose (offset from the left edge of the containing element), not
    // just a textual prefix glyph.
    function parseIdCellIndents(html) {
        const rowRe = /<tr[^>]*>\s*<td[^>]*padding-left:\s*(\d+)px[^>]*>.*?#([^<]+)<\/td>/g;
        const rows = [];
        let m;
        while ((m = rowRe.exec(html)) !== null) {
            rows.push({ indentPx: Number(m[1]), id: m[2] });
        }
        return rows;
    }

    test('a grandchild (feature -> task -> subtask, parent edges only, no blocks edges) nests under its parent element, not as a flat top-level row', () => {
        const tasks = [
            { id: 'FEAT-1', title: '[feat] top-level feature', status: 'open' },
            { id: 'FEAT-1.1', parent: 'FEAT-1', title: '[impl] task under the feature', status: 'open' },
            { id: 'FEAT-1.1.1', parent: 'FEAT-1.1', title: '[test] subtask under the task', status: 'open' },
        ];
        // No `dependencies`/`blocks` edges anywhere in this fixture -- the
        // ONLY relationship between these three beads is bd's real `parent`
        // containment field, so any nesting observed here can only have come
        // from parent-based tree-building, never from blocks-based nesting.
        const html = renderBeadsHtml(tasks);

        const rows = parseIdCellIndents(html);
        const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

        assert.ok(byId['FEAT-1'], 'the feature row must render');
        assert.ok(byId['FEAT-1.1'], 'the task row must render');
        assert.ok(byId['FEAT-1.1.1'], 'the subtask (grandchild) row must render');

        // The feature is a root: no depth indent beyond the base 8px.
        assert.strictEqual(byId['FEAT-1'].indentPx, 8, 'the root feature must render at base (unindented) depth');

        // The task, one level down, must be indented deeper than the feature.
        assert.ok(byId['FEAT-1.1'].indentPx > byId['FEAT-1'].indentPx, 'the task must be indented under its parent feature');

        // The grandchild subtask must be indented deeper still than its
        // immediate parent (the task) -- i.e. nested two levels under the
        // feature, not flattened back to root (0) or only one level (task)
        // depth. This is the crux of the bug: pre-fix (blocks-only nesting),
        // with no blocks edges present, FEAT-1.1.1 would render at the SAME
        // base indent as FEAT-1 (a flat top-level row), failing this
        // assertion.
        assert.ok(byId['FEAT-1.1.1'].indentPx > byId['FEAT-1.1'].indentPx, 'the subtask (grandchild) must be indented deeper than its parent task, not flattened to a top-level row');
        assert.ok(byId['FEAT-1.1.1'].indentPx > byId['FEAT-1'].indentPx + 20, 'the subtask must be nested at least two containment levels below the root feature');

        // Structural (DOM) placement also requires document order: an
        // ancestor's row element must precede its descendant's row element
        // in the rendered tree, exactly as a real nested DOM would require
        // a parent element to open before its child.
        const order = rows.map((r) => r.id);
        assert.ok(order.indexOf('FEAT-1') < order.indexOf('FEAT-1.1'), 'the feature row must precede its child task row');
        assert.ok(order.indexOf('FEAT-1.1') < order.indexOf('FEAT-1.1.1'), 'the task row must precede its child subtask row');

        // And the grandchild must not ALSO appear a second time as an
        // unnested (base-indent) top-level row elsewhere in the output.
        const rootIndentRows = rows.filter((r) => r.indentPx === byId['FEAT-1'].indentPx);
        assert.ok(!rootIndentRows.some((r) => r.id === 'FEAT-1.1.1'), 'the subtask must not also render as a flat, unindented top-level row');
    });
});
