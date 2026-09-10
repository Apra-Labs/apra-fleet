import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
    createScopeGuard,
} from '../src/supervisor/scope-overlap.mjs';
import { execBdAsync } from '../src/supervisor/lib/exec-bd.mjs';

// apra-fleet-72o0 -- the pre-launch scope-overlap guard's production path
// must do ONE bulk `bd list --all --limit 0 --json` per checkLaunch() call,
// never N sequential `bd list --parent` subprocess spawns (one per
// discovered node). Covers: single-bulk-fetch call count, the closed-parent
// correctness fix `--all` provides, that the default fetcher actually passes
// `--all`, and that pre-existing behavior (overlap/no-overlap/excludeSprintId/
// empty-roots) is unchanged.

/** Minimal in-memory ledger exposing only list() (mutable via its array). */
function stubLedger(reservations) {
    return { list: () => reservations.map((r) => ({ ...r })) };
}

/**
 * Build a stub `listAllBeads()` spy over a fixed flat bead-row list (raw
 * `bd list --json` shape: id + parent). Records call count.
 */
function stubListAllBeads(rows) {
    let calls = 0;
    const listAllBeads = async () => {
        calls += 1;
        return rows.map((r) => ({ ...r }));
    };
    return { listAllBeads, callCount: () => calls };
}

