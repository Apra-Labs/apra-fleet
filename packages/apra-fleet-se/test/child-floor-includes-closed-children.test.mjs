import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { computeChildFloor } from '../fleet-sprint/runner.js';

// apra-fleet-bkax.1: computeChildFloor (fleet-sprint/beads-children.mjs)
// issued `bd list --parent <parentId> --json` WITHOUT a closed-children flag.
// `bd list` excludes closed issues by default, so once every existing child
// under a parent was closed the query returned [], the floor computed to 0,
// and the id allocator re-minted an already-used id (`.1`/`.2`, ...) -- the
// trigger for the collision-overwrite bug fixed in apra-fleet-btj9.1.
//
// apra-fleet-btj9.5: the fix originally shipped as `--status all`, which is
// NOT a documented value for `bd list -s/--status` on installed bd 1.1.0
// (`bd list --help` documents open/in_progress/blocked/deferred/closed only;
// `all` is a documented status value for `bd search`, not `bd list`). Moved
// to `bd list`'s own documented `--all` flag ("Show all issues including
// closed") instead, which is empirically equivalent on bd 1.1.0 today but
// carries no risk of breaking if a future bd release tightens `--status`
// value validation.
//
// This drives computeChildFloor directly with an injected command() fake
// (the real production entry point, re-exported from runner.js) so no real
// `bd` process or bd-replay fixture is needed: the fake simply answers
// whatever `bd list --parent ... --json` returns with a fixed bead list,
// mirroring exactly what a real `bd list --parent <id> --json --all` would
// hand back for that parent.
//
// Falsifiability: reverting the `--all` fix (leaving the label as
// `bd list --parent ${parentId} --json`) does not change what THIS fake
// returns (it always returns the fixed list regardless of the label), so
// the interesting assertion is the explicit `--all` check on the dispatched
// command string in the first test below -- that assertion fails
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
    test('an all-closed child set still yields the highest trailing .N as the floor, via an --all read', async () => {
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
            /^bd list --parent parent-1 --json --all$/,
            'the bd list --parent read must include the documented --all flag so closed children are not silently dropped',
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

    // apra-fleet-btj9.4, criterion 1: the tests above drive computeChildFloor
    // with an injected fake that answers the SAME fixed list regardless of the
    // dispatched command string, so none of them can catch bd itself rejecting
    // the `--all` flag -- only that computeChildFloor asks for it. This test
    // closes that blind spot by shelling out once to the REAL `bd list --help`
    // and asserting the flag computeChildFloor's label names is one bd 1.1.0
    // actually documents. Fast, local, help-text-only -- no dolt server, no
    // sandbox, no sprint fixture -- so it stays out of the slow/real-bd flaky
    // family. If `bd` is absent from PATH, skip VISIBLY (node:test's skip API)
    // rather than silently passing.
    test('bd list --help documents the --all flag computeChildFloor dispatches (apra-fleet-btj9.4)', (t) => {
        let helpText;
        try {
            helpText = execFileSync('bd', ['list', '--help'], { encoding: 'utf8' });
        } catch (err) {
            if (err && err.code === 'ENOENT') {
                t.skip('bd binary not found on PATH -- cannot verify --all against a real `bd list --help`');
                return;
            }
            throw err;
        }
        assert.match(
            helpText,
            /(^|\s)--all(\s|$)/m,
            "bd list --help must document the --all flag computeChildFloor's label relies on",
        );
    });

    // apra-fleet-btj9.4, criterion 2: pins the apra-fleet-btj9.3 fix (the
    // catch branch's log emit) itself, not just the best-effort return value
    // the test above it already covers. A command() fake that throws, paired
    // with a log spy, must yield floor 0 AND exactly one log call naming the
    // parent id and the thrown error's own text -- so a caller that grep's
    // sprint output for this parent id can find why its floor came back 0.
    test('a failed bd list read logs exactly one line naming the parent id and the error text (apra-fleet-btj9.3)', async () => {
        const logCalls = [];
        const log = (msg) => logCalls.push(msg);
        const command = async () => {
            throw new Error('dispatch timeout');
        };

        const floor = await computeChildFloor({ command, member: 'local', parentId: 'parent-9', log });

        assert.strictEqual(floor, 0, 'the best-effort return value is unchanged by adding a log callback');
        assert.strictEqual(logCalls.length, 1, 'the failure must be logged exactly once, not swallowed silently');
        assert.match(logCalls[0], /parent-9/, 'the log line must name the parent id so a reader can tell whose floor read failed');
        assert.match(logCalls[0], /dispatch timeout/, "the log line must include the thrown error's own message text");
    });
});
