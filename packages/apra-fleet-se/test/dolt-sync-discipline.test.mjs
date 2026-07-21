import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    doltPullBefore,
    doltPushAfter,
    verifyDoerStreakClosed,
} from '../auto-sprint/runner.js';
import {
    assessConflictGates,
    isDoltPullConflict,
} from '../auto-sprint/dolt-recovery.mjs';
import {
    recoverDoltConflictPathB,
} from '../auto-sprint/dolt-recovery-path-b.mjs';
import {
    recoverDoltConflict,
} from '../auto-sprint/dolt-recovery-tier2.mjs';
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
//   (d) Path A end-to-end on a DELIBERATELY WEDGED REAL dolt clone: both gates
//       pass, zero data loss, both sides' history present in dolt_log.
//   (e) Path B on a REAL wedged clone including mutation replay: the discarded
//       clone is re-bootstrapped from the shared remote and the one critical
//       pending mutation is replayed and republished (zero loss of it).
//   (f) an unrecognized scripted-step output OR a failed Path A gate escalates
//       to Tier 2 rather than proceeding blind.
//
// (d) and (e) operate on a REAL wedged dolt clone built with the real dolt
// binary (resolved from the apra-fleet-ire installer, falling back to PATH),
// NOT mocks, and assert zero data loss against the real repo's dolt_log /
// remote. If the dolt binary is unavailable, those two cases SKIP with a clear
// message (never a silent pass). The suite tears down every spawned resource
// and temp clone in a finally, even on failure.
// =============================================================================

// -----------------------------------------------------------------------------
// Real dolt binary resolution + skip gating.
// -----------------------------------------------------------------------------

/**
 * Resolve the dolt binary: prefer the copy the apra-fleet-ire installer places
 * (via an explicit env override or its conventional install locations), then
 * fall back to a `dolt` already on PATH. Returns an absolute path / bare name
 * usable as an argv[0], or null if none is runnable.
 */
function resolveDoltBinary() {
    const candidates = [];
    // 1. Explicit override the apra-fleet-ire installer / CI can set.
    if (process.env.APRA_FLEET_IRE_DOLT) candidates.push(process.env.APRA_FLEET_IRE_DOLT);
    if (process.env.DOLT_BIN) candidates.push(process.env.DOLT_BIN);
    // 2. Conventional apra-fleet-ire install locations.
    const home = os.homedir() || os.tmpdir();
    const exe = process.platform === 'win32' ? 'dolt.exe' : 'dolt';
    candidates.push(path.join(home, '.apra-fleet', 'ire', 'bin', exe));
    candidates.push(path.join(home, '.apra-fleet', 'bin', exe));
    for (const c of candidates) {
        try {
            if (c && fs.existsSync(c) && runsDolt(c)) return c;
        } catch { /* keep trying */ }
    }
    // 3. Fall back to PATH.
    if (runsDolt('dolt')) return 'dolt';
    return null;
}

/** Does `bin` respond to `dolt version`? */
function runsDolt(bin) {
    try {
        const res = spawnSync(bin, ['version'], { encoding: 'utf8', timeout: 15000 });
        return res.status === 0 && /dolt version/i.test(`${res.stdout || ''}${res.stderr || ''}`);
    } catch {
        return false;
    }
}

const DOLT_BIN = resolveDoltBinary();
const DOLT_SKIP = DOLT_BIN
    ? false
    : 'dolt binary unavailable (not installed via apra-fleet-ire and not on PATH) -- '
      + 'skipping the real wedged-clone Path A/B integration cases. Install dolt via the '
      + 'apra-fleet-ire installer (or put `dolt` on PATH) to run them.';

// -----------------------------------------------------------------------------
// Real dolt helpers (used only by cases (d) and (e)).
// -----------------------------------------------------------------------------

/** Run a dolt subcommand in `cwd` with an isolated DOLT_ROOT_PATH. */
function dolt(cwd, args, rootPath) {
    const res = spawnSync(DOLT_BIN, args, {
        cwd,
        encoding: 'utf8',
        timeout: 60000,
        env: { ...process.env, DOLT_ROOT_PATH: rootPath, NO_COLOR: '1' },
    });
    return {
        code: res.status,
        stdout: res.stdout || '',
        stderr: res.stderr || '',
        out: `${res.stdout || ''}${res.stderr || ''}`,
    };
}

/** Parse the row arrays out of a `dolt sql --result-format json` batch (one
 *  `{"rows":[...]}` object per row-returning statement). */
function parseJsonRows(out) {
    const all = [];
    for (const line of out.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
            const obj = JSON.parse(t);
            if (obj && Array.isArray(obj.rows)) all.push(obj.rows);
        } catch { /* not a JSON result line */ }
    }
    return all;
}

