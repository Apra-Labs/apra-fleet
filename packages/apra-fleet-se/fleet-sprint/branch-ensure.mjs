// The pure branch-selection decision helper for fleet-sprint's Ensure Sprint
// Branch phase (apra-fleet-3swo.3.6). Moved verbatim out of runner.js --
// runner.js imports it back for its own Ensure Sprint Branch phase and for
// resyncReacquiredMember(). This is a move-only extraction: no I/O, no
// behaviour change -- the helper stays pure.

// Pure branch-selection decision for the Ensure Sprint Branch phase. Given the
// outcomes of the probes that phase issues -- a soft-failed
// `git fetch origin/<branch>` and, when that reports the ref is missing, a
// local-branch existence probe -- this decides which checkout command to run,
// or that the phase must abort rather than touch git at all. No I/O of its
// own; the caller still issues the command() calls and does the logging.
//
// Returns one of:
//   { action: 'abort', message } -- the fetch failed for a reason other than
//     "branch doesn't exist yet", or local and origin have diverged. The
//     caller must throw and never attempt a checkout: a transient fetch
//     failure misread as "new branch" would reset the branch to base and
//     destroy pushed work.
//   { action: 'checkout', reused: true, command } -- reuse an existing local
//     branch as-is (plain `git checkout`, no reset), preserving commits that
//     exist only locally.
//   { action: 'checkout', reused: false, command, startPoint } -- normal
//     `git checkout -B <branch> <startPoint>`, where startPoint is
//     `origin/<branch>` when the fetch succeeded and `origin/<baseBranch>`
//     when the branch is genuinely new.
//
// When the fetch succeeds and a local branch also exists, the two tips can
// still disagree, because a doer may have committed without its push
// succeeding. `localTipStatus` -- the caller's comparison of the two tips via
// `git merge-base --is-ancestor` in both directions -- resolves that:
//   'behind-or-equal' -- local holds nothing origin does not; safe to reset.
//   'ahead'           -- local holds commits origin does not and origin holds
//                        none local does not; reuse the local branch so those
//                        commits survive.
//   'diverged'        -- neither tip is an ancestor of the other; abort rather
//                        than attempt any automatic merge or rebase, since
//                        either direction could discard real commits.
export function decideEnsureBranchAction({ branch, baseBranch, branchFetchOk, branchFetchError, localBranchExists, localTipStatus, localSha, remoteSha }) {
    // A failed fetch is only safe to read as "branch doesn't exist yet" when
    // git says exactly that. Any other failure -- network blip, auth expiry,
    // DNS hiccup -- must not fall back to origin/<baseBranch>, or a transient
    // error would silently reset the branch to base.
    if (!branchFetchOk && !/couldn't find remote ref/i.test(branchFetchError || '')) {
        return {
            action: 'abort',
            message:
                `Ensure Sprint Branch: fetch of existing branch 'origin/${branch}' ` +
                `failed for a reason other than "branch doesn't exist" (${branchFetchError || 'unknown error'}) -- ` +
                `refusing to silently fall back to resetting to base, since the branch may actually exist with real ` +
                `pushed work and this fetch failure could be transient. Investigate and retry.`,
        };
    }

    // Both refs exist and neither tip is an ancestor of the other: never
    // attempt an automatic merge or rebase, abort and let a human reconcile.
    if (branchFetchOk && localBranchExists && localTipStatus === 'diverged') {
        const shaNote = (localSha || remoteSha)
            ? ` (local ${localSha || 'unknown'} vs 'origin/${branch}' ${remoteSha || 'unknown'} -- if 'git branch -vv' ` +
              `on the machine you are inspecting does not show '${branch}' at all, this member is very likely ` +
              `dispatching commands against a DIFFERENT git working directory than the one you checked; verify the ` +
              `member's actual registered working directory before assuming this is a real divergence.)`
            : '';
        return {
            action: 'abort',
            message:
                `Ensure Sprint Branch: local branch '${branch}' has diverged from 'origin/${branch}' ` +
                `(neither is an ancestor of the other) -- refusing to reset or auto-merge, since either direction ` +
                `could silently discard real commits. A human needs to investigate and reconcile the two branches ` +
                `manually before this sprint can safely proceed.${shaNote}`,
        };
    }

    const startPoint = branchFetchOk ? `origin/${branch}` : `origin/${baseBranch}`;
    // Reuse the local branch as-is (no reset) whenever the remote ref is
    // missing entirely, or it exists but the local branch is strictly ahead of
    // it -- resetting would discard committed-but-unpushed local work.
    const reuseLocalBranch =
        (!branchFetchOk && !!localBranchExists) ||
        (branchFetchOk && !!localBranchExists && localTipStatus === 'ahead');

    if (reuseLocalBranch) {
        return {
            action: 'checkout',
            reused: true,
            command: `git checkout ${branch}`,
        };
    }

    return {
        action: 'checkout',
        reused: false,
        command: `git checkout -B ${branch} ${startPoint}`,
        startPoint,
    };
}
