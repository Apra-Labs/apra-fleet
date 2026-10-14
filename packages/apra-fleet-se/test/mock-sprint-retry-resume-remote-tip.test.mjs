import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncMemberBefore, syncMemberAfter } from '../fleet-sprint/runner.js';
// apra-fleet-3swo.5.7: the doer's retry flag is policy data now, not a literal
// at a runner.js call site.
import { policyFor, ROLE_NAMES } from '../fleet-sprint/role-policies.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const check = (cond, msg) => assert.ok(cond, msg);

// Same tiny scripted command() mock as git-sync-brackets.test.mjs:
// a map from cmd-substring -> a sequence of results (each { ok } or
// { ok:false, error }), recording every call (with member_name) so tests can
// assert on the exact emitted git command sequence and its ordering. No real
// bd/network -- every git outcome here is scripted.
function makeCommandMock(script) {
    const calls = [];
    const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
    const command = async (cmd, opts = {}) => {
        calls.push({ cmd, opts });
        for (const [key, queue] of queues) {
            if (cmd.includes(key)) {
                const next = queue.length > 1 ? queue.shift() : queue[0];
                return next;
            }
        }
        return { ok: true, output: '', error: null };
    };
    return { command, calls };
}

const OK = { ok: true, output: '', error: null };
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_S = 'c'.repeat(40);
const lines = (...l) => l.map((x) => `${x}\n`).join('');
const fail = (error) => ({ ok: false, output: '', error });