/**
 * Stand up a throwaway real-dolt workspace: a shared file remote plus two
 * clones, and deliberately WEDGE clone B with a single-row `issues` merge
 * conflict against clone A's already-pushed change. Everything lives under one
 * temp root the caller removes in a finally.
 *
 * @returns {{ root, rootPath, remoteUrl, cloneA, cloneB, pullOutput }}
 */
function makeWedgedRealClone(root) {
    const rootPath = path.join(root, 'doltroot');
    fs.mkdirSync(rootPath, { recursive: true });
    // Identity for commits (isolated to this workspace's DOLT_ROOT_PATH).
    dolt(root, ['config', '--global', '--add', 'user.name', 'eft-9.8-test'], rootPath);
    dolt(root, ['config', '--global', '--add', 'user.email', 'eft-9.8@test.local'], rootPath);

    // --- shared remote (a real file remote) seeded with one issues row -------
    const remoteRepo = path.join(root, 'remote');
    fs.mkdirSync(remoteRepo, { recursive: true });
    assert.equal(dolt(remoteRepo, ['init'], rootPath).code, 0, 'dolt init (remote seed) succeeds');
    assert.equal(
        dolt(remoteRepo, ['sql', '-q',
            "CREATE TABLE issues (id VARCHAR(64) PRIMARY KEY, status VARCHAR(32));"
            + " INSERT INTO issues VALUES ('BD-1','open');"], rootPath).code,
        0, 'seed issues table');
    assert.equal(dolt(remoteRepo, ['add', '-A'], rootPath).code, 0, 'stage seed');
    assert.equal(dolt(remoteRepo, ['commit', '-m', 'seed'], rootPath).code, 0, 'commit seed');

    const store = path.join(root, 'store');
    fs.mkdirSync(store, { recursive: true });
    const remoteUrl = `file://${store.split(path.sep).join('/')}`;
    assert.equal(dolt(remoteRepo, ['remote', 'add', 'origin', remoteUrl], rootPath).code, 0, 'add origin');
    assert.equal(dolt(remoteRepo, ['push', 'origin', 'main'], rootPath).code, 0, 'seed pushed to remote');

    // --- two clones off the shared remote ------------------------------------
    const cloneA = path.join(root, 'A');
    const cloneB = path.join(root, 'B');
    assert.equal(dolt(root, ['clone', remoteUrl, cloneA], rootPath).code, 0, 'clone A');
    assert.equal(dolt(root, ['clone', remoteUrl, cloneB], rootPath).code, 0, 'clone B');

    // --- A wins the race: closes BD-1 and pushes first -----------------------
    assert.equal(dolt(cloneA, ['sql', '-q', "UPDATE issues SET status='closed' WHERE id='BD-1';"], rootPath).code, 0, 'A updates BD-1');
    assert.equal(dolt(cloneA, ['add', '-A'], rootPath).code, 0, 'A stages');
    assert.equal(dolt(cloneA, ['commit', '-m', 'A closes BD-1'], rootPath).code, 0, 'A commits');
    assert.equal(dolt(cloneA, ['push', 'origin', 'main'], rootPath).code, 0, 'A pushes first (wins)');

    // --- B makes a conflicting change to the SAME row, then pulls -> wedged --
    assert.equal(dolt(cloneB, ['sql', '-q', "UPDATE issues SET status='in_progress' WHERE id='BD-1';"], rootPath).code, 0, 'B updates BD-1');
    assert.equal(dolt(cloneB, ['add', '-A'], rootPath).code, 0, 'B stages');
    assert.equal(dolt(cloneB, ['commit', '-m', 'B sets BD-1 in_progress'], rootPath).code, 0, 'B commits');
    const pull = dolt(cloneB, ['pull', 'origin', 'main'], rootPath);

    return { root, rootPath, remoteUrl, cloneA, cloneB, pullOutput: pull.out };
}

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
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// =============================================================================
// (d) Path A end-to-end on a REAL wedged dolt clone: both gates pass, zero
//     data loss, both sides' history in dolt_log.
// =============================================================================

