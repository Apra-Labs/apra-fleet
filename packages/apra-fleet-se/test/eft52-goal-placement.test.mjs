// apra-fleet-eft.52.1.3: server-side goal-based Sprint/Backlog placement.
//
// Two layers are exercised here, matching the bead's ACCEPTANCE clause:
//
//   1. runner.js `partitionByGoalMembership()` -- the SERVER-SIDE computation.
//      A top-level item outside the sprint goal band is tagged
//      placement:'backlog'; an in-goal (or blocks-edge-connected) item is
//      placement:'sprint'; descendants inherit their root's placement.
//
//   2. viewer-extensions.mjs `renderBeadsHtml()` -- the browser consumer. It
//      re-derives the Sprint vs Backlog sections from the server-provided
//      `placement` flag (NOT from priority, and NOT by hiding rows with CSS),
//      so a below-goal item lands in the Backlog container and a
//      blocks-exception item lands in the Sprint container.
//
// The viewer assertions are DOM-verifiable via string position relative to the
// stable `backlog-header` section marker (the Sprint section always renders
// before the Backlog section), consistent with the rest of
// viewer-extensions.test.mjs -- no CSS display:none is used to move a row
// between sections.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { partitionByGoalMembership, goalPriorityMax } from '../fleet-sprint/runner.js';
import { renderBeadsHtml } from '../fleet-sprint/viewer-extensions.mjs';

// Helper: placement (or undefined) for a given id in the partition output.
function placementOf(result, id) {
    const all = result.sprintTasks.concat(result.backlogTasks);
    const found = all.find((t) => String(t.id) === String(id));
    return found ? found.placement : undefined;
}

