// apra-fleet-972p.1.2 (C3, DQ-26): tests for src/beads/normalize.mjs's five
// pure helpers, using small bead fixtures for tree building and scope
// expansion. Mirrors the fixtures/assertions packages/apra-fleet-se/test/
// supervisor-backlog.test.mjs already exercises against the canonical
// backlog.mjs implementation, so this subpath copy is proven behavior-
// identical rather than merely "looks the same."

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
    parentIdOf,
    normalizeBead,
    buildChildIndex,
    expandScopeInMemory,
    buildBacklogTree,
} from '../src/beads/normalize.mjs';

describe('parentIdOf', () => {
    test('reads an explicit parentId field', () => {
        assert.strictEqual(parentIdOf({ id: 'a.1', parentId: 'a' }), 'a');
    });

    test('reads an explicit parent field', () => {
        assert.strictEqual(parentIdOf({ id: 'a.1', parent: 'a' }), 'a');
    });

    test('derives from a parent-child dependency edge', () => {
        const raw = {
            id: 'a.1',
            dependencies: [
                { type: 'blocks', issue_id: 'a.1', depends_on_id: 'a.0' },
                { type: 'parent-child', issue_id: 'a.1', depends_on_id: 'a' },
            ],
        };
        assert.strictEqual(parentIdOf(raw), 'a');
    });

    test('returns null for a tracker root', () => {
        assert.strictEqual(parentIdOf({ id: 'a' }), null);
    });

    test('returns null for non-object input', () => {
        assert.strictEqual(parentIdOf(null), null);
        assert.strictEqual(parentIdOf(undefined), null);
    });
});

describe('normalizeBead', () => {
    test('normalizes a raw bd list row', () => {
        const raw = {
            id: 'a.1',
            title: 'Do the thing',
            issue_type: 'task',
            status: 'open',
            priority: 2,
            dependencies: [{ type: 'parent-child', issue_id: 'a.1', depends_on_id: 'a' }],
        };
        assert.deepStrictEqual(normalizeBead(raw), {
            id: 'a.1',
            title: 'Do the thing',
            issueType: 'task',
            status: 'open',
            parentId: 'a',
            priority: 2,
        });
    });

    test('defaults issueType/status and nulls out non-numeric priority', () => {
        const normalized = normalizeBead({ id: 'a' });
        assert.strictEqual(normalized.issueType, 'task');
        assert.strictEqual(normalized.status, 'open');
        assert.strictEqual(normalized.priority, null);
        assert.strictEqual(normalized.parentId, null);
    });

    test('is idempotent on an already-normalized object', () => {
        const once = normalizeBead({ id: 'a.1', title: 'x', issueType: 'bug', status: 'closed', parentId: 'a', priority: 1 });
        const twice = normalizeBead(once);
        assert.deepStrictEqual(once, twice);
    });

    test('passes through a server-computed placement field', () => {
        const normalized = normalizeBead({ id: 'a', placement: 'sprint' });
        assert.strictEqual(normalized.placement, 'sprint');
    });

    test('omits placement when absent', () => {
        const normalized = normalizeBead({ id: 'a' });
        assert.ok(!('placement' in normalized));
    });
});

describe('buildChildIndex', () => {
    test('groups direct children by parent id', () => {
        const beads = [
            { id: 'a', parentId: null },
            { id: 'a.1', parentId: 'a' },
            { id: 'a.2', parentId: 'a' },
            { id: 'a.1.1', parentId: 'a.1' },
        ];
        const idx = buildChildIndex(beads);
        assert.deepStrictEqual(idx.get('a'), ['a.1', 'a.2']);
        assert.deepStrictEqual(idx.get('a.1'), ['a.1.1']);
        assert.strictEqual(idx.has('a.2'), false);
    });

    test('handles an empty/non-array input', () => {
        assert.strictEqual(buildChildIndex(null).size, 0);
        assert.strictEqual(buildChildIndex([]).size, 0);
    });
});

