import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
    createBacklog,
    buildBacklogTree,
    renderBacklogTreeHtml,
    formatPartialClaim,
    parentIdOf,
    normalizeBead,
} from '../src/supervisor/backlog.mjs';
import { createScopeGuard } from '../src/supervisor/scope-overlap.mjs';
import { createDashboard, renderIndexPageHtml } from '../src/supervisor/dashboard.mjs';
import { WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';

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
        assert.deepEqual(raw, { id: 'c1', title: 'C1', issueType: 'task', status: 'open', parentId: 'E' });
        const pre = normalizeBead({ id: 'z', title: 'Z', issueType: 'epic', status: 'closed', parentId: 'root' });
        assert.equal(pre.parentId, 'root');
        assert.equal(pre.issueType, 'epic');
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
