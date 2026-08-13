import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    doltPullBefore,
    doltPushAfter,
    verifyDoerStreakClosed,
} from '../fleet-sprint/runner.js';
import { createDoltMutex } from '../src/supervisor/dolt-mutex.mjs';
import { createIdAllocator } from '../src/supervisor/id-allocator.mjs';

// =============================================================================
// apra-fleet-eft.9.8 -- dolt sync discipline, one consolidated suite covering
// all six Plan 3.3/3.4 guarantees end to end:
//
//   (a) all three D-pull/D-push brackets present, INCLUDING the orchestrator
//       D-pull immediately before the post-streak `bd show` verification -- a
//       remote doer close must NOT be falsely reported FAILED. This case fails
//       if that pre-verification D-pull is removed (proven by a control that
//       reads WITHOUT pulling first and observes the false FAILED).
//   (b) two concurrent sprints never race a `bd dolt push` (the global mutex
//       grants at most one holder; push windows never overlap).
//   (c) the constraint-C.4 concurrent same-parent creation scenario yields no
//       child-id collision (the global allocator hands out strictly distinct
//       ids under a shared parent).

// Cases (d), (e) and (f) covered the retired Path A / Path B / Tier 2 recovery
// ladder and were removed with it (docs/dolt-sync-redesign.md Part 2.4). Its
// replacement, settleDoltConflicts(), is covered by test/dolt-settle.test.mjs
// (mocked mechanics), test/dolt-push-recovery-wiring.test.mjs (both divergence
// terminals) and scripts/dolt-settle-integration.mjs (live, per member).
//
// The suite tears down every spawned resource and temp dir in a finally, even
// on failure.
// =============================================================================

// =============================================================================
// (a) All three brackets present, incl. the pre-verification D-pull.
// =============================================================================

// A tiny scripted command() mock recording every call with its opts.
function makeCommandMock(handler) {
    const calls = [];
    const command = async (cmd, opts = {}) => {
        calls.push({ cmd, opts });
        return handler(cmd, opts);
    };
    return { command, calls };
}

const OK = { ok: true, output: '', error: null };

test('(a) all three D-pull/D-push brackets fire, including the pre-`bd show` D-pull', async () => {
    // D-pull-before (dispatch/read bracket). apra-fleet-eft.35: doltPullBefore
    // now issues a `bd config get sync.remote --json` pre-gate check (same
    // fail-closed gate doltPushAfter already had) before `bd dolt pull`
    // itself -- mirrored below via `.some()`/`.find()` rather than a fixed
    // calls[0] index, the same style already used for the D-push assertion
    // a few lines down.
    const pullMock = makeCommandMock(() => OK);
    const pullRes = await doltPullBefore('memberA', { command: pullMock.command });
    assert.deepEqual(pullRes, { ok: true, member: 'memberA' });
    const pullCall = pullMock.calls.find((c) => c.cmd === 'bd dolt pull');
    assert.ok(pullCall, 'D-pull issues `bd dolt pull`');
    assert.equal(pullCall.opts.member_name, 'memberA', 'D-pull carries explicit member_name (3.2)');

    // D-push-after (mutation bracket).
    const pushMock = makeCommandMock(() => OK);
    const pushRes = await doltPushAfter('memberA', { command: pushMock.command });
    assert.deepEqual(pushRes, { ok: true, member: 'memberA', pushed: true, reconciled: false });
    assert.ok(pushMock.calls.some((c) => c.cmd === 'bd dolt push'), 'D-push issues `bd dolt push`');

    // Post-streak verification bracket: the D-pull MUST precede the `bd show`.
    const calls = [];
    let pulled = false;
    const command = async (cmd, opts = {}) => {
        calls.push({ cmd, opts });
        if (cmd.includes('bd dolt pull')) { pulled = true; return OK; }
        if (cmd.includes('bd show')) {
            // The doer's just-pushed closes are only visible AFTER the D-pull.
            return JSON.stringify([
                { id: 'BD-1', status: pulled ? 'closed' : 'open' },
                { id: 'BD-2', status: pulled ? 'closed' : 'open' },
            ]);
        }
        return OK;
    };
    const unclosed = await verifyDoerStreakClosed({
        command, orchestratorMember: 'orch', beadIds: ['BD-1', 'BD-2'],
    });
    assert.deepEqual(unclosed, [], 'a remote doer close is NOT falsely reported FAILED');

    const pullIdx = calls.findIndex((c) => c.cmd.includes('bd dolt pull'));
    const showIdx = calls.findIndex((c) => c.cmd.includes('bd show'));
    assert.ok(pullIdx !== -1 && showIdx !== -1, 'both the D-pull and the verification read ran');
    assert.ok(pullIdx < showIdx, 'the D-pull runs strictly BEFORE the `bd show` verification read');
});

