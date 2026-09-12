// =============================================================================
// PHASE MODULE: Publish PR (apra-fleet-3swo.6.9).
//
// The TWELFTH and LAST of runSprintCycle's twelve phase() boundaries: push the
// sprint branch and raise (but never merge) a pull request for it. Per the pm
// skill's R12 rule a human -- or a later, explicitly-scoped issue -- must
// review and merge; nothing here merges anything. Moved verbatim out of
// runner.js: every log line, PR title/body string and command() option is
// byte-identical to the inline version, so the golden transcript is unchanged.
// Move-only, no behaviour change.
//
// WHERE THIS PHASE STARTS AND STOPS. It starts at its own phase() call and
// ends where the inline version's final `endGroup()` used to sit. The
// `// 7. Publish` section banner above it, BOTH endGroup() calls and the two
// return objects stay in runner.js -- group('Finalization')/endGroup() wrap all
// four Finalization phases, not this one, and runSprintCycle's return value is
// the function's own contract. This phase returns `{ pushed }` and runner.js
// builds both return objects from it; that is the ONLY structural change, and
// it is behaviour-preserving in both directions:
//   - push failed: this phase logs [Publish Push Failed] and returns
//     pushed:false WITHOUT doing any PR/target-issue work, exactly as the
//     inline early return did; runner.js then endGroup()s and returns the
//     COMPUTED verdict with pushed:false.
//   - push succeeded: this phase runs the PR/target-issue work and returns
//     pushed:true; runner.js endGroup()s and returns the computed verdict.
// A genuine PR-creation failure still throws a typed CommandError from inside
// this phase, so it propagates out BEFORE runner.js's endGroup() -- same
// ordering the inline version had.
//
// THE BRANCH PUSH STAYS INSIDE A SYNC BRACKET (apra-fleet-3swo.4.1). The push
// goes through gitSync.pushGitAfter(), the bracketed syncMemberAfter() entry
// point -- never a raw `git push` and never the bare primitive -- so the pause
// guard reads "not clean" for its whole duration and a pause can never land
// mid-push of the sprint branch. Registering this module in
// ../guarded-modules.mjs is what keeps unbracketed-push-guard covering that
// site instead of silently losing it now that it has left runner.js. The
// non-hosted-remote target-issue closure's D-push likewise goes through
// gitSync.syncBeadsAfter(..., { pushBeads: true }).
//
// WHICH MEMBER DOES WHAT, AND WHY IT MATTERS. The branch push and the
// `git remote get-url origin` read run on publishGitMember -- the role-resolved
// 'harvester' member, a real dispatch member with an actual git checkout --
// NEVER orchestratorMember, which may be a shared/unreservable, git-less member
// (docs/design-orchestrator-worktree-model-v2.md section 4.3/4.5).
// raiseVcsPrForMember() and the direct `bd close` calls stay on
// orchestratorMember: a credential-file read plus a REST call, and beads
// mutations, neither of which needs a git checkout (section 4.6).
//
// WHY ITS HELPERS ARE INJECTED RATHER THAN IMPORTED. sanitizePrText is defined
// in ../runner.js, so importing it would be a circular import back into the
// file this module was sliced out of -- it is injected exactly as
// ./final-review.mjs injects it. command, gitSync, getMemberForRole and args
// are runSprintCycle-scoped, so there is nothing to import; vcsCapabilities,
// raiseVcsPrForMember, ApraFleet and CommandError live in real modules and are
// imported directly.
//
// GUARD COVERAGE: registered as 'phases/publish-pr.mjs' in
// ../guarded-modules.mjs. It took TWO member_name-bearing command() call sites
// out of runner.js -- the `git remote get-url origin` capability probe on
// publishGitMember and the per-target-issue `bd close` on orchestratorMember --
// plus the branch push and the beads D-push described above, and NO
// dispatchRole() site (it dispatches no agent; raiseVcsPrForMember is a REST
// call). That is exactly what dispatch-safety-guard, unbracketed-push-guard
// and the phase 3 dispatch census read, so all three baselines are pinned
// rather than assumed. It also owns the ONLY remaining vcsCapabilities() call
// site outside abort.mjs, which test/vcs-capabilities-table.test.mjs counts.
// =============================================================================

import { CommandError } from '@apralabs/apra-fleet-workflow';
import { ApraFleet } from '@apralabs/apra-fleet-client';
import { capabilities as vcsCapabilities } from '../vcs-module.mjs';
import { raiseVcsPrForMember } from '../vcs-auth.mjs';

