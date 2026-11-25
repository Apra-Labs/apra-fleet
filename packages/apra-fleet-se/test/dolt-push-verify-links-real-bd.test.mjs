// A conflicted beads pull that drops a parent link and a blocks edge is caught
// before the engine's push publishes it -- against the REAL pinned bd.
//
// Real pieces: two real bd clones (A and B) of one bare git remote (beads
// syncs through refs/dolt/data on it), the REAL doltPushAfter
// (fleet-sprint/dolt-sync.mjs) and the REAL createBeadsScope verify
// (beadsScope.verifyLinksBeforePush), wired exactly as runner.js wires it
// (git-sync's verifyLinks option). Every member command runs for real in that
// member's clone.
//
// The conflict: A links C under P and adds "X blocked by Y", edits Y's title
// and pushes; B then edits Y's title too. B's engine push is rejected
// (behind), its reconcile `bd dolt pull` conflicts on Y and auto-merges
// (last write wins).
//
// WHAT THE PINNED bd (1.3.x) REALLY DOES THERE (measured while writing this
// test, deterministic in this sandbox): the merge leaves the merged
// dependency rows -- C's parent link and the X/Y blocks edge -- UNCOMMITTED in
// B's working set. `bd list` on B still shows both links, but a plain
// `bd dolt push` publishes only the commit, and A loses both links on its
// next pull. A link READ can never see that loss, so case 1 asserts the real
// outcome: after the guarded push, A has both links (and without the guard it
// does not -- see the falsifiability note).
//
// The read-and-restore half of the guard (ERROR lines, `bd update --parent`
// and `bd dep add` before the push) restores only links a pull DROPPED: links
// the pulling clone held just before the pull and lacks just after it (the
// pull bracket in beads-scope.mjs). The pinned bd does not produce such a
// loss on its own here. Cases 2 and 3 therefore keep the real clones and the
// real conflicted pull and inject the lossy result through the command seam:
// right after B's real reconcile pull, the seam really removes two links B
// held before the pull -- X's parent link (X -> P) and the blocks edge
// "Z blocked by X", both published before B bootstrapped -- from B's clone (a
// direct bd call in B, invisible to the engine's ledger, like a merge that
// dropped them). Case 2 asserts the ERROR lines, the restores before the
// push, and both links on A afterwards; case 3 stubs ONLY the two restore
// commands to fail and asserts no push is issued and the typed error names
// both edges.
//
// Falsifiability: removing the verify call from doltPushAfter's reconcile
// path (verifyLinksBeforePush after the reconcile pull) makes case 1 fail (A
// pulls a state without both links), case 2 fail (no ERROR/restore before the
// re-push) and case 3 fail (the re-push is issued) -- checked locally once by
// reverting the fix.
//
// The second block covers links an AGENT changed on its own clone (outside
// the engine's command path, no pull in between): (1) a retarget and a
// reversal (cycle-break) on A survive A's reconciled push, with no
// ParentLinkRestoreError; (2) a reparent on A reaches the remote; (4) a
// removal and a retarget A pushed are not restored when B pulls them through
// the engine pull path and pushes (the run-wide agent-removal record). Each
// is checked on a FRESH clone of the remote. Falsifiability: with
// parent-link-guard.mjs and beads-scope.mjs reverted to before the
// pull-bracket change, (1) fails (bd refuses the re-added X blocked-by Y as a
// cycle); with only the agent-removal record disabled, (4) fails (B restores
// both edges) -- checked locally once.
//
// Hermetic: HOME, USERPROFILE, GIT_CONFIG_GLOBAL and TMPDIR point into one
// temp sandbox, removed afterwards; no network. Skips (with the reason) when
// no bd binary is on PATH. ASCII only.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    doltPushAfter,
    doltPullBefore,
    clearMembersOwingLinkVerify,
    invalidateSyncRemoteCache,
    clearLastSyncedTip,
    clearTipProbeFailures,
    clearDegradedSyncRecords,
} from '../fleet-sprint/dolt-sync.mjs';
import { ParentLinkRestoreError } from '../fleet-sprint/parent-link-guard.mjs';
import {
    bdAvailable, createSandbox, runOrThrow, linksOf, buildScenario, engineFor, pushOptsFor, remoteLinks, pullOptsFor,
} from './helpers/real-bd-link-sandbox.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';

