import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
    createBacklog,
    buildBacklogTree,
    buildChildIndex,
    expandScopeInMemory,
    renderBacklogTreeHtml,
    renderBacklogPanelHtml,
    formatPartialClaim,
    parentIdOf,
    normalizeBead,
    applyBeadFilters,
} from '../src/supervisor/backlog.mjs';
import { createScopeGuard, expandScope } from '../src/supervisor/scope-overlap.mjs';
import { createDashboard, renderIndexPageHtml } from '../src/supervisor/dashboard.mjs';
import { WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';
import { renderBeadsHtml } from '../fleet-sprint/viewer-extensions.mjs';

// apra-fleet-eft.6.2 -- Backlog-last tree: full tracker MINUS the union of every
// active sprint's live-expanded scope, rendered as a TREE with per-node claim
// status. Claimed beads never appear in the Backlog and never twice on the page;
// a partially-claimed epic stays in the Backlog with a partial-claim annotation
// naming the owning sprint and the claimed/free counts; the server's
// exact-overlap launch policy is unchanged (UI steering does not weaken it).

/** Minimal in-memory ledger exposing only list(). */
function fakeLedger(reservations) {
    return { list: () => reservations.map((r) => ({ ...r })) };
}

/**
 * A small tracker: epic E with children c1..c5, plus a standalone free bead f0.
 * Parent-child edges are expressed in the raw `bd list --json` dependency shape
 * so parentIdOf() is exercised end-to-end.
 */
function trackerBead(id, title, parentId, issueType = 'task') {
    const deps = parentId
        ? [{ issue_id: id, depends_on_id: parentId, type: 'parent-child' }]
        : [];
    return { id, title, issue_type: issueType, status: 'open', dependencies: deps };
}

describe('backlog -- parentIdOf / normalizeBead', () => {
    test('parentIdOf reads the parent-child grouping edge (child -> parent), null at a root', () => {
        assert.equal(parentIdOf(trackerBead('c1', 'C1', 'E')), 'E');
        assert.equal(parentIdOf(trackerBead('E', 'Epic', null)), null);
        // A blocks edge is NOT a parent edge.
        assert.equal(parentIdOf({ id: 'x', dependencies: [{ issue_id: 'x', depends_on_id: 'y', type: 'blocks' }] }), null);
    });

    test('normalizeBead maps raw + already-normalized shapes to the minimal node shape', () => {
        const raw = normalizeBead(trackerBead('c1', 'C1', 'E', 'task'));
        assert.deepEqual(raw, { id: 'c1', title: 'C1', issueType: 'task', status: 'open', parentId: 'E', priority: null });
        const pre = normalizeBead({ id: 'z', title: 'Z', issueType: 'epic', status: 'closed', parentId: 'root' });
        assert.equal(pre.parentId, 'root');
        assert.equal(pre.issueType, 'epic');
    });

    // apra-fleet-x8r.7: normalizeBead()'s returned key set is exactly what
    // downstream consumers (computeSprintProgress's priority filter, the
    // dashboard/backlog tree renderers) can rely on. Pin it so widening or
    // narrowing that shape forces a deliberate test update here, rather than
    // silently changing what a fixture can/can't assert on.
    test('normalizeBead returns exactly the pinned key set', () => {
        const keys = Object.keys(normalizeBead(trackerBead('c1', 'C1', 'E', 'task'))).sort();
        assert.deepEqual(keys, ['id', 'issueType', 'parentId', 'priority', 'status', 'title']);
    });

    test('normalizeBead preserves a numeric priority, and normalizes a missing/non-numeric one to null (never a numeric default)', () => {
        const withPriority = normalizeBead({ ...trackerBead('c1', 'C1', 'E'), priority: 2 });
        assert.equal(withPriority.priority, 2);
        const withoutPriority = normalizeBead(trackerBead('c2', 'C2', 'E'));
        assert.equal(withoutPriority.priority, null);
        const nonNumeric = normalizeBead({ ...trackerBead('c3', 'C3', 'E'), priority: 'high' });
        assert.equal(nonNumeric.priority, null);
    });
});

describe('backlog -- buildBacklogTree', () => {
    const beads = [
        normalizeBead(trackerBead('E', 'Epic', null, 'epic')),
        normalizeBead(trackerBead('c1', 'C1', 'E')),
        normalizeBead(trackerBead('c2', 'C2', 'E')),
        normalizeBead(trackerBead('c3', 'C3', 'E')),
        normalizeBead(trackerBead('c4', 'C4', 'E')),
        normalizeBead(trackerBead('c5', 'C5', 'E')),
        normalizeBead(trackerBead('f0', 'Free root', null)),
    ];

    test('nothing claimed: whole tracker renders as a tree (epic with 5 children + free root)', () => {
        const tree = buildBacklogTree(beads, new Map());
        assert.deepEqual(tree.map((n) => n.id).sort(), ['E', 'f0']);
        const epic = tree.find((n) => n.id === 'E');
        assert.equal(epic.children.length, 5);
        assert.equal(epic.partialClaim, null);
    });

    test('a fully-claimed subtree (epic root claimed) never appears in the Backlog', () => {
        // Sprint claims E and thus its whole subtree c1..c5.
        const claimed = new Map([
            ['E', 's1'], ['c1', 's1'], ['c2', 's1'], ['c3', 's1'], ['c4', 's1'], ['c5', 's1'],
        ]);
        const tree = buildBacklogTree(beads, claimed);
        assert.deepEqual(tree.map((n) => n.id), ['f0']);
    });

    test('partial claim: free epic keeps ONLY its free children and carries an annotation', () => {
        // Sprint s-abc claims c1 and c2 (rooted at those children, not the epic).
        const claimed = new Map([['c1', 'sprint-abc123'], ['c2', 'sprint-abc123']]);
        const tree = buildBacklogTree(beads, claimed);
        const epic = tree.find((n) => n.id === 'E');
        assert.ok(epic, 'partially-claimed epic must stay visible in the Backlog');
        // Claimed children are gone; only the 3 free children remain.
        assert.deepEqual(epic.children.map((c) => c.id).sort(), ['c3', 'c4', 'c5']);
        assert.ok(epic.partialClaim, 'partial-claim annotation expected');
        assert.equal(epic.partialClaim.totalCount, 5);
        assert.equal(epic.partialClaim.claimedCount, 2);
        assert.equal(epic.partialClaim.freeCount, 3);
        assert.deepEqual(epic.partialClaim.sprints, [{ sprintId: 'sprint-abc123', count: 2 }]);
    });

    test('no bead appears twice: claimed ids are absent everywhere in the returned forest', () => {
        const claimed = new Map([['c1', 's1'], ['c2', 's1']]);
        const tree = buildBacklogTree(beads, claimed);
        const seen = [];
        const walk = (n) => { seen.push(n.id); (n.children ?? []).forEach(walk); };
        tree.forEach(walk);
        assert.ok(!seen.includes('c1'));
        assert.ok(!seen.includes('c2'));
        // Every remaining id is unique.
        assert.equal(seen.length, new Set(seen).size);
    });

    test('a free node whose parent is claimed is re-rooted (never silently dropped)', () => {
        // Inconsistent-but-defensive: parent claimed, child free.
        const claimed = new Map([['E', 's1']]);
        const tree = buildBacklogTree(beads, claimed);
        // c1..c5 (free) surface as roots since their parent E is claimed; f0 too.
        assert.deepEqual(tree.map((n) => n.id).sort(), ['c1', 'c2', 'c3', 'c4', 'c5', 'f0']);
    });
});

describe('backlog -- expandScopeInMemory equivalence with expandScope() (apra-fleet-c4s)', () => {
    // The same tracker shape supervisor-scope-overlap.test.mjs-style fixtures
    // use: epic E -> c1..c5, one of which (c2) has its own grandchildren.
    const beads = [
        normalizeBead(trackerBead('E', 'Epic', null, 'epic')),
        normalizeBead(trackerBead('c1', 'C1', 'E')),
        normalizeBead(trackerBead('c2', 'C2', 'E')),
        normalizeBead(trackerBead('c3', 'C3', 'E')),
        normalizeBead(trackerBead('c4', 'C4', 'E')),
        normalizeBead(trackerBead('c5', 'C5', 'E')),
        normalizeBead(trackerBead('g1', 'G1', 'c2')),
        normalizeBead(trackerBead('g2', 'G2', 'c2')),
        normalizeBead(trackerBead('f0', 'Free root', null)),
    ];
    const childIndex = buildChildIndex(beads);

    /** Subprocess-shaped listChildren stub backed by the SAME fixture, for the old expandScope(). */
    function listChildrenFromFixture(parentId) {
        return Promise.resolve((childIndex.get(parentId) ?? []).slice());
    }

    test('same roots + same beads list -> IDENTICAL claimed-id set as the subprocess-based expandScope()', async () => {
        for (const roots of [['E'], ['c2'], ['c1', 'c3'], ['f0'], ['c2', 'c4'], ['does-not-exist']]) {
            const oldResult = await expandScope(roots, listChildrenFromFixture);
            const newResult = expandScopeInMemory(roots, childIndex);
            assert.deepEqual([...newResult].sort(), [...oldResult].sort(),
                `expandScopeInMemory(${JSON.stringify(roots)}) must match expandScope() exactly`);
        }
    });

    test('expandScopeInMemory is a synchronous pure Set/Map traversal (no subprocess/IO)', () => {
        // Calling it returns a plain Set directly, not a Promise -- proving no
        // async subprocess spawn (unlike expandScope(), which is async and
        // awaits one `bd list --parent` call per discovered node).
        const scope = expandScopeInMemory(['c2'], childIndex);
        assert.ok(scope instanceof Set, 'must return a Set synchronously, not a Promise');
        assert.deepEqual([...scope].sort(), ['c2', 'g1', 'g2']);
    });
});

describe('backlog -- createBacklog production default computes claimed scope in-memory (apra-fleet-c4s)', () => {
    const allBeads = [
        trackerBead('E', 'Epic', null, 'epic'),
        trackerBead('c1', 'C1', 'E'),
        trackerBead('c2', 'C2', 'E'),
        trackerBead('c3', 'C3', 'E'),
        trackerBead('f0', 'Free', null),
    ];

    test('buildClaimedBy() with no expandScope override expands live subtrees off listAllBeads(), zero extra bd calls', async () => {
        let listAllBeadsCalls = 0;
        const backlog = createBacklog({
            ledger: fakeLedger([{ sprintId: 's1', issueRoots: ['E'] }]),
            listAllBeads: () => { listAllBeadsCalls += 1; return allBeads; },
            // Deliberately NOT injecting `expandScope` -- exercises the
            // production default (in-memory) path.
        });
        const claimedBy = await backlog.buildClaimedBy();
        // E's live subtree (via the same allBeads fixture) is E,c1,c2,c3.
        assert.deepEqual([...claimedBy.keys()].sort(), ['E', 'c1', 'c2', 'c3']);
        assert.equal(listAllBeadsCalls, 1, 'buildClaimedBy() must fetch beads at most once when not given a pre-fetched list');
    });

    test('buildTree() and buildBacklogTasks() each fetch listAllBeads() exactly ONCE per call (no duplicate bulk fetch)', async () => {
        let listAllBeadsCalls = 0;
        const backlog = createBacklog({
            ledger: fakeLedger([{ sprintId: 's1', issueRoots: ['c1'] }]),
            listAllBeads: () => { listAllBeadsCalls += 1; return allBeads; },
        });
        await backlog.buildTree();
        assert.equal(listAllBeadsCalls, 1, 'buildTree() must call listAllBeads() exactly once');

        listAllBeadsCalls = 0;
        await backlog.buildBacklogTasks();
        assert.equal(listAllBeadsCalls, 1, 'buildBacklogTasks() must call listAllBeads() exactly once');
    });

    // apra-fleet: buildBacklogTasks()'s returned rows used to carry no
    // `parent` field at all (only the raw `dependencies` array), so
    // renderBeadsHtml()'s Backlog tree had nothing to nest a parent-child-only
    // bead by and it rendered as a flat root alongside its own epic. Pins the
    // `parent: parentIdOf(b)` stamp added to close that gap.
    test('buildBacklogTasks() stamps `parent` (via parentIdOf) onto every free row', async () => {
        const backlog = createBacklog({
            ledger: fakeLedger([]),
            listAllBeads: () => allBeads,
        });
        const { tasks } = await backlog.buildBacklogTasks();
        const c1 = tasks.find((t) => t.id === 'c1');
        const epic = tasks.find((t) => t.id === 'E');
        assert.ok(c1, 'expected c1 to be present in the free backlog set');
        assert.equal(c1.parent, 'E', "c1's stamped parent must match its parent-child dependency edge");
        assert.equal(epic.parent, null, 'a root bead with no parent-child edge stamps parent: null, not undefined');
    });
});

// apra-fleet-qoxd.3 (verifying apra-fleet-qoxd.1): applyBeadFilters()'s
// created_at sort -- ascending/descending ordering off distinct timestamps,
// missing/invalid values always sorting last regardless of direction without
// throwing, and omitting `sort` leaving row order (and the { tasks, total,
// filterOptions } contract) exactly as the type/status/priority/model/q
// narrowing already produced it.
describe('backlog -- applyBeadFilters created_at sort (apra-fleet-qoxd.1)', () => {
    const rows = [
        { id: 'r1', title: 'Row one', issue_type: 'task', status: 'open', created_at: '2026-01-02T00:00:00Z' },
        { id: 'r2', title: 'Row two', issue_type: 'task', status: 'open', created_at: '2026-01-05T00:00:00Z' },
        { id: 'r3', title: 'Row three', issue_type: 'task', status: 'open', created_at: '2026-01-01T00:00:00Z' },
    ];

    test('sort: created_at, dir: asc returns rows in ascending created_at order', () => {
        const { tasks } = applyBeadFilters(rows, { sort: 'created_at', dir: 'asc' });
        assert.deepEqual(tasks.map((r) => r.id), ['r3', 'r1', 'r2']);
    });

    test('sort: created_at, dir: desc returns rows in descending created_at order', () => {
        const { tasks } = applyBeadFilters(rows, { sort: 'created_at', dir: 'desc' });
        assert.deepEqual(tasks.map((r) => r.id), ['r2', 'r1', 'r3']);
    });

    test('rows with missing/invalid created_at sort last for BOTH directions, and no call throws', () => {
        const mixed = [
            { id: 'valid1', title: 'Valid one', issue_type: 'task', status: 'open', created_at: '2026-01-02T00:00:00Z' },
            { id: 'missing', title: 'Missing created_at', issue_type: 'task', status: 'open' },
            { id: 'valid2', title: 'Valid two', issue_type: 'task', status: 'open', created_at: '2026-01-01T00:00:00Z' },
            { id: 'invalid', title: 'Invalid created_at', issue_type: 'task', status: 'open', created_at: 'not-a-date' },
        ];

        let asc;
        assert.doesNotThrow(() => {
            asc = applyBeadFilters(mixed, { sort: 'created_at', dir: 'asc' }).tasks;
        });
        assert.deepEqual(asc.map((r) => r.id).slice(-2).sort(), ['invalid', 'missing']);
        assert.deepEqual(asc.map((r) => r.id).slice(0, 2), ['valid2', 'valid1']);

        let desc;
        assert.doesNotThrow(() => {
            desc = applyBeadFilters(mixed, { sort: 'created_at', dir: 'desc' }).tasks;
        });
        assert.deepEqual(desc.map((r) => r.id).slice(-2).sort(), ['invalid', 'missing']);
        assert.deepEqual(desc.map((r) => r.id).slice(0, 2), ['valid1', 'valid2']);
    });

    test('omitting sort preserves prior behaviour: order unchanged, and the { tasks, total, filterOptions } contract is intact', () => {
        const result = applyBeadFilters(rows, { type: 'task' });
        assert.deepEqual(result.tasks.map((r) => r.id), ['r1', 'r2', 'r3']);
        assert.equal(result.total, rows.length);
        assert.ok(result.filterOptions);
        assert.deepEqual(Object.keys(result).sort(), ['filterOptions', 'tasks', 'total']);

        // No filters object at all behaves the same way.
        const noFilters = applyBeadFilters(rows);
        assert.deepEqual(noFilters.tasks.map((r) => r.id), ['r1', 'r2', 'r3']);
    });
});

describe('backlog -- formatPartialClaim', () => {
    test('matches the "N of M children claimed by <sprint>; K free" shape', () => {
        const text = formatPartialClaim({
            totalCount: 5, claimedCount: 2, freeCount: 3,
            sprints: [{ sprintId: 'sprint-abc123', count: 2 }],
        });
        assert.equal(text, '2 of 5 children claimed by sprint-abc123; 3 free');
    });

    test('names multiple owning sprints with per-sprint counts', () => {
        const text = formatPartialClaim({
            totalCount: 4, claimedCount: 3, freeCount: 1,
            sprints: [{ sprintId: 'sA', count: 2 }, { sprintId: 'sB', count: 1 }],
        });
        assert.ok(text.includes('sA (2)'));
        assert.ok(text.includes('sB (1)'));
        assert.ok(text.endsWith('1 free'));
    });
});

describe('backlog -- renderBacklogTreeHtml', () => {
    test('renders nested <ul>/<li> hierarchy, not a flat list', () => {
        const tree = buildBacklogTree([
            normalizeBead(trackerBead('E', 'Epic', null, 'epic')),
            normalizeBead(trackerBead('c1', 'Child one', 'E')),
        ], new Map());
        const html = renderBacklogTreeHtml(tree);
        // A nested <ul> inside the epic's <li> proves hierarchy (not flat).
        assert.ok(html.includes('data-bead-id="E"'));
        assert.ok(html.includes('data-bead-id="c1"'));
        const epicIdx = html.indexOf('data-bead-id="E"');
        const nestedUl = html.indexOf('<ul', epicIdx + 1);
        const childIdx = html.indexOf('data-bead-id="c1"');
        assert.ok(nestedUl !== -1 && nestedUl < childIdx, 'child must be inside a nested <ul> under the epic');
    });

    test('partial-claim annotation is rendered on the free epic', () => {
        const tree = buildBacklogTree([
            normalizeBead(trackerBead('E', 'Epic', null, 'epic')),
            normalizeBead(trackerBead('c1', 'C1', 'E')),
            normalizeBead(trackerBead('c2', 'C2', 'E')),
            normalizeBead(trackerBead('c3', 'C3', 'E')),
        ], new Map([['c1', 'sprint-abc123']]));
        const html = renderBacklogTreeHtml(tree);
        assert.ok(html.includes('data-partial-claim="true"'));
        assert.ok(html.includes('1 of 3 children claimed by sprint-abc123; 2 free'));
    });

    test('empty forest renders an explicit empty state, never a blank/throw', () => {
        assert.doesNotThrow(() => renderBacklogTreeHtml([]));
        assert.doesNotThrow(() => renderBacklogTreeHtml(undefined));
        assert.ok(renderBacklogTreeHtml([]).toLowerCase().includes('no unclaimed work'));
    });

    test('untrusted id/title fields are HTML-escaped', () => {
        const tree = buildBacklogTree([
            normalizeBead({ id: '<script>x</script>', title: '<img src=x>', issue_type: 'task', status: 'open', dependencies: [] }),
        ], new Map());
        const html = renderBacklogTreeHtml(tree);
        assert.ok(!html.includes('<script>x</script>'));
        assert.ok(!html.includes('<img src=x>'));
    });
});

// apra-fleet-eft.89.3 (verifying apra-fleet-eft.89.1/89.2): renderBacklogPanelHtml()
// always calls the shared renderBeadsHtml([], tasks, ...) with an EMPTY
// sprintTasks -- so, per 89.1's "only render a section that actually has
// content" fix, the panel must show a Backlog section but never an
// always-empty Sprint sibling section/placeholder. This is the supervisor-
// side half of eft.89 (fleet-sprint's own empty-Backlog-drop side is covered
// in viewer-extensions.test.mjs's "Sprint / Backlog two-section layout"
// describe block).
describe('backlog -- renderBacklogPanelHtml: Sprint section is gone, Backlog + filter header remain (apra-fleet-eft.89.3)', () => {
    const tasks = [
        { id: 'B1', title: '[bug] a backlog item', status: 'open', issue_type: 'bug', priority: 2 },
        { id: 'B2', title: '[impl] another backlog item', status: 'open', issue_type: 'task', priority: 1 },
    ];
    const filterOptions = { type: ['bug', 'task'], status: ['open'], priority: [1, 2], model: [] };

    // renderBacklogPanelHtml() also embeds the client-side script's source
    // text (via .toString()) inside its own <script> tags, which itself
    // carries doc-comments that happen to mention the word "Sprint" (e.g.
    // "the supervisor's Launch Sprint form") -- that embedded JS SOURCE TEXT
    // is not rendered UI and must not be mistaken for an actual Sprint
    // section header. Assertions about what's actually shown to the operator
    // are therefore scoped to the server-rendered table markup only, i.e.
    // everything before the first <script> tag.
    function renderedTableMarkup(html) {
        const idx = html.indexOf('<script>');
        return idx === -1 ? html : html.slice(0, idx);
    }

    test('renders the backlog rows and the injected filter header, without a Sprint section or "No sprint tasks." placeholder', () => {
        const html = renderBacklogPanelHtml(tasks, filterOptions);
        const tableMarkup = renderedTableMarkup(html);

        // The redundant, always-empty Sprint sub-view must be gone entirely.
        assert.ok(!tableMarkup.includes('Sprint'), 'no "Sprint" section header may render -- fleet-sprint\'s renderBeadsHtml is always called with an empty sprintTasks here');
        assert.ok(!tableMarkup.includes('No sprint tasks.'), 'no empty-Sprint placeholder row may render either');

        // The backlog rows themselves must still be present.
        assert.ok(html.includes('data-bead-id="B1"'));
        assert.ok(html.includes('data-bead-id="B2"'));
        assert.ok(html.includes('#B1'));
        assert.ok(html.includes('#B2'));
    });

    test('the injected filter header (now a 7-column header row, apra-fleet-qoxd.2 added the Created-at sort cell) is still swapped in on top of the shared table markup', () => {
        const html = renderBacklogPanelHtml(tasks, filterOptions);

        // injectFilterHeader() + injectRowCheckboxes() still ran: the plain-
        // label header row is replaced by the interactive one carrying
        // data-filter-field controls, and every data row still gets its
        // select checkbox -- neither post-processing pass depended on the
        // now-removed Sprint section.
        assert.ok(html.includes('data-filter-field="q"'), 'the ID column\'s free-text search control must still be present');
        assert.ok(html.includes('data-filter-field="type"'));
        assert.ok(html.includes('data-filter-field="status"'));
        assert.ok(html.includes('data-filter-field="priority"'));
        assert.ok(html.includes('data-filter-field="model"'));
        // apra-fleet-qoxd.2: a 7th cell carries the Created-at sort control,
        // with distinguishable asc/desc options (assertable by string match).
        assert.ok(html.includes('data-sort-field="created_at"'), 'the Created-at sort control must be present');
        assert.ok(html.includes('Created (newest)'));
        assert.ok(html.includes('Created (oldest)'));
        // The header row itself now has exactly 7 <th> cells (ID/Title/Type/
        // Status/Pri/Model/Sort) -- one more than the plain header it
        // replaced, since injectFilterHeader() only needs its OWN 6-cell
        // match to find the original static header; the replacement it
        // splices in is free to carry a different cell count.
        const headerRowMatch = html.match(/<tr[^>]*>\s*(?:<th[^>]*>[\s\S]*?<\/th>\s*){7}<\/tr>/);
        assert.ok(headerRowMatch, 'the swapped-in header row must have exactly 7 <th> cells');
        assert.ok(html.includes('bead-select-checkbox'), 'row checkboxes must still be injected');
        // The outer <table> wrapper renderBeadsHtml() always emits is unchanged.
        assert.ok(html.includes('<table'));
    });

    test('an empty backlog still renders the filter header and table wrapper, with no Sprint section', () => {
        const html = renderBacklogPanelHtml([], { type: [], status: [], priority: [], model: [] });
        const tableMarkup = renderedTableMarkup(html);
        assert.ok(!tableMarkup.includes('Sprint'));
        assert.ok(!tableMarkup.includes('No sprint tasks.'));
        assert.ok(html.includes('<table'));
        assert.ok(html.includes('data-filter-field="q"'));
    });
});

// apra-fleet-eft.90: persistent item counts at the top of both beads trees --
// the supervisor's Backlog tab tree (backlog.mjs's renderBacklogPanelHtml, a
// plain total N, independent of #backlog-active-filters which stays empty
// with no filter active) and fleet-sprint's own viewer beads tree
// (viewer-extensions.mjs's renderBeadsHtml, 'M/N' where M = open, N = total).
// Both counts treat every rendered bead (parent AND child) as its own item --
// never deduped/collapsed by tree hierarchy -- and both must render the
// empty-tree case ('0 bead(s)' / '0/0') without throwing.
describe('backlog -- persistent item counts (apra-fleet-eft.90)', () => {
    test('renderBacklogPanelHtml shows a total count N, always visible, independent of the (empty, no-filter) #backlog-active-filters indicator', () => {
        const tasks = [
            { id: 'B1', title: '[bug] a backlog item', status: 'open', issue_type: 'bug', priority: 2 },
            { id: 'B2', title: '[impl] another backlog item', status: 'open', issue_type: 'task', priority: 1 },
            { id: 'B3', title: '[impl] a child item', status: 'open', issue_type: 'task', priority: 1, parent: 'B1' },
        ];
        const html = renderBacklogPanelHtml(tasks, { type: [], status: [], priority: [], model: [] });
        assert.ok(html.includes('id="backlog-total-count"'), 'a dedicated total-count element must be present');
        // Parent (B1) and child (B3) each count as their own item -- 3, not 2.
        assert.ok(html.includes('3 bead(s)'), `expected the total count to be 3, got: ${html.match(/id="backlog-total-count"[^>]*>([^<]*)</)}`);
        // The filter-status indicator itself stays empty (no filter active) --
        // the total count is a SEPARATE, always-visible element.
        assert.ok(html.includes('id="backlog-active-filters" style="font-size: 12px; color: var(--accent, #3b82f6);"></span>'));
    });

    test('renderBacklogPanelHtml with an empty backlog renders "0 bead(s)", never throwing', () => {
        assert.doesNotThrow(() => renderBacklogPanelHtml([], { type: [], status: [], priority: [], model: [] }));
        const html = renderBacklogPanelHtml([], { type: [], status: [], priority: [], model: [] });
        assert.ok(html.includes('0 bead(s)'));
    });

    test('renderBeadsHtml (fleet-sprint viewer tree) shows an explicitly labeled M/N at the top -- N = every rendered bead (Sprint + Backlog, including children), M = how many are not closed', () => {
        const sprintTasks = [
            { id: 'EPIC', title: '[feature] epic', status: 'in_progress', dependencies: [] },
            { id: 'EPIC.1', parent: 'EPIC', title: '[impl] child one', status: 'closed', dependencies: [] },
            { id: 'EPIC.2', parent: 'EPIC', title: '[impl] child two', status: 'open', dependencies: [] },
        ];
        const backlogTasks = [
            { id: 'BL1', title: '[bug] backlog item', status: 'open', priority: 1 },
        ];
        const html = renderBeadsHtml(sprintTasks, backlogTasks);
        // 4 total items (EPIC, EPIC.1, EPIC.2, BL1); 3 are not closed (EPIC,
        // EPIC.2, BL1) -- EPIC.1 is the only closed one.
        // apra-fleet-vk0a.1: explicitly labeled 'All tasks (incl. backlog)' --
        // distinct from renderProgressBarHtml()'s OWN, differently-scoped
        // 'Required: M/N' widget that sits directly above it.
        assert.ok(html.includes('All tasks (incl. backlog): 3 open / 4 total'), `expected the labeled count 'All tasks (incl. backlog): 3 open / 4 total', got: ${html.slice(0, 200)}`);
    });

    test('renderBeadsHtml with both lists empty renders "All tasks (incl. backlog): 0 open / 0 total", never throwing', () => {
        assert.doesNotThrow(() => renderBeadsHtml([], []));
        const html = renderBeadsHtml([], []);
        assert.ok(html.includes('All tasks (incl. backlog): 0 open / 0 total'));
    });

    test('renderBeadsHtml count is removed/broken regression guard: a bead-count element must exist and be non-empty', () => {
        const html = renderBeadsHtml([{ id: 1, title: 'a', status: 'open', dependencies: [] }], []);
        const match = /class="beads-count"[^>]*>([^<]*)</.exec(html);
        assert.ok(match, 'a "beads-count" element must be present in renderBeadsHtml output');
        assert.ok(/^All tasks \(incl\. backlog\): \d+ open \/ \d+ total$/.test(match[1].trim()), `expected a labeled 'All tasks (incl. backlog): M open / N total' count, got: ${match[1]}`);
    });
});

describe('backlog -- createBacklog', () => {
    const allBeads = [
        trackerBead('E', 'Epic', null, 'epic'),
        trackerBead('c1', 'C1', 'E'),
        trackerBead('c2', 'C2', 'E'),
        trackerBead('c3', 'C3', 'E'),
        trackerBead('f0', 'Free', null),
    ];

    test('subtracts the live-expanded scope of each active sprint from the tracker', async () => {
        const backlog = createBacklog({
            ledger: fakeLedger([{ sprintId: 's1', issueRoots: ['c1'] }]),
            listAllBeads: () => allBeads,
            // s1 rooted at c1 -> live scope {c1}.
            expandScope: async (roots) => new Set(roots),
        });
        const claimedBy = await backlog.buildClaimedBy();
        assert.deepEqual([...claimedBy.keys()].sort(), ['c1']);
        assert.equal(claimedBy.get('c1'), 's1');

        const tree = await backlog.buildTree();
        const epic = tree.find((n) => n.id === 'E');
        assert.ok(epic.partialClaim, 'epic should be a partial-claim parent');
        assert.deepEqual(epic.children.map((c) => c.id).sort(), ['c2', 'c3']);
    });

    test('claimed union recomputed live (grown subtree): a child added after launch is still claimed', async () => {
        // Sprint rooted at E; expandScope returns the WHOLE current subtree,
        // including a brand-new child c3 created after launch.
        const backlog = createBacklog({
            ledger: fakeLedger([{ sprintId: 's1', issueRoots: ['E'] }]),
            listAllBeads: () => allBeads,
            expandScope: async () => new Set(['E', 'c1', 'c2', 'c3']),
        });
        const tree = await backlog.buildTree();
        // Whole epic subtree claimed -> only the free root remains in the Backlog.
        assert.deepEqual(tree.map((n) => n.id), ['f0']);
    });

    test('finished sprints (per watchdog) do not claim -- their beads return to the Backlog', async () => {
        const backlog = createBacklog({
            ledger: fakeLedger([
                { sprintId: 'live', issueRoots: ['c1'] },
                { sprintId: 'done', issueRoots: ['c2'] },
            ]),
            listAllBeads: () => allBeads,
            expandScope: async (roots) => new Set(roots),
            watchdog: {
                classifySprint: async (e) => ({
                    status: e.sprintId === 'done' ? WATCHDOG_STATUS.FINISHED : WATCHDOG_STATUS.RUNNING_HEALTHY,
                }),
            },
        });
        const claimedBy = await backlog.buildClaimedBy();
        assert.ok(claimedBy.has('c1'));
        assert.ok(!claimedBy.has('c2'), 'a finished sprint must not keep claiming its scope');
    });

    test('a per-sprint expansion failure is isolated -- other sprints still claim, page still renders', async () => {
        const backlog = createBacklog({
            ledger: fakeLedger([
                { sprintId: 'ok', issueRoots: ['c1'] },
                { sprintId: 'boom', issueRoots: ['c2'] },
            ]),
            listAllBeads: () => allBeads,
            expandScope: async (roots) => {
                if (roots.includes('c2')) throw new Error('bd blew up');
                return new Set(roots);
            },
            logger: { log() {}, error() {} },
        });
        const claimedBy = await backlog.buildClaimedBy();
        assert.ok(claimedBy.has('c1'));
        assert.ok(!claimedBy.has('c2'));
        assert.doesNotThrow(() => renderBacklogTreeHtml([]));
    });

    test('createBacklog requires a ledger', () => {
        assert.throws(() => createBacklog({}), TypeError);
    });

    // apra-fleet-qoxd.3 (verifying apra-fleet-qoxd.1): proves the full
    // route -> buildBacklogTasks -> applyBeadFilters wiring -- a
    // { sort: 'created_at', dir } filter passed into buildBacklogTasks()
    // actually reorders the free rows it returns, off an injected
    // listAllBeads() fixture carrying distinct created_at timestamps.
    test('buildBacklogTasks() honours a { sort: "created_at", dir } filter (route -> buildBacklogTasks -> applyBeadFilters wiring)', async () => {
        const beadsWithTimestamps = [
            { ...trackerBead('E', 'Epic', null, 'epic'), created_at: '2026-01-01T00:00:00Z' },
            { ...trackerBead('c1', 'C1', 'E'), created_at: '2026-01-03T00:00:00Z' },
            { ...trackerBead('c2', 'C2', 'E'), created_at: '2026-01-02T00:00:00Z' },
            { ...trackerBead('c3', 'C3', 'E'), created_at: '2026-01-05T00:00:00Z' },
            { ...trackerBead('f0', 'Free', null), created_at: '2026-01-04T00:00:00Z' },
        ];
        const backlog = createBacklog({
            ledger: fakeLedger([]),
            listAllBeads: () => beadsWithTimestamps,
        });

        const asc = await backlog.buildBacklogTasks({ sort: 'created_at', dir: 'asc' });
        assert.deepEqual(asc.tasks.map((t) => t.id), ['E', 'c2', 'c1', 'f0', 'c3']);

        const desc = await backlog.buildBacklogTasks({ sort: 'created_at', dir: 'desc' });
        assert.deepEqual(desc.tasks.map((t) => t.id), ['c3', 'f0', 'c1', 'c2', 'E']);

        // No sort filter -- unsorted (whatever order the free-row build produced).
        const unsorted = await backlog.buildBacklogTasks();
        assert.equal(unsorted.tasks.length, 5);
    });
});

describe('backlog -- index page places the Backlog ALWAYS LAST', () => {
    test('renderIndexPageHtml puts the Backlog section after the sprint stack', () => {
        const html = renderIndexPageHtml([], renderBacklogTreeHtml(buildBacklogTree([
            normalizeBead(trackerBead('f0', 'Free', null)),
        ], new Map())));
        const stackIdx = html.indexOf('id="sprint-stack"');
        const backlogIdx = html.indexOf('id="backlog"');
        assert.ok(stackIdx !== -1 && backlogIdx !== -1);
        assert.ok(backlogIdx > stackIdx, 'Backlog section must come after the sprint stack');
        assert.ok(html.includes('data-bead-id="f0"'));
    });

    test('createDashboard renders the injected Backlog seam last on the page', async () => {
        const backlog = createBacklog({
            ledger: fakeLedger([]),
            listAllBeads: () => [trackerBead('f0', 'Free root', null)],
            expandScope: async () => new Set(),
        });
        const dashboard = createDashboard({
            ledger: fakeLedger([{ sprintId: 's1', members: ['alice'], issueRoots: ['r1'], childPid: 1 }]),
            watchdog: { classifySprint: async () => ({ status: WATCHDOG_STATUS.RUNNING_HEALTHY }) },
            expandScope: async () => new Set(['r1']),
            listAllBeads: async () => [],
            driftCheck: async () => null,
            backlog,
        });
        const html = await dashboard.renderIndexPage();
        const stackIdx = html.indexOf('id="sprint-stack"');
        const backlogIdx = html.indexOf('id="backlog"');
        assert.ok(backlogIdx > stackIdx, 'Backlog must render after the sprint stack');
        assert.ok(html.includes('data-bead-id="f0"'));
    });

    test('a Backlog render failure does not take down the whole index page', async () => {
        const dashboard = createDashboard({
            ledger: fakeLedger([]),
            watchdog: { classifySprint: async () => ({ status: WATCHDOG_STATUS.RUNNING_HEALTHY }) },
            backlog: { renderHtml: async () => { throw new Error('boom'); } },
            listAllBeads: async () => [],
            driftCheck: async () => null,
            logger: { log() {}, error() {} },
        });
        const html = await dashboard.renderIndexPage();
        assert.ok(html.startsWith('<!DOCTYPE html>'));
        assert.ok(html.includes('id="backlog"'));
    });
});

describe('backlog -- server exact-overlap policy is unchanged (UI steering does not weaken it)', () => {
    test('the scope guard still rejects an overlapping multi-select', async () => {
        // Active sprint s1 owns c1,c2 (rooted at E). The operator, steered by the
        // Backlog to the free children, nonetheless multi-selects an overlapping
        // set including c2 -- the SERVER must still reject it.
        const childMap = { E: ['c1', 'c2', 'c3'] };
        const guard = createScopeGuard({
            ledger: fakeLedger([{ sprintId: 's1', issueRoots: ['c1'] }]),
            listChildren: async (id) => childMap[id] ?? [],
        });
        // Non-overlapping selection (c3 only) is allowed.
        const okResult = await guard.checkLaunch(['c3']);
        assert.equal(okResult.ok, true);
        // Overlapping selection (includes c1) is rejected -- exact-overlap block.
        const badResult = await guard.checkLaunch(['c1']);
        assert.equal(badResult.ok, false);
        assert.equal(badResult.conflicts[0].sprintId, 's1');
        assert.ok(badResult.conflicts[0].overlappingIds.includes('c1'));
    });
});
