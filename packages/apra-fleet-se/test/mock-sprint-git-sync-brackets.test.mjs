import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyGitFailure,
    syncMemberBefore,
    syncMemberAfter,
} from '../auto-sprint/runner.js';
import { GitDivergedError, GitSyncError } from '../auto-sprint/errors.mjs';
import { WorkflowError } from '@apralabs/apra-fleet-workflow';

const check = (cond, msg) => assert.ok(cond, msg);

// A tiny scripted command() mock: pass a map from cmd-substring -> a sequence
// of results (each { ok } or { ok:false, error }). Records every call with its
// member_name so tests can assert explicit member threading (3.2).
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
// apra-fleet-eft.8.1 -- classifyGitFailure: the transient-vs-diverged split
// that risk 2 hinges on.
// =============================================================================
test('classifyGitFailure: non-FF / unmerged / conflict outputs classify as diverged', () => {
    check(classifyGitFailure('fatal: Not possible to fast-forward, aborting.') === 'diverged', 'non-FF merge is diverged');
    check(classifyGitFailure(' ! [rejected]        main -> main (non-fast-forward)') === 'diverged', 'rejected push is diverged');
    check(classifyGitFailure('error: Pulling is not possible because you have unmerged files.') === 'diverged', 'unmerged is diverged');
    check(classifyGitFailure('CONFLICT (content): Merge conflict in a.txt') === 'diverged', 'conflict is diverged');
    check(classifyGitFailure('hint: Updates were rejected because the tip of your current branch is behind') === 'diverged', 'behind-tip is diverged');
});

test('classifyGitFailure: network / lock outputs classify as transient', () => {
    check(classifyGitFailure('fatal: unable to access https://... Could not resolve host: github.com') === 'transient', 'dns is transient');
    check(classifyGitFailure('fatal: Unable to create /repo/.git/index.lock: File exists.') === 'transient', 'index.lock is transient');
    check(classifyGitFailure('ssh: connect to host ... Connection timed out') === 'transient', 'conn timeout is transient');
    check(classifyGitFailure('error: cannot lock ref refs/heads/main') === 'transient', 'lock ref is transient');
});

test('classifyGitFailure: unclassifiable output is unknown (not silently transient)', () => {
    check(classifyGitFailure('some totally novel git failure text') === 'unknown', 'novel failure is unknown');
    check(classifyGitFailure('') === 'unknown', 'empty is unknown');
});

// =============================================================================
// syncMemberBefore (G-pull): fetch + merge --ff-only, typed divergence, retry.
// =============================================================================
test('syncMemberBefore: happy path runs fetch then merge --ff-only, each with explicit member_name', async () => {
    const { command, calls } = makeCommandMock({});
    const res = await syncMemberBefore('m1', { command });
    check(res.ok && res.member === 'm1', `expected ok result, got ${JSON.stringify(res)}`);
    check(calls.length === 2, `expected exactly fetch + merge, got ${calls.map((c) => c.cmd).join(' | ')}`);
    check(/git fetch/.test(calls[0].cmd), `first command must be a fetch, got ${calls[0].cmd}`);
    check(/git merge --ff-only/.test(calls[1].cmd), `second command must be ff-only merge, got ${calls[1].cmd}`);
    check(calls.every((c) => c.opts.member_name === 'm1'), 'every git command must carry an explicit member_name');
});

test('syncMemberBefore: a non-FF merge raises a DISTINCT typed GitDivergedError (not a generic failure)', async () => {
    const { command } = makeCommandMock({
        'git merge --ff-only': [fail('fatal: Not possible to fast-forward, aborting.')],
    });
    let err = null;
    try { await syncMemberBefore('m1', { command }); } catch (e) { err = e; }
    check(err instanceof GitDivergedError, `expected GitDivergedError, got ${err && err.constructor.name}`);
    check(err instanceof WorkflowError, 'GitDivergedError must extend WorkflowError');
    check(err.member === 'm1', 'error must carry the member');
    check(/fast-forward/i.test(err.gitOutput || ''), 'error must carry the git output');
    check(err.operation === 'pull', 'operation must be pull');
});

test('syncMemberBefore: divergence is NEVER retried (merge issued exactly once)', async () => {
    // Return a non-FF result twice; the helper must not retry after the first.
    const { command, calls } = makeCommandMock({
        'git merge --ff-only': [fail('fatal: Not possible to fast-forward, aborting.'), OK],
    });
    await assert.rejects(() => syncMemberBefore('m1', { command }), GitDivergedError);
    const mergeCalls = calls.filter((c) => /git merge --ff-only/.test(c.cmd));
    check(mergeCalls.length === 1, `diverged merge must not be retried, saw ${mergeCalls.length} merge calls`);
});

