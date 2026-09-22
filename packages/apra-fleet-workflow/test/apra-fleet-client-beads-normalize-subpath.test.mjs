// apra-fleet-972p.1.2 (C3, DQ-26): proves the `@apralabs/apra-fleet-client/beads/*`
// exports-map subpath actually resolves from a SIBLING package (this one)
// through node's real module resolution -- not just a relative import inside
// apra-fleet-client's own test suite, which would not catch a package.json
// exports map typo/omission.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
    parentIdOf,
    normalizeBead,
    buildChildIndex,
    expandScopeInMemory,
    buildBacklogTree,
} from '@apralabs/apra-fleet-client/beads/normalize';

describe('@apralabs/apra-fleet-client/beads/normalize subpath resolution', () => {
    test('resolves and exports all five pure helpers', () => {
        assert.strictEqual(typeof parentIdOf, 'function');
        assert.strictEqual(typeof normalizeBead, 'function');
        assert.strictEqual(typeof buildChildIndex, 'function');
        assert.strictEqual(typeof expandScopeInMemory, 'function');
        assert.strictEqual(typeof buildBacklogTree, 'function');
    });

    test('smoke test: normalize + index + expand a tiny bead fixture end to end', () => {
        const raw = [
            { id: 'a', title: 'Root', issue_type: 'epic', status: 'open' },
            { id: 'a.1', title: 'Child', issue_type: 'task', status: 'open',
                dependencies: [{ type: 'parent-child', issue_id: 'a.1', depends_on_id: 'a' }] },
        ];
        const beads = raw.map(normalizeBead);
        assert.strictEqual(beads[1].parentId, 'a');

        const childIndex = buildChildIndex(beads);
        const scope = expandScopeInMemory(['a'], childIndex);
        assert.deepStrictEqual([...scope].sort(), ['a', 'a.1']);

        const tree = buildBacklogTree(beads, new Map());
        assert.strictEqual(tree.length, 1);
        assert.strictEqual(tree[0].id, 'a');
        assert.strictEqual(tree[0].children[0].id, 'a.1');
    });
});