describe('scope-overlap -- apra-fleet-72o0 bulk fetch', () => {
    test('exactly ONE bulk fetch per checkLaunch, even with multiple ledger sprints and a deep tree', async () => {
        // root -> f1 -> t1; root -> f2. R1 -> c1. R2 -> c2.
        const rows = [
            { id: 'root', parent: null },
            { id: 'f1', parent: 'root' },
            { id: 't1', parent: 'f1' },
            { id: 'f2', parent: 'root' },
            { id: 'R1', parent: null },
            { id: 'c1', parent: 'R1' },
            { id: 'R2', parent: null },
            { id: 'c2', parent: 'R2' },
        ];
        const { listAllBeads, callCount } = stubListAllBeads(rows);
        const ledger = stubLedger([
            { sprintId: 'sprint-1', issueRoots: ['R1'] },
            { sprintId: 'sprint-2', issueRoots: ['R2'] },
        ]);
        const guard = createScopeGuard({ ledger, listAllBeads });

        const result = await guard.checkLaunch(['root']);
        assert.equal(result.ok, true);
        assert.deepEqual(result.requestScope, ['f1', 'f2', 'root', 't1']);
        assert.equal(callCount(), 1, `expected exactly one bulk fetch, got ${callCount()}`);
    });

    test('a second checkLaunch call issues its own fresh bulk fetch (still one per call)', async () => {
        const rows = [
            { id: 'R', parent: null },
            { id: 'c', parent: 'R' },
        ];
        const { listAllBeads, callCount } = stubListAllBeads(rows);
        const ledger = stubLedger([]);
        const guard = createScopeGuard({ ledger, listAllBeads });

        await guard.checkLaunch(['R']);
        await guard.checkLaunch(['R']);
        assert.equal(callCount(), 2);
    });

    test('closed-parent case: a CLOSED intermediate parent whose OPEN children overlap another sprint scope IS detected', async () => {
        // EPIC is CLOSED, but its child TASK is open and also reachable from
        // the incoming request's own root (TASK). Without --all, EPIC would
        // be invisible to a `bd list` (default) fetch, but the parent-child
        // edge from TASK -> EPIC still exists in the tracker; what matters
        // here is that EPIC's subtree membership is derived correctly EVEN
        // THOUGH EPIC itself is closed -- i.e. closed beads must still be
        // present in the fetched rows for expansion to walk through them.
        const rows = [
            { id: 'EPIC', parent: null, status: 'closed' },
            { id: 'TASK', parent: 'EPIC', status: 'open' },
        ];
        const { listAllBeads } = stubListAllBeads(rows);
        const ledger = stubLedger([{ sprintId: 'sprint-owner', issueRoots: ['EPIC'] }]);
        const guard = createScopeGuard({ ledger, listAllBeads });

        // A second sprint requests TASK directly -- TASK is inside
        // sprint-owner's live subtree (EPIC -> TASK), so this must conflict.
        const result = await guard.checkLaunch(['TASK']);
        assert.equal(result.ok, false);
        assert.equal(result.conflicts.length, 1);
        assert.equal(result.conflicts[0].sprintId, 'sprint-owner');
        assert.deepEqual(result.conflicts[0].overlappingIds, ['TASK']);
    });

    test('default fetcher argv is exactly ["list", "--all", "--limit", "0", "--json"]', async () => {
        // bdListAllBeadsWithClosed() has no injection point of its own (by
        // design -- it is the thin default, not a seam), so pin its argv
        // contract by reading scope-overlap.mjs's source and asserting the
        // literal argv it hands to execBdAsync. execBdAsync itself DOES
        // accept an injectable execFileAsyncImpl (its documented test seam),
        // so use that to prove the identical argv shape round-trips and that
        // '--all' really reaches the child-process call, not just the source
        // string -- the correctness property that matters (a closed parent's
        // subtree only survives without `--all` failing this way).
        const calls = [];
        const fakeExecFileAsync = async (cmd, args) => {
            calls.push({ cmd, args });
            return { stdout: '[{"id":"x","parent":null}]', stderr: '' };
        };
        const { stdout } = await execBdAsync(['list', '--all', '--limit', '0', '--json'], {}, fakeExecFileAsync);
        assert.deepEqual(calls[0].args, ['list', '--all', '--limit', '0', '--json']);
        assert.ok(calls[0].args.includes('--all'));
        assert.equal(stdout, '[{"id":"x","parent":null}]');

        // Cross-check against scope-overlap.mjs's actual source text so this
        // test fails loudly if the literal argv array in
        // bdListAllBeadsWithClosed() ever drifts from what is asserted above
        // (e.g. someone removes --all while "fixing" performance again).
        const fs = await import('node:fs');
        const url = await import('node:url');
        const srcPath = url.fileURLToPath(new URL('../src/supervisor/scope-overlap.mjs', import.meta.url));
        const src = fs.readFileSync(srcPath, 'utf-8');
        const fnSrc = src.slice(src.indexOf('export async function bdListAllBeadsWithClosed'));
        assert.match(fnSrc, /execBdAsync\(\['list', '--all', '--limit', '0', '--json'\]\)/);
    });

    test('existing behavior preserved: no-overlap (disjoint scopes launch cleanly)', async () => {
        const rows = [
            { id: 'R1', parent: null },
            { id: 'c1', parent: 'R1' },
            { id: 'R2', parent: null },
            { id: 'c2', parent: 'R2' },
        ];
        const { listAllBeads } = stubListAllBeads(rows);
        const ledger = stubLedger([{ sprintId: 'sprint-1', issueRoots: ['R1'] }]);
        const guard = createScopeGuard({ ledger, listAllBeads });

        const result = await guard.checkLaunch(['R2']);
        assert.equal(result.ok, true);
        assert.deepEqual(result.conflicts, []);
    });

    test('existing behavior preserved: overlap detection names sprint + overlapping ids', async () => {
        const rows = [
            { id: 'R', parent: null },
            { id: 'f1', parent: 'R' },
            { id: 't1', parent: 'f1' },
            { id: 'f2', parent: 'R' },
        ];
        const { listAllBeads } = stubListAllBeads(rows);
        const ledger = stubLedger([{ sprintId: 'sprint-owner', issueRoots: ['R'] }]);
        const guard = createScopeGuard({ ledger, listAllBeads });

        const result = await guard.checkLaunch(['f1']);
        assert.equal(result.ok, false);
        assert.equal(result.conflicts.length, 1);
        assert.equal(result.conflicts[0].sprintId, 'sprint-owner');
        assert.deepEqual(result.conflicts[0].overlappingIds, ['f1', 't1']);
    });

    test('existing behavior preserved: excludeSprintId lets a sprint self-check without conflicting with itself', async () => {
        const rows = [
            { id: 'R', parent: null },
            { id: 'c1', parent: 'R' },
        ];
        const { listAllBeads } = stubListAllBeads(rows);
        const ledger = stubLedger([{ sprintId: 'sprint-1', issueRoots: ['R'] }]);
        const guard = createScopeGuard({ ledger, listAllBeads });

        const result = await guard.checkLaunch(['R'], { excludeSprintId: 'sprint-1' });
        assert.equal(result.ok, true);
    });

    test('existing behavior preserved: empty roots throws TypeError', async () => {
        const { listAllBeads } = stubListAllBeads([]);
        const ledger = stubLedger([]);
        const guard = createScopeGuard({ ledger, listAllBeads });

        await assert.rejects(() => guard.checkLaunch([]), TypeError);
    });

    // -------------------------------------------------------------------------
    // Round-2 review item 6: the bulk path lost the per-root id validation the
    // old per-node path did inside bdListChildren(). A malformed root then
    // expanded to just itself and was reported as NON-overlapping -- an invalid
    // launch request quietly accepted instead of rejected.
    // -------------------------------------------------------------------------

    test('a malformed request root is REJECTED on the bulk path, not silently expanded to itself', async () => {
        const { listAllBeads, callCount } = stubListAllBeads([{ id: 'R', parent: null }]);
        const ledger = stubLedger([]);
        const guard = createScopeGuard({ ledger, listAllBeads });

        for (const bad of ['R; rm -rf /', 'a b', 'x$(whoami)', '', 'a/b', 'a,b']) {
            // eslint-disable-next-line no-await-in-loop
            await assert.rejects(
                () => guard.checkLaunch([bad]),
                /Invalid issue id/,
                `expected root ${JSON.stringify(bad)} to be rejected`,
            );
        }
        assert.equal(callCount(), 0, 'validation must reject BEFORE the bulk bd fetch is spawned');
    });

    test('a malformed root among otherwise valid roots still rejects the whole launch', async () => {
        const { listAllBeads } = stubListAllBeads([{ id: 'R', parent: null }]);
        const ledger = stubLedger([]);
        const guard = createScopeGuard({ ledger, listAllBeads });
        await assert.rejects(() => guard.checkLaunch(['R', 'not a valid id']), /Invalid issue id/);
    });

    test('well-formed roots (letters, digits, dot, underscore, dash) are unaffected', async () => {
        const { listAllBeads } = stubListAllBeads([{ id: 'apra-fleet-72o0.1_v2', parent: null }]);
        const ledger = stubLedger([]);
        const guard = createScopeGuard({ ledger, listAllBeads });
        const result = await guard.checkLaunch(['apra-fleet-72o0.1_v2']);
        assert.equal(result.ok, true);
        assert.deepEqual(result.requestScope, ['apra-fleet-72o0.1_v2']);
    });

    test('ledger roots are NOT re-validated -- one bad historical record cannot block every future launch', async () => {
        const { listAllBeads } = stubListAllBeads([{ id: 'R', parent: null }]);
        const ledger = stubLedger([{ sprintId: 'sprint-legacy', issueRoots: ['bad id with spaces'] }]);
        const guard = createScopeGuard({ ledger, listAllBeads });
        const result = await guard.checkLaunch(['R']);
        assert.equal(result.ok, true);
    });

    test('the standalone guard.expandScope(roots) also uses the bulk path with a fresh fetch', async () => {
        const rows = [
            { id: 'root', parent: null },
            { id: 'a', parent: 'root' },
            { id: 'b', parent: 'a' },
        ];
        const { listAllBeads, callCount } = stubListAllBeads(rows);
        const ledger = stubLedger([]);
        const guard = createScopeGuard({ ledger, listAllBeads });

        const scope = await guard.expandScope(['root']);
        assert.deepEqual([...scope].sort(), ['a', 'b', 'root']);
        assert.equal(callCount(), 1);
    });

    test('legacy explicit listChildren seam still drives the old per-node async path unchanged', async () => {
        const queried = [];
        const childMap = { R: ['c1'], c1: ['t1'], t1: [] };
        const listChildren = async (parentId) => {
            queried.push(parentId);
            return childMap[parentId] ? [...childMap[parentId]] : [];
        };
        const ledger = stubLedger([]);
        const guard = createScopeGuard({ ledger, listChildren });

        const result = await guard.checkLaunch(['R']);
        assert.equal(result.ok, true);
        assert.deepEqual(result.requestScope, ['R', 'c1', 't1']);
        // Per-node calls, one id per call, never comma-joined.
        assert.ok(queried.includes('R'));
        assert.ok(queried.includes('c1'));
        assert.ok(!queried.some((q) => q.includes(',')));
    });
});
