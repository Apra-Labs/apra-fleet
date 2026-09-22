// =============================================================================
// PHASE MODULE: Ensure Sprint Branch (apra-fleet-3swo.6.2).
//
// The FIRST of runSprintCycle's twelve phase() boundaries, moved verbatim out of
// runner.js. This is a MOVE-ONLY extraction: the command sequence, the log
// text, the publishState payload and the group()/phase()/endGroup()
// presentation calls are byte-identical to the inline version, so the golden
// transcript is unchanged.
//
// EXPLICIT STATE, NOT A CLOSURE. The inline version read nine runSprintCycle
// locals off the enclosing scope. This module receives them as ONE explicit
// state argument instead -- the same object runSprintCycle threads to every
// phase module Phase 4 slices out. Nothing here reaches back into runner.js:
// the single pure helper this phase needs (decideEnsureBranchAction) is
// imported from ../branch-ensure.mjs, which is where that helper already lived.
//
// WHY THIS PHASE TAKES NO WORK FROM sprintState. The state object carries the
// sprint-scoped fleet client and the per-member VCS provider resolver
// (../sprint-state.mjs). This phase issues only plain git commands through
// command() and resolves no member shell of its own -- the one settle-shell
// resolution near this phase (the pre-flight beads-health gate) sits BEFORE
// the Ensure Sprint Branch boundary and stays in runner.js. So the state
// argument is destructured down to exactly the seams this phase uses, rather
// than accepting a field it would never read.
//
// GUARD COVERAGE: registered as 'phases/ensure-sprint-branch.mjs' in
// ../guarded-modules.mjs. It carries eight command() call sites, every one of
// them member_name-bearing, which is precisely why registration is part of
// this extraction rather than a follow-up -- an unregistered module loses all
// five mechanical guards silently while they keep reporting green.
//
// POST-EXTRACTION FIX (apra-fleet-3swo, fleet-mac regression investigation,
// not part of the move-only slice above): a 'diverged' abort was reported to
// an operator whose own checkout showed no local branch of that name at all.
// Reading decideEnsureBranchAction() and this phase's wiring end to end (plus
// the passing "no local branch -> fresh checkout" unit and mock-sprint
// coverage) turned up no misclassification -- the tip-comparison block below
// is correctly gated on `localBranchExists`, and a 'diverged' verdict is only
// reachable when git's own `rev-parse --verify --quiet` genuinely resolved
// the local ref. The much more likely explanation is an operational mismatch
// (the member's actual command-dispatch working directory, or a stale build,
// differing from wherever was manually inspected) rather than a code defect.
// Since a wrong-looking 'diverged' verdict is expensive to debug from the
// abort message alone, this phase now resolves and reports both tip SHAs on
// that path (see the diagnostic block below and the shaNote branch in
// decideEnsureBranchAction()) -- two extra command() call sites, so the
// EXPECTED_ENSURE_SPRINT_BRANCH_COMMAND_COUNT in
// test/dispatch-safety-guard.test.mjs went from 8 to 10.
// =============================================================================

import { decideEnsureBranchAction } from '../branch-ensure.mjs';

/**
 * Runs the Ensure Sprint Branch phase: fetch base and the sprint branch on
 * every ensure-set member, decide per member whether to reuse an existing
 * local branch or check one out from a start point, and dispatch that
 * decision -- preserving orphaned WIP in a named stash rather than aborting
 * or discarding it.
 *
 * @param {{
 *   command: Function,
 *   log: (msg: string) => void,
 *   group: (label: string) => void,
 *   phase: (label: string) => void,
 *   endGroup: () => void,
 *   publishState: (namespace: string, data: any) => void,
 *   branchEnsureMembers: string[],
 *   validated: { branch: string, baseBranch: string, goal: string, maxCycles: number, requirementsFile?: string|null },
 * }} state
 * @returns {Promise<void>}
 */
