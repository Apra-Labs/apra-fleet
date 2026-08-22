import { test, describe } from 'node:test';
import assert from 'node:assert';
import { beadsExtension, renderBeadsHtml, renderResultExtrasHtml, renderProgressBarHtml } from '../fleet-sprint/viewer-extensions.mjs';
import { computeSprintProgress } from '../fleet-sprint/sprint-progress.mjs';

// apra-fleet-x8r.1: closed/required progress-bar widget. computeSprintProgress
// is a pure function over the ALREADY-SCOPED bead list (the same list
// bdListScoped('') / runner.js's scope-walk already produces, threaded
// through as sprintTasks) -- it does no I/O and never re-derives scope.
describe('computeSprintProgress', () => {
    test('counts closed vs total across a mixed-status scoped bead list', () => {
        const beads = [
            { id: 1, status: 'closed' },
            { id: 2, status: 'open' },
            { id: 3, status: 'closed' },
            { id: 4, status: 'in_progress' },
        ];
        assert.deepStrictEqual(computeSprintProgress(beads), { closed: 2, required: 4, fraction: 0.5 });
    });

    test('required=0 (empty scope) renders without dividing by zero -- fraction is 0, not NaN', () => {
        const result = computeSprintProgress([]);
        assert.deepStrictEqual(result, { closed: 0, required: 0, fraction: 0 });
        assert.ok(Number.isFinite(result.fraction));
    });

    test('non-array input never throws -- treated as empty', () => {
        assert.deepStrictEqual(computeSprintProgress(null), { closed: 0, required: 0, fraction: 0 });
        assert.deepStrictEqual(computeSprintProgress(undefined), { closed: 0, required: 0, fraction: 0 });
    });

    test('all closed -> fraction 1', () => {
        const beads = [{ status: 'closed' }, { status: 'closed' }];
        assert.deepStrictEqual(computeSprintProgress(beads), { closed: 2, required: 2, fraction: 1 });
    });

    // apra-fleet-x8r.4: `required` must match runner.js's real completion
    // gate -- below-goal-priority beads and decomposed parent (grouping)
    // nodes are excluded from the required-to-close set, so a sprint scope
    // containing either can still reach N/N once every ELIGIBLE bead closes,
    // even though the raw scope list itself never all-closes.
    test('a below-goal bead and a decomposed parent are excluded from required -- scope reaches N/N once eligible beads close', () => {
        const beads = [
            // In-goal leaf, closed.
            { id: 'a', status: 'closed', priority: 1 },
            // In-goal leaf, closed.
            { id: 'b', status: 'closed', priority: 2, parent: 'a' },
            // Below-goal bead (priority 3 > goalMax 2) -- still OPEN, but must
            // not block N/N since it is outside the required set.
            { id: 'c', status: 'open', priority: 3 },
            // Decomposed parent (someone else's `.parent`) -- structurally
            // excluded regardless of priority/status; its own status here is
            // deliberately 'open' to prove exclusion isn't just "closed
            // parents don't matter".
            { id: 'd', status: 'open', priority: 1 },
            { id: 'e', status: 'closed', priority: 1, parent: 'd' },
        ];
        const result = computeSprintProgress(beads, { goalMax: 2, decomposedParentIds: ['d'] });
        // Eligible set: a, b, e (c is below-goal; d is a decomposed parent).
        // All three are closed -> N/N.
        assert.deepStrictEqual(result, { closed: 3, required: 3, fraction: 1 });
    });

    test('opts is additive-optional -- a bare call keeps the pre-x8r.4 "every bead in scope" behavior', () => {
        const beads = [
            { id: 'a', status: 'closed', priority: 1 },
            { id: 'b', status: 'open', priority: 5 },
        ];
        assert.deepStrictEqual(computeSprintProgress(beads), { closed: 1, required: 2, fraction: 0.5 });
        assert.deepStrictEqual(computeSprintProgress(beads, {}), { closed: 1, required: 2, fraction: 0.5 });
    });

    // apra-fleet-x8r.8: runner.js's partitionByGoalMembership() (eft.52.1.3)
    // can admit a below-goal-priority bead into the Sprint section via a
    // documented blocks-edge exception, tagging it `placement: 'sprint'`.
    // The beads TREE (renderBeadsHtml) honors that flag when present. Before
    // this fix, computeSprintProgress() ignored `placement` and re-derived
    // membership from raw priority alone -- so a blocks-exception bead could
    // render as an open Sprint row in the tree while the bar above it read
    // N/N, excluding that same row from the count. This pins the two
    // surfaces agreeing: a below-goal bead tagged `placement: 'sprint'` is
    // counted (and, while open, blocks N/N), matching the tree that renders
    // it as a Sprint row; a below-goal bead tagged `placement: 'backlog'` is
    // excluded, matching the tree that renders it in the Backlog instead.
    test('a below-goal bead admitted into the Sprint section via the blocks-edge exception is counted, matching the tree (apra-fleet-x8r.8)', () => {
        const beads = [
            // In-goal leaf, closed.
            { id: 'a', status: 'closed', priority: 1, placement: 'sprint' },
            // Below-goal by priority (3 > goalMax 1), but admitted into the
            // Sprint section by the blocks-edge exception -- still OPEN.
            { id: 'blocks-exception', status: 'open', priority: 3, placement: 'sprint' },
        ];
        const result = computeSprintProgress(beads, { goalMax: 1 });
        // Without placement-awareness this would read closed:1, required:1,
        // fraction:1 (N/N) despite 'blocks-exception' rendering as an open
        // Sprint row in the tree. With placement honored, it stays 1/2.
        assert.deepStrictEqual(result, { closed: 1, required: 2, fraction: 0.5 });
    });

    test('a below-goal bead NOT admitted into the Sprint section (placement: backlog) is excluded, matching the tree', () => {
        const beads = [
            { id: 'a', status: 'closed', priority: 1, placement: 'sprint' },
            { id: 'below-goal', status: 'open', priority: 3, placement: 'backlog' },
        ];
        const result = computeSprintProgress(beads, { goalMax: 1 });
        assert.deepStrictEqual(result, { closed: 1, required: 1, fraction: 1 });
    });

    test('rows with no `placement` field fall back to the plain numeric priority filter unchanged (e.g. dashboard.mjs callers)', () => {
        const beads = [
            { id: 'a', status: 'closed', priority: 1 },
            { id: 'below-goal', status: 'open', priority: 3 },
        ];
        assert.deepStrictEqual(computeSprintProgress(beads, { goalMax: 1 }), { closed: 1, required: 1, fraction: 1 });
    });
});

describe('renderProgressBarHtml', () => {
    test('renders the M/N text and a bar fill proportional to fraction', () => {
        const html = renderProgressBarHtml({ closed: 3, required: 10, fraction: 0.3 });
        assert.ok(html.includes('3/10'));
        assert.ok(html.includes('width: 30%'));
    });

    test('required=0 renders a flat empty bar and 0/0 text, never throws', () => {
        assert.doesNotThrow(() => renderProgressBarHtml({ closed: 0, required: 0, fraction: 0 }));
        const html = renderProgressBarHtml({ closed: 0, required: 0, fraction: 0 });
        assert.ok(html.includes('0/0'));
        assert.ok(html.includes('width: 0%'));
    });

    test('never throws on null/undefined input', () => {
        assert.doesNotThrow(() => renderProgressBarHtml(null));
        assert.doesNotThrow(() => renderProgressBarHtml(undefined));
    });

    test('is embedded into the browser-side beadsExtension.js script', () => {
        assert.ok(beadsExtension.js.includes('computeSprintProgress'));
        assert.ok(beadsExtension.js.includes('renderProgressBarHtml'));
    });
});

