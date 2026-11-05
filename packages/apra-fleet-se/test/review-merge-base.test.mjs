// Review diff base: the reviewer and Final Review prompts name
// `<merge-base-sha>..<branch>`, where the SHA is computed on the reviewer's
// member as `git merge-base origin/<base> <branch>` after `git fetch origin
// <base>`. Never the member's local base branch, which the engine does not
// update and which can be arbitrarily far behind.
//
// ASCII only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CancelledError } from '@apralabs/apra-fleet-workflow';
import { resolveReviewMergeBase, resolveFinalReviewMergeBase } from '../fleet-sprint/git-topology.mjs';
import { GitSyncError } from '../fleet-sprint/errors.mjs';
import { buildReviewerPrompt, buildFinalVerdictPrompt, reviewDiffRange } from '../fleet-sprint/prompts.mjs';
import { createGitRepoFixture, probeGitRepoFixtureSupport } from './helpers/git-repo-fixture.mjs';
import { runOnce, uniqueMockBranch, withScenarioMarkers, MOCK_REVIEW_MERGE_BASE_SHA } from './helpers/mock-sprint-harness.mjs';

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const support = probeGitRepoFixtureSupport();

test('regression: a local base branch far behind origin still yields the fork point, not the stale local base', { skip: support.ok ? false : support.reason }, async () => {
    // The fixture's shared branch plays the BASE branch here.
    const fx = createGitRepoFixture({ branch: 'main', prefix: 'review-merge-base-' });
    try {
        // origin/main moves ahead of the member's local main (never updated).
        for (let i = 1; i <= 5; i += 1) fx.peerPublish(`base-before-${i}`);
        // The sprint branch is cut from a freshly fetched origin/main, as the
        // engine does; local main stays at the seed commit.
        fx.gitSetup(['fetch', 'origin']);
        const forkPoint = fx.localRev('origin/main');
        fx.gitSetup(['checkout', '-b', 'feat/x', 'origin/main']);
        fx.memberCommit('sprint-work-1');
        fx.memberCommit('sprint-work-2');
        // origin/main keeps moving during the sprint.
        fx.peerPublish('base-after-1');
        fx.peerPublish('base-after-2');

        assert.equal(fx.localRev('main'), fx.seedSha, 'precondition: the local base branch is stale');
        const staleBase = fx.gitSetup(['merge-base', 'main', 'feat/x']).stdout;
        assert.equal(staleBase, fx.seedSha);
        assert.notEqual(staleBase, forkPoint);

        const sha = await resolveReviewMergeBase({
            command: fx.command, member: fx.member, baseBranch: 'main', branch: 'feat/x',
        });
        assert.equal(sha, forkPoint, 'the review base must be the fork point from origin/main');
        assert.notEqual(sha, fx.seedSha);

        // The range shows exactly the sprint's own two commits.
        const log = fx.gitSetup(['log', '--format=%s', `${sha}..feat/x`]).stdout.split('\n').filter(Boolean);
        assert.deepEqual(log, ['sprint-work-2', 'sprint-work-1']);

        // Exactly fetch then merge-base, on the reviewer's member, never the bare local base.
        const cmds = fx.calls.map((c) => c.cmd);
        assert.deepEqual(cmds, ['git fetch origin main', 'git merge-base origin/main feat/x']);
        for (const c of fx.calls) assert.equal(c.opts.member_name, fx.member);
        assert.ok(!cmds.some((c) => /(^|\s)main\.\./.test(c)), 'no command may name the bare local base');
    } finally {
        fx.cleanup();
    }
});