// =============================================================================
// apra-fleet-eft.87.2 -- regression: a RETRIED doer dispatch must resume onto
// its streak branch's remote tip (fetch + hard-reset) instead of re-issuing a
// plain `git merge --ff-only`, which is the sequence that let a retry
// re-implement the task as a content-identical, SHA-distinct duplicate commit
// and then fail forever with a non-fast-forward push (apra-fleet-eft.87).
// Fixed by apra-fleet-eft.87.1 (syncMemberBefore's `resetToRemoteTip` option,
// threaded from withGitSync's `resumeOntoRemoteTip`).
// =============================================================================
test('retried doer dispatch: pre-dispatch sync resets onto the remote tip (fetch + reset --hard) before the retry commits, and the retry push then succeeds fast-forward with no divergence', async () => {
    const branch = 'eft87-retry-resume';
    const { command, calls } = makeCommandMock({
        'git fetch': [OK, OK],
        'git merge --ff-only': [OK],
        [`git reset --hard origin/${branch}`]: [OK],
        // Retry salvage (GitHub #716): HEAD equals the remote tip and the
        // tree is clean, so there is nothing to pin and no side ref is made.
        [`git rev-parse HEAD origin/${branch}`]: [{ ok: true, output: lines(SHA_A, SHA_A), error: null }],
        'stash create': [OK],
        'git push': [OK, OK],
    });

    // --- Attempt 1: normal first dispatch, happy-path pre-dispatch sync ---
    const before1 = await syncMemberBefore('doer-x', { command, branch });
    check(before1.ok, `attempt 1 pre-dispatch sync must succeed, got ${JSON.stringify(before1)}`);

    // Simulate the doer committing its task's change and the post-dispatch
    // G-push publishing it to the streak branch's remote tip.
    await command('git commit -m "apra-fleet-eft87 task work"', { member_name: 'doer-x' });
    const after1 = await syncMemberAfter('doer-x', { command, branch });
    check(after1.ok && after1.pushed && !after1.rebased, `attempt 1 push must publish cleanly, got ${JSON.stringify(after1)}`);

    // --- Retry: the dispatch is re-run (session re-init) for the SAME task
    // on the SAME streak branch. withGitSync passes resumeOntoRemoteTip:true
    // for exactly this case, which threads through as resetToRemoteTip. ---
    const commit2IdxBefore = calls.length;
    const before2 = await syncMemberBefore('doer-x', { command, branch, resetToRemoteTip: true });
    check(before2.ok, `retry pre-dispatch sync must succeed, got ${JSON.stringify(before2)}`);
    const commit2Idx = calls.length;
    await command('git commit -m "apra-fleet-eft87 task work (retry)"', { member_name: 'doer-x' });

    // Assert 1: the retry's emitted git command sequence contains the
    // pre-dispatch fetch + reset onto the streak branch's remote tip, and it
    // ran BEFORE the doer's (re-)commit step.
    const resetCalls = calls.filter((c) => /git reset --hard/.test(c.cmd));
    check(resetCalls.length === 1, `expected exactly one hard-reset onto the remote tip for the retry, saw ${resetCalls.length}: ${JSON.stringify(calls.map((c) => c.cmd))}`);
    check(new RegExp(`origin/${branch}\\b`).test(resetCalls[0].cmd), `reset must target the streak branch's remote tip, got '${resetCalls[0].cmd}'`);
    check(resetCalls[0].opts.member_name === 'doer-x', 'reset must carry the explicit member_name');
    const resetIdx = calls.findIndex((c) => /git reset --hard/.test(c.cmd));
    check(resetIdx !== -1 && resetIdx >= commit2IdxBefore && resetIdx < commit2Idx, `reset must occur inside the retry's pre-dispatch sync, before the retry's commit step (resetIdx=${resetIdx}, commit2Idx=${commit2Idx})`);

    // The new retry sequence: fetch, salvage reads (HEAD/remote tip, stash
    // snapshot), then the reset. Nothing to save here, so no side ref.
    const retryCmds = calls.slice(commit2IdxBefore, commit2Idx).map((c) => c.cmd);
    assert.deepEqual(retryCmds, [
        `git fetch origin ${branch}`,
        `git rev-parse HEAD origin/${branch}`,
        'git -c user.name=fleet-salvage -c user.email=fleet-salvage.invalid stash create',
        `git reset --hard origin/${branch}`,
    ], 'retry pre-dispatch sync must salvage-check before the reset, in this exact order');
    check(calls.every((c) => !/git branch -f/.test(c.cmd)), 'a clean, up-to-date checkout must not get a salvage side ref');

    // The retry must NOT re-issue a plain ff-only merge (that was the
    // pre-fix behaviour under skipPreDispatchSync's absence -- exactly what
    // let the retry diverge from an already-published commit).
    const mergeCalls = calls.filter((c) => /git merge --ff-only/.test(c.cmd));
    check(mergeCalls.length === 1, `expected the ff-only merge to run ONLY on attempt 1 (never on the resume-onto-remote-tip retry), saw ${mergeCalls.length}`);

    // Assert 2: the retry's post-dispatch push must succeed fast-forward --
    // no second content-identical/SHA-distinct commit divergence, no
    // 'non-fast-forward' / 'Not possible to fast-forward' path taken.
    const after2 = await syncMemberAfter('doer-x', { command, branch });
    check(after2.ok && after2.pushed && !after2.rebased, `retry push must ALSO succeed fast-forward (no divergence from the resumed remote tip), got ${JSON.stringify(after2)}`);

    const pushCalls = calls.filter((c) => /^git push/.test(c.cmd));
    check(pushCalls.length === 2, `expected exactly one push per attempt (2 total), saw ${pushCalls.length}`);
    const fetchCalls = calls.filter((c) => /^git fetch/.test(c.cmd));
    check(fetchCalls.length === 2, `expected one pre-dispatch fetch per attempt (2 total), saw ${fetchCalls.length}`);
});

