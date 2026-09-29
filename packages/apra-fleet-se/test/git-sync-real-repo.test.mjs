// The withGitSync() bracket driven against REAL git repositories
// (apra-fleet-j918.6.1).
//
// THE GAP THIS CLOSES. test/helpers/mock-sprint-harness.mjs intercepts every
// command matching /^(git|gh)\s/ and answers it with a literal success result
// ("ok (mocked -- no real git remote in this mock sprint)") unless the test
// opted into failure through `gitGhFailurePattern`. Nearly a hundred files
// under test/ import that harness, so across the whole suite every
// `git fetch`, `git merge --ff-only`, `git push`, `git pull --rebase`,
// `git rebase --abort` and `git status --porcelain` that fleet-sprint's
// git-sync.mjs / member-sync.mjs / git-topology.mjs issue has only ever
// SUCCEEDED, or failed in a way a test hand-authored. Nothing anywhere
// executed the bracket against a git that can genuinely refuse. An assertion
// that a command STRING was emitted cannot catch a wrong flag (`git merge`
// instead of `git merge --ff-only`), a wrong refspec, or a wrong recovery
// order -- only real git can.
//
// WHAT RUNS HERE. helpers/git-repo-fixture.mjs stands up a bare repo as the
// shared "origin", a member clone the bracket operates in, and a peer clone
// standing in for another machine publishing to the same branch. The injected
// command() executes the bracket's composed git string VERBATIM as real git.
// Every assertion below is about REAL REPOSITORY STATE afterwards -- which SHA
// origin's branch points at, the subject/topology of the commits reachable
// from it, whether any merge commit exists, whether the working tree is clean,
// whether a rebase was left in progress -- never about a command string having
// been issued. No network, no credentials, no GitHub, no `gh`.
//
// THE MOCK IS NOT TOUCHED. This suite is purely additive: the harness's
// git/gh interception and its `gitGhFailurePattern` failure injection remain
// exactly as they were, and remain the right tool for the sprint-shaped tests
// that need a deterministic simulated remote.
//
// FALSIFICATION (recorded per apra-fleet-j918.6.1's acceptance criteria).
// Each of these single-token edits to fleet-sprint/member-sync.mjs makes a
// named assertion group here fail, and nothing in the mock-based suites
// notices any of them:
//   1. Drop the fast-forward guard -- `git merge --ff-only ${remote}/${branch}`
//      -> `git merge ${remote}/${branch}` (member-sync.mjs, syncMemberBefore).
//      "G-pull: a genuine non-fast-forward divergence" stops throwing
//      GitDivergedError at all; real git happily mints a merge commit.
//   2. Drop the rebase from the reconcile retry -- `git pull --rebase ...`
//      -> `git pull --no-rebase ...` (member-sync.mjs, syncMemberAfter).
//      "G-push: a push that must be reconciled" still ends up green-ish on a
//      command-string test, but here origin grows a MERGE commit and the
//      doer commit is no longer a linear descendant of the peer commit.
//   3. Drop the reset from the resume path -- `git reset --hard <remote>/<branch>`
//      -> a no-op/merge (member-sync.mjs, syncMemberBefore's resetToRemoteTip
//      branch). "G-pull: resumeOntoRemoteTip" fails because the member's stale
//      unpublished commit survives instead of being discarded.
// The exact observed failure output for each is quoted on the bead.
//
// WALL CLOCK / LANE. Measured at ~5.1s for the whole file on a 2026 MacBook
// Pro -- 4 tests, ~1.1-1.4s each, every one of which builds its own throwaway
// bare origin plus three real clones and then runs the bracket's own git.
// That cost is git process spawns; nothing here waits on a timer (the
// post-dispatch retry ladder's real 5s/15s backoff is disabled for this file,
// see before() below). Two orders of magnitude under the suite's per-file
// budget and in the same band as the existing real-execution suite
// dolt-sync-configured-remote.test.mjs (~7s), so this file lives in `test/`
// and is picked up by the DEFAULT `test/*.test.mjs` glob that this package's
// `npm test` (scripts/run-tests.mjs mock) runs. That IS a lane CI executes:
// the root `npm test` (scripts/run-all-tests.mjs) runs this workspace's own
// `npm test` on every PR. It
// is deliberately NOT in `test/slow/`: that directory is only reached by the
// separate `npm run test:slow` script and is excluded from the default suite,
// so putting it there would have left this gap open while looking closed.
// No bd fixture is involved (nothing here shells `bd`), so the file behaves
// identically in mock, real and record bd modes.
//
// HOST GATING: explicit and loud. A host without a usable `git`, without a
// writable temp directory, or with a `git` too old to honour
// GIT_CONFIG_GLOBAL prints a DEGRADED line and skips WITH THAT REASON
// attached, rather than reporting a silent pass.
//
// ASCII only.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createSyncBrackets, createGitSync } from '../fleet-sprint/git-sync.mjs';
import { GitDivergedError } from '../fleet-sprint/errors.mjs';
import {
    syncMemberBefore,
    syncMemberAfter,
    syncMemberAfterOrdered,
    isNoMutationDispatchFailure,
} from '../fleet-sprint/runner.js';
import { createGitRepoFixture, probeGitRepoFixtureSupport } from './helpers/git-repo-fixture.mjs';