test('a failed fetch fails loudly and never computes a merge base against the local base', async () => {
    const calls = [];
    const command = async (cmd, opts) => {
        calls.push(cmd);
        if (/^git fetch /.test(cmd)) return { ok: false, output: '', error: "fatal: 'origin' does not appear to be a git repository" };
        return { ok: true, output: SHA, error: null };
    };
    await assert.rejects(
        resolveReviewMergeBase({ command, member: 'm1', baseBranch: 'main', branch: 'feat/x' }),
        (err) => /\[Review Base\]/.test(err.message) && /git fetch origin main failed/.test(err.message),
    );
    assert.ok(calls.every((c) => /^git fetch origin main$/.test(c)), `only the fetch may run, got ${JSON.stringify(calls)}`);
});

test('a failed or non-SHA merge-base fails loudly', async () => {
    const failing = async (cmd) => (/^git merge-base /.test(cmd)
        ? { ok: false, output: '', error: 'fatal: Not a valid object name feat/x' }
        : { ok: true, output: '', error: null });
    await assert.rejects(
        resolveReviewMergeBase({ command: failing, member: 'm1', baseBranch: 'main', branch: 'feat/x' }),
        /\[Review Base\] git merge-base origin\/main feat\/x failed/,
    );
    const garbage = async () => ({ ok: true, output: 'ok', error: null });
    await assert.rejects(
        resolveReviewMergeBase({ command: garbage, member: 'm1', baseBranch: 'main', branch: 'feat/x' }),
        /did not return a commit SHA/,
    );
});

test('Final Review base: a transient failure is retried once and succeeds', async () => {
    let n = 0;
    const logs = [];
    const resolve = async () => { n += 1; if (n === 1) throw new GitSyncError('[Review Base] fetch failed'); return SHA; };
    const sha = await resolveFinalReviewMergeBase(resolve, { member: 'm1', branch: 'feat/x', baseBranch: 'main', log: (m) => logs.push(m) });
    assert.equal(sha, SHA);
    assert.equal(n, 2);
    assert.ok(logs.some((m) => /retrying once/.test(m)));
});

test('Final Review base: a second failure is a loud GitSyncError with a relaunch hint', async () => {
    let n = 0;
    const resolve = async () => { n += 1; throw new GitSyncError(`fetch failed #${n}`); };
    await assert.rejects(
        resolveFinalReviewMergeBase(resolve, { member: 'm1', branch: 'feat/x', baseBranch: 'main' }),
        (err) => err.name === 'GitSyncError'
            && /Final Review was NOT dispatched/.test(err.message)
            && /fetch failed #2/.test(err.message)
            && /No work is lost/.test(err.message)
            && /relaunch the sprint on the same branch 'feat\/x' with base 'main'/.test(err.message),
    );
    assert.equal(n, 2, 'exactly one retry');
});

for (const [name, make] of [
    ['a CancelledError (operator stop)', () => new CancelledError('stopped by operator')],
    ['a generic Error', () => new Error('unexpected bug')],
]) {
    test(`Final Review base: ${name} from the first attempt propagates unchanged, with no retry`, async () => {
        let n = 0;
        const logs = [];
        const thrown = make();
        const resolve = async () => { n += 1; throw thrown; };
        await assert.rejects(
            resolveFinalReviewMergeBase(resolve, { member: 'm1', branch: 'feat/x', baseBranch: 'main', log: (m) => logs.push(m) }),
            (err) => err === thrown && !(err instanceof GitSyncError),
        );
        assert.equal(n, 1, 'no retry');
        assert.ok(!logs.some((m) => /retrying once/.test(m)), 'no retry log line');
    });
}

test('Final Review base: a CancelledError on the retry propagates unchanged, not re-worded', async () => {
    let n = 0;
    const cancel = new CancelledError('stopped by operator');
    const resolve = async () => { n += 1; throw n === 1 ? new GitSyncError('fetch failed') : cancel; };
    await assert.rejects(
        resolveFinalReviewMergeBase(resolve, { member: 'm1', branch: 'feat/x', baseBranch: 'main' }),
        (err) => err === cancel,
    );
    assert.equal(n, 2);
});