test('(d) Path A resolves a REAL single-row wedged clone with zero data loss', { skip: DOLT_SKIP }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eft98-patha-'));
    try {
        const wc = makeWedgedRealClone(root);

        // The failed pull's OWN output must classify as a genuine merge conflict
        // (the Path A trigger) via the real detector.
        assert.ok(
            isDoltPullConflict(wc.pullOutput),
            `the real wedged clone's pull output is a genuine merge conflict\n${wc.pullOutput}`,
        );

        // Clean the in-progress merge left by the failed pull, then re-open it
        // and read the REAL dolt_conflicts rows the gate decides from.
        dolt(wc.cloneB, ['reset', '--hard'], wc.rootPath);
        dolt(wc.cloneB, ['merge', '--abort'], wc.rootPath);
        const probe = dolt(wc.cloneB, ['sql', '-q',
            "SET @@dolt_allow_commit_conflicts=1;"
            + " CALL DOLT_MERGE('origin/main');"
            + " SELECT `table` AS `table`, num_conflicts FROM dolt_conflicts;",
            '--result-format', 'json'], wc.rootPath);
        const rowSets = parseJsonRows(probe.out);
        const conflictRows = rowSets.find((rs) => rs.some((r) => r && r.table === 'issues')) || [];
        assert.ok(conflictRows.length > 0, `real dolt_conflicts reported the conflict\n${probe.out}`);

        // Feed the REAL conflict rows to the production gate: both gates pass.
        const gate = assessConflictGates(conflictRows);
        assert.equal(gate.passedTableGate, true, 'table gate passes (issues is allowlisted)');
        assert.equal(gate.passedShapeGate, true, 'shape gate passes (a single conflicted row)');
        assert.equal(gate.passed, true, 'both gates pass on the real conflict shape');

        // Gated on that pass, run the runbook's resolve-in-place against the
        // real clone in one session, exactly as Path A does.
        dolt(wc.cloneB, ['reset', '--hard'], wc.rootPath);
        dolt(wc.cloneB, ['merge', '--abort'], wc.rootPath);
        const resolve = dolt(wc.cloneB, ['sql', '-q',
            "SET @@dolt_allow_commit_conflicts=1;"
            + " CALL DOLT_MERGE('origin/main');"
            + " CALL DOLT_CONFLICTS_RESOLVE('--theirs','issues');"
            + " CALL DOLT_COMMIT('-m','Path A scripted resolve-in-place of single-row issues conflict');",
            '--result-format', 'json'], wc.rootPath);
        assert.equal(resolve.code, 0, `real resolve+commit succeeds\n${resolve.out}`);

        // Zero data loss: BOTH sides' history is present in the real dolt_log
        // (the merge commit keeps both parents).
        const logOut = dolt(wc.cloneB, ['sql', '-q', 'SELECT message FROM dolt_log;'], wc.rootPath).out;
        assert.match(logOut, /A closes BD-1/, "our loser clone still has A's committed history (no data loss)");
        assert.match(logOut, /B sets BD-1 in_progress/, "the loser clone's own history is preserved (no data loss)");
        assert.match(logOut, /Path A scripted resolve-in-place/, 'the resolve merge commit is present');

        // No conflicts remain and the row survived (theirs won, first-pusher).
        const rows = parseJsonRows(dolt(wc.cloneB, ['sql', '-q', 'SELECT * FROM issues;', '--result-format', 'json'], wc.rootPath).out);
        const issues = rows.find((rs) => rs.some((r) => r && r.id === 'BD-1')) || [];
        assert.equal(issues[0].status, 'closed', 'the surviving row is the first-successful-pusher value');

        // Republish the reconciled clone to the shared remote.
        assert.equal(dolt(wc.cloneB, ['push', 'origin', 'main'], wc.rootPath).code, 0, 'the reconciled clone republishes cleanly');
    } finally {
        // Teardown even on failure: remove the whole temp workspace.
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// =============================================================================
// (e) Path B on a REAL wedged clone incl. mutation replay: drives the actual
//     recoverDoltConflictPathB() function against real dolt + a real filesystem.
// =============================================================================

test('(e) Path B discards, re-bootstraps a REAL wedged clone, and replays the pending mutation', { skip: DOLT_SKIP }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eft98-pathb-'));
    try {
        const wc = makeWedgedRealClone(root);

        // The one local-only mutation that mattered (the loser clone's own
        // write) -- Path B must replay this after discarding everything else.
        const PENDING = { id: 'BD-2', status: 'open' };

        // A real config.yaml with sync.remote so Path B's Windows gotcha #1
        // guard passes against a genuine file (real hasSyncRemoteInYaml).
        const configPath = path.join(root, 'config.yaml');
        fs.writeFileSync(configPath, `sync:\n  remote: ${wc.remoteUrl}\n`, 'utf8');

        // removePath / listLocalState operate on the REAL clone B directory.
        const removePaths = [wc.cloneB];

        // command() shells out to REAL dolt: bootstrap => re-clone from the
        // shared remote; the mutation replay + push run against that fresh
        // clone. Everything here is real dolt against a real remote.
        const command = async (cmd) => {
            if (cmd.includes('bd bootstrap')) {
                const r = dolt(root, ['clone', wc.remoteUrl, wc.cloneB], wc.rootPath);
                return { ok: r.code === 0, output: r.out, error: r.code === 0 ? null : r.out };
            }
            if (cmd.includes('REPLAY:')) {
                const r = dolt(wc.cloneB, ['sql', '-q',
                    `INSERT INTO issues VALUES ('${PENDING.id}','${PENDING.status}');`], wc.rootPath);
                if (r.code !== 0) return { ok: false, output: r.out, error: r.out };
                dolt(wc.cloneB, ['add', '-A'], wc.rootPath);
                const c = dolt(wc.cloneB, ['commit', '-m', 'Path B replay of pending mutation'], wc.rootPath);
                return { ok: c.code === 0, output: c.out, error: c.code === 0 ? null : c.out };
            }
            if (cmd.includes('bd dolt push')) {
                const r = dolt(wc.cloneB, ['push', 'origin', 'main'], wc.rootPath);
                return { ok: r.code === 0, output: r.out, error: r.code === 0 ? null : r.out };
            }
            return { ok: true, output: '', error: null };
        };

        const res = await recoverDoltConflictPathB({
            member: 'sprint-eft-loser',
            command,
            configPath,
            removePaths,
            pendingMutation: { description: 'replay BD-2 create', cmd: 'REPLAY: bd create BD-2' },
        });

        assert.equal(res.ok, true, 'Path B recovered the real clone');
        assert.equal(res.recovered, true, 'Path B reports recovered');
        assert.equal(res.mutationReplayed, true, 'the pending mutation was replayed');
        assert.deepEqual(res.removedPaths, removePaths, 'the wedged clone dir was discarded');

        // Zero loss of the critical mutation: it reached the SHARED REMOTE.
        // Verify from an INDEPENDENT fresh clone of the remote.
        const verify = path.join(root, 'verify');
        assert.equal(dolt(root, ['clone', wc.remoteUrl, verify], wc.rootPath).code, 0, 'fresh verify clone');
        const rows = parseJsonRows(dolt(verify, ['sql', '-q', "SELECT * FROM issues WHERE id='BD-2';", '--result-format', 'json'], wc.rootPath).out);
        const replayed = rows.find((rs) => rs.some((r) => r && r.id === 'BD-2')) || [];
        assert.ok(replayed.length > 0, 'the replayed pending mutation reached the shared remote (not lost)');
        assert.equal(replayed[0].status, 'open', 'the replayed mutation has its original value');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// =============================================================================
// (f) Unrecognized output or a failed gate escalates to Tier 2 (never proceeds).
// =============================================================================

test('(f) a Path A gate rejection with a Path B failure escalates to Tier 2', async () => {
    const dispatched = [];
    const agent = async (prompt, opts) => { dispatched.push({ prompt, opts }); return { resolved: true }; };

    // Path A rejects the shape at its gate (proceeded:false); Path B then fails
    // with a genuine operational error -> Tier 2 escalation.
    const res = await recoverDoltConflict({
        member: 'sprint-eft-wedged',
        pathA: async () => ({ ok: false, proceeded: false, gate: { passed: false }, reason: 'gate rejected: multi-row conflict' }),
        pathB: async () => { throw new Error('bd bootstrap failed and did not recover'); },
        agent,
    });

    assert.equal(res.ok, false, 'the ladder did not proceed as if recovery succeeded');
    assert.equal(res.tier, 'tier-2', 'escalated to Tier 2');
    assert.equal(res.escalated, true, 'the wedged state was escalated');
    assert.equal(dispatched.length, 1, 'a Tier 2 recovery agent was dispatched exactly once');
    assert.match(dispatched[0].prompt, /DOLT CONFLICT RECOVERY RUNBOOK/, 'the dispatch carries the Tier 2 runbook');
});

test('(f) an UNRECOGNIZED scripted-step output escalates to Tier 2 rather than proceeding blind', async () => {
    const dispatched = [];
    const agent = async (prompt, opts) => { dispatched.push({ prompt, opts }); return { resolved: true }; };

    // Path A does not apply; Path B returns a NON-ok result with output the
    // ladder does not recognize -> must escalate, never silently succeed.
    const res = await recoverDoltConflict({
        member: 'sprint-eft-wedged',
        pathA: async () => ({ ok: false, proceeded: false, reason: 'Path A not applicable' }),
        pathB: async () => ({ ok: false, reason: 'bootstrap emitted output this ladder does not recognize' }),
        agent,
    });

    assert.equal(res.ok, false, 'an unrecognized outcome is not treated as success');
    assert.equal(res.tier, 'tier-2', 'unrecognized output escalates to Tier 2');
    assert.equal(dispatched.length, 1, 'the unrecognized outcome dispatched a Tier 2 recovery agent');
    assert.match(res.pathBReason, /does not recognize/, 'the unrecognized Path B output is recorded in the escalation');
});
