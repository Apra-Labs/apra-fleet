// A conflicted beads pull in the PULL bracket (doltPullBefore: pre-dispatch or
// the launch gate), followed by a push that fast-forwards with no reconcile,
// still publishes the links the merge brought in -- against the REAL pinned bd.
//
// Real pieces: two real bd clones (A and B) of one bare git remote, the REAL
// doltPullBefore and doltPushAfter (fleet-sprint/dolt-sync.mjs) and the REAL
// createBeadsScope pull bracket and verify, wired as runner.js wires them.
//
// The conflict (helpers/real-bd-link-sandbox.mjs buildScenario): A links C
// under P, adds "X blocked by Y", edits Y and pushes; B then edits Y too. B's
// pre-dispatch pull conflicts on Y and auto-merges (last write wins). On the
// pinned bd (1.3.x) the merged dependency rows -- C's parent link and the X/Y
// blocks edge -- sit in B's working set UNCOMMITTED; B is now level with the
// remote, so its next push fast-forwards and never reconciles. A plain
// `bd dolt push` would publish the merge commit without both links.
//
//   1. The pull bracket marks B as owing a commit of the merged working set
//      plus a link verify before its first push: a fresh clone of the remote
//      after B's push shows both links.
//   2. A link an agent removes on B after that pull and before the push
//      (Z blocked by X, which B held before the pull) is NOT restored by that
//      verify: the remote lacks it, and still has both merged links.
//
// Falsifiability: removing the line in doltPullBefore that marks the member
// as owing the commit + verify makes case 1 fail (the fresh clone lacks both
// links) -- checked locally once.
//
// Hermetic: HOME, USERPROFILE, GIT_CONFIG_GLOBAL and TMPDIR point into one
// temp sandbox per case, removed afterwards; no network. Skips (with the
// reason) when no bd binary is on PATH. ASCII only.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    doltPushAfter,
    doltPullBefore,
    clearMembersOwingLinkVerify,
    invalidateSyncRemoteCache,
    clearLastSyncedTip,
    clearTipProbeFailures,
    clearDegradedSyncRecords,
} from '../fleet-sprint/dolt-sync.mjs';
import {
    bdAvailable, runOrThrow, buildScenario, engineFor, pushOptsFor, pullOptsFor, remoteLinks,
} from './helpers/real-bd-link-sandbox.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';

const SKIP = bdAvailable() ? false : 'requires a real bd binary on PATH';

const traceOf = (eng) => eng.calls.map((c) => `${c.member}: ${c.cmd}`).join('\n');

describe('pull-bracket commit + verify against a real conflicted bd pull', { skip: SKIP, concurrency: false }, () => {
    const budget = scaledTimeout(120_000, { concurrency: TEST_CONCURRENCY });
    const sandboxes = [];
    before(() => {
        invalidateSyncRemoteCache();
        clearTipProbeFailures();
        clearDegradedSyncRecords();
    });
    beforeEach(() => {
        clearMembersOwingLinkVerify();
        clearLastSyncedTip();
    });
    after(() => {
        for (const root of sandboxes) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });

    /** Build the conflict, seed the run's scope on A, run B's pre-dispatch pull through the engine. */
    async function pullOnB() {
        const { sb, ids } = await buildScenario();
        sandboxes.push(sb.root);
        const eng = await engineFor(sb, ids);
        await eng.scope.fetchAllBeadsShared(); // the run's scope: P and its tree, read on A
        eng.calls.length = 0;
        const pulled = await doltPullBefore('B', pullOptsFor(eng));
        assert.equal(pulled.ok, true, JSON.stringify(pulled));
        assert.ok(!pulled.skipped, `B's pull must really run: ${JSON.stringify(pulled)}`);
        return { sb, ids, eng };
    }

    test('1. a conflicted pre-dispatch pull, then a fast-forward push: a fresh clone of the remote shows the parent link and the blocks edge', { timeout: budget }, async () => {
        const { sb, ids, eng } = await pullOnB();
        const pullAt = eng.calls.length;

        const res = await doltPushAfter('B', pushOptsFor(eng));
        assert.equal(res.pushed, true, JSON.stringify(res));
        assert.equal(res.reconciled, false, `the push must fast-forward with no reconcile:\n${traceOf(eng)}`);
        const after = eng.calls.slice(pullAt);
        const commit = after.findIndex((c) => c.member === 'B' && /^bd dolt commit -m /.test(c.cmd));
        const push = after.findIndex((c) => c.member === 'B' && /^bd dolt push/.test(c.cmd));
        assert.ok(commit >= 0 && commit < push, `the merged working set is committed before the push:\n${traceOf(eng)}`);

        const onRemote = await remoteLinks(sb, 'fresh-1');
        assert.equal(onRemote.parentOf.get(ids.C), ids.P, `C -> P is on the remote:\n${eng.logs.join('\n')}`);
        assert.ok(onRemote.blocks.has(`${ids.X}>${ids.Y}`), `X blocked-by Y is on the remote:\n${eng.logs.join('\n')}`);
    });

    test('2. an edge an agent removes on B after that pull and before the push is NOT restored', { timeout: budget }, async () => {
        const { sb, ids, eng } = await pullOnB();
        // The agent on B, after the pull: drop Z blocked-by X (a link B held before the pull).
        await runOrThrow(sb, `bd dep remove ${ids.Z} ${ids.X}`, sb.dirs.B);

        const res = await doltPushAfter('B', pushOptsFor(eng));
        assert.equal(res.pushed, true, JSON.stringify(res));
        assert.equal(res.reconciled, false, traceOf(eng));
        assert.equal(eng.calls.filter((c) => new RegExp(`^bd dep add ${ids.Z} ${ids.X}$`).test(c.cmd)).length, 0, traceOf(eng));
        assert.ok(!eng.logs.some((l) => l.startsWith('ERROR')), eng.logs.join('\n'));

        const onRemote = await remoteLinks(sb, 'fresh-2');
        assert.ok(!onRemote.blocks.has(`${ids.Z}>${ids.X}`), 'the agent-removed edge Z blocked-by X is not on the remote');
        assert.equal(onRemote.parentOf.get(ids.C), ids.P, 'C -> P (merged by the pull) is on the remote');
        assert.ok(onRemote.blocks.has(`${ids.X}>${ids.Y}`), 'X blocked-by Y (merged by the pull) is on the remote');
    });
});
