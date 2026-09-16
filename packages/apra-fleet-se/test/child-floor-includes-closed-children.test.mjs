import { test, describe } from 'node:test';
import assert from 'node:assert';
import { computeChildFloor } from '../fleet-sprint/runner.js';

// apra-fleet-bkax.1: computeChildFloor (fleet-sprint/beads-children.mjs)
// issued `bd list --parent <parentId> --json` WITHOUT `--status all`. `bd
// list` excludes closed issues by default, so once every existing child
// under a parent was closed the query returned [], the floor computed to 0,
// and the id allocator re-minted an already-used id (`.1`/`.2`, ...) -- the
// trigger for the collision-overwrite bug fixed in apra-fleet-btj9.1.
//
// This drives computeChildFloor directly with an injected command() fake
// (the real production entry point, re-exported from runner.js) so no real
// `bd` process or bd-replay fixture is needed: the fake simply answers
// whatever `bd list --parent ... --json` returns with a fixed bead list,
// mirroring exactly what a real `bd list --parent <id> --json --status all`
// would hand back for that parent.
//
// Falsifiability: reverting the `--status all` fix (leaving the label as
// `bd list --parent ${parentId} --json`) does not change what THIS fake
// returns (it always returns the fixed list regardless of the label), so
// the interesting assertion is the explicit `--status all` check on the
// dispatched command string in the first test below -- that assertion fails
// immediately if the label reverts. The floor-value assertions additionally
// pin the counting logic itself (grandchildren excluded, closed counted).

function makeListCommand(beads) {
    const calls = [];
    const command = async (cmd) => {
        calls.push(cmd);
        return JSON.stringify(beads);
    };
    return { command, calls };
}

describe('computeChildFloor -- includes closed children in the floor computation (apra-fleet-bkax.1)', () => {
    test('an all-closed child set still yields the highest trailing .N as the floor, via a --status all read', async () => {
        const beads = [
            { id: 'parent-1.1', status: 'closed' },
            { id: 'parent-1.2', status: 'closed' },
            { id: 'parent-1.3', status: 'closed' },
        ];
        const { command, calls } = makeListCommand(beads);

        const floor = await computeChildFloor({ command, member: 'local', parentId: 'parent-1' });

        assert.strictEqual(floor, 3, 'floor must reflect the highest child index even though every child is closed');
        assert.strictEqual(calls.length, 1, 'computeChildFloor must issue exactly one bd list read');
        assert.match(
            calls[0],
            /^bd list --parent parent-1 --json --status all$/,
            'the bd list --parent read must include --status all so closed children are not silently dropped',
        );
    });

    test('a mixed open/closed child set yields the highest trailing .N across BOTH statuses', async () => {
        const beads = [
            { id: 'parent-1.1', status: 'closed' },
            { id: 'parent-1.5', status: 'open' },
            { id: 'parent-1.3', status: 'closed' },
        ];
        const { command } = makeListCommand(beads);

        const floor = await computeChildFloor({ command, member: 'local', parentId: 'parent-1' });

        assert.strictEqual(floor, 5, 'the highest index must win regardless of which status holds it');
    });

    test('a grandchild (two dotted segments) is ignored, not counted as a direct child', async () => {
        const beads = [
            { id: 'parent-1.2', status: 'closed' },
            { id: 'parent-1.2.1', status: 'open' },
        ];
        const { command } = makeListCommand(beads);

        const floor = await computeChildFloor({ command, member: 'local', parentId: 'parent-1' });

        assert.strictEqual(floor, 2, 'only direct children (single trailing numeric segment) count toward the floor');
    });

    test('a failed/unparseable list yields 0 (best-effort tolerance is preserved)', async () => {
        const command = async () => {
            throw new Error('dispatch fault');
        };

        const floor = await computeChildFloor({ command, member: 'local', parentId: 'parent-1' });

        assert.strictEqual(floor, 0);
    });
});
