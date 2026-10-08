import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncMemberBefore, syncMemberAfter } from '../fleet-sprint/runner.js';
import { GitSyncError } from '../fleet-sprint/errors.mjs';
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

// =============================================================================
// Salvage before the resume reset. A retry after a killed doer used to
// hard-reset straight onto the remote tip, silently destroying the killed
// attempt's unpublished commits and uncommitted changes. The reset is now
// preceded by a salvage step; these pin its command shape and ordering (the
// real-repo behaviour is pinned in git-sync-real-repo.test.mjs).
// =============================================================================
const SALVAGE_BRANCH = 'feat/salvage-shape';

function salvageScript(overrides = {}) {
    return {
        'git fetch': [OK],
        'git status --porcelain': [{ ok: true, output: ' M README.md\n?? wip/new.txt\n', error: null }],
        'git log --oneline': [{ ok: true, output: 'abc1234 fleet-salvage-uncommitted-work\ndef5678 killed attempt test commit\n', error: null }],
        ...overrides,
    };
}

test('salvage: a dirty tree is committed with an explicit -c identity, then a local fleet-salvage/<branch>/<short sha> branch is created, all BEFORE the hard reset', async () => {
    const { command, calls } = makeCommandMock(salvageScript());
    const logs = [];
    const res = await syncMemberBefore('doer-s', { command, branch: SALVAGE_BRANCH, resetToRemoteTip: true, log: (m) => logs.push(String(m)) });
    check(res.ok, 'salvage + reset must succeed');

    const idx = (re) => calls.findIndex((c) => re.test(c.cmd));
    const statusIdx = idx(/^git status --porcelain/);
    const addIdx = idx(/^git add -A/);
    const commitIdx = idx(/^git -c user\.name=\S+ -c user\.email=\S+ .*\bcommit\b/);
    const logIdx = idx(/^git log --oneline/);
    const branchIdx = idx(/^git branch -f fleet-salvage\//);
    const resetIdx = idx(/^git reset --hard/);
    check([statusIdx, addIdx, commitIdx, logIdx, branchIdx, resetIdx].every((i) => i !== -1), `every salvage step must be issued; got ${JSON.stringify(calls.map((c) => c.cmd))}`);
    check(statusIdx < addIdx && addIdx < commitIdx && commitIdx < logIdx && logIdx < branchIdx && branchIdx < resetIdx, `order must be status < add < commit < log < branch < reset; got ${JSON.stringify(calls.map((c) => c.cmd))}`);

    check(calls[logIdx].cmd.includes(`origin/${SALVAGE_BRANCH}..HEAD`), `the ahead-check must compare HEAD against the remote tip, got '${calls[logIdx].cmd}'`);
    check(calls[branchIdx].cmd === `git branch -f fleet-salvage/${SALVAGE_BRANCH}/abc1234 HEAD`, `salvage branch must be named after the short HEAD sha and created idempotently with -f, got '${calls[branchIdx].cmd}'`);
    check(calls.every((c) => c.opts.member_name === 'doer-s'), 'every salvage command carries the explicit member_name');
    check(calls.every((c) => !/^git push/.test(c.cmd)), 'salvage never pushes anything');

    const salvageLog = logs.find((l) => l.includes(`fleet-salvage/${SALVAGE_BRANCH}/abc1234`));
    check(salvageLog && salvageLog.includes('killed attempt test commit') && salvageLog.includes('def5678'), `the log must name the ref and its commits; logs: ${JSON.stringify(logs)}`);
});

test('salvage: every salvage command is shell-neutral -- no shell expansion, no home-relative path, no quoting a PowerShell member would read differently', async () => {
    const { command, calls } = makeCommandMock(salvageScript());
    await syncMemberBefore('doer-s', { command, branch: SALVAGE_BRANCH, resetToRemoteTip: true });
    const salvageCalls = calls.filter((c) => !/^git (fetch|reset)/.test(c.cmd));
    check(salvageCalls.length >= 5, `expected the salvage commands, got ${JSON.stringify(salvageCalls.map((c) => c.cmd))}`);
    for (const { cmd } of salvageCalls) {
        check(!/[$`'"~;|&<>(){}]/.test(cmd), `salvage command must carry no shell metacharacter, quote or expansion: '${cmd}'`);
    }
});

test('salvage: a clean tree with nothing ahead of the remote makes no commit and no branch, and still resets', async () => {
    const { command, calls } = makeCommandMock(salvageScript({
        'git status --porcelain': [OK],
        'git log --oneline': [OK],
    }));
    const res = await syncMemberBefore('doer-s', { command, branch: SALVAGE_BRANCH, resetToRemoteTip: true });
    check(res.ok, 'must succeed');
    check(calls.every((c) => !/\bcommit\b|^git add|^git branch/.test(c.cmd)), `nothing to salvage -> no add/commit/branch, got ${JSON.stringify(calls.map((c) => c.cmd))}`);
    check(calls.some((c) => /^git reset --hard/.test(c.cmd)), 'the reset still runs');
});

for (const [step, key] of [['status read', 'git status --porcelain'], ['salvage commit', 'user.email='], ['ahead check', 'git log --oneline'], ['salvage branch', 'git branch -f']]) {
    test(`salvage: a failed ${step} throws GitSyncError and never issues the hard reset`, async () => {
        const { command, calls } = makeCommandMock(salvageScript({ [key]: [fail('fatal: simulated salvage failure')] }));
        const err = await syncMemberBefore('doer-s', { command, branch: SALVAGE_BRANCH, resetToRemoteTip: true }).then(() => null, (e) => e);
        check(err instanceof GitSyncError, `expected GitSyncError, got ${err && err.constructor.name}: ${err && err.message}`);
        check(/salvage/i.test(err.message), `the error must name the salvage step, got: ${err.message}`);
        check(calls.every((c) => !/^git reset --hard/.test(c.cmd)), `no reset after a failed salvage, got ${JSON.stringify(calls.map((c) => c.cmd))}`);
    });
}