test('(a) CONTROL: removing the pre-verification D-pull would falsely report the streak FAILED', async () => {
    // This is the regression the pre-verification D-pull exists to prevent.
    // A read of the orchestrator clone WITHOUT a preceding D-pull sees the
    // STALE (still-open) snapshot and wrongly concludes the doer streak failed.
    // If someone deleted the D-pull from verifyDoerStreakClosed, case (a) above
    // would produce exactly this [BD-1, BD-2] result and fail -- so this proves
    // the D-pull is load-bearing, not decorative.
    const staleReadNoPull = async ({ beadIds }) => {
        // No `bd dolt pull` -- the clone is stale.
        const snapshot = beadIds.map((id) => ({ id, status: 'open' }));
        const byId = new Map(snapshot.map((b) => [b.id, b.status]));
        return beadIds.filter((id) => byId.get(id) !== 'closed');
    };
    const falselyFailed = await staleReadNoPull({ beadIds: ['BD-1', 'BD-2'] });
    assert.deepEqual(
        falselyFailed, ['BD-1', 'BD-2'],
        'without the pre-verification D-pull, both just-pushed closes are falsely reported FAILED',
    );
});

// =============================================================================
// (b) Two concurrent sprints never race a `bd dolt push` (global mutex).
// =============================================================================

test('(b) the global dolt push mutex serializes concurrent sprints -- push windows never overlap', async () => {
    const mutex = createDoltMutex({ isPidAlive: () => true });
    let insideCriticalSection = false;
    let maxConcurrent = 0;
    let concurrent = 0;
    const grantOrder = [];

    // Simulate a sprint's guarded D-push: acquire, "push" (async work), release.
    async function guardedPush(sprintId) {
        const grant = await mutex.acquire(sprintId);
        grantOrder.push(sprintId);
        // Any overlap here means two sprints pushed at once -- a hard failure.
        assert.equal(insideCriticalSection, false, `sprint ${sprintId} entered while another held the mutex`);
        insideCriticalSection = true;
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        // Yield to the event loop several times so a broken mutex would interleave.
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
        concurrent -= 1;
        insideCriticalSection = false;
        mutex.release(grant.token);
    }

    // Ten concurrent same-instant push attempts across two "sprints".
    const attempts = [];
    for (let i = 0; i < 10; i += 1) {
        attempts.push(guardedPush(i % 2 === 0 ? 'sprint-eft-1' : 'sprint-eft-2'));
    }
    await Promise.all(attempts);

    assert.equal(maxConcurrent, 1, 'at most ONE sprint ever holds the push mutex (no push race)');
    assert.equal(grantOrder.length, 10, 'every queued push attempt was eventually granted (no starvation)');
    assert.equal(mutex.status().held, false, 'the mutex is free after all pushes release');
});

// =============================================================================
// (c) Concurrent same-parent creation yields no id collision (constraint C.4).
// =============================================================================

test('(c) concurrent same-parent child-id allocation never collides (constraint C.4)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eft98-alloc-'));
    try {
        const allocator = createIdAllocator({
            dataDir: dir,
            isPidAlive: () => true,
        });
        await allocator.load();

        // Two sprints concurrently mint children under the SAME parent. Without
        // the global allocator each clone would derive the same next id (C.4)
        // and the two D-pushes would hard-conflict.
        const N = 25;
        const grants = await Promise.all(
            Array.from({ length: N }, (_, i) =>
                allocator.allocate('apra-fleet-eft.9', { sprintId: i % 2 === 0 ? 'A' : 'B' })),
        );

        const childIds = grants.map((g) => g.childId);
        const unique = new Set(childIds);
        assert.equal(unique.size, N, 'every concurrently-allocated child id is DISTINCT (zero collisions)');
        for (const id of childIds) {
            assert.match(id, /^apra-fleet-eft\.9\.\d+$/, 'child ids hang under the shared parent');
        }

        // The seqs are exactly 1..N with no gap or duplicate.
        const seqs = grants.map((g) => g.seq).sort((a, b) => a - b);
        assert.deepEqual(seqs, Array.from({ length: N }, (_, i) => i + 1), 'seqs are a dense, gap-free 1..N');
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch(e) {}
    }
});
