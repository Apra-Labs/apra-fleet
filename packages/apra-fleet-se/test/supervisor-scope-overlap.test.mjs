import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
    createScopeGuard,
    expandScope,
    formatScopeConflict,
} from '../src/supervisor/scope-overlap.mjs';

// apra-fleet-eft.5.3 -- issue-scope overlap via LIVE-expanded subtree
// recomputation. The guard re-expands both the request's and every active
// sprint's roots at launch-attempt time (never a frozen snapshot), one
// `bd list --parent <id>` per node, and any nonzero intersection rejects the
// whole launch naming the conflicting sprint + overlapping bead ids.

/**
 * Build a stub `listChildren(parentId)` over a fixed parent->children map.
 * Records every parent id it was queried with, so tests can assert we never
 * comma-join a multi-parent query and that expansion re-queries live.
 */
function stubLister(childMap) {
    const queried = [];
    const listChildren = async (parentId) => {
        queried.push(parentId);
        return childMap[parentId] ? [...childMap[parentId]] : [];
    };
    return { listChildren, queried };
}

/** Minimal in-memory ledger exposing only list() (mutable via its array). */
function stubLedger(reservations) {
    return { list: () => reservations.map((r) => ({ ...r })) };
}

describe('scope-overlap -- live subtree expansion', () => {
    test('expandScope BFS-walks to full depth, roots included, one id per call', async () => {
        // root -> f1 -> t1; root -> f2. Grandchild t1 must be reached even
        // though bd list --parent is single-level.
        const { listChildren, queried } = stubLister({
            root: ['f1', 'f2'],
            f1: ['t1'],
            f2: [],
            t1: [],
        });
        const scope = await expandScope(['root'], listChildren);
        assert.deepEqual([...scope].sort(), ['f1', 'f2', 'root', 't1']);
        // Never a comma-joined parent -- each query is a single id.
        for (const q of queried) assert.ok(!q.includes(','), `queried a comma-joined parent: ${q}`);
    });

    test('multiple roots are each expanded via one call and merged', async () => {
        const { listChildren, queried } = stubLister({
            rootA: ['a1'],
            rootB: ['b1'],
            a1: [],
            b1: [],
        });
        const scope = await expandScope(['rootA', 'rootB'], listChildren);
        assert.deepEqual([...scope].sort(), ['a1', 'b1', 'rootA', 'rootB']);
        // Both roots queried, as separate single-id calls.
        assert.ok(queried.includes('rootA'));
        assert.ok(queried.includes('rootB'));
        assert.ok(!queried.some((q) => q.includes(',')));
    });
});

describe('scope-overlap -- checkLaunch rejection', () => {
    test('disjoint scopes launch cleanly', async () => {
        const childMap = { R1: ['c1'], c1: [], R2: ['c2'], c2: [] };
        const { listChildren } = stubLister(childMap);
        const ledger = stubLedger([{ sprintId: 'sprint-1', issueRoots: ['R1'] }]);
        const guard = createScopeGuard({ ledger, listChildren });

        const result = await guard.checkLaunch(['R2']);
        assert.equal(result.ok, true);
        assert.deepEqual(result.conflicts, []);
    });

    test('a bead created AFTER launch under an already-claimed root is still detected', async () => {
        // sprint-1 launched with root R. Its subtree is expanded live each call.
        // A new bead C is grafted under R AFTER launch; a second request rooted
        // at C must overlap because we re-expand R live, not from a snapshot.
        const childMap = { R: [] }; // at launch time, R had no children
        const { listChildren } = stubLister(childMap);
        const ledger = stubLedger([{ sprintId: 'sprint-1', issueRoots: ['R'] }]);
        const guard = createScopeGuard({ ledger, listChildren });

        // First: launching C is clean while C is not yet under R.
        const before = await guard.checkLaunch(['C']);
        assert.equal(before.ok, true);

        // Now a planner grafts C under R mid-run.
        childMap.R = ['C'];
        childMap.C = [];

        const after = await guard.checkLaunch(['C']);
        assert.equal(after.ok, false);
        assert.equal(after.conflicts.length, 1);
        assert.equal(after.conflicts[0].sprintId, 'sprint-1');
        assert.deepEqual(after.conflicts[0].overlappingIds, ['C']);
    });

    test('any nonzero intersection rejects the whole launch, naming sprint + ids', async () => {
        const childMap = { R: ['f1', 'f2'], f1: ['t1'], f2: [], t1: [] };
        const { listChildren } = stubLister(childMap);
        const ledger = stubLedger([{ sprintId: 'sprint-owner', issueRoots: ['R'] }]);
        const guard = createScopeGuard({ ledger, listChildren });

        // Request rooted at f1 (a descendant already inside sprint-owner's scope).
        const result = await guard.checkLaunch(['f1']);
        assert.equal(result.ok, false);
        assert.equal(result.conflicts.length, 1);
        assert.equal(result.conflicts[0].sprintId, 'sprint-owner');
        assert.deepEqual(result.conflicts[0].overlappingIds, ['f1', 't1']);

        const msg = formatScopeConflict(result.conflicts);
        assert.match(msg, /sprint-owner/);
        assert.match(msg, /f1/);
        assert.match(msg, /t1/);
    });

    test('excludeSprintId lets a sprint self-check without conflicting with itself', async () => {
        const childMap = { R: ['c1'], c1: [] };
        const { listChildren } = stubLister(childMap);
        const ledger = stubLedger([{ sprintId: 'sprint-1', issueRoots: ['R'] }]);
        const guard = createScopeGuard({ ledger, listChildren });

        const result = await guard.checkLaunch(['R'], { excludeSprintId: 'sprint-1' });
        assert.equal(result.ok, true);
    });

    test('reports conflicts against multiple overlapping sprints', async () => {
        const childMap = { R1: ['x'], x: [], R2: ['y'], y: [], Q: ['x', 'y'] };
        const { listChildren } = stubLister(childMap);
        const ledger = stubLedger([
            { sprintId: 'sprint-1', issueRoots: ['R1'] },
            { sprintId: 'sprint-2', issueRoots: ['R2'] },
        ]);
        const guard = createScopeGuard({ ledger, listChildren });

        // Q's subtree spans both x and y, overlapping both active sprints.
        const result = await guard.checkLaunch(['Q']);
        assert.equal(result.ok, false);
        assert.equal(result.conflicts.length, 2);
        const bySprint = Object.fromEntries(result.conflicts.map((c) => [c.sprintId, c.overlappingIds]));
        assert.deepEqual(bySprint['sprint-1'], ['x']);
        assert.deepEqual(bySprint['sprint-2'], ['y']);
    });
});