test('syncMemberBefore: a transient fetch failure is retried, then succeeds', async () => {
    const { command, calls } = makeCommandMock({
        'git fetch': [fail('fatal: unable to access ... Could not resolve host: github.com'), OK],
    });
    const res = await syncMemberBefore('m1', { command });
    check(res.ok, 'transient fetch failure should be retried to success');
    const fetchCalls = calls.filter((c) => /git fetch/.test(c.cmd));
    check(fetchCalls.length === 2, `transient fetch should be retried once, saw ${fetchCalls.length}`);
});

// =============================================================================
// syncMemberAfter (G-push): push, one bounded pull-rebase retry, typed errors.
// =============================================================================
test('syncMemberAfter: clean push succeeds with no rebase, explicit member_name', async () => {
    const { command, calls } = makeCommandMock({});
    const res = await syncMemberAfter('m1', { command });
    check(res.ok && res.pushed && !res.rebased, `expected clean push, got ${JSON.stringify(res)}`);
    check(calls.length === 1 && /git push/.test(calls[0].cmd), 'single push expected');
    check(calls[0].opts.member_name === 'm1', 'push must carry explicit member_name');
});

test('syncMemberAfter: pushCode:false is a no-op (nothing published)', async () => {
    const { command, calls } = makeCommandMock({});
    const res = await syncMemberAfter('m1', { command, pushCode: false });
    check(res.ok && !res.pushed, 'pushCode:false must not push');
    check(calls.length === 0, 'no git command should be issued when pushCode is false');
});

test('syncMemberAfter: non-FF push triggers EXACTLY ONE pull --rebase then a successful re-push', async () => {
    const { command, calls } = makeCommandMock({
        'git push': [fail(' ! [rejected] (non-fast-forward)'), OK], // first push rejected, second ok
        'git pull --rebase': [OK],
    });
    const res = await syncMemberAfter('m1', { command });
    check(res.ok && res.pushed && res.rebased, `expected rebased re-push success, got ${JSON.stringify(res)}`);
    const rebaseCalls = calls.filter((c) => /git pull --rebase/.test(c.cmd));
    const pushCalls = calls.filter((c) => /git push/.test(c.cmd));
    check(rebaseCalls.length === 1, `exactly one rebase expected, saw ${rebaseCalls.length}`);
    check(pushCalls.length === 2, `push should be retried exactly once after rebase, saw ${pushCalls.length}`);
});

test('syncMemberAfter: push still rejected after the one rebase raises typed GitDivergedError, no further retry', async () => {
    const { command, calls } = makeCommandMock({
        'git push': [fail(' ! [rejected] (non-fast-forward)')], // always rejected
        'git pull --rebase': [OK],
    });
    let err = null;
    try { await syncMemberAfter('m1', { command }); } catch (e) { err = e; }
    check(err instanceof GitDivergedError, `expected GitDivergedError, got ${err && err.constructor.name}`);
    check(err.member === 'm1' && /rejected/i.test(err.gitOutput || ''), 'diverged error carries member and git output');
    const pushCalls = calls.filter((c) => /git push/.test(c.cmd));
    const rebaseCalls = calls.filter((c) => /git pull --rebase/.test(c.cmd));
    check(pushCalls.length === 2, `push tried once + one re-push only, saw ${pushCalls.length}`);
    check(rebaseCalls.length === 1, `rebase bounded to one, saw ${rebaseCalls.length}`);
});

test('syncMemberAfter: a transient push failure is retried (not treated as divergence), then succeeds', async () => {
    const { command, calls } = makeCommandMock({
        'git push': [fail('fatal: unable to access ... Connection timed out'), OK],
    });
    const res = await syncMemberAfter('m1', { command });
    check(res.ok && res.pushed && !res.rebased, 'transient push failure retried without a rebase');
    const rebaseCalls = calls.filter((c) => /git pull --rebase/.test(c.cmd));
    check(rebaseCalls.length === 0, 'transient failure must not trigger a pull --rebase');
});

// =============================================================================
// Cross-check: the two failure classes are DISTINCT types, asserted separately
// (the crux of risk 2).
// =============================================================================
test('syncMemberAfter: a transient failure that exhausts retries raises GitSyncError, NOT GitDivergedError', async () => {
    const { command } = makeCommandMock({
        'git push': [fail('fatal: unable to access ... Connection timed out')], // never recovers
    });
    let err = null;
    try { await syncMemberAfter('m1', { command, maxTransientRetries: 1 }); } catch (e) { err = e; }
    check(err instanceof GitSyncError, `expected GitSyncError, got ${err && err.constructor.name}`);
    check(!(err instanceof GitDivergedError), 'transient-exhausted must NOT be a divergence error');
    check(err instanceof WorkflowError, 'GitSyncError must extend WorkflowError');
    check(err.member === 'm1' && /timed out/i.test(err.gitOutput || ''), 'sync error carries member and git output');
});