const SKIP = bdAvailable() ? false : 'requires a real bd binary on PATH';

describe('verify-before-push against a real conflicted bd pull', { skip: SKIP, concurrency: false }, () => {
    const budget = scaledTimeout(120_000, { concurrency: TEST_CONCURRENCY });
    const sandboxes = [];
    before(() => {
        invalidateSyncRemoteCache();
        clearLastSyncedTip();
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

    test('the merged links reach the remote: after the guarded push from B, clone A still has both links', { timeout: budget }, async () => {
        const { sb, ids } = await buildScenario();
        sandboxes.push(sb.root);
        const eng = await engineFor(sb, ids);
        await seedLedger(eng, ids);

        const res = await doltPushAfter('B', pushOptsFor(eng));
        assert.equal(res.pushed, true, JSON.stringify(res));
        assert.equal(res.reconciled, true, `B's first push must be rejected and reconciled: ${eng.logs.join('\n')}`);

        await runOrThrow(sb, 'bd dolt pull', sb.dirs.A);
        const onA = await linksOf(sb, sb.dirs.A);
        assert.equal(onA.parentOf.get(ids.C), ids.P, `C -> P lost on A after the guarded push:\n${eng.logs.join('\n')}`);
        assert.ok(onA.blocks.has(`${ids.X}>${ids.Y}`), `X blocked-by Y lost on A after the guarded push:\n${eng.logs.join('\n')}`);
    });

    test('links missing from the pushing clone after the pull are reported, restored BEFORE the push, and reach clone A', { timeout: budget }, async () => {
        const { sb, ids } = await buildScenario();
        sandboxes.push(sb.root);
        // The injected lossy merge: both links really removed from B's clone,
        // outside the engine's command path (so its ledger does not know).
        let injected = false;
        const eng = await engineFor(sb, ids, {
            afterPull: async (member) => {
                if (member !== 'B' || injected) return;
                injected = true;
                await runOrThrow(sb, 'bd dolt commit', sb.dirs.B);
                await runOrThrow(sb, `bd update ${ids.X} --parent ""`, sb.dirs.B);
                await runOrThrow(sb, `bd dep remove ${ids.Z} ${ids.X}`, sb.dirs.B);
            },
        });
        await seedLedger(eng, ids);

        const res = await doltPushAfter('B', pushOptsFor(eng));
        assert.equal(res.pushed, true, JSON.stringify(res));
        assert.ok(injected, 'the reconcile pull ran on B');

        const errors = eng.logs.filter((l) => l.startsWith('ERROR:'));
        assert.ok(errors.some((l) => l.includes('parent-child link vanished') && l.includes(`'${ids.X}'`) && l.includes(`'${ids.P}'`)), errors.join('\n'));
        assert.ok(errors.some((l) => l.includes('blocks link vanished') && l.includes(`'${ids.Z}'`) && l.includes(`'${ids.X}'`)), errors.join('\n'));

        const idx = (re, from = 0) => eng.calls.findIndex((c, i) => i >= from && c.member === 'B' && re.test(c.cmd));
        const pull = idx(/bd dolt pull/);
        const restoreParent = idx(new RegExp(`^bd update ${ids.X} --parent ${ids.P}$`));
        const restoreBlocks = idx(new RegExp(`^bd dep add ${ids.Z} ${ids.X}$`));
        const rePush = idx(/bd dolt push/, pull + 1);
        const trace = eng.calls.map((c) => `${c.member}: ${c.cmd}`).join('\n');
        assert.ok(pull >= 0 && restoreParent > pull && restoreParent < rePush, trace);
        assert.ok(restoreBlocks > pull && restoreBlocks < rePush, trace);

        await runOrThrow(sb, 'bd dolt pull', sb.dirs.A);
        const onA = await linksOf(sb, sb.dirs.A);
        assert.equal(onA.parentOf.get(ids.X), ids.P, 'X -> P present on A');
        assert.ok(onA.blocks.has(`${ids.Z}>${ids.X}`), 'Z blocked-by X present on A');
        assert.equal(onA.parentOf.get(ids.C), ids.P, 'C -> P (merged by the conflicted pull) present on A');
        assert.ok(onA.blocks.has(`${ids.X}>${ids.Y}`), 'X blocked-by Y (merged by the conflicted pull) present on A');
    });

    test('a failing restore issues no push and the typed error names both edges', { timeout: budget }, async () => {
        const { sb, ids } = await buildScenario();
        sandboxes.push(sb.root);
        let injected = false;
        const isRestore = (cmd) => cmd === `bd update ${ids.X} --parent ${ids.P}` || cmd === `bd dep add ${ids.Z} ${ids.X}`;
        const eng = await engineFor(sb, ids, {
            failCommand: (cmd, member) => member === 'B' && isRestore(cmd),
            afterPull: async (member) => {
                if (member !== 'B' || injected) return;
                injected = true;
                await runOrThrow(sb, 'bd dolt commit', sb.dirs.B);
                await runOrThrow(sb, `bd update ${ids.X} --parent ""`, sb.dirs.B);
                await runOrThrow(sb, `bd dep remove ${ids.Z} ${ids.X}`, sb.dirs.B);
            },
        });
        await seedLedger(eng, ids);
        const remoteTipBefore = await runOrThrow(sb, `git ls-remote "file://${sb.remote}" refs/dolt/data`, sb.root);

        await assert.rejects(() => doltPushAfter('B', pushOptsFor(eng)), (err) => {
            assert.ok(err instanceof ParentLinkRestoreError, `${err && err.name}: ${err && err.message}`);
            assert.match(err.message, new RegExp(`parent-child link '${ids.X}' -> parent '${ids.P}'`));
            assert.match(err.message, new RegExp(`blocks link '${ids.Z}' blocked by '${ids.X}'`));
            assert.deepEqual(err.edges.map((e) => e.kind).sort(), ['blocks', 'parent-child']);
            return true;
        });
        const pushes = eng.calls.filter((c) => c.member === 'B' && /bd dolt push/.test(c.cmd));
        assert.equal(pushes.length, 1, `only the first (rejected) push may run:\n${eng.calls.map((c) => `${c.member}: ${c.cmd}`).join('\n')}`);
        const remoteTipAfter = await runOrThrow(sb, `git ls-remote "file://${sb.remote}" refs/dolt/data`, sb.root);
        assert.equal(remoteTipAfter, remoteTipBefore, 'nothing from B reached the remote');
    });
});

/**
 * Feed the run's link ledger the way a sprint does: one full-DB snapshot read
 * on the backlog member (clone A, which holds C -> P and X blocked-by Y),
 * scoped to the sprint target P (engineFor's targetIssues).
 */
async function seedLedger(eng, ids) {
    const rows = await eng.scope.fetchAllBeadsShared();
    const c = rows.find((b) => b.id === ids.C);
    assert.equal(c && c.parent, ids.P, 'the ledger snapshot carries C -> P');
    const x = rows.find((b) => b.id === ids.X);
    assert.ok(x && (x.dependencies || []).some((d) => d.type === 'blocks' && d.depends_on_id === ids.Y), 'the ledger snapshot carries X blocked-by Y');
    eng.calls.length = 0;
}

// ---------------------------------------------------------------------------
// Links an AGENT changes on its own clone (outside the engine's command path,
// with no pull in between) are never restored -- on that clone, or on another
// clone that pulls the change. Real bd, real clones, real remote.
// ---------------------------------------------------------------------------

/**
 * A, B and a bare remote. On A, published before B bootstraps: features P and
 * Q (Q under P), tasks X, Y, Z, W under P, and V (no parent, touched only by
 * B to make A's push non-fast-forward); X blocked by Y and W blocked by Y.
 */
async function buildAgentScenario() {
    const sb = createSandbox();
    const { A, B } = sb.dirs;
    await runOrThrow(sb, 'git config --global user.name "Link Guard"', sb.root);
    await runOrThrow(sb, 'git config --global user.email link-guard@test.local', sb.root);
    await runOrThrow(sb, 'git config --global commit.gpgsign false', sb.root);
    await runOrThrow(sb, `git init -q --bare -b main "${sb.remote}"`, sb.root);
    const url = `file://${sb.remote}`;
    fs.mkdirSync(A);
    await runOrThrow(sb, 'git init -q -b main', A);
    await runOrThrow(sb, `git remote add origin "${url}"`, A);
    await runOrThrow(sb, 'git commit -q --allow-empty -m init', A);
    await runOrThrow(sb, 'git push -q origin main', A);
    await runOrThrow(sb, 'bd init --prefix ag', A);
    const ids = {};
    const create = async (title, extra = '') => (await runOrThrow(sb, `bd create "${title}" ${extra} --silent`, A)).split(/\s+/).pop();
    ids.P = await create('P', '-t feature');
    ids.Q = await create('Q', `-t feature --parent ${ids.P}`);
    for (const name of ['X', 'Y', 'Z', 'W']) ids[name] = await create(name, `-t task --parent ${ids.P}`);
    ids.V = await create('V', '-t task');
    await runOrThrow(sb, `bd dep add ${ids.X} ${ids.Y}`, A);
    await runOrThrow(sb, `bd dep add ${ids.W} ${ids.Y}`, A);
    await runOrThrow(sb, 'bd dolt push', A);
    fs.mkdirSync(B);
    await runOrThrow(sb, `git clone -q "${url}" .`, B);
    await runOrThrow(sb, 'bd bootstrap --yes', B);
    return { sb, ids };
}

/** B publishes an unrelated edit, so A's next push is rejected and reconciles (the path that runs the verify). */
async function publishUnrelatedEditFromB(sb, ids) {
    await runOrThrow(sb, `bd update ${ids.V} --title "V edited on B"`, sb.dirs.B);
    await runOrThrow(sb, 'bd dolt push', sb.dirs.B);
}

const restoresIn = (eng) => eng.calls.filter((c) => /^bd dep add |^bd update \S+ --parent /.test(c.cmd));
const traceOf = (eng) => eng.calls.map((c) => `${c.member}: ${c.cmd}`).join('\n');

describe('agent link changes survive the link guard against real bd', { skip: SKIP, concurrency: false }, () => {
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

    test('(1) an agent on A retargets one blocks edge and reverses another; the guarded push publishes exactly that, no ParentLinkRestoreError', { timeout: budget }, async () => {
        const { sb, ids } = await buildAgentScenario();
        sandboxes.push(sb.root);
        const eng = await engineFor(sb, ids);
        await eng.scope.fetchAllBeadsShared(); // the run's ledger records X blocked-by Y and W blocked-by Y
        eng.calls.length = 0;
        await publishUnrelatedEditFromB(sb, ids);

        // The planner on A: retarget W (blocked by Y -> blocked by Z) and break
        // a would-be cycle by reversing X blocked-by Y into Y blocked-by X.
        await runOrThrow(sb, `bd dep remove ${ids.W} ${ids.Y}`, sb.dirs.A);
        await runOrThrow(sb, `bd dep add ${ids.W} ${ids.Z}`, sb.dirs.A);
        await runOrThrow(sb, `bd dep remove ${ids.X} ${ids.Y}`, sb.dirs.A);
        await runOrThrow(sb, `bd dep add ${ids.Y} ${ids.X}`, sb.dirs.A);

        const res = await doltPushAfter('A', pushOptsFor(eng));
        assert.equal(res.pushed, true, JSON.stringify(res));
        assert.equal(res.reconciled, true, `A's push must be rejected and reconciled (the verify path): ${eng.logs.join('\n')}`);
        assert.deepEqual(restoresIn(eng), [], traceOf(eng));
        assert.ok(!eng.logs.some((l) => l.startsWith('ERROR')), eng.logs.join('\n'));

        const onRemote = await remoteLinks(sb, 'fresh1');
        assert.ok(onRemote.blocks.has(`${ids.W}>${ids.Z}`), 'the retargeted edge W blocked-by Z is on the remote');
        assert.ok(!onRemote.blocks.has(`${ids.W}>${ids.Y}`), 'the original edge W blocked-by Y is not');
        assert.ok(onRemote.blocks.has(`${ids.Y}>${ids.X}`), 'the reversed edge Y blocked-by X is on the remote');
        assert.ok(!onRemote.blocks.has(`${ids.X}>${ids.Y}`), 'the original edge X blocked-by Y is not');
    });

    test('(2) an agent reparent on A (Z: P -> Q) reaches the remote unreverted', { timeout: budget }, async () => {
        const { sb, ids } = await buildAgentScenario();
        sandboxes.push(sb.root);
        const eng = await engineFor(sb, ids);
        await eng.scope.fetchAllBeadsShared();
        eng.calls.length = 0;
        await publishUnrelatedEditFromB(sb, ids);

        await runOrThrow(sb, `bd update ${ids.Z} --parent ${ids.Q}`, sb.dirs.A);

        const res = await doltPushAfter('A', pushOptsFor(eng));
        assert.equal(res.pushed, true, JSON.stringify(res));
        assert.equal(res.reconciled, true, eng.logs.join('\n'));
        assert.deepEqual(restoresIn(eng), [], traceOf(eng));
        const onRemote = await remoteLinks(sb, 'fresh2');
        assert.equal(onRemote.parentOf.get(ids.Z), ids.Q, 'the remote holds the new parent');
    });

    test('(4) cross clone: A removes one blocks edge and retargets another and pushes; B pulls through the engine and pushes -- nothing is restored', { timeout: budget }, async () => {
        const { sb, ids } = await buildAgentScenario();
        sandboxes.push(sb.root);
        // The backlog member is B: the planner works on a non-backlog member.
        const eng = await engineFor(sb, ids, { backlog: 'B' });
        await eng.scope.fetchAllBeadsShared();
        eng.calls.length = 0;

        // A's pre-dispatch pull (its links are read around it).
        await doltPullBefore('A', pullOptsFor(eng));
        // The planner on A: remove X blocked-by Y; retarget W (Y -> Z).
        await runOrThrow(sb, `bd dep remove ${ids.X} ${ids.Y}`, sb.dirs.A);
        await runOrThrow(sb, `bd dep remove ${ids.W} ${ids.Y}`, sb.dirs.A);
        await runOrThrow(sb, `bd dep add ${ids.W} ${ids.Z}`, sb.dirs.A);
        await doltPushAfter('A', pushOptsFor(eng));

        // B pulls A's push through the engine pull path (a clean pull: the
        // edges are present before it and missing after it), then pushes.
        await doltPullBefore('B', pullOptsFor(eng));
        const res = await doltPushAfter('B', pushOptsFor(eng));
        assert.equal(res.ok, true, JSON.stringify(res));
        assert.deepEqual(restoresIn(eng), [], traceOf(eng));
        assert.ok(!eng.logs.some((l) => l.startsWith('ERROR')), eng.logs.join('\n'));

        const onRemote = await remoteLinks(sb, 'fresh4');
        assert.ok(!onRemote.blocks.has(`${ids.X}>${ids.Y}`), 'the removed edge X blocked-by Y is not on the remote');
        assert.ok(!onRemote.blocks.has(`${ids.W}>${ids.Y}`), 'the original target of the retargeted edge is not on the remote');
        assert.ok(onRemote.blocks.has(`${ids.W}>${ids.Z}`), 'the retargeted edge W blocked-by Z is on the remote');
    });
});
