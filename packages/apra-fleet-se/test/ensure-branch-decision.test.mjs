import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideEnsureBranchAction } from '../fleet-sprint/runner.js';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-9te.4.3 (verification for apra-fleet-9te.4 / apra-fleet-9te.4.1):
// exercises decideEnsureBranchAction() -- the extracted, pure branch-selection
// decision the Ensure Sprint Branch phase in fleet-sprint/runner.js makes once
// it has the results of its two probes (a soft-failed `git fetch
// origin/<branch>`, and, only when that fetch reports the ref missing, a
// `git rev-parse --verify --quiet refs/heads/<branch>` local-branch probe).
//
// Before apra-fleet-9te.4.1, the naive fallback
// (`checkout -B <branch> origin/<baseBranch>`) silently force-reset ANY
// pre-existing local `<branch>` to base's tip whenever the remote ref was
// missing -- discarding commits from a prior --max-cycles-limited cycle that
// closed beads but never got pushed. These three cases are the regression
// matrix for that fix:
//   1. A local-only branch (with a commit not on base, never pushed) plus a
//      missing remote ref must be REUSED as-is (plain `git checkout
//      <branch>`, no reset), so its commit survives.
//   2. A genuinely-new branch (no local ref) with a missing remote ref must
//      still fall back to `origin/<baseBranch>` (sanity: unchanged
//      behavior for the legitimately-new-branch case).
//   3. A fetch failure for any OTHER reason (not "branch doesn't exist yet")
//      must abort loudly instead of ever attempting a checkout -- collapsing
//      this with case 2 would silently discard real pushed work on a
//      transient failure, exactly the data-loss bug apra-fleet-9te.4.1 fixed.
//
// Because decideEnsureBranchAction() is pure (no git I/O of its own -- see
// its doc comment in runner.js), "commit survives" for case 1 is verified at
// this layer by asserting the decision returns the non-destructive plain
// `git checkout <branch>` form (no `-B` reset flag, no origin start-point):
// that is precisely the command the real Ensure Sprint Branch phase then
// issues against the actual branch, and a plain checkout never moves the
// branch tip, so whatever commit is already there is left untouched.
// =============================================================================

test('decideEnsureBranchAction: local-only branch + missing remote ref -> reuse local as-is (commit-preserving)', () => {
    const decision = decideEnsureBranchAction({
        branch: 'auto-sprint/mock-preserve',
        baseBranch: 'main',
        branchFetchOk: false,
        branchFetchError: "fatal: couldn't find remote ref auto-sprint/mock-preserve",
        localBranchExists: true,
    });

    check(decision.action === 'checkout', `Expected a checkout decision, got: ${JSON.stringify(decision)}`);
    check(decision.reused === true, `Expected the local branch to be marked as reused, got: ${JSON.stringify(decision)}`);
    check(
        decision.command === 'git checkout auto-sprint/mock-preserve',
        `Expected a plain, non-destructive checkout (no -B, no reset start-point) so the local-only commit survives, got: ${decision.command}`
    );
    // The critical negative assertion: the destructive `-B <branch>
    // <startPoint>` reset form -- which would discard the local-only
    // commit -- must never be produced for this case.
    check(!/-B\b/.test(decision.command), `Expected no -B reset flag in the reuse-local checkout command, got: ${decision.command}`);
    check(!decision.command.includes('origin/'), `Expected the reuse-local checkout to never reference an origin start-point, got: ${decision.command}`);
});

test('decideEnsureBranchAction: no local branch + missing remote ref -> falls back to origin/<baseBranch> (sanity, unchanged behavior)', () => {
    const decision = decideEnsureBranchAction({
        branch: 'auto-sprint/mock-new-branch',
        baseBranch: 'main',
        branchFetchOk: false,
        branchFetchError: "fatal: couldn't find remote ref auto-sprint/mock-new-branch",
        localBranchExists: false,
    });

    check(decision.action === 'checkout', `Expected a checkout decision, got: ${JSON.stringify(decision)}`);
    check(decision.reused === false, `Expected the new-branch fallback path (not a local reuse), got: ${JSON.stringify(decision)}`);
    check(decision.startPoint === 'origin/main', `Expected the fallback start-point to be origin/<baseBranch>, got: ${decision.startPoint}`);
    check(
        decision.command === 'git checkout -B auto-sprint/mock-new-branch origin/main',
        `Expected the standard checkout -B from origin/<baseBranch>, got: ${decision.command}`
    );
});

test('decideEnsureBranchAction: fetch fails for a non-missing-ref reason -> aborts loudly, never proposes a checkout', () => {
    const decision = decideEnsureBranchAction({
        branch: 'auto-sprint/mock-transient-failure',
        baseBranch: 'main',
        branchFetchOk: false,
        branchFetchError: 'fatal: unable to access remote: Could not resolve host',
        // A caller would never even run the local-branch probe in this
        // case (runner.js's own `if (!branchFetch.ok)` gate governs whether
        // to issue the rev-parse at all) -- passing localBranchExists here
        // regardless proves the abort decision does not depend on it.
        localBranchExists: true,
    });

    check(decision.action === 'abort', `Expected an abort decision for a non-missing-ref fetch failure, got: ${JSON.stringify(decision)}`);
    check(
        decision.message.includes('failed for a reason other than "branch doesn\'t exist"'),
        `Expected the discrimination message, got: ${decision.message}`
    );
    check(
        decision.message.includes('Could not resolve host'),
        `Expected the underlying git failure text to be surfaced, got: ${decision.message}`
    );
    check(decision.command === undefined, `Expected no checkout command to be proposed on abort, got: ${JSON.stringify(decision)}`);
});