test('retry reset with unpublished commits and tracked WIP: a fleet-salvage side ref pins the stash commit BEFORE the reset, the sprint branch is never committed on, and the log names the ref and recovery commands', async () => {
    const branch = 'feat/salvage-x';
    const logs = [];
    const { command, calls } = makeCommandMock({
        'git fetch': [OK],
        [`git rev-parse HEAD origin/${branch}`]: [{ ok: true, output: lines(SHA_A, SHA_B), error: null }],
        'git rev-list --count': [{ ok: true, output: lines('2'), error: null }],
        'stash create': [{ ok: true, output: lines(SHA_S), error: null }],
    });
    const res = await syncMemberBefore('doer-x', { command, branch, resetToRemoteTip: true, log: (m) => logs.push(m) });
    const ref = `fleet-salvage/feat-salvage-x/${SHA_S.slice(0, 12)}`;
    assert.equal(res.salvageRef, ref);
    const cmds = calls.map((c) => c.cmd);
    assert.deepEqual(cmds, [
        `git fetch origin ${branch}`,
        `git rev-parse HEAD origin/${branch}`,
        `git rev-list --count ${SHA_A} --not ${SHA_B}`,
        'git -c user.name=fleet-salvage -c user.email=fleet-salvage.invalid stash create',
        `git branch -f ${ref} ${SHA_S}`,
        `git reset --hard origin/${branch}`,
    ]);
    check(cmds.every((c) => !/git add|git commit|git push|git stash (push|save)/.test(c)), 'salvage must never stage, commit, push or move WIP off the work tree');
    check(calls.every((c) => c.opts.member_name === 'doer-x'), 'every salvage command carries the explicit member_name');
    const line = logs.find((l) => l.includes(ref)) || '';
    check(line.includes(`git stash apply ${SHA_S}`) && line.includes(`git cherry-pick ${SHA_B}..${SHA_A}`) && line.includes(`git log ${ref}`), `log must name the ref and the recovery commands, got: ${line}`);
});

test('retry reset fails closed: an unreadable HEAD, a failed stash snapshot, or a conflicting side-ref name throws GitSyncError and never runs the reset', async () => {
    const branch = 'b1';
    const scenarios = [
        { name: 'unparseable rev-parse', script: { [`git rev-parse HEAD origin/${branch}`]: [{ ok: true, output: 'ok (mocked)', error: null }] }, re: /Retry salvage .* failed/ },
        { name: 'stash create fails', script: { [`git rev-parse HEAD origin/${branch}`]: [{ ok: true, output: lines(SHA_A, SHA_A), error: null }], 'stash create': [fail('fatal: boom')] }, re: /NOT resetting/ },
        {
            name: 'D/F ref conflict',
            script: {
                [`git rev-parse HEAD origin/${branch}`]: [{ ok: true, output: lines(SHA_A, SHA_A), error: null }],
                'stash create': [{ ok: true, output: lines(SHA_S), error: null }],
                'git branch -f': [fail("error: 'refs/heads/fleet-salvage/b1' exists; cannot create 'refs/heads/fleet-salvage/b1/cccccccccccc'")],
            },
            re: /existing ref 'fleet-salvage\/b1'.*git branch -D fleet-salvage\/b1/,
        },
    ];
    for (const sc of scenarios) {
        const { command, calls } = makeCommandMock({ 'git fetch': [OK], ...sc.script });
        await assert.rejects(
            syncMemberBefore('m1', { command, branch, resetToRemoteTip: true }),
            (err) => err.name === 'GitSyncError' && sc.re.test(err.message),
            sc.name,
        );
        check(calls.every((c) => !/git reset --hard/.test(c.cmd)), `${sc.name}: the reset must not run`);
    }
});

test('syncMemberBefore: resetToRemoteTip defaults false, so a non-retry (or non-mutating-retry) call keeps the exact prior ff-only-merge behaviour, never resetting', async () => {
    const { command, calls } = makeCommandMock({});
    const res = await syncMemberBefore('m1', { command, branch: 'some-branch' });
    check(res.ok, 'happy path must still succeed');
    check(calls.length === 2, `expected exactly fetch + merge (no reset), got ${calls.map((c) => c.cmd).join(' | ')}`);
    check(/git fetch/.test(calls[0].cmd), 'first command must be a fetch');
    check(/git merge --ff-only/.test(calls[1].cmd), 'second command must be the unchanged ff-only merge');
    check(calls.every((c) => !/git reset --hard/.test(c.cmd)), 'no reset --hard must occur when resetToRemoteTip is not set');
});