describe('partitionByGoalMembership (runner.js): server-side goal membership', () => {
    test('sanity: goalPriorityMax picks the numerically-worst band tier', () => {
        assert.strictEqual(goalPriorityMax('P1/P2'), 'P2');
        assert.strictEqual(goalPriorityMax('P0/P1/P3'), 'P3');
        assert.strictEqual(goalPriorityMax('P1'), 'P1');
    });

    test('in-goal default: a top-level item within the goal band is placement:sprint', () => {
        const tasks = [
            { id: 'IN-1', priority: 1, dependencies: [] },
            { id: 'IN-2', priority: 2, dependencies: [] },
        ];
        const result = partitionByGoalMembership(tasks, 'P1/P2');
        assert.strictEqual(placementOf(result, 'IN-1'), 'sprint');
        assert.strictEqual(placementOf(result, 'IN-2'), 'sprint');
        assert.strictEqual(result.backlogTasks.length, 0);
    });

    test('below-goal demotion: a non-goal P3 top-level (goal P1/P2) is placement:backlog', () => {
        const tasks = [
            { id: 'IN-1', priority: 1, dependencies: [] },
            { id: 'LOW-3', priority: 3, dependencies: [] },
        ];
        const result = partitionByGoalMembership(tasks, 'P1/P2');
        assert.strictEqual(placementOf(result, 'IN-1'), 'sprint');
        assert.strictEqual(placementOf(result, 'LOW-3'), 'backlog');
        assert.deepStrictEqual(result.backlogTasks.map((t) => t.id), ['LOW-3']);
    });

    test('blocks-edge exception (outgoing): a below-goal P3 that depends_on an in-goal top-level stays in Sprint', () => {
        const tasks = [
            { id: 'IN-1', priority: 1, dependencies: [] },
            // LOW-3 is P3 (below P1/P2) but blocks-connected to IN-1 -> Sprint.
            { id: 'LOW-3', priority: 3, dependencies: [{ depends_on_id: 'IN-1', type: 'blocks' }] },
        ];
        const result = partitionByGoalMembership(tasks, 'P1/P2');
        assert.strictEqual(placementOf(result, 'LOW-3'), 'sprint');
        assert.strictEqual(result.backlogTasks.length, 0);
    });

    test('blocks-edge exception (incoming): an in-goal top-level that depends_on a below-goal top-level keeps that item in Sprint', () => {
        const tasks = [
            // IN-1 (in-goal) is blocked by LOW-3 (below-goal) -> LOW-3 stays Sprint.
            { id: 'IN-1', priority: 1, dependencies: [{ depends_on_id: 'LOW-3', type: 'blocks' }] },
            { id: 'LOW-3', priority: 3, dependencies: [] },
        ];
        const result = partitionByGoalMembership(tasks, 'P1/P2');
        assert.strictEqual(placementOf(result, 'IN-1'), 'sprint');
        assert.strictEqual(placementOf(result, 'LOW-3'), 'sprint');
        assert.strictEqual(result.backlogTasks.length, 0);
    });

    test('a non-blocks (e.g. parent-child) dependency edge does NOT trigger the Sprint exception', () => {
        const tasks = [
            { id: 'IN-1', priority: 1, dependencies: [] },
            // A below-goal item merely related by a non-'blocks' edge is still demoted.
            { id: 'LOW-3', priority: 3, dependencies: [{ depends_on_id: 'IN-1', type: 'related' }] },
        ];
        const result = partitionByGoalMembership(tasks, 'P1/P2');
        assert.strictEqual(placementOf(result, 'LOW-3'), 'backlog');
    });

    test('descendant inheritance: children inherit their top-level root placement (both directions)', () => {
        const tasks = [
            { id: 'IN-1', priority: 1, dependencies: [] },
            { id: 'IN-1-CHILD', parent: 'IN-1', priority: 4, dependencies: [] }, // P4 child of in-goal root
            { id: 'LOW-3', priority: 3, dependencies: [] },
            { id: 'LOW-3-CHILD', parent: 'LOW-3', priority: 1, dependencies: [] }, // P1 child of below-goal root
        ];
        const result = partitionByGoalMembership(tasks, 'P1/P2');
        // Child of the in-goal root is Sprint even though it is itself P4.
        assert.strictEqual(placementOf(result, 'IN-1-CHILD'), 'sprint');
        // Child of the below-goal root is Backlog even though it is itself P1.
        assert.strictEqual(placementOf(result, 'LOW-3-CHILD'), 'backlog');
    });

    test('non-numeric / missing priority is NOT demoted (in-scope work of unknown rank stays Sprint)', () => {
        const tasks = [
            { id: 'NO-PRI', dependencies: [] }, // no priority field
            { id: 'NULL-PRI', priority: null, dependencies: [] },
            { id: 'STR-PRI', priority: 'P3', dependencies: [] }, // non-numeric
        ];
        const result = partitionByGoalMembership(tasks, 'P1/P2');
        assert.strictEqual(placementOf(result, 'NO-PRI'), 'sprint');
        assert.strictEqual(placementOf(result, 'NULL-PRI'), 'sprint');
        assert.strictEqual(placementOf(result, 'STR-PRI'), 'sprint');
        assert.strictEqual(result.backlogTasks.length, 0);
    });

    test('defensive: non-array input and empty input never throw', () => {
        assert.doesNotThrow(() => partitionByGoalMembership(undefined, 'P1/P2'));
        assert.doesNotThrow(() => partitionByGoalMembership([], 'P1/P2'));
        const empty = partitionByGoalMembership([], 'P1/P2');
        assert.deepStrictEqual(empty, { sprintTasks: [], backlogTasks: [] });
    });
});