describe('expandScopeInMemory', () => {
    const beads = [
        { id: 'a', parentId: null },
        { id: 'a.1', parentId: 'a' },
        { id: 'a.2', parentId: 'a' },
        { id: 'a.1.1', parentId: 'a.1' },
        { id: 'b', parentId: null },
    ];
    const childIndex = buildChildIndex(beads);

    test('expands a root into its full subtree, root included', () => {
        const scope = expandScopeInMemory(['a'], childIndex);
        assert.deepStrictEqual([...scope].sort(), ['a', 'a.1', 'a.1.1', 'a.2']);
    });

    test('a partial-tree root (not the whole epic) only claims itself and its own descendants', () => {
        const scope = expandScopeInMemory(['a.1'], childIndex);
        assert.deepStrictEqual([...scope].sort(), ['a.1', 'a.1.1']);
    });

    test('multiple disjoint roots union their subtrees', () => {
        const scope = expandScopeInMemory(['a.2', 'b'], childIndex);
        assert.deepStrictEqual([...scope].sort(), ['a.2', 'b']);
    });

    test('empty roots produce an empty scope', () => {
        assert.strictEqual(expandScopeInMemory([], childIndex).size, 0);
        assert.strictEqual(expandScopeInMemory(undefined, childIndex).size, 0);
    });
});

describe('buildBacklogTree', () => {
    const beads = [
        { id: 'epic', title: 'Epic', issueType: 'epic', status: 'open', parentId: null },
        { id: 'epic.1', title: 'Child 1', issueType: 'task', status: 'open', parentId: 'epic' },
        { id: 'epic.2', title: 'Child 2', issueType: 'task', status: 'open', parentId: 'epic' },
        { id: 'epic.1.1', title: 'Grandchild', issueType: 'task', status: 'open', parentId: 'epic.1' },
        { id: 'lone', title: 'Lone root', issueType: 'task', status: 'open', parentId: null },
    ];

    test('an entirely free tree returns every root with full nesting', () => {
        const tree = buildBacklogTree(beads, new Map());
        assert.deepStrictEqual(
            tree.map((n) => n.id).sort(),
            ['epic', 'lone'],
        );
        const epicNode = tree.find((n) => n.id === 'epic');
        assert.deepStrictEqual(epicNode.children.map((c) => c.id).sort(), ['epic.1', 'epic.2']);
        const child1Node = epicNode.children.find((c) => c.id === 'epic.1');
        assert.deepStrictEqual(child1Node.children.map((c) => c.id), ['epic.1.1']);
        assert.strictEqual(epicNode.partialClaim, null);
    });

    test('a fully claimed subtree is pruned entirely from the forest', () => {
        const claimedBy = new Map([
            ['epic', 'sprint-x'],
            ['epic.1', 'sprint-x'],
            ['epic.2', 'sprint-x'],
            ['epic.1.1', 'sprint-x'],
        ]);
        const tree = buildBacklogTree(beads, claimedBy);
        assert.deepStrictEqual(tree.map((n) => n.id), ['lone']);
    });

    test('a partial claim (some children claimed) keeps the free parent with only free children, annotated', () => {
        const claimedBy = new Map([['epic.1', 'sprint-x']]);
        const tree = buildBacklogTree(beads, claimedBy);
        const epicNode = tree.find((n) => n.id === 'epic');
        assert.ok(epicNode, 'epic should stay in the forest (it is itself free)');
        assert.deepStrictEqual(epicNode.children.map((c) => c.id), ['epic.2']);
        assert.deepStrictEqual(epicNode.partialClaim, {
            totalCount: 2,
            claimedCount: 1,
            freeCount: 1,
            sprints: [{ sprintId: 'sprint-x', count: 1 }],
        });
    });

    test('a free node whose parent is claimed re-roots into the forest', () => {
        // Defensive re-rooting case: epic.1 claimed but its child epic.1.1 is not
        // (should not happen under the exact-overlap policy, but must not be
        // silently dropped if it ever does).
        const claimedBy = new Map([['epic.1', 'sprint-x']]);
        const tree = buildBacklogTree(beads, claimedBy);
        const ids = new Set();
        const collect = (nodes) => nodes.forEach((n) => { ids.add(n.id); collect(n.children); });
        collect(tree);
        assert.ok(ids.has('epic.1.1'), 'orphaned free grandchild must still surface in the forest');
    });

    test('empty input returns an empty forest', () => {
        assert.deepStrictEqual(buildBacklogTree([], new Map()), []);
        assert.deepStrictEqual(buildBacklogTree(null, null), []);
    });
});