// =============================================================================
// Guard: the eft.54/eft.50 terminal no-mutation-failure optimization
// (skipPreDispatchSync, which skips the ENTIRE pre-dispatch sync rather than
// resuming onto the remote tip) must still exist and stay mutually exclusive
// with the new resumeOntoRemoteTip path -- apra-fleet-eft.87.1 must not have
// blanket-removed it. withGitSync moved out of runSprintCycle into
// git-sync.mjs (apra-fleet-3swo.4.1) and is exported now, but the branch
// ordering inside its body is still what this guard is about, so it stays a
// source-level assertion against the exact code introduced by eft.54.1 /
// kept by eft.87.1 -- read from git-sync.mjs, with the doer-streak call site
// still read from runner.js.
// =============================================================================
test('guard: withGitSync source still has a skipPreDispatchSync short-circuit distinct from (and preceding) the resumeOntoRemoteTip resync path', async () => {
    const runnerSource = await fs.readFile(path.join(__dirname, '../fleet-sprint/runner.js'), 'utf-8');
    const gitSyncSource = await fs.readFile(path.join(__dirname, '../fleet-sprint/git-sync.mjs'), 'utf-8');
    const dispatchRoleSource = await fs.readFile(path.join(__dirname, '../fleet-sprint/dispatch-role.mjs'), 'utf-8');

    check(
        /async function withGitSync\(ctx, member, pushCode, dispatchFn, \{[^}]*skipPreDispatchSync = false[^}]*resumeOntoRemoteTip = false[^}]*\}/.test(gitSyncSource),
        'withGitSync must declare BOTH skipPreDispatchSync and resumeOntoRemoteTip as distinct opts (neither replaced the other)'
    );

    const skipIdx = gitSyncSource.indexOf('if (skipPreDispatchSync) {');
    check(skipIdx !== -1, 'the eft.54.1 skipPreDispatchSync short-circuit branch must still be present');

    const skipLogIdx = gitSyncSource.indexOf('Skipping pre-dispatch G-pull/D-pull for member', skipIdx);
    check(skipLogIdx !== -1 && skipLogIdx > skipIdx, 'the skip branch must still log that it skipped the redundant pre-dispatch G-pull/D-pull (terminal no-mutation failure case)');

    const resetThreadIdx = gitSyncSource.indexOf('resetToRemoteTip: resumeOntoRemoteTip', skipIdx);
    check(resetThreadIdx !== -1, 'syncMemberBefore must still be called with resetToRemoteTip: resumeOntoRemoteTip on the non-skip path');
    check(resetThreadIdx > skipLogIdx, 'the resumeOntoRemoteTip resync must live in the ELSE branch, after (mutually exclusive with) the skipPreDispatchSync short-circuit');

    // The two retry modes must never both apply to the same dispatch: the
    // doer-streak throw-retry call site passes only resumeOntoRemoteTip, and
    // the terminal-no-mutation-failure retry ladder passes only
    // skipPreDispatchSync -- never both true together.
    // apra-fleet-3swo.5.7: RE-ANCHORED. The doer's generic-throw retry used to
    // be a literal `dispatchDoer({ resumeOntoRemoteTip: true })` call in
    // runner.js; the ladder migrated onto fleet-sprint/dispatch-role.mjs, where
    // the flag is set from the 'doer' row's retry.resumeOntoRemoteTipOnRetry.
    // Both halves of the original fact are still pinned: the row declares it,
    // and the engine really passes it -- on a RETRY only, and never after a
    // provably no-mutation auth failure, which had nothing to publish.
    check(
        policyFor('doer').retry.resumeOntoRemoteTipOnRetry === true,
        "the doer row must still declare retry.resumeOntoRemoteTipOnRetry (this is what apra-fleet-eft.87.1 wired up)"
    );
    check(
        /resumeOntoRemoteTip: true/.test(dispatchRoleSource),
        'the engine must still set resumeOntoRemoteTip on the bracket options for a ladder that declares it'
    );
    check(
        // doer-resume inherits the doer's retry block by spread (it is the
        // same ladder's secondary), so the doer LADDER is the only one.
        [...new Set(ROLE_NAMES
            .filter((r) => policyFor(r).retry.resumeOntoRemoteTipOnRetry)
            .map((r) => policyFor(r).ladder))].join(',') === 'doer',
        'the doer streak is the only ladder that resumes a retry onto the branch remote tip'
    );
});