describe('renderBeadsHtml (viewer): consumes server placement flag, not CSS hiding (apra-fleet-eft.52.1.3)', () => {
    const idCell = (id) => '#' + id + '</td>';
    // The Backlog section always renders after the Sprint section; its header
    // carries the stable `backlog-header` class. A row is "inside the Backlog
    // container" iff its id cell appears after that marker, and "inside the
    // Sprint container" iff it appears before it.
    const backlogMarker = 'backlog-header';

    test('fixture end-to-end: a below-goal P3 top-level renders inside the Backlog container, a blocks-exception P3 inside the Sprint container', () => {
        // Raw scoped beads as the server would see them, partitioned server-side.
        const raw = [
            { id: 'GOAL-1', title: '[impl] in-goal work', status: 'open', priority: 1, dependencies: [] },
            // Plain below-goal P3: no blocks tie to the goal -> Backlog.
            { id: 'BL-3', title: '[bug] deferred low-priority item', status: 'open', priority: 3, dependencies: [] },
            // Below-goal P3 that an in-goal top-level BLOCKS (incoming edge) -> Sprint.
            { id: 'KEEP-3', title: '[impl] blocks the goal work', status: 'open', priority: 3, dependencies: [] },
        ];
        raw[0].dependencies = [{ depends_on_id: 'KEEP-3', type: 'blocks' }]; // GOAL-1 depends_on KEEP-3

        const { sprintTasks, backlogTasks } = partitionByGoalMembership(raw, 'P1/P2');
        // Server-side sanity: the flag lives in the payload, not the DOM.
        assert.strictEqual(sprintTasks.find((t) => t.id === 'KEEP-3').placement, 'sprint');
        assert.strictEqual(backlogTasks.find((t) => t.id === 'BL-3').placement, 'backlog');

        const html = renderBeadsHtml(sprintTasks, backlogTasks);
        const backlogIdx = html.indexOf(backlogMarker);
        assert.ok(backlogIdx > -1, 'the Backlog section header must render');

        // (a) the below-goal P3 lands inside the Backlog container.
        assert.ok(html.indexOf(idCell('BL-3')) > backlogIdx, 'below-goal P3 must render inside the Backlog container');
        // (b) the blocks-exception P3 lands inside the Sprint container.
        const keepIdx = html.indexOf(idCell('KEEP-3'));
        assert.ok(keepIdx > -1 && keepIdx < backlogIdx, 'blocks-exception P3 must render inside the Sprint container');
        // (c) the in-goal item is also in the Sprint container.
        const goalIdx = html.indexOf(idCell('GOAL-1'));
        assert.ok(goalIdx > -1 && goalIdx < backlogIdx, 'in-goal item must render inside the Sprint container');
    });

    test('placement flag is authoritative: a backlog-placed row passed in the sprintTasks array is still re-derived into the Backlog container (not CSS-hidden)', () => {
        // Deliberately mis-slot a backlog-placed task into the sprint array to
        // prove the viewer honors the server `placement` flag over the array.
        const misSlotted = [
            { id: 'S-OK', title: '[impl] real sprint row', status: 'open', placement: 'sprint' },
            { id: 'B-MOVED', title: '[bug] should be backlog', status: 'open', placement: 'backlog' },
        ];
        const html = renderBeadsHtml(misSlotted, []);
        const backlogIdx = html.indexOf(backlogMarker);
        assert.ok(backlogIdx > -1, 'a Backlog section must be created from the re-derived flag');
        assert.ok(html.indexOf(idCell('B-MOVED')) > backlogIdx, 'placement:backlog row must move to the Backlog container');
        assert.ok(html.indexOf(idCell('S-OK')) < backlogIdx, 'placement:sprint row stays in the Sprint container');
        // The row is genuinely relocated, not merely hidden in place with CSS.
        assert.ok(!/display\s*:\s*none/i.test(html), 'placement must not be applied via CSS display:none hiding');
    });

    test('flag-less tasks are unchanged: no placement field means the caller-supplied arrays are honored verbatim', () => {
        const sprintTasks = [{ id: 'S1', title: '[impl] sprint', status: 'open', dependencies: [] }];
        const backlogTasks = [{ id: 'B1', title: '[bug] backlog', status: 'open' }];
        const html = renderBeadsHtml(sprintTasks, backlogTasks);
        const backlogIdx = html.indexOf(backlogMarker);
        assert.ok(html.indexOf(idCell('S1')) < backlogIdx, 'flag-less sprint task stays in Sprint');
        assert.ok(html.indexOf(idCell('B1')) > backlogIdx, 'flag-less backlog task stays in Backlog');
    });
});