/**
 * Runs the Publish PR phase: push the sprint branch, then either raise a PR on
 * a hosted remote or (on a remote that can never open one) close the target
 * issue(s) directly when the verdict passed.
 *
 * @param {object} state Explicit phase state; see this file's header.
 * @returns {Promise<{ pushed: boolean }>} Whether the sprint branch actually
 *   reached the remote. runner.js folds this straight into runSprintCycle's
 *   return value -- it never overrides the sprint's own computed verdict.
 */
export async function runPublishPrPhase({
    // Presentation + command seams.
    phase,
    log,
    command,
    // Sprint identity/config.
    args,
    validated,
    targetIssues,
    orchestratorMember,
    finalCycleLabel,
    // The sync brackets this phase's branch push and beads D-push go through.
    gitSync,
    // Role resolution for the git-capable publishing member (see header).
    getMemberForRole,
    // The verdict this phase publishes but must never change.
    finalVerdictResult,
    // Exported BY runner.js; injected to avoid a circular import (see header).
    sanitizePrText,
}) {
    phase(`Publish PR C${finalCycleLabel}`);
    // The branch push is the LAST step of a sprint that has already done all of
    // its work and computed a final verdict. A transient push failure (a racing
    // writer, a momentarily unreachable remote, a credential refresh in flight)
    // used to throw a CommandError from here, which converted a computed PASS
    // into `verdict: 'ABORTED'` and discarded the whole run's conclusion over a
    // network hiccup at the very end. So: failSoft plus the same short, bounded
    // sync backoff every other push round trip uses, and -- if it STILL will not
    // go through -- log loudly and return the COMPUTED verdict with
    // `pushed: false` rather than destroying it.
    //
    // A persistent failure also skips everything downstream of the push (PR
    // creation on a hosted remote; direct target-issue closure + D-push on a
    // non-hosted one). None of that may run against a branch whose commits
    // never reached the remote: a PR cannot be raised for unpushed work, and
    // closing the sprint's target issue would advertise a completion nobody can
    // see. This is the deliberately MINIMAL hardening -- the pluggable-publish
    // restructure is apra-fleet-647.2, which supersedes it.
    // apra-fleet: this push and the origin-remote read just below it run on
    // publishGitMember -- a real dispatch member with an actual git checkout
    // (harvester, falling back to the fallback pool like every other role
    // resolution in ../runner.js) -- NEVER orchestratorMember, which may be a
    // shared/unreservable, git-less member (docs/design-orchestrator-
    // worktree-model-v2.md section 4.3/4.5). raiseVcsPrForMember() below
    // stays on orchestratorMember: it is a credential-file read + REST call,
    // not git, and is explicitly designed to stay there (section 4.6).
    const publishGitMember = getMemberForRole('harvester');
    let pushed = false;
    let lastPushError = '';
    // apra-fleet-9wdh-adjacent (Publish-PR push self-heal): this used to retry
    // the byte-identical `git push` up to 3 times with no fetch/rebase step in
    // between -- fine for a transient/busy-remote failure, but a genuine
    // non-fast-forward rejection ("fetch first") is deterministic, so all 3
    // attempts failed identically and the branch's work was stranded local-
    // only. syncMemberAfter() (../git-sync.mjs) already implements the
    // correct self-heal for exactly this failure shape -- bounded transient
    // retry, then one pull-rebase-then-re-push on a genuine non-fast-forward
    // divergence, never a blind force-push -- and every OTHER post-dispatch
    // G-push in fleet-sprint already routes through it. Publish PR is the one
    // push site that bypassed it. Route through it here too instead of the
    // raw retry loop. NOTE: no `agent` is passed here, so a real content
    // conflict during the rebase (not just a plain non-FF race) throws
    // GitDivergedError directly rather than getting syncMemberAfter's
    // optional Tier 2 conflict-resolution-agent dispatch -- same as the old
    // loop, which had no Tier 2 either; not a regression.
    // (apra-fleet-3swo.4.1) ... and this G-push, unlike the Publish-PR D-push
    // just below, was never inside a sync bracket either -- a pause could land
    // mid-`git push` of the sprint branch. pushGitAfter() is the bracketed
    // syncMemberAfter() entry point; it threads the same command/log/branch/
    // onAuthFailure/provider-resolver state the bare call passed by hand.
    try {
        await gitSync.pushGitAfter(publishGitMember, { remote: 'origin', setUpstream: true });
        pushed = true;
    } catch (pushErr) {
        lastPushError = pushErr.message;
    }
    if (!pushed) {
        log(`[Publish Push Failed] Could not push sprint branch '${validated.branch}' to origin (bounded transient retry, and a rebase-then-re-push if diverged, both exhausted) -- the sprint's work is COMMITTED LOCALLY ONLY and is NOT on the remote. Skipping PR creation and target-issue closure (neither is meaningful for an unpushed branch); the sprint's own computed verdict (${finalVerdictResult.verdict}) is preserved and returned with pushed:false. Push the branch by hand and raise the PR, or re-run finalization once the remote is reachable. Last error: ${lastPushError}`);
        return { pushed: false };
    }
    // The final verdict is surfaced directly in the PR title and body -- a
    // human reviewer must never have to dig through sprint logs to learn
    // whether the run's own review gate passed. A FAIL verdict still publishes
    // the PR (never suppressed), with the verdict stated plainly so the
    // reviewer can weigh it before merging.
    const finalVerdictLabel = finalVerdictResult.verdict === 'PASS' ? 'PASS' : 'FAIL';

    // Resolve the sprint's own git 'origin' remote and classify it via
    // VCSModule.capabilities() BEFORE ever attempting the VCSModule REST
    // create-pull-request call. A remote whose provider cannot open a PR (a
    // file:// bare mirror, or any other host with no hosting API support)
    // means PR creation can never succeed, and attempting it anyway throws a
    // hard 'gh auth login required'-shaped CommandError that would fail the
    // whole sprint. Resolving the remote is itself failSoft -- an
    // unresolvable remote fails closed to canOpenPullRequest:false, per
    // capabilities()'s own contract -- so a probe hiccup here can never kill
    // the sprint.
    const originUrlRes = await command('git remote get-url origin', {
        member_name: publishGitMember,
        silent: true,
        failSoft: true,
        label: 'Resolve origin remote URL',
    });
    const originUrl = originUrlRes.ok ? originUrlRes.output.trim() : '';
    // (apra-fleet-3swo.4.10) capabilities() is already the provider-agnostic
    // hook -- it dispatches to WHICHEVER registered provider's matchesHost()
    // claims this remote's host (github, azure-devops, bitbucket, ... see
    // vcs-module.mjs's capabilities()), never a hardcoded GitHub check. The
    // log line below used to say "not a gh-hostable GitHub remote" even
    // though the gate itself was already provider-neutral -- that wording
    // was pure residue, not control flow, but a broken/misconfigured
    // Azure DevOps or Bitbucket remote hitting this same branch would have
    // been told (wrongly) that it looked like a GitHub problem. `host` is
    // carried through so the log names what was actually resolved, matching
    // finalizeAbort's identical gate (abort.mjs) which never had the stale
    // GitHub wording in the first place.
    const publishPrCapabilities = vcsCapabilities(originUrl);
    const hostedRemote = publishPrCapabilities.canOpenPullRequest;

    if (!hostedRemote) {
        log(`Publish PR: origin remote '${originUrl || '(unresolved)'}' cannot open a pull request (host: ${publishPrCapabilities.host || 'unknown'}) -- ` +
            'skipping PR creation entirely (no dependency on any VCS provider\'s auth for this path).');
        // A non-hosted remote can never complete PR creation, so target-issue
        // closure cannot be gated on it -- close the target issue(s) directly,
        // but only when the sprint's own final verdict actually passed. A FAIL
        // verdict must never be masked by closing the issue anyway; it still
        // ends the sprint 'failed' via the return value below, same as the
        // hosted-remote path.
        if (finalVerdictResult.verdict === 'PASS') {
            for (const id of targetIssues) {
                const closeRes = await command(`bd close ${id}`, {
                    member_name: orchestratorMember,
                    silent: true,
                    failSoft: true,
                    label: `Close target issue '${id}' directly (non-hosted remote, no PR gate)`,
                });
                if (closeRes.ok) {
                    log(`Publish PR: closed target issue '${id}' directly (non-hosted remote, PASS verdict).`);
                } else {
                    log(`Publish PR: failed to close target issue '${id}' directly (non-fatal, continuing): ${closeRes.error}`);
                }
            }
            await gitSync.syncBeadsAfter(orchestratorMember, { pushBeads: true });
        } else {
            log('Publish PR: final verdict is FAIL -- leaving target issue(s) open (not closing on a non-PASS verdict).');
        }
    } else {
        // finalVerdictResult.notes is LLM-authored free text -- sanitize with
        // sanitizePrText() (see the comment above its definition) BEFORE it is
        // ever embedded in the VCSModule-built create-pull-request command()
        // string below. validated.goal/validated.branch need no sanitization
        // here: both are already validated against shell-injection-safe patterns
        // (GOAL_PATTERN/BRANCH_NAME_PATTERN) at arg-validation time.
        const prTitle = `Auto-sprint [${finalVerdictLabel}]: ${validated.branch}`;
        const safeNotes = sanitizePrText(finalVerdictResult.notes);
        const prBody = [
            `Automated apra-fleet-se sprint (goal: ${validated.goal}).`,
            '',
            `Final Verdict: ${finalVerdictLabel}`,
            safeNotes ? `Notes: ${safeNotes}` : null,
            '',
            'Do NOT auto-merge -- see pm skill R12; a human must review and merge this PR.',
        ].filter((line) => line !== null).join('\n');

        // Idempotent PR creation via VCSModule (apra-fleet-tfx.8: the reverted
        // gh-based path is gone). A push+pr credential is minted just-in-time immediately
        // before this one call (never at sprint setup, never for any other
        // phase), VCSModule builds the orchestrator-side curl command, and
        // `orchestratorMember` dispatches it via execute_command -- no gh, no
        // server-side fallback. A re-run of finalization against a branch
        // that ALREADY has an open PR from a prior, otherwise-successful run
        // can be told apart from a genuine failure: the REST create-PR call
        // returns 422 "already exists" in that case -- that specific outcome
        // is swallowed (logged, not thrown) because it means the desired end
        // state (a PR is open for this branch) already holds. Any OTHER
        // failure (auth, network, a real API error, the injectable mock
        // failure below) is NOT swallowed -- it is re-raised as a typed
        // CommandError so it surfaces clearly rather than being silently
        // invisible.
        const fleetApiForPr = (args && typeof args.callTool === 'function') ? new ApraFleet({ callTool: args.callTool }) : null;
        if (!fleetApiForPr) {
            // Graceful degradation (apra-fleet-tfx.8.1): minting the push+pr
            // credential VCSModule needs to raise this PR requires an MCP
            // client. When no callTool is wired (e.g. a mock-sprint scenario
            // that never opted into an MCP client), the sprint branch is
            // already pushed by the withGitSync bracket -- so rather than an
            // unconditional hard-throw that would fail every such pre-existing
            // scenario at the very last step, this degrades to a clear,
            // skipped-PR log and lets the sprint report its real verdict. In
            // production callTool is always wired (bin/cli.mjs), so this branch
            // never runs there; it exists purely so PR creation is not a hard
            // MCP dependency for callers that legitimately have none. A genuine
            // PR-creation FAILURE (auth, network, a real API error) still
            // throws below -- only the callTool-absent case is degraded.
            log(`[Publish PR Skipped] no MCP callTool available to mint a push+pr credential for member '${orchestratorMember}' -- branch '${validated.branch}' is pushed but the PR was not raised.`);
        } else {
            const prResult = await raiseVcsPrForMember({
                fleetApi: fleetApiForPr,
                command,
                member: orchestratorMember,
                base: validated.baseBranch,
                head: validated.branch,
                title: prTitle,
                body: prBody,
                log,
                logPrefix: '[Publish PR]',
                // Already resolved above via publishGitMember (a real
                // git-capable member) for the PR-capability gate -- skip
                // re-deriving it a second time by shelling out to
                // orchestratorMember, which may have no git checkout of its
                // own to read a remote from (docs/design-orchestrator-
                // worktree-model-v2.md section 4.6: this call stays workspace-
                // independent by design, credential-file-read + REST only).
                remoteUrlOverride: originUrl,
            });
            if (!prResult.ok) {
                if (prResult.authFailure) {
                    // apra-fleet-5co8.15: an auth failure raiseVcsPrForMember
                    // could not clear -- including one that never got past
                    // credential provisioning, e.g. a missing Azure DevOps PAT
                    // credential-store entry -- degrades the publish phase
                    // instead of aborting the sprint, same policy
                    // finalizeAbort() already applies to its own authFailure
                    // outcome (see ../abort.mjs). The branch is already pushed; only
                    // the PR itself is skipped.
                    log(`[Publish PR Skipped] could not raise a PR for branch '${validated.branch}' -> '${validated.baseBranch}' (branch is pushed) due to an unrecoverable VCS auth failure: ${prResult.error}`);
                } else {
                    throw new CommandError(
                        `[Publish PR Failed] VCSModule create-pull-request failed for branch '${validated.branch}' -> '${validated.baseBranch}': ${prResult.error}`,
                        { details: { branch: validated.branch, baseBranch: validated.baseBranch, error: prResult.error } }
                    );
                }
            } else if (prResult.alreadyExists) {
                log(`Publish PR: a PR for branch '${validated.branch}' already exists -- treating as idempotent success.`);
            }
        }
    }

    return { pushed: true };
}