const support = probeGitRepoFixtureSupport();
if (!support.ok) {
    console.error(`[git-sync-real-repo] DEGRADED -- real-git bracket coverage did NOT run on this host: ${support.reason}`);
}

/**
 * Wire the bracket exactly the way runner.js's own createGitSync({...}) call
 * does, with the fixture's real-git command() in place of the live fleet's.
 * git-sync.mjs never imports runner.js back, so its sync helpers are always
 * dependency-injected -- these four are the same symbols runner.js injects.
 */
function makeGitSync(fixture, { brackets, log = () => {} } = {}) {
    const handle = brackets || createSyncBrackets();
    return createGitSync({
        brackets: handle,
        command: fixture.command,
        log,
        branch: fixture.branch,
        args: {},
        agent: undefined,
        doltPushMutex: undefined,
        sprintId: 'sprint-j918-6-1',
        onAuthFailure: undefined,
        resolveMemberProvider: undefined,
        ensureVcsAuthFresh: async () => {},
        syncMemberBefore,
        syncMemberAfter,
        syncMemberAfterOrdered,
        isNoMutationDispatchFailure,
    });
}

describe('withGitSync against a real git origin (no network, no credentials)', { skip: support.ok ? false : support.reason }, () => {
    let fixture;
    let priorInstantBackoff;

    before(() => {
        // The post-dispatch sync ladder sleeps 5s then 15s for real between
        // retries unless this is set. Nothing here is expected to need a
        // retry, but a regression that DID trigger one must show up as a
        // failed assertion, not as a 20-second CI outlier.
        priorInstantBackoff = process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF;
        process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF = '1';
    });

    after(() => {
        if (priorInstantBackoff === undefined) delete process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF;
        else process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF = priorInstantBackoff;
    });

    beforeEach(() => {
        fixture = null;
    });

    afterEach(() => {
        if (!fixture) return;
        const { root } = fixture;
        // SANDBOX CONTAINMENT, asserted rather than assumed: the fixture
        // redirects HOME/XDG_CONFIG_HOME/GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM
        // into `root`, so anything real git wrote for a "user" landed there
        // and is enumerable. Then the whole tree goes away.
        const homeEntries = fixture.homeEntries();
        const unexpected = homeEntries.filter((e) => !['.config', '.gitconfig', '.gitconfig-system'].includes(e));
        assert.deepEqual(unexpected, [], `real git wrote unexpected entries into the sandbox HOME: ${JSON.stringify(homeEntries)}`);
        fixture.cleanup();
        assert.equal(fs.existsSync(root), false, 'the fixture tempdir must be fully removed; nothing may outlive the test');
        fixture = null;
    });

    // -------------------------------------------------------------------
    // 1. The happy pull half: a clean fetch and a REAL fast-forward merge.
    // -------------------------------------------------------------------
    test('G-pull: a clean fetch plus a real fast-forward merge advances the member onto the published tip with no merge commit', async () => {
        fixture = createGitRepoFixture({ member: 'ff-member', prefix: 'j918-6-1-ff-' });
        const brackets = createSyncBrackets();
        const gitSync = makeGitSync(fixture, { brackets });

        // Another machine published while this member was idle.
        const peerSha = fixture.peerPublish('peer-published-work');
        assert.equal(fixture.originTip(), peerSha, 'precondition: origin carries the peer commit');
        assert.notEqual(fixture.localTip(), peerSha, 'precondition: the member has NOT seen it yet');

        let tipSeenByDispatch = null;
        let bracketCountDuringDispatch = null;
        const result = await gitSync.withGitSync('ff-member', true, async () => {
            // The pre-dispatch G-pull has already run by the time the dispatch
            // body executes -- this is the state a doer would actually start
            // from.
            tipSeenByDispatch = fixture.localTip();
            bracketCountDuringDispatch = gitSync.openBracketCount();
            return 'dispatch-ok';
        });

        assert.equal(result, 'dispatch-ok', 'the bracket returns the dispatch result untouched');

        // REAL STATE: the member fast-forwarded onto the peer's commit before
        // the dispatch body ran -- refs, not command strings.
        assert.equal(tipSeenByDispatch, peerSha, 'the dispatch body started from the peer-published tip, so fetch+merge really moved HEAD');
        assert.equal(fixture.localTip(), peerSha, 'the member clone HEAD is exactly the published SHA');
        assert.equal(fixture.localRemoteTrackingTip(), peerSha, 'the fetch really updated refs/remotes/origin/<branch>');
        assert.equal(fixture.originTip(), peerSha, 'the no-op post-dispatch push left origin exactly where it was');

        // TOPOLOGY: a fast-forward, not a merge.
        assert.deepEqual(fixture.localSubjects(), ['peer-published-work', 'seed'], 'linear history, newest first');
        assert.deepEqual(fixture.localMergeSubjects(), [], 'a fast-forward must not mint a merge commit');
        assert.equal(fixture.localStatus(), '', 'the working tree is clean after the bracket');
        assert.equal(fixture.localRebaseInProgress(), false, 'no rebase/merge state left behind');

        // The bracket accounting the clean-state pause guard reads is real
        // even while real git is running.
        assert.equal(bracketCountDuringDispatch, 1, 'exactly one sync bracket is open while the dispatch runs');
        assert.equal(gitSync.openBracketCount(), 0, 'the bracket closed');
    });

    // -------------------------------------------------------------------
    // 2. The divergence the --ff-only guard exists to catch.
    // -------------------------------------------------------------------
    test('G-pull: a genuine non-fast-forward divergence raises GitDivergedError and leaves the member unmerged, unmodified and undispatched', async () => {
        fixture = createGitRepoFixture({ member: 'diverged-member', prefix: 'j918-6-1-div-' });
        const gitSync = makeGitSync(fixture);

        // The single-writer-token invariant is genuinely broken: the member
        // has an unpublished local commit AND the peer published a different
        // one on the same branch. These touch different files, so this is a
        // pure TOPOLOGY divergence -- not a content conflict.
        const localSha = fixture.memberCommit('member-local-work');
        const peerSha = fixture.peerPublish('peer-concurrent-work');
        assert.notEqual(localSha, peerSha);

        let dispatched = false;
        const err = await gitSync.withGitSync('diverged-member', true, async () => {
            dispatched = true;
            return 'must-never-run';
        }).then(() => null, (e) => e);

        assert.ok(err instanceof GitDivergedError, `expected GitDivergedError, got ${err && err.constructor.name}: ${err && err.message}`);
        assert.equal(err.operation, 'pull', 'the divergence is attributed to the G-pull half');
        assert.equal(dispatched, false, 'a diverged G-pull aborts the bracket BEFORE the dispatch body runs');

        // REAL STATE: nothing was auto-merged, nothing was discarded.
        assert.equal(fixture.localTip(), localSha, 'the member HEAD is still its own local commit -- never auto-merged onto the peer commit');
        assert.equal(fixture.originTip(), peerSha, 'origin is untouched: the aborted bracket never pushed');
        assert.equal(fixture.localRemoteTrackingTip(), peerSha, 'the fetch half DID succeed and really updated the remote-tracking ref');
        assert.deepEqual(fixture.localMergeSubjects(), [], 'no merge commit was created -- this is exactly what --ff-only buys');
        assert.equal(fixture.isAncestor(peerSha, localSha), false, 'the two tips are still genuinely divergent');
        assert.equal(fixture.isAncestor(localSha, peerSha), false, 'the two tips are still genuinely divergent');
        assert.equal(fixture.localStatus(), '', 'the failed merge left a clean working tree');
        assert.equal(fixture.localRebaseInProgress(), false, 'no half-finished merge state left behind');
        assert.equal(gitSync.openBracketCount(), 0, 'the bracket decremented even on the throwing path');
    });

    // -------------------------------------------------------------------
    // 3. The push half: a REAL non-fast-forward rejection, reconciled by the
    //    one bounded pull --rebase, then re-pushed.
    // -------------------------------------------------------------------
    test('G-push: a push that must be reconciled really is rejected, rebased and re-pushed, leaving linear history on origin', async () => {
        fixture = createGitRepoFixture({ member: 'rebase-member', prefix: 'j918-6-1-reb-' });
        const gitSync = makeGitSync(fixture);

        let doerShaBeforeRebase = null;
        let peerSha = null;
        const result = await gitSync.withGitSync('rebase-member', true, async () => {
            // The doer commits its work...
            doerShaBeforeRebase = fixture.memberCommit('doer-work');
            // ...and, while it was working, another machine published to the
            // same branch. The post-dispatch G-push below is therefore a
            // genuinely non-fast-forward push that real git will reject.
            peerSha = fixture.peerPublish('peer-concurrent-work');
            return 'dispatch-ok';
        });

        assert.equal(result, 'dispatch-ok', 'the dispatch result survives the reconcile');

        const finalLocal = fixture.localTip();
        // REAL STATE: both commits are on origin, and the doer commit was
        // genuinely REWRITTEN by the rebase (a merge-based reconcile would
        // have preserved its SHA).
        assert.equal(fixture.originTip(), finalLocal, 'origin now points at exactly the member tip -- the re-push really landed');
        assert.notEqual(finalLocal, doerShaBeforeRebase, 'the doer commit was rewritten, proving a real rebase ran (a merge would keep the SHA)');
        assert.deepEqual(
            fixture.originSubjects(),
            ['doer-work', 'peer-concurrent-work', 'seed'],
            'origin history is linear with the doer commit replayed ON TOP of the concurrently published peer commit',
        );
        assert.deepEqual(fixture.originMergeSubjects(), [], 'the reconcile is a rebase, so origin must carry no merge commit');
        assert.equal(fixture.isAncestor(peerSha, finalLocal), true, 'the peer commit is an ancestor of the published tip -- its work was not dropped');
        assert.equal(fixture.localStatus(), '', 'the working tree is clean after the rebase and re-push');
        assert.equal(fixture.localRebaseInProgress(), false, 'no rebase was left in progress');
        assert.equal(gitSync.openBracketCount(), 0, 'the bracket closed');
    });

    // -------------------------------------------------------------------
    // 4. The documented recovery from case 2: resumeOntoRemoteTip.
    // -------------------------------------------------------------------
    test('G-pull: resumeOntoRemoteTip really hard-resets onto the fetched remote tip, discarding the stale unpublished commit', async () => {
        fixture = createGitRepoFixture({ member: 'resume-member', prefix: 'j918-6-1-res-' });
        const gitSync = makeGitSync(fixture);

        // Exactly the state case 2 refuses to fast-forward through: a local
        // unpublished commit plus a published peer commit. A retried dispatch
        // that may already have published takes this branch instead.
        const staleSha = fixture.memberCommit('stale-unpublished-retry-work');
        const peerSha = fixture.peerPublish('published-tip');

        let tipSeenByDispatch = null;
        await gitSync.withGitSync('resume-member', true, async () => {
            tipSeenByDispatch = fixture.localTip();
            return 'dispatch-ok';
        }, { resumeOntoRemoteTip: true });

        assert.equal(tipSeenByDispatch, peerSha, 'the retried dispatch resumes ON the published tip');
        assert.equal(fixture.localTip(), peerSha, 'the member HEAD is exactly the remote tip after the reset');
        assert.equal(fixture.isAncestor(staleSha, peerSha), false, 'the stale unpublished commit is genuinely gone, not merged in');
        assert.deepEqual(fixture.localSubjects(), ['published-tip', 'seed'], 'the discarded commit is absent from the resumed history');
        assert.deepEqual(fixture.localMergeSubjects(), [], 'a reset, not a merge');
        assert.equal(fixture.originTip(), peerSha, 'the no-op post-dispatch push left origin unchanged');
        assert.equal(fixture.localStatus(), '', 'the hard reset left a clean working tree');
        assert.equal(gitSync.openBracketCount(), 0, 'the bracket closed');
    });

    // -------------------------------------------------------------------
    // 5. apra-fleet-2wdc.8 (Track B2): a real push of a .github/workflows
    //    change through the engine's own Sync bracket. GitHub's own
    //    "refusing to allow ... without workflows permission" rejection
    //    (apra-fleet-2wdc's actual bug) is server-side and not reproducible
    //    against a local bare repo -- that gap is the operator referral
    //    recorded on the bead. What IS reproducible, and is exactly what
    //    this pins, is that the bracket's own git plumbing (the composed
    //    `git add`/`git push`/refspec handling in member-sync.mjs) does not
    //    itself reject or mangle a path under .github/workflows/ -- e.g. by
    //    quoting it wrong, truncating the nested directory, or otherwise
    //    tripping over the embedded '/'.
    // -------------------------------------------------------------------
    test('G-push: a change under .github/workflows/ pushes cleanly through the bracket, landing on origin at the exact nested path', async () => {
        fixture = createGitRepoFixture({ member: 'workflows-member', prefix: 'j918-6-1-wf-' });
        const gitSync = makeGitSync(fixture);

        const workflowYaml = 'name: ci\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n';
        let committedSha = null;
        const result = await gitSync.withGitSync('workflows-member', true, async () => {
            committedSha = fixture.memberCommitFile('.github/workflows/ci.yml', workflowYaml, 'add workflow change');
            return 'dispatch-ok';
        });

        assert.equal(result, 'dispatch-ok', 'the bracket returns the dispatch result untouched');

        // REAL STATE: the workflow-file commit really landed on origin, at
        // the exact nested path, with its exact content -- not rejected, not
        // mangled, not silently dropped.
        assert.equal(fixture.originTip(), committedSha, 'origin now points at the doer commit -- the push of the workflow-file change really landed');
        assert.equal(fixture.originFileAt('.github/workflows/ci.yml'), workflowYaml.trimEnd(), 'the workflow file landed on origin at the exact nested path with its exact content');
        assert.deepEqual(fixture.originSubjects(), ['add workflow change', 'seed'], 'linear history: no merge/rebase/rewrite was needed for an uncontested push');
        assert.equal(fixture.localStatus(), '', 'the working tree is clean after the bracket');
        assert.equal(fixture.localRebaseInProgress(), false, 'no rebase/merge state left behind');
        assert.equal(gitSync.openBracketCount(), 0, 'the bracket closed');
    });
});