export async function runEnsureSprintBranchPhase({
    command,
    log,
    group,
    phase,
    endGroup,
    publishState,
    branchEnsureMembers,
    validated,
}) {
    // =======================
    // 0. Git Setup: ensure the sprint branch exists off base_branch
    // =======================
    // First GIT dispatch of the run -- runs before any bd/agent activity so
    // the whole sprint develops on `branch`, branched from `base_branch`.
    group('Sprint Setup');
    phase('Ensure Sprint Branch');
    // Dispatch the fetch + checkout to EVERY member in the ensure set, not just
    // the orchestrator. Sequential (not parallel) so the command log stays
    // deterministic.
    for (const member of branchEnsureMembers) {
        // Two sequential command() calls, not a single `a && b` shell string:
        // `&&` is a bash-ism that PowerShell 5.1 (Windows' default, pre-7.0)
        // rejects outright ("The token '&&' is not a valid statement
        // separator in this version"), breaking this phase on any Windows
        // member. command() already throws on a non-zero exit by default (no
        // failSoft here), so awaiting the fetch before the checkout
        // reproduces `&&`'s fail-fast semantics -- if the fetch fails, the
        // checkout is never attempted, on every OS/shell.
        await command(
            `git fetch origin ${validated.baseBranch} --quiet`,
            {
                member_name: member,
                silent: true,
                label: `Fetch '${validated.baseBranch}' on member '${member}'`,
            }
        );

        // Fetch <branch> itself before deciding the checkout start-point:
        // adopting origin/<branch> when it exists keeps real pushed sprint
        // history from being force-reset to base's tip on a relaunch, and makes
        // `checkout -B <branch> origin/<branch>` set up correct upstream
        // tracking. failSoft because a brand-new sprint branch legitimately
        // does not exist on origin yet, and that must never abort the run;
        // origin/<baseBranch> is the fallback only when it is genuinely new.
        const branchFetch = await command(
            `git fetch origin ${validated.branch} --quiet`,
            {
                member_name: member,
                silent: true,
                failSoft: true,
                label: `Fetch existing '${validated.branch}' (if any) on member '${member}'`,
            }
        );
        // Probe for a pre-existing local branch. When the remote ref is
        // missing, the naive fallback would force-reset that local branch to
        // base's tip, discarding commits that closed beads but were never
        // pushed and leaving beads and the git tree disagreeing. The probe also
        // runs when the fetch SUCCEEDED, because a successful fetch alone does
        // not make origin/<branch> authoritative if the local branch has
        // committed work origin does not (see the tip comparison below).
        const localProbe = await command(
            `git rev-parse --verify --quiet refs/heads/${validated.branch}`,
            {
                member_name: member,
                silent: true,
                failSoft: true,
                label: `Probe for pre-existing local branch '${validated.branch}' on member '${member}'`,
            }
        );
        const localBranchExists = localProbe.ok;

        // When both origin/<branch> and a local <branch> exist, compare their
        // tips with two `git merge-base --is-ancestor` checks (one each
        // direction) so decideEnsureBranchAction() never has to assume a
        // successful fetch means "safe to reset" -- see that function for the
        // ahead/behind/diverged case breakdown this feeds.
        let localTipStatus;
        if (branchFetch.ok && localBranchExists) {
            const localIsAncestorOfRemote = await command(
                `git merge-base --is-ancestor ${validated.branch} origin/${validated.branch}`,
                {
                    member_name: member,
                    silent: true,
                    failSoft: true,
                    label: `Check whether local '${validated.branch}' is an ancestor of 'origin/${validated.branch}' on member '${member}'`,
                }
            );
            const remoteIsAncestorOfLocal = await command(
                `git merge-base --is-ancestor origin/${validated.branch} ${validated.branch}`,
                {
                    member_name: member,
                    silent: true,
                    failSoft: true,
                    label: `Check whether 'origin/${validated.branch}' is an ancestor of local '${validated.branch}' on member '${member}'`,
                }
            );
            if (localIsAncestorOfRemote.ok && remoteIsAncestorOfLocal.ok) {
                localTipStatus = 'behind-or-equal'; // tips are equal
            } else if (localIsAncestorOfRemote.ok) {
                localTipStatus = 'behind-or-equal'; // local is a strict ancestor of origin
            } else if (remoteIsAncestorOfLocal.ok) {
                localTipStatus = 'ahead';
            } else {
                localTipStatus = 'diverged';
            }
        }

        // Diagnostic-only, and ONLY on the rare path that is about to abort:
        // name the two tip SHAs so a human reading the abort message can
        // immediately tell genuine divergence apart from "this member's
        // actual git working directory is not the one I just inspected" --
        // in practice the far more common explanation for a 'diverged'
        // report that looks wrong from the operator's own checkout. Cheap
        // and failSoft; never adds a command on the common (non-diverged)
        // path, and never blocks the abort if a probe itself fails.
        let localSha, remoteSha;
        if (localTipStatus === 'diverged') {
            const localShaRes = await command(
                `git rev-parse --short ${validated.branch}`,
                { member_name: member, silent: true, failSoft: true, label: `Resolve local '${validated.branch}' tip SHA for diagnostics on member '${member}'` }
            );
            const remoteShaRes = await command(
                `git rev-parse --short origin/${validated.branch}`,
                { member_name: member, silent: true, failSoft: true, label: `Resolve 'origin/${validated.branch}' tip SHA for diagnostics on member '${member}'` }
            );
            localSha = localShaRes.ok ? localShaRes.output.trim() : undefined;
            remoteSha = remoteShaRes.ok ? remoteShaRes.output.trim() : undefined;
        }

        // The fetch-outcome / local-probe / tip-comparison -> checkout-command
        // decision lives in the pure decideEnsureBranchAction() helper above;
        // this call site only turns that decision into a command()/log()
        // dispatch.
        const decision = decideEnsureBranchAction({
            branch: validated.branch,
            baseBranch: validated.baseBranch,
            branchFetchOk: branchFetch.ok,
            branchFetchError: branchFetch.error,
            localBranchExists,
            localTipStatus,
            localSha,
            remoteSha,
        });
        if (decision.action === 'abort') {
            throw new Error(`${decision.message} (member '${member}')`);
        }
        if (decision.reused) {
            if (branchFetch.ok) {
                log(
                    `Ensure Sprint Branch: local branch '${validated.branch}' on member '${member}' is AHEAD of ` +
                    `'origin/${validated.branch}' (has committed, unpushed work) -- reusing it as-is instead of ` +
                    `resetting to origin, to avoid discarding local-only commits.`
                );
            } else {
                log(
                    `Ensure Sprint Branch: remote ref for '${validated.branch}' is missing on member '${member}' ` +
                    `but a local branch of that name already exists -- reusing it as-is instead of resetting to base, ` +
                    `to avoid discarding local-only commits.`
                );
            }
        }
        const checkoutCommand = decision.command;
        const checkoutLabel = decision.reused
            ? (branchFetch.ok
                ? `Reuse existing local sprint branch '${validated.branch}' on member '${member}' (local ahead of origin)`
                : `Reuse existing local sprint branch '${validated.branch}' on member '${member}' (remote ref missing)`)
            : `Ensure sprint branch '${validated.branch}' from '${decision.startPoint}' on member '${member}'`;

        // An infrastructure-killed dispatch (transport drop, timeout,
        // stop_prompt) leaves the member's working tree DIRTY with whatever the
        // agent had in flight, and the checkout then fails with "Your local
        // changes ... would be overwritten". That orphaned WIP belongs to a
        // bead that is still open (a future streak redoes it properly), so
        // preserve it in a named stash and proceed -- never abort the sprint
        // over it, and never discard it. A clean tree issues no extra commands.
        const checkoutResult = await command(
            checkoutCommand,
            {
                member_name: member,
                silent: true,
                failSoft: true,
                label: checkoutLabel,
            }
        );
        if (!checkoutResult.ok) {
            if (!/would be overwritten/i.test(checkoutResult.error || '')) {
                throw new Error(
                    `Ensure Sprint Branch: checkout of '${validated.branch}' on member '${member}' failed for a ` +
                    `reason other than a dirty working tree (${checkoutResult.error || 'unknown error'}) -- aborting.`
                );
            }
            log(
                `Ensure Sprint Branch: member '${member}' has uncommitted changes (likely orphaned WIP from an ` +
                `interrupted prior dispatch) blocking checkout -- preserving them in a named stash and retrying.`
            );
            await command(
                `git stash push -u -m "fleet-sprint[${validated.branch}] auto-stash of orphaned WIP blocking branch ensure"`,
                {
                    member_name: member,
                    silent: true,
                    label: `Stash orphaned WIP on member '${member}'`,
                }
            );
            await command(
                checkoutCommand,
                {
                    member_name: member,
                    silent: true,
                    label: `${checkoutLabel} (post-stash retry)`,
                }
            );
        }
    }
    publishState('sprint-args', {
        branch: validated.branch,
        baseBranch: validated.baseBranch,
        goal: validated.goal,
        maxCycles: validated.maxCycles,
        requirementsFile: validated.requirementsFile || null,
    });
    endGroup();
}