test('decideEnsureBranchAction: successful branch fetch + local behind-or-equal origin -> resets to origin/<branch> (normal/expected case)', () => {
    const decision = decideEnsureBranchAction({
        branch: 'auto-sprint/mock-existing-remote',
        baseBranch: 'main',
        branchFetchOk: true,
        branchFetchError: null,
        localBranchExists: true,
        localTipStatus: 'behind-or-equal',
    });

    check(decision.action === 'checkout', `Expected a checkout decision, got: ${JSON.stringify(decision)}`);
    check(decision.reused === false, `Expected the authoritative-origin path (not local reuse) when local is behind-or-equal, got: ${JSON.stringify(decision)}`);
    check(
        decision.command === 'git checkout -B auto-sprint/mock-existing-remote origin/auto-sprint/mock-existing-remote',
        `Expected checkout -B from origin/<branch>, got: ${decision.command}`
    );
});

test('decideEnsureBranchAction: successful branch fetch + no local branch -> resets to origin/<branch> (sanity, unchanged behavior)', () => {
    // When there is no local branch at all, tip comparison is never run by
    // the caller (localTipStatus stays undefined) -- must still take the
    // normal reset path, not be misread as "diverged" or "ahead".
    const decision = decideEnsureBranchAction({
        branch: 'auto-sprint/mock-existing-remote',
        baseBranch: 'main',
        branchFetchOk: true,
        branchFetchError: null,
        localBranchExists: false,
        localTipStatus: undefined,
    });

    check(decision.action === 'checkout', `Expected a checkout decision, got: ${JSON.stringify(decision)}`);
    check(decision.reused === false, `Expected the authoritative-origin path (no local branch to preserve), got: ${JSON.stringify(decision)}`);
    check(
        decision.command === 'git checkout -B auto-sprint/mock-existing-remote origin/auto-sprint/mock-existing-remote',
        `Expected checkout -B from origin/<branch>, got: ${decision.command}`
    );
});

// =============================================================================
// apra-fleet-co4 (CONFIRMED LIVE DATA LOSS, 2026-07-27): apra-fleet-9te.4.1's
// fix only covered "origin ref for <branch> is entirely missing" -- it did
// NOT cover "origin ref exists, but the local checkout has additional
// commits ahead of it that were never pushed" (a doer commit whose own push
// failed, or a sprint killed/restarted before the orchestrator's push
// bracket ran for that commit). The prior version of this function treated
// any successful fetch as unconditionally authoritative and always issued
// `git checkout -B <branch> origin/<branch>`, silently discarding those
// local-only commits -- exactly what destroyed commit a919b53a
// (apra-fleet-eft.68.1) on member fleet-mac. These are the regression cases
// for that fix.
// =============================================================================

test('decideEnsureBranchAction: successful branch fetch + local branch AHEAD of origin -> reuse local as-is (commit-preserving, the eft.68.1 incident scenario)', () => {
    const decision = decideEnsureBranchAction({
        branch: 'feat/sprint-service-1',
        baseBranch: 'main',
        branchFetchOk: true,
        branchFetchError: null,
        localBranchExists: true,
        localTipStatus: 'ahead',
    });

    check(decision.action === 'checkout', `Expected a checkout decision, got: ${JSON.stringify(decision)}`);
    check(decision.reused === true, `Expected the local branch to be marked as reused, got: ${JSON.stringify(decision)}`);
    check(
        decision.command === 'git checkout feat/sprint-service-1',
        `Expected a plain, non-destructive checkout (no -B, no reset start-point) so the unpushed local commits survive, got: ${decision.command}`
    );
    check(!/-B\b/.test(decision.command), `Expected no -B reset flag in the reuse-local checkout command, got: ${decision.command}`);
    check(!decision.command.includes('origin/'), `Expected the reuse-local checkout to never reference an origin start-point, got: ${decision.command}`);
});

test('decideEnsureBranchAction: successful branch fetch + local branch DIVERGED from origin -> aborts loudly, never attempts an automatic merge', () => {
    const decision = decideEnsureBranchAction({
        branch: 'feat/sprint-service-1',
        baseBranch: 'main',
        branchFetchOk: true,
        branchFetchError: null,
        localBranchExists: true,
        localTipStatus: 'diverged',
    });

    check(decision.action === 'abort', `Expected an abort decision for a diverged local branch, got: ${JSON.stringify(decision)}`);
    check(
        decision.message.includes('diverged'),
        `Expected the diverged-branch discrimination message, got: ${decision.message}`
    );
    check(decision.command === undefined, `Expected no checkout command to be proposed on abort, got: ${JSON.stringify(decision)}`);
});