// apra-fleet-eft.37.4 (M3): beadsExtension.detailLookup is the relocated
// (verbatim) former core findBeadById() -- core now only knows the generic
// detailLookup(state, id) hook contract, never bd's sprintTasks/backlogTasks
// shape. Exercised directly here since it is server-side (Node) code, not
// embedded into beadsExtension.js's browser-side script.
describe('beadsExtension.detailLookup: relocated findBeadById (server-side hook)', () => {
    test('finds a bead in sprintTasks and returns {text, updatedAt}', () => {
        const state = {
            extensions: {
                beads: {
                    sprintTasks: [{ id: 'bd-1', description: 'full text here', updated_at: '2026-07-20T00:00:00Z' }],
                    backlogTasks: []
                }
            }
        };
        const detail = beadsExtension.detailLookup(state, 'bd-1');
        assert.deepStrictEqual(detail, { text: 'full text here', updatedAt: '2026-07-20T00:00:00Z' });
    });

    test('finds a bead in backlogTasks too, not just sprintTasks', () => {
        const state = {
            extensions: {
                beads: {
                    sprintTasks: [],
                    backlogTasks: [{ id: 'bd-backlog-1', description: 'backlog description', updated_at: '2026-07-19T00:00:00Z' }]
                }
            }
        };
        const detail = beadsExtension.detailLookup(state, 'bd-backlog-1');
        assert.deepStrictEqual(detail, { text: 'backlog description', updatedAt: '2026-07-19T00:00:00Z' });
    });

    test('an unknown bead id returns null, not a crash', () => {
        const state = { extensions: { beads: { sprintTasks: [{ id: 'bd-1', description: 'd' }], backlogTasks: [] } } };
        assert.strictEqual(beadsExtension.detailLookup(state, 'does-not-exist'), null);
    });

    test('returns null (not a crash) when no beads state has been published yet', () => {
        assert.strictEqual(beadsExtension.detailLookup({ extensions: {} }, 'bd-1'), null);
        assert.strictEqual(beadsExtension.detailLookup({}, 'bd-1'), null);
    });
});

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