test('resolveReviewMergeBase: a CancelledError from command() propagates unchanged', async () => {
    const cancel = new CancelledError('stopped by operator');
    const command = async () => { throw cancel; };
    await assert.rejects(
        resolveReviewMergeBase({ command, member: 'm1', baseBranch: 'main', branch: 'feat/x' }),
        (err) => err === cancel,
    );
});

test('both prompts print <sha>..<branch>, say to use exactly that range, and never a bare <base>..<branch>', () => {
    const reviewer = buildReviewerPrompt({
        beadIds: ['x-1'], acceptanceCriteriaJson: '[]', baseBranch: 'main', branch: 'feat/x', mergeBaseSha: SHA,
    });
    const finalPrompt = buildFinalVerdictPrompt({
        targetIssues: ['x-1'], branch: 'feat/x', baseBranch: 'main', mergeBaseSha: SHA, goal: 'P1/P2', cyclesRun: 1,
        closedCount: 1, openAtGoalCount: 0, deployFailures: [], integFailures: [],
    });
    for (const p of [reviewer, finalPrompt]) {
        assert.ok(p.includes(`${SHA}..feat/x`), 'prompt must name the merge-base range');
        assert.match(p, /Use exactly this range for every git diff and git log/);
        assert.ok(!p.includes('main..feat/x'), 'prompt must not name the bare base range');
        assert.ok(!p.includes('base_branch..branch'));
    }
});

test('the prompt builders refuse to build without a merge-base SHA', () => {
    assert.throws(() => buildReviewerPrompt({ beadIds: ['x-1'], acceptanceCriteriaJson: '[]', baseBranch: 'main', branch: 'feat/x' }), /merge-base commit SHA/);
    assert.throws(() => buildFinalVerdictPrompt({
        targetIssues: ['x-1'], branch: 'feat/x', baseBranch: 'main', goal: 'P1/P2', cyclesRun: 1,
        closedCount: 1, openAtGoalCount: 0, deployFailures: [], integFailures: [],
    }), /merge-base commit SHA/);
    assert.throws(() => reviewDiffRange('main', 'feat/x'), /merge-base commit SHA/);
});

test('mock sprint: every reviewer and Final Review dispatch is preceded by fetch + merge-base and names that range', async () => {
    await withScenarioMarkers('review merge base', async () => {
        // 'run1' reuses the happy-path bd recording (bd-replay needs one per tag).
        const tag = 'run1';
        const branch = uniqueMockBranch(tag);
        const run = await runOnce(tag);
        assert.equal(run.result && run.result.status, 'success', `run did not succeed: ${JSON.stringify(run.result)}`);

        const reviews = run.dispatched.filter((d) => d.agent === 'reviewer');
        assert.ok(reviews.length >= 2, 'expected at least one per-round review and the Final Review');
        assert.ok(reviews.some((d) => d.label === 'Final Review'), 'expected a Final Review dispatch');
        for (const d of reviews) {
            assert.ok(d.prompt.includes(`${MOCK_REVIEW_MERGE_BASE_SHA}..${branch}`), `reviewer prompt lacks the merge-base range: ${d.prompt.slice(0, 400)}`);
            assert.ok(!d.prompt.includes(`main..${branch}`), 'reviewer prompt must not name the bare base range');
        }

        const mergeBases = run.commandLog.filter((c) => c === `git merge-base origin/main ${branch}`);
        assert.ok(mergeBases.length >= reviews.length, `expected one merge-base per review dispatch (${reviews.length}), got ${mergeBases.length}`);
        // Each merge-base is preceded by its own fetch of the base branch
        // (a fresh `git fetch origin main` since the previous merge-base).
        let fetchedSinceLast = false;
        for (const c of run.commandLog) {
            if (c === 'git fetch origin main') fetchedSinceLast = true;
            if (c === `git merge-base origin/main ${branch}`) {
                assert.ok(fetchedSinceLast, 'every merge-base must follow a fresh git fetch origin main');
                fetchedSinceLast = false;
            }
        }
    });
});
