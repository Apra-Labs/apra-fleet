import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncMemberBefore, syncMemberAfter } from '../fleet-sprint/runner.js';

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
// blanket-removed it. withGitSync itself is a closure private to
// runSprintCycle (not exported), so this is asserted at the source level
// against the exact code introduced by eft.54.1 / kept by eft.87.1.
// =============================================================================
test('guard: withGitSync source still has a skipPreDispatchSync short-circuit distinct from (and preceding) the resumeOntoRemoteTip resync path', async () => {
    const runnerSource = await fs.readFile(path.join(__dirname, '../fleet-sprint/runner.js'), 'utf-8');

    check(
        /async function withGitSync\(member, pushCode, dispatchFn, \{[^}]*skipPreDispatchSync = false[^}]*resumeOntoRemoteTip = false[^}]*\}/.test(runnerSource),
        'withGitSync must declare BOTH skipPreDispatchSync and resumeOntoRemoteTip as distinct opts (neither replaced the other)'
    );

    const skipIdx = runnerSource.indexOf('if (skipPreDispatchSync) {');
    check(skipIdx !== -1, 'the eft.54.1 skipPreDispatchSync short-circuit branch must still be present');

    const skipLogIdx = runnerSource.indexOf('Skipping pre-dispatch G-pull/D-pull for member', skipIdx);
    check(skipLogIdx !== -1 && skipLogIdx > skipIdx, 'the skip branch must still log that it skipped the redundant pre-dispatch G-pull/D-pull (terminal no-mutation failure case)');

    const resetThreadIdx = runnerSource.indexOf('resetToRemoteTip: resumeOntoRemoteTip', skipIdx);
    check(resetThreadIdx !== -1, 'syncMemberBefore must still be called with resetToRemoteTip: resumeOntoRemoteTip on the non-skip path');
    check(resetThreadIdx > skipLogIdx, 'the resumeOntoRemoteTip resync must live in the ELSE branch, after (mutually exclusive with) the skipPreDispatchSync short-circuit');

    // The two retry modes must never both apply to the same dispatch: the
    // doer-streak throw-retry call site passes only resumeOntoRemoteTip, and
    // the terminal-no-mutation-failure retry ladder passes only
    // skipPreDispatchSync -- never both true together.
    check(
        /dispatchDoer\(\{ resumeOntoRemoteTip: true \}\)/.test(runnerSource),
        'the generic-throw doer streak retry call site must still request resumeOntoRemoteTip (this is what apra-fleet-eft.87.1 wired up)'
    );
});