// apra-fleet-eft.42: the tree used to nest by `blocks`-type dependency edges;
// it now nests by bd's real `parent` (containment) field instead, with
// `blocks` edges preserved as an inline "blocked by" annotation on the row
// rather than tree placement. The expectations below replace/repurpose the
// old blocks-based-nesting assertions, which are now inverted -- see the
// module doc-comment in fleet-sprint/viewer-extensions.mjs.
describe('renderBeadsHtml: containment tree (parent-based nesting, blocks-deps as annotations)', () => {
    // A row's id cell is `prefix + '#' + id` where `prefix` is this two-glyph
    // marker (only present at depth > 0) -- built via fromCharCode, not a
    // literal non-ASCII character, per this repo's ASCII-only file convention.
    const childPrefix = String.fromCharCode(0x2514, 0x2500) + ' ';

    test('nests children under their parent (containment); the parent is not left as a childless sibling', () => {
        const tasks = [
            { id: '41', title: '[bug] parent epic', status: 'open' },
            { id: '41.1', parent: '41', title: '[impl] child one', status: 'closed' },
            { id: '41.2', parent: '41', title: '[test] child two', status: 'open' },
            { id: '41.4', parent: '41', title: '[test] child four', status: 'open', dependencies: [{ depends_on_id: '41.1', type: 'blocks' }] },
        ];
        const html = renderBeadsHtml(tasks);

        // Root row has no depth-prefix.
        assert.ok(html.includes('>#41</td>'), '41 must render as a root row');
        // Every child renders WITH the depth-prefix, i.e. nested under 41 --
        // not as a second, unprefixed (root-level) row of its own.
        assert.ok(html.includes(childPrefix + '#41.1</td>'), '41.1 must nest under its parent 41');
        assert.ok(html.includes(childPrefix + '#41.2</td>'), '41.2 must nest under its parent 41');
        assert.ok(html.includes(childPrefix + '#41.4</td>'), '41.4 must nest under its parent 41');
        assert.ok(!html.includes('>#41.1</td>'), '41.1 must not also render as an unnested root-level row');
        assert.ok(!html.includes('>#41.2</td>'), '41.2 must not also render as an unnested root-level row');
        assert.ok(!html.includes('>#41.4</td>'), '41.4 must not also render as an unnested root-level row');
        // 41 must actually precede its children in the output.
        assert.ok(html.indexOf('>#41</td>') < html.indexOf(childPrefix + '#41.1</td>'));
        assert.ok(html.indexOf('>#41</td>') < html.indexOf(childPrefix + '#41.2</td>'));
        assert.ok(html.indexOf('>#41</td>') < html.indexOf(childPrefix + '#41.4</td>'));
    });

    test('a "blocks" dependency renders as an inline "blocked by" annotation, not as tree nesting under the blocker', () => {
        const tasks = [
            { id: 'P1', title: '[bug] parent one', status: 'open' },
            { id: 'X', parent: 'P1', title: '[impl] child of P1, blocked by Y', status: 'open', dependencies: [{ depends_on_id: 'Y', type: 'blocks' }] },
            { id: 'P2', title: '[bug] parent two', status: 'open' },
            { id: 'Y', parent: 'P2', title: '[impl] child of P2 (the blocker)', status: 'closed' },
        ];
        const html = renderBeadsHtml(tasks);

        // X nests under its own parent, P1 -- NOT under its blocker Y.
        assert.ok(html.includes(childPrefix + '#X</td>'), 'X must nest under its parent P1');
        // The blocking relationship is preserved as an inline annotation, not lost.
        assert.ok(html.includes('blocked by: #Y'), 'the blocks edge must still be surfaced as an inline annotation');
        // X (a child of P1) must render before P2 -- proving it was placed in
        // P1's subtree, not pulled into Y's subtree under the unrelated P2.
        assert.ok(html.indexOf('>#P1</td>') < html.indexOf(childPrefix + '#X</td>'));
        assert.ok(html.indexOf(childPrefix + '#X</td>') < html.indexOf('>#P2</td>'), 'X must render inside P1\'s subtree, before the unrelated P2 subtree');
    });

    test('multiple top-level roots (no parent) render as multiple top-level rows, not an error', () => {
        const tasks = [
            { id: 'ROOT1', title: '[impl] root one', status: 'open', dependencies: [] },
            { id: 'ROOT2', title: '[impl] root two', status: 'open', dependencies: [] },
        ];
        assert.doesNotThrow(() => renderBeadsHtml(tasks));
        const html = renderBeadsHtml(tasks);
        assert.ok(html.includes('#ROOT1'));
        assert.ok(html.includes('#ROOT2'));
    });

    test('a task with multiple blockers is rendered exactly once, with every blocker noted in the annotation', () => {
        const tasks = [
            { id: 'A', title: '[impl] a', status: 'closed', dependencies: [] },
            { id: 'B', title: '[impl] b', status: 'closed', dependencies: [] },
            { id: 'C', title: '[impl] c', status: 'open', dependencies: [{ depends_on_id: 'A', type: 'blocks' }, { depends_on_id: 'B', type: 'blocks' }] },
        ];
        const html = renderBeadsHtml(tasks);
        assert.strictEqual((html.match(/#C</g) || []).length, 1, 'C must appear exactly once, not once per blocker');
        assert.ok(html.includes('blocked by: #A, #B'), 'both blockers must be listed in the single annotation');
    });

    test('a `parent`-containment cycle does not crash rendering or infinite-loop (cycle-guard)', () => {
        const tasks = [
            { id: 'A', parent: 'B', title: '[impl] a' },
            { id: 'B', parent: 'A', title: '[impl] b' },
        ];
        assert.doesNotThrow(() => renderBeadsHtml(tasks));
        const html = renderBeadsHtml(tasks);
        assert.ok(html.includes('#A') && html.includes('#B'), 'both nodes in the cycle must still render via the safety-net sweep');
        assert.strictEqual((html.match(/#A</g) || []).length, 1, 'A must not be rendered twice despite the cycle');
        assert.strictEqual((html.match(/#B</g) || []).length, 1, 'B must not be rendered twice despite the cycle');
    });

    test('status badges are unchanged for closed/open/in_progress/blocked rows, even when nested by parent', () => {
        const tasks = [
            { id: 'EPIC', title: '[bug] epic', status: 'in_progress' },
            { id: 'EPIC.1', parent: 'EPIC', title: '[impl] done work', status: 'closed' },
            { id: 'EPIC.2', parent: 'EPIC', title: '[impl] open work', status: 'open' },
            { id: 'EPIC.3', parent: 'EPIC', title: '[impl] not ready', status: 'open', ready: false },
        ];
        const html = renderBeadsHtml(tasks);
        assert.ok(html.includes('IN PROGRESS'));
        assert.ok(html.includes('CLOSED'));
        assert.ok(html.includes('>OPEN<'));
        assert.ok(html.includes('BLOCKED'));
    });

    test('renderBeadsHtml is a pure synchronous function returning a string (no fetch/await in the render path)', () => {
        assert.notStrictEqual(renderBeadsHtml.constructor.name, 'AsyncFunction', 'must not be declared async');
        const result = renderBeadsHtml([{ id: 1, title: 't', status: 'open' }]);
        assert.strictEqual(typeof result, 'string');
        assert.ok(!(result instanceof Promise), 'must return a string directly, never a Promise');
        assert.strictEqual(typeof result.then, 'undefined', 'a plain string has no .then -- confirms this is not a thenable/Promise');
    });
});

// apra-fleet-eft.52.1.2: Sprint's TOP-LEVEL rows are primarily ordered by
// status urgency (In-progress -> Open -> Blocked -> Closed), falling back to
// priority-then-id only to break ties within a status. This is explicitly
// NON-recursive: a nested child list under one of those roots keeps its
// existing natural DAG order, unaffected by its parent's (or its own)
// status.
describe('renderBeadsHtml: Sprint top-level status ordering (apra-fleet-eft.52.1.2)', () => {
    const childPrefix = String.fromCharCode(0x2514, 0x2500) + ' ';

    test('top-level roots with all four statuses render in order In-progress, Open, Blocked, Closed, regardless of input order', () => {
        const tasks = [
            { id: 'ROOT-CLOSED', title: '[impl] closed root', status: 'closed', priority: 1, dependencies: [] },
            { id: 'ROOT-BLOCKED', title: '[impl] blocked root', status: 'open', ready: false, priority: 1, dependencies: [] },
            { id: 'ROOT-OPEN', title: '[impl] open root', status: 'open', priority: 1, dependencies: [] },
            { id: 'ROOT-INPROGRESS', title: '[impl] in-progress root', status: 'in_progress', priority: 1, dependencies: [] },
        ];
        const html = renderBeadsHtml(tasks);

        const posInProgress = html.indexOf('>#ROOT-INPROGRESS</td>');
        const posOpen = html.indexOf('>#ROOT-OPEN</td>');
        const posBlocked = html.indexOf('>#ROOT-BLOCKED</td>');
        const posClosed = html.indexOf('>#ROOT-CLOSED</td>');

        assert.ok(posInProgress < posOpen, 'in-progress root must render before the open root');
        assert.ok(posOpen < posBlocked, 'open root must render before the blocked root');
        assert.ok(posBlocked < posClosed, 'blocked root must render before the closed root');
    });

    test('within the same status, roots still fall back to priority-then-id ordering', () => {
        const tasks = [
            { id: 'LOW', title: '[impl] low priority', status: 'open', priority: 4, dependencies: [] },
            { id: 'HIGH', title: '[impl] high priority', status: 'open', priority: 1, dependencies: [] },
        ];
        const html = renderBeadsHtml(tasks);
        assert.ok(html.indexOf('>#HIGH</td>') < html.indexOf('>#LOW</td>'), 'P1 root must sort before P4 root within the same status');
    });

    test('the status sort is non-recursive: a nested child list keeps its original DAG order, not a status-based order', () => {
        const tasks = [
            { id: 'EPIC', title: '[bug] epic', status: 'open', dependencies: [] },
            { id: 'EPIC.1', parent: 'EPIC', title: '[impl] closed child', status: 'closed', dependencies: [] },
            { id: 'EPIC.2', parent: 'EPIC', title: '[impl] in-progress child', status: 'in_progress', dependencies: [] },
        ];
        const html = renderBeadsHtml(tasks);
        // Children keep their existing (natural DAG / id) order -- EPIC.1
        // before EPIC.2 -- even though EPIC.2 (in-progress) would sort ahead
        // of EPIC.1 (closed) under the top-level status rule.
        assert.ok(html.indexOf(childPrefix + '#EPIC.1</td>') < html.indexOf(childPrefix + '#EPIC.2</td>'), 'children must remain in natural order, not be re-sorted by status');
    });

    test('the Backlog section ordering is unaffected by the Sprint status sort', () => {
        const sprintTasks = [{ id: 'S1', title: '[impl] sprint root', status: 'closed', dependencies: [] }];
        const backlogTasks = [
            { id: 'B-low', title: '[bug] low priority backlog item', status: 'in_progress', priority: 4 },
            { id: 'B-high', title: '[bug] high priority backlog item', status: 'closed', priority: 1 },
        ];
        const html = renderBeadsHtml(sprintTasks, backlogTasks);
        // Backlog keeps its own priority-then-id ordering (P1 before P4),
        // even though B-low's status (in_progress) would outrank B-high's
        // (closed) under Sprint's status rule -- Backlog does not use it.
        assert.ok(html.indexOf('#B-high') < html.indexOf('#B-low'), 'Backlog must still sort P1 before P4, unaffected by status');
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

    test('apra-fleet-xbu.C6: issue_type is read first for its own dedicated badge, even with no matching title prefix', () => {
        const html = renderBeadsHtml([{ id: 1, title: 'fix the auth bug', status: 'open', issue_type: 'bug', dependencies: [] }]);
        assert.ok(html.includes('>BUG<'), 'a bug-typed bead must badge as BUG from issue_type alone, not fall through to MISC');
    });

    test('apra-fleet-xbu.C6: a task/feature issue_type (no dedicated badge) still falls back to its [prefix] title convention', () => {
        const html = renderBeadsHtml([{ id: 1, title: '[test] verify the fix', status: 'open', issue_type: 'task', dependencies: [] }]);
        assert.ok(html.includes('>TEST<'), 'issue_type=task has no dedicated badge, so the [test] title prefix must still win, not a bare TASK badge');
    });

    test('apra-fleet-xbu.C6: an open bead explicitly marked not-ready renders BLOCKED, not OPEN', () => {
        const html = renderBeadsHtml([{ id: 1, title: 'deadlocked task', status: 'open', ready: false, dependencies: [] }]);
        assert.ok(html.includes('BLOCKED'), 'ready:false must render a distinct BLOCKED badge');
        assert.ok(!html.includes('>OPEN<'), 'must not also render the plain OPEN badge for the same bead');
    });

    test('apra-fleet-xbu.C6: an open bead with no ready field at all (e.g. backlog) still renders plain OPEN, unchanged', () => {
        const html = renderBeadsHtml([{ id: 1, title: 'plain open task', status: 'open', dependencies: [] }]);
        assert.ok(html.includes('>OPEN<'), 'absence of the ready field must not be misread as blocked');
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
    // apra-fleet-eft.89: a section header + its body only render when that
    // section actually has at least one task -- an empty list skips the
    // section entirely (no header, no "No sprint tasks."/"No backlog
    // items." placeholder row), rather than always showing both.
    test('when both sprintTasks and backlogTasks are empty, neither section header renders, but the output stays well-formed', () => {
        assert.doesNotThrow(() => renderBeadsHtml());
        const html = renderBeadsHtml();
        assert.ok(!html.includes('Sprint'));
        assert.ok(!html.includes('Backlog'));
        assert.ok(!html.includes('No sprint tasks.'));
        assert.ok(!html.includes('No backlog items.'));
        // The 6-column header row and table wrapper still always render.
        assert.ok(html.includes('<th style="padding: 8px;">ID</th>'));
        assert.ok(html.includes('<table'));
    });

    test('sprintTasks populated, backlogTasks empty: only the Sprint section renders, no Backlog header/row', () => {
        const html = renderBeadsHtml([{ id: 'S1', title: '[impl] in the sprint', status: 'open', dependencies: [] }], []);
        assert.ok(html.includes('Sprint'));
        assert.ok(!html.includes('Backlog'));
        assert.ok(!html.includes('No backlog items.'));
        assert.ok(html.includes('#S1'));
    });

    test('backlogTasks populated, sprintTasks empty: only the Backlog section renders, no Sprint header/row', () => {
        const html = renderBeadsHtml([], [{ id: 'B1', title: '[impl] in the backlog', status: 'open' }]);
        assert.ok(!html.includes('Sprint'));
        assert.ok(html.includes('Backlog'));
        assert.ok(!html.includes('No sprint tasks.'));
        assert.ok(html.includes('#B1'));
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

// apra-fleet-k7s: Backlog items that carry `blocks`-type dependency edges
// BETWEEN EACH OTHER now nest into a tree (same indent/prefix mechanics as
// Sprint's renderNode), instead of always flattening. Items with no such
// in-set edge remain flat/top-level, unchanged.
describe('renderBeadsHtml: Backlog dependency tree (apra-fleet-k7s)', () => {
    const childPrefix = String.fromCharCode(0x2514, 0x2500) + ' ';

    test('a backlog item blocked by another backlog item nests under its blocker', () => {
        const backlogTasks = [
            { id: 'BL-1', title: '[impl] the blocker', status: 'open' },
            { id: 'BL-2', title: '[impl] blocked by BL-1', status: 'open', dependencies: [{ depends_on_id: 'BL-1', type: 'blocks' }] },
        ];
        const html = renderBeadsHtml([], backlogTasks);

        assert.ok(html.includes('>#BL-1</td>'), 'BL-1 must render as a root row');
        assert.ok(html.includes(childPrefix + '#BL-2</td>'), 'BL-2 must nest under its blocker BL-1');
        assert.ok(!html.includes('>#BL-2</td>'), 'BL-2 must not also render as an unnested root-level row');
        assert.ok(html.indexOf('>#BL-1</td>') < html.indexOf(childPrefix + '#BL-2</td>'), 'the blocker must render before the item it blocks');
        assert.ok(html.includes('blocked by: #BL-1'), 'the blocking edge is still surfaced as an inline annotation too');
    });

    test('backlog items with no blocks-edge between them stay flat/top-level, unchanged', () => {
        const backlogTasks = [
            { id: 'B-low', title: '[bug] low priority backlog item', status: 'open', priority: 4 },
            { id: 'B-high', title: '[bug] high priority backlog item', status: 'deferred', priority: 1 },
        ];
        const html = renderBeadsHtml([], backlogTasks);

        assert.ok(!html.includes(childPrefix + '#B-low</td>'), 'B-low has no in-set blocker, so must not be indented');
        assert.ok(!html.includes(childPrefix + '#B-high</td>'), 'B-high has no in-set blocker, so must not be indented');
        assert.ok(html.indexOf('#B-high') < html.indexOf('#B-low'), 'unrelated root items still sort P1 before P4');
    });

    test('a backlog item blocked by a bead outside the backlog set (not in this dataset) stays a root, not dropped', () => {
        const backlogTasks = [
            { id: 'B-1', title: '[impl] blocked by something not in backlog', status: 'open', dependencies: [{ depends_on_id: 'sprint-only-id', type: 'blocks' }] },
        ];
        const html = renderBeadsHtml([], backlogTasks);
        assert.ok(html.includes('>#B-1</td>'), 'an out-of-set blocker must not prevent B-1 from rendering as a root');
        assert.ok(!html.includes('blocked by:'), 'an out-of-set blocker id is not part of this dataset, so no annotation is drawn for it');
    });

    test('a backlog item blocked by multiple in-set items nests once (lowest-sorted blocker wins), all blockers still annotated', () => {
        const backlogTasks = [
            { id: 'A', title: '[impl] a', status: 'closed' },
            { id: 'B', title: '[impl] b', status: 'closed' },
            { id: 'C', title: '[impl] c', status: 'open', dependencies: [{ depends_on_id: 'B', type: 'blocks' }, { depends_on_id: 'A', type: 'blocks' }] },
        ];
        const html = renderBeadsHtml([], backlogTasks);
        assert.strictEqual((html.match(/#C</g) || []).length, 1, 'C must render exactly once, not once per blocker');
        assert.ok(html.includes(childPrefix + '#C</td>'), 'C must be nested (under A, the lowest-sorted blocker)');
        assert.ok(html.includes('blocked by: #A, #B'), 'both blockers must be listed in the annotation regardless of which one won nesting');
    });

    test('a blocks-cycle among backlog items does not crash or infinite-loop (cycle-guard + safety net)', () => {
        const backlogTasks = [
            { id: 'X', title: '[impl] x', status: 'open', dependencies: [{ depends_on_id: 'Y', type: 'blocks' }] },
            { id: 'Y', title: '[impl] y', status: 'open', dependencies: [{ depends_on_id: 'X', type: 'blocks' }] },
        ];
        assert.doesNotThrow(() => renderBeadsHtml([], backlogTasks));
        const html = renderBeadsHtml([], backlogTasks);
        // Matches only the row's own id cell (</td> right after), not the
        // "blocked by: #X"/"blocked by: #Y" annotation each row also carries
        // (X and Y block each other), which would otherwise double-count.
        assert.strictEqual((html.match(/#X<\/td>/g) || []).length, 1, 'X must not be rendered twice despite the cycle');
        assert.strictEqual((html.match(/#Y<\/td>/g) || []).length, 1, 'Y must not be rendered twice despite the cycle');
    });
});

// apra-fleet-4p5: tree nodes (and the two top-level Sprint/Backlog section
// headers) should be collapsible/expandable, so a user can fold away
// completed or uninteresting subtrees. renderBeadsHtml() stays a pure,
// synchronous string builder -- collapse state is threaded in via an
// optional third `collapsedIds` argument, never read from `document`.
describe('renderBeadsHtml: collapsible/expandable tree nodes and sections (apra-fleet-4p5)', () => {
    const childPrefix = String.fromCharCode(0x2514, 0x2500) + ' ';

    test('a node with children renders a [-] (expanded) toggle by default', () => {
        const tasks = [
            { id: '41', title: '[bug] parent epic', status: 'open' },
            { id: '41.1', parent: '41', title: '[impl] child one', status: 'closed' },
        ];
        const html = renderBeadsHtml(tasks);
        assert.ok(html.includes('data-toggle-id="41"'));
        assert.ok(html.includes('[-]'));
        // Not collapsed, so the child still renders.
        assert.ok(html.includes(childPrefix + '#41.1</td>'));
    });

    test('a childless node renders no toggle control of its own (just an invisible spacer)', () => {
        const html = renderBeadsHtml([{ id: 'leaf', title: 'no children here', status: 'open' }]);
        assert.ok(!html.includes('data-toggle-id="leaf"'));
        // Only the Sprint section has content here (backlogTasks is empty,
        // so the Backlog section is skipped entirely per apra-fleet-eft.89)
        // -- exactly 1 `.tree-toggle` control exists, belonging to the
        // Sprint section header, none to the leaf node.
        assert.strictEqual((html.match(/class="tree-toggle"/g) || []).length, 1);
    });

    test('a node id present in collapsedIds renders its [+] toggle and hides its children rows entirely', () => {
        const tasks = [
            { id: '41', title: '[bug] parent epic', status: 'open' },
            { id: '41.1', parent: '41', title: '[impl] child one', status: 'closed' },
            { id: '41.2', parent: '41', title: '[impl] child two', status: 'open' },
        ];
        const html = renderBeadsHtml(tasks, [], new Set(['41']));
        // Parent row itself still renders, now showing the collapsed [+] toggle.
        assert.ok(html.includes('>#41</td>'), 'the collapsed parent row itself must still render');
        assert.ok(html.includes('data-toggle-id="41"'));
        assert.ok(html.includes('[+]'));
        // Children are hidden -- neither nested nor re-attached as spurious roots.
        assert.ok(!html.includes('41.1'), 'a collapsed node\'s child must not appear anywhere in the output');
        assert.ok(!html.includes('41.2'), 'a collapsed node\'s child must not appear anywhere in the output');
    });

    test('collapsedIds accepts a plain array, not just a Set, without throwing', () => {
        const tasks = [
            { id: 'P', title: '[bug] parent', status: 'open' },
            { id: 'C', parent: 'P', title: '[impl] child', status: 'open' },
        ];
        assert.doesNotThrow(() => renderBeadsHtml(tasks, [], ['P']));
        const html = renderBeadsHtml(tasks, [], ['P']);
        assert.ok(!html.includes('#C<'));
    });

    test('a collapsed grandparent hides grandchildren too (transitively), not just direct children', () => {
        const tasks = [
            { id: 'A', title: '[bug] a', status: 'open' },
            { id: 'A.1', parent: 'A', title: '[impl] a1', status: 'open' },
            { id: 'A.1.1', parent: 'A.1', title: '[impl] a1.1', status: 'open' },
        ];
        const html = renderBeadsHtml(tasks, [], new Set(['A']));
        assert.ok(html.includes('>#A</td>'));
        assert.ok(!html.includes('A.1'), 'a deeply nested descendant must also be hidden when an ancestor is collapsed');
    });

    test('a collapsed node with a cycle in its (undiscovered) subtree still does not crash or double-render', () => {
        const tasks = [
            { id: 'A', parent: 'B', title: '[impl] a' },
            { id: 'B', parent: 'A', title: '[impl] b' },
        ];
        assert.doesNotThrow(() => renderBeadsHtml(tasks, [], new Set(['A'])));
    });

    test('backlog dependency-tree nodes are collapsible the same way as Sprint containment nodes', () => {
        const backlogTasks = [
            { id: 'BL-1', title: '[impl] the blocker', status: 'open' },
            { id: 'BL-2', title: '[impl] blocked by BL-1', status: 'open', dependencies: [{ depends_on_id: 'BL-1', type: 'blocks' }] },
        ];
        const collapsedHtml = renderBeadsHtml([], backlogTasks, new Set(['BL-1']));
        assert.ok(collapsedHtml.includes('>#BL-1</td>'));
        assert.ok(!collapsedHtml.includes('BL-2'), 'BL-2 must be hidden while its blocker BL-1 is collapsed');

        const expandedHtml = renderBeadsHtml([], backlogTasks);
        assert.ok(expandedHtml.includes(childPrefix + '#BL-2</td>'), 'BL-2 renders normally when nothing is collapsed');
    });

    // apra-fleet: a bead reachable ONLY via a parent-child dependency edge
    // (no `blocks` edge to anything) used to render as a flat root sibling
    // of its own epic in the Backlog section -- the tree builder nested
    // Backlog exclusively by `blocks` edges, never by `parent` containment,
    // even though Sprint's tree (built from `map`/`childrenOf`) always has.
    // Regression coverage for the dashboard-side half of the fix (the other
    // half stamps `parent` onto each row in backlog.mjs's buildBacklogTasks).
    test('a Backlog bead reachable only via a parent-child edge (no blocks edge) nests under its parent, not as a flat root', () => {
        const backlogTasks = [
            { id: 'EPIC-1', title: '[epic] the epic', status: 'open' },
            { id: 'CHILD-1', title: '[impl] a plain parent-child child', status: 'open', parent: 'EPIC-1', dependencies: [{ depends_on_id: 'EPIC-1', type: 'parent-child' }] },
        ];
        const html = renderBeadsHtml([], backlogTasks);
        assert.ok(html.includes(childPrefix + '#CHILD-1</td>'), 'CHILD-1 must nest under EPIC-1 via the parent-child edge, not render as a flat root');
    });

    test('a Backlog bead with BOTH a parent-child edge and a blocks edge nests by containment (parent wins over the blocks-edge fallback)', () => {
        const backlogTasks = [
            { id: 'EPIC-1', title: '[epic] the epic', status: 'open' },
            { id: 'OTHER-1', title: '[impl] an unrelated blocker', status: 'open' },
            {
                id: 'CHILD-1', title: '[impl] child of the epic, also blocked by OTHER-1', status: 'open', parent: 'EPIC-1',
                dependencies: [{ depends_on_id: 'EPIC-1', type: 'parent-child' }, { depends_on_id: 'OTHER-1', type: 'blocks' }],
            },
        ];
        const html = renderBeadsHtml([], backlogTasks);
        const epicIdx = html.indexOf('>#EPIC-1</td>');
        const childIdx = html.indexOf(childPrefix + '#CHILD-1</td>');
        assert.ok(epicIdx !== -1 && childIdx !== -1 && childIdx > epicIdx, 'CHILD-1 must nest directly under EPIC-1, not under OTHER-1');
        assert.ok(html.includes('blocked by: #OTHER-1'), 'the blocks edge is still surfaced as an inline annotation even though it did not decide nesting');
    });

    test('a Backlog bead with a parent OUTSIDE the dataset falls back to its blocks edge for nesting', () => {
        const backlogTasks = [
            { id: 'BLOCKER-1', title: '[impl] the blocker', status: 'open' },
            {
                id: 'CHILD-1', title: '[impl] child of an epic not in this dataset', status: 'open', parent: 'EPIC-NOT-HERE',
                dependencies: [{ depends_on_id: 'EPIC-NOT-HERE', type: 'parent-child' }, { depends_on_id: 'BLOCKER-1', type: 'blocks' }],
            },
        ];
        const html = renderBeadsHtml([], backlogTasks);
        assert.ok(html.includes(childPrefix + '#CHILD-1</td>'), 'CHILD-1 must still nest under its in-dataset blocker when its parent is out of scope');
    });

    test('the Sprint and Backlog section headers each carry their own toggle, collapsible via synthetic ids', () => {
        const html = renderBeadsHtml([{ id: 'S1', title: 'a sprint task', status: 'open' }], [{ id: 'B1', title: 'a backlog task', status: 'open' }]);
        assert.ok(html.includes('data-toggle-id="section:sprint"'));
        assert.ok(html.includes('data-toggle-id="section:backlog"'));
    });

    test('the Backlog header carries a distinct, stable CSS class and muted-band styling not present on the Sprint header (apra-fleet-eft.52.1.1)', () => {
        const html = renderBeadsHtml([{ id: 'S1', title: 'a sprint task', status: 'open' }], [{ id: 'B1', title: 'a backlog task', status: 'open' }]);
        const sprintHeaderRow = html.slice(html.lastIndexOf('<tr', html.indexOf('data-toggle-id="section:sprint"')), html.indexOf('data-toggle-id="section:sprint"') + 50);
        const backlogHeaderRow = html.slice(html.lastIndexOf('<tr', html.indexOf('data-toggle-id="section:backlog"')), html.indexOf('data-toggle-id="section:backlog"') + 50);
        assert.ok(backlogHeaderRow.includes('backlog-section'), 'Backlog header row must carry a distinct backlog-section class');
        assert.ok(backlogHeaderRow.includes('backlog-header'), 'Backlog header cell must carry a distinct backlog-header class');
        assert.ok(!sprintHeaderRow.includes('backlog-section'), 'Sprint header row must NOT carry the backlog-section class');
        assert.ok(!sprintHeaderRow.includes('backlog-header'), 'Sprint header cell must NOT carry the backlog-header class');
        // Differing style band: Backlog gets a background fill the Sprint header lacks.
        assert.ok(backlogHeaderRow.includes('background:'), 'Backlog header must have a distinct background/muted-band style');
        assert.ok(!sprintHeaderRow.includes('background:'), 'Sprint header must not share the Backlog muted-band background');
    });

    test('the Backlog header toggle still reflects collapsed/expanded state, on top of its distinct backlog class (apra-fleet-eft.52.1.1)', () => {
        const sprintTasks = [{ id: 'S1', title: 'a sprint task', status: 'open' }];
        const backlogTasks = [{ id: 'B1', title: 'a backlog task', status: 'open' }];

        const expandedHtml = renderBeadsHtml(sprintTasks, backlogTasks);
        const expandedBacklogRow = expandedHtml.slice(
            expandedHtml.lastIndexOf('<tr', expandedHtml.indexOf('data-toggle-id="section:backlog"')),
            expandedHtml.indexOf('data-toggle-id="section:backlog"') + 200
        );
        assert.ok(expandedBacklogRow.includes('backlog-header'), 'expanded Backlog header row must still carry its distinct class');
        assert.ok(expandedBacklogRow.includes('[-]'), 'expanded Backlog header toggle must show [-]');
        assert.ok(!expandedBacklogRow.includes('[+]'), 'expanded Backlog header toggle must not show [+]');

        const collapsedHtml = renderBeadsHtml(sprintTasks, backlogTasks, new Set(['section:backlog']));
        const collapsedBacklogRow = collapsedHtml.slice(
            collapsedHtml.lastIndexOf('<tr', collapsedHtml.indexOf('data-toggle-id="section:backlog"')),
            collapsedHtml.indexOf('data-toggle-id="section:backlog"') + 200
        );
        assert.ok(collapsedBacklogRow.includes('backlog-header'), 'collapsed Backlog header row must still carry its distinct class');
        assert.ok(collapsedBacklogRow.includes('[+]'), 'collapsed Backlog header toggle must show [+]');
        assert.ok(!collapsedBacklogRow.includes('[-]'), 'collapsed Backlog header toggle must not show [-]');
    });

    test('collapsing the Sprint section hides every sprint row, but leaves Backlog untouched', () => {
        const sprintTasks = [{ id: 'S1', title: 'a sprint task', status: 'open' }];
        const backlogTasks = [{ id: 'B1', title: 'a backlog task', status: 'open' }];
        const html = renderBeadsHtml(sprintTasks, backlogTasks, new Set(['section:sprint']));
        assert.ok(!html.includes('#S1'), 'a collapsed Sprint section must hide its rows entirely');
        assert.ok(html.includes('#B1'), 'the Backlog section must be unaffected by collapsing Sprint');
        // The section header itself (with its [+] toggle) still renders.
        assert.ok(html.includes('data-toggle-id="section:sprint"'));
    });

    test('collapsing the Backlog section hides every backlog row, but leaves Sprint untouched', () => {
        const sprintTasks = [{ id: 'S1', title: 'a sprint task', status: 'open' }];
        const backlogTasks = [{ id: 'B1', title: 'a backlog task', status: 'open' }];
        const html = renderBeadsHtml(sprintTasks, backlogTasks, new Set(['section:backlog']));
        assert.ok(html.includes('#S1'));
        assert.ok(!html.includes('#B1'));
    });

    test('renderBeadsHtml() with no third argument behaves exactly as before (nothing collapsed by default)', () => {
        const tasks = [
            { id: '41', title: '[bug] parent epic', status: 'open' },
            { id: '41.1', parent: '41', title: '[impl] child one', status: 'closed' },
        ];
        assert.doesNotThrow(() => renderBeadsHtml(tasks));
        const html = renderBeadsHtml(tasks);
        assert.ok(html.includes(childPrefix + '#41.1</td>'));
    });
});

describe('apra-fleet-eft.27.2: renderBeadsHtml on-demand description markup', () => {
    test('a lean (summary-only) bead renders an expandable row carrying its id/updatedAt for the client-side fetch, marked NOT loaded', () => {
        const html = renderBeadsHtml([{ id: 'bd-1', title: 'A task', status: 'open', summary: 'short preview...', updated_at: '2026-07-20T00:00:00Z', dependencies: [] }]);
        assert.ok(html.includes('class="bead-desc"'));
        assert.ok(html.includes('data-bead-id="bd-1"'));
        assert.ok(html.includes('data-updated-at="2026-07-20T00:00:00Z"'));
        assert.ok(html.includes('data-loaded="false"'), 'a summary-only bead has no full text yet -- must be marked not-loaded so the client fetches it on expand');
        assert.ok(html.includes('short preview...'));
    });

    test('a bead with the full description inline (e.g. a History-view snapshot) is marked already-loaded -- no fetch needed', () => {
        const html = renderBeadsHtml([{ id: 'bd-2', title: 'A task', status: 'open', description: 'the full text', updated_at: '2026-07-20T00:00:00Z', dependencies: [] }]);
        assert.ok(html.includes('data-loaded="true"'));
        assert.ok(html.includes('the full text'));
    });

    test('a bead with neither description nor summary renders its plain title with no expandable markup', () => {
        const html = renderBeadsHtml([{ id: 'bd-3', title: 'Bare task', status: 'open', dependencies: [] }]);
        assert.ok(!html.includes('bead-desc'));
        assert.ok(html.includes('Bare task'));
    });
});

describe('apra-fleet-eft.27.2: browser-side fetch + localStorage cache (embedded script)', () => {
    function createMockLocalStorage() {
        const store = new Map();
        return {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => { store.set(k, String(v)); },
            removeItem: (k) => store.delete(k),
            clear: () => store.clear()
        };
    }

    // Extracts the cache/fetch helpers embedded in beadsExtension.js (the
    // same source that runs in the browser) exactly as the real page would
    // load them, minus the two top-level addEventListener() wireups (which
    // would otherwise register real listeners against the test's mocked
    // `document`) -- mirrors the extraction pattern the existing
    // "embeds a working renderBeadsHtml()" test above already uses.
    function extractHelpers() {
        const src = beadsExtension.js.replace(/document\.addEventListener[\s\S]*$/, '');
        const factory = new Function(`
            ${src}
            return { loadBeadDescription: loadBeadDescription, readBeadDescCache: readBeadDescCache, writeBeadDescCache: writeBeadDescCache };
        `);
        return factory();
    }

    function makeDetailsEl(id, updatedAt, initialText) {
        const bodyEl = { textContent: initialText, dataset: { loaded: 'false' } };
        return {
            dataset: { beadId: id, updatedAt: updatedAt },
            querySelector: (sel) => (sel === '.bead-desc-body' ? bodyEl : null),
            _bodyEl: bodyEl
        };
    }

    // Globals are saved/restored per-test explicitly (try/finally inside
    // each test body below) rather than via a file-wide beforeEach/afterEach,
    // since only this describe block touches globalThis.localStorage/fetch.
    let originalLocalStorage, originalFetch;

    test('cache miss: fetches from GET /extensions/beads/detail/:id exactly once, then caches the result', async () => {
        originalLocalStorage = globalThis.localStorage;
        originalFetch = globalThis.fetch;
        try {
            globalThis.localStorage = createMockLocalStorage();
            let fetchCalls = 0;
            globalThis.fetch = async (url) => {
                fetchCalls++;
                assert.ok(url.includes('/extensions/beads/detail/bd-1'));
                return { ok: true, json: async () => ({ id: 'bd-1', text: 'the full text', updatedAt: 'v1' }) };
            };

            const { loadBeadDescription } = extractHelpers();
            const details = makeDetailsEl('bd-1', 'v1', 'short preview');
            await loadBeadDescription(details);

            assert.equal(fetchCalls, 1);
            assert.equal(details._bodyEl.textContent, 'the full text');
            assert.equal(details._bodyEl.dataset.loaded, 'true');
        } finally {
            globalThis.localStorage = originalLocalStorage;
            globalThis.fetch = originalFetch;
        }
    });

    test('cache hit: a second expand of an unchanged bead (same updatedAt) causes NO network request', async () => {
        originalLocalStorage = globalThis.localStorage;
        originalFetch = globalThis.fetch;
        try {
            const storage = createMockLocalStorage();
            globalThis.localStorage = storage;
            let fetchCalls = 0;
            globalThis.fetch = async () => {
                fetchCalls++;
                return { ok: true, json: async () => ({ id: 'bd-1', text: 'the full text', updatedAt: 'v1' }) };
            };

            const { loadBeadDescription } = extractHelpers();

            // First expand: populates the cache via a real fetch.
            await loadBeadDescription(makeDetailsEl('bd-1', 'v1', 'preview'));
            assert.equal(fetchCalls, 1);

            // Second expand of a FRESH element (simulating the full-innerHTML
            // rebuild a poll tick performs) with the SAME updatedAt: must be
            // served entirely from localStorage, no additional fetch.
            const second = makeDetailsEl('bd-1', 'v1', 'preview');
            await loadBeadDescription(second);
            assert.equal(fetchCalls, 1, 'a cache hit must not trigger another network request');
            assert.equal(second._bodyEl.textContent, 'the full text');
        } finally {
            globalThis.localStorage = originalLocalStorage;
            globalThis.fetch = originalFetch;
        }
    });

    test('a changed updatedAt invalidates the cache and triggers exactly one refetch', async () => {
        originalLocalStorage = globalThis.localStorage;
        originalFetch = globalThis.fetch;
        try {
            globalThis.localStorage = createMockLocalStorage();
            let fetchCalls = 0;
            globalThis.fetch = async () => {
                fetchCalls++;
                return { ok: true, json: async () => ({ id: 'bd-1', text: 'v' + fetchCalls, updatedAt: 'irrelevant' }) };
            };

            const { loadBeadDescription } = extractHelpers();

            await loadBeadDescription(makeDetailsEl('bd-1', 'v1', 'preview'));
            assert.equal(fetchCalls, 1);

            // Bead changed server-side -- next poll reports a new updatedAt.
            const changed = makeDetailsEl('bd-1', 'v2', 'preview');
            await loadBeadDescription(changed);
            assert.equal(fetchCalls, 2, 'a changed updatedAt must trigger exactly one refetch, not a stale cache hit');
        } finally {
            globalThis.localStorage = originalLocalStorage;
            globalThis.fetch = originalFetch;
        }
    });

    test('a fetch failure (network error) is handled gracefully, never throwing', async () => {
        originalLocalStorage = globalThis.localStorage;
        originalFetch = globalThis.fetch;
        try {
            globalThis.localStorage = createMockLocalStorage();
            globalThis.fetch = async () => { throw new Error('network down'); };

            const { loadBeadDescription } = extractHelpers();
            const details = makeDetailsEl('bd-1', 'v1', 'preview');
            await assert.doesNotReject(loadBeadDescription(details));
            assert.equal(details._bodyEl.textContent, '(failed to load description)');
        } finally {
            globalThis.localStorage = originalLocalStorage;
            globalThis.fetch = originalFetch;
        }
    });

    test('a 404 response is handled gracefully, never throwing', async () => {
        originalLocalStorage = globalThis.localStorage;
        originalFetch = globalThis.fetch;
        try {
            globalThis.localStorage = createMockLocalStorage();
            globalThis.fetch = async () => ({ ok: false });

            const { loadBeadDescription } = extractHelpers();
            const details = makeDetailsEl('bd-1', 'v1', 'preview');
            await assert.doesNotReject(loadBeadDescription(details));
            assert.equal(details._bodyEl.textContent, '(description unavailable)');
        } finally {
            globalThis.localStorage = originalLocalStorage;
            globalThis.fetch = originalFetch;
        }
    });
});

// apra-fleet-eft.37.3: renderResultExtrasHtml() is the se-owned piece that
// moved OUT of core (which used to mint state.verdict/state.prUrl by name)
// -- it reads the SAME generic state.result object the core Result strip
// reads, but knows the two auto-sprint-specific keys worth coloring/
// link-ifying. Pure string-builder, same testing pattern as renderBeadsHtml.
describe('renderResultExtrasHtml: auto-sprint verdict badge + PR link', () => {
    test('returns an empty string when result has neither verdict nor prUrl', () => {
        assert.strictEqual(renderResultExtrasHtml(null), '');
        assert.strictEqual(renderResultExtrasHtml(undefined), '');
        assert.strictEqual(renderResultExtrasHtml({}), '');
        assert.strictEqual(renderResultExtrasHtml({ notes: 'no verdict here' }), '');
    });

    test('a PASS-family verdict renders in the success color', () => {
        for (const verdict of ['PASS', 'MERGED', 'APPROVED']) {
            const html = renderResultExtrasHtml({ verdict });
            assert.ok(html.includes('var(--success)'), `${verdict} must render success-colored`);
            assert.ok(html.includes(verdict));
        }
    });

    test('a FAIL-family verdict renders in the danger color', () => {
        for (const verdict of ['FAIL', 'CHANGES_NEEDED', 'ABORTED']) {
            const html = renderResultExtrasHtml({ verdict });
            assert.ok(html.includes('var(--danger)'), `${verdict} must render danger-colored`);
        }
    });

    test('an unrecognized verdict still renders (neutral grey), never dropped', () => {
        const html = renderResultExtrasHtml({ verdict: 'SOMETHING_NEW' });
        assert.ok(html.includes('SOMETHING_NEW'));
        assert.ok(html.includes('#a1a1aa'));
    });

    test('a malicious verdict/prUrl is escaped, never a live tag/attribute break-out', () => {
        const html = renderResultExtrasHtml({
            verdict: '<script>alert(1)</script>',
            prUrl: '"><script>alert(2)</script>',
        });
        assert.ok(!/<script>alert/i.test(html));
        assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    });

    test('prUrl renders as a safe, new-tab link when present', () => {
        const html = renderResultExtrasHtml({ verdict: 'PASS', prUrl: 'https://github.com/example/repo/pull/1' });
        assert.ok(html.includes('href="https://github.com/example/repo/pull/1"'));
        assert.ok(html.includes('target="_blank"'));
        assert.ok(html.includes('rel="noopener noreferrer"'));
    });

    test('a null/absent prUrl renders no link at all, but the verdict badge still shows', () => {
        const html = renderResultExtrasHtml({ verdict: 'PASS', prUrl: null });
        assert.ok(!html.includes('<a '));
        assert.ok(html.includes('PASS'));
    });
});

// apra-fleet-4p5: exercises the actual browser-side click-delegation wiring
// (collapsedBeadIds Set + renderBeadsPanel()) embedded in beadsExtension.js,
// using a minimal mock `document` that records addEventListener callbacks
// and getElementById containers -- mirrors the existing
// "browser-side fetch + localStorage cache" describe block's approach of
// running the real embedded source, not a hand-reimplementation of it.
describe('beadsExtension.js: embedded browser-side collapse/expand click handling (apra-fleet-4p5)', () => {
    function createMockDocument() {
        const listeners = {};
        const containers = {};
        const doc = {
            addEventListener(type, handler) {
                (listeners[type] = listeners[type] || []).push(handler);
            },
            getElementById(id) {
                if (!containers[id]) containers[id] = { innerHTML: '' };
                return containers[id];
            }
        };
        return { doc, listeners, containers };
    }

    function makeToggleClickEvent(toggleId) {
        const toggleEl = { dataset: { toggleId } };
        return { target: { closest: (sel) => (sel === '.tree-toggle' ? toggleEl : null) } };
    }

    test('clicking a node\'s .tree-toggle re-renders the panel with that node collapsed, purely client-side (no new server payload)', () => {
        const { doc, listeners, containers } = createMockDocument();
        new Function('document', beadsExtension.js)(doc);

        const stateHandlers = listeners['workflow:state:beads'];
        assert.ok(stateHandlers && stateHandlers.length === 1);
        stateHandlers[0]({
            detail: {
                sprintTasks: [
                    { id: '41', title: 'parent', status: 'open' },
                    { id: '41.1', parent: '41', title: 'child', status: 'open' },
                ],
                backlogTasks: []
            }
        });

        const container = containers['extension-beads'];
        assert.ok(container.innerHTML.includes('41.1'), 'child renders before any collapse');

        const clickHandlers = listeners['click'];
        assert.ok(clickHandlers && clickHandlers.length === 1);
        clickHandlers[0](makeToggleClickEvent('41'));

        assert.ok(!container.innerHTML.includes('41.1'), 'child must be hidden after collapsing its parent, with no server round-trip');
        assert.ok(container.innerHTML.includes('[+]'), 'the toggle now shows the collapsed indicator');

        // Clicking the same toggle again expands it back.
        clickHandlers[0](makeToggleClickEvent('41'));
        assert.ok(container.innerHTML.includes('41.1'), 'child reappears after expanding again');
    });

    test('collapse state survives a fresh state-update re-render (a later poll tick), unlike per-row DOM state', () => {
        const { doc, listeners, containers } = createMockDocument();
        new Function('document', beadsExtension.js)(doc);

        const stateHandlers = listeners['workflow:state:beads'];
        const clickHandlers = listeners['click'];
        const push = (sprintTasks) => stateHandlers[0]({ detail: { sprintTasks, backlogTasks: [] } });

        push([
            { id: 'P', title: 'parent', status: 'open' },
            { id: 'C', parent: 'P', title: 'child', status: 'open' },
        ]);
        clickHandlers[0](makeToggleClickEvent('P'));
        assert.ok(!containers['extension-beads'].innerHTML.includes('>#C<'));

        // A later poll delivers a fresh (structurally identical) payload --
        // the collapse choice must still be honored, since it lives in the
        // script's own closure, not in any DOM node the rebuild would wipe.
        push([
            { id: 'P', title: 'parent', status: 'open' },
            { id: 'C', parent: 'P', title: 'child', status: 'open' },
        ]);
        assert.ok(!containers['extension-beads'].innerHTML.includes('>#C<'), 'collapse must persist across the next poll\'s full innerHTML rebuild');
    });

    test('a click that does not land on a .tree-toggle is a no-op (no crash, no re-render)', () => {
        const { doc, listeners, containers } = createMockDocument();
        new Function('document', beadsExtension.js)(doc);

        listeners['workflow:state:beads'][0]({ detail: { sprintTasks: [{ id: 'X', title: 'x', status: 'open' }], backlogTasks: [] } });
        const before = containers['extension-beads'].innerHTML;

        assert.doesNotThrow(() => listeners['click'][0]({ target: { closest: () => null } }));
        assert.strictEqual(containers['extension-beads'].innerHTML, before);
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
