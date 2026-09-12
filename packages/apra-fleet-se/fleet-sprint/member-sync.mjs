// =============================================================================
// MEMBER SYNC -- the per-member git/dolt sync brackets
// (apra-fleet-3swo.6.10)
// =============================================================================
//
// Moved VERBATIM out of runner.js. This module owns the four bracket entry
// points the orchestrator wraps every dispatch (and every resume) in:
//
//   1. syncMemberBefore() -- G-pull: fetch + ff-only merge (or a reset to the
//      remote tip on a mutating retry) before a member does any work.
//   2. syncMemberAfter() -- G-push: push, with ONE bounded pull-rebase retry
//      and the Tier 2 conflict-resolution dispatch behind it.
//   3. syncMemberAfterOrdered() -- the ordered post-dispatch step: G-push
//      (code) BEFORE D-push (beads), so a bead close can never be published
//      ahead of the code that justifies it.
//   4. resyncReacquiredMember() -- the resume path's unconditional
//      re-reconciliation of ONE member that was just re-acquired.
//
// These are the CALLERS of the git-topology layer (./git-topology.mjs), not
// part of it: every git command they issue goes through runGitStep, and every
// failure they classify goes through resolveGitProviderForClassification.
// git-topology.mjs's own header records that these four deliberately stayed in
// runner.js when it was extracted; they now live here, which is why this
// extraction had to run AFTER that one -- the other order would have forced a
// temporary back-import from runner.js into the new module.
//
// WHY resolveSettleShell did NOT move with them: syncMemberAfterOrdered calls
// it to resolve the member's registered shell before building the dolt-settle
// callback, but it stays DEFINED IN runner.js and is imported back from there
// (see the import below for the anchoring test and the call-site split). It was
// module-private before this extraction and is now merely exported so this
// module can reach it; it is not otherwise part of runner.js's moved surface.
//
// GUARD REGISTRATION: this module is registered in ./guarded-modules.mjs as
// part of this extraction (see that file's STANDING RULE). It carries
// syncMemberAfter's one member_name-bearing command() site -- the Tier 2
// post-resolution `git status --porcelain` read -- and, more importantly, it
// is where syncMemberAfterOrdered now lives, which is the sanctioned wrapper
// unbracketed-push-guard.mjs resolves BY NAME WITHIN A FILE: its bare
// syncMemberAfter()/DoltSync.syncAfter() calls stay sanctioned only because
// the wrapper that contains them travelled here with them.
//
// Dependency-injection stance is unchanged: nothing here does I/O of its own.
// Every git command is issued via an injected command() with an explicit
// `member_name`, and the resume path's git/dolt runners are injected too, so
// unit tests drive all of it with no live fleet.
// =============================================================================

import { GitDivergedError, GitSyncError } from './errors.mjs';
import { runGitStep, resolveGitProviderForClassification } from './git-topology.mjs';
import { parseUnmergedPaths, detectAndAbortRebaseConflict, dispatchConflictResolutionAgent } from './conflict-ladder.mjs';
import { DoltSync } from './dolt-sync.mjs';
import { buildSettleCallback } from './dolt-settle.mjs';
import { decideEnsureBranchAction } from './branch-ensure.mjs';
// resolveSettleShell stays in runner.js: test/sprint-state.test.mjs anchors it
// there by symbol ('resolveSettleShell must still exist in runner.js'), and six
// of its seven call sites are runner.js's own orchestrator-side settle brackets.
// This is the same runner.js back-import abort.mjs, prompts.mjs and worklists.mjs
// already use; nothing here touches it at module-evaluation time, so the cycle
// resolves through the hoisted function declaration at call time.
import { resolveSettleShell } from './runner.js';

// ---------------------------------------------------------------------------
// Orchestrator-bracketed git sync helpers
// ---------------------------------------------------------------------------
//
// Stance: SINGLE-WRITER TOKEN PASSING. The writer pushes, then the next reader
// pulls, so every intra-sprint git merge is fast-forward BY CONSTRUCTION. A
// non-FF result is therefore not a merge to resolve -- it is proof the
// invariant is already broken, so it is a HARD, TYPED error
// (GitDivergedError), never auto-resolved.
//
// Every bracket must fail-soft-with-retry in a way that DISTINGUISHES
// transient-retry (network unreachable, an index/ref lock) from diverged-abort
// (non-FF, unmerged/conflicted paths). A diverged state must NEVER be retried
// blindly. classifyGitFailure() is that classifier -- it moved to
// ./git-topology.mjs with runGitStep (apra-fleet-3swo.6.3); the two failure
// classes surface as two distinct WorkflowError subclasses (GitSyncError vs
// GitDivergedError) so callers and tests can assert them apart.
//
// Every git command is issued via the injected command() with an explicit
// `member_name` -- agents never run sync themselves; the orchestrator brackets
// each dispatch. `command` is dependency-injected so unit tests can drive these
// helpers with a mock command() and no live fleet.

/**
 * G-pull: bring `member` up to the shared branch tip before it does any work --
 * `git fetch` then `git merge --ff-only`. Because of single-writer token
 * passing this merge is fast-forward by construction; a non-FF result is a
 * distinct typed GitDivergedError (NOT a generic failure), never auto-merged.
 * Transient (network/lock) failures are retried up to `maxTransientRetries`;
 * divergence is never retried.
 *
 * Every git command is issued via the injected command() with an explicit
 * member_name.
 *
 * An optional injected `onAuthFailure` is threaded through to runGitStep's
 * bounded one-shot self-heal, since a stale token can break a pull as easily as
 * a push.
 *
 * An optional `resetToRemoteTip` (default false) changes the pull half from
 * `git merge --ff-only` to `git reset --hard <remote>/<branch>` so a RETRIED
 * doer dispatch resumes on the published tip instead of failing on (or
 * re-committing over) a divergence its own prior attempt left behind. It must
 * only be set on a retry that may have mutated state (withGitSync's
 * resumeOntoRemoteTip); omitting it keeps the ff-only-merge behaviour for every
 * first attempt.
 *
 * apra-fleet-417.7: an optional injected `resolveMemberProvider` (see
 * createMemberVcsProviderResolver) is resolved ONCE at the top of this call
 * and threaded into every runGitStep call below, so a G-pull auth failure for
 * a non-GitHub member classifies via that member's own provider chain.
 *
 * @param {string} member
 * @param {{ command: Function, log?: Function, maxTransientRetries?: number, remote?: string, branch?: string, onAuthFailure?: Function, resetToRemoteTip?: boolean, resolveMemberProvider?: (member: string) => Promise<string|undefined> }} opts
 * @returns {Promise<{ ok: true, member: string }>}
 */
export async function syncMemberBefore(member, opts = {}) {
    const { command, log = () => {}, maxTransientRetries = 1, remote = 'origin', branch, onAuthFailure, resetToRemoteTip = false, resolveMemberProvider } = opts;
    if (typeof command !== 'function') {
        throw new Error("syncMemberBefore requires an injected command() in opts");
    }
    const provider = await resolveGitProviderForClassification(resolveMemberProvider, member, log);

    const fetchCmd = branch ? `git fetch ${remote} ${branch}` : `git fetch ${remote}`;
    const fetch = await runGitStep({
        command, member, cmd: fetchCmd,
        label: `G-pull fetch for '${member}'`, log, maxTransientRetries, onAuthFailure, provider,
    });
    if (!fetch.ok) {
        // A brand-new sprint branch created locally from base, before its
        // first G-push, makes this fetch fail with "couldn't find remote ref
        // <branch>". That is a benign, expected state: there is nothing on the
        // remote to pull, so the bracket's pull half is a no-op, not an error.
        // Only this precise git message may be treated as
        // branch-doesn't-exist; anything else must still surface.
        if (/couldn't find remote ref/i.test(fetch.error || '')) {
            log(`[Sync] G-pull for member '${member}': branch '${branch}' does not exist on '${remote}' yet (not pushed); skipping pull (nothing to sync down).`);
            return { ok: true, member };
        }
        // A fetch cannot "diverge" -- any failure here is transient-exhausted
        // or unknown; surface it as a (non-diverged) sync error.
        throw new GitSyncError(
            `[Sync] G-pull fetch failed for member '${member}': ${fetch.error}`,
            { member, gitOutput: fetch.error },
        );
    }

    // On a RETRIED dispatch whose prior attempt was not provably a no-mutation
    // failure (it may have committed and/or pushed its streak), `git merge
    // --ff-only` is the wrong recovery: if the prior attempt pushed and the
    // local tip then diverged with a re-implemented duplicate commit, the
    // ff-only merge raises GitDivergedError and the streak can NEVER resume,
    // because every subsequent push/merge fails non-fast-forward. Hard-resetting
    // onto the freshly fetched remote tip makes the retry resume ON TOP of
    // already-published work instead of re-committing it. Only the code checkout
    // is touched (beads live in a separate Dolt clone); a local commit that was
    // never published is intentionally dropped and simply re-done by the retry,
    // which is what prevents the divergent duplicate commit. A concrete branch
    // is required to name a remote tip; without one this falls through to the
    // ff-only merge below.
    if (resetToRemoteTip && branch) {
        const resetTarget = `${remote}/${branch}`;
        const reset = await runGitStep({
            command, member, cmd: `git reset --hard ${resetTarget}`,
            label: `G-pull reset-to-remote-tip for '${member}'`, log, maxTransientRetries, onAuthFailure, provider,
        });
        if (!reset.ok) {
            throw new GitSyncError(
                `[Sync] G-pull reset-to-remote-tip failed for member '${member}': ${reset.error}`,
                { member, gitOutput: reset.error },
            );
        }
        log(`[Sync] G-pull for member '${member}': hard-reset local branch onto '${resetTarget}' so a retried dispatch resumes on the published tip instead of re-committing.`);
        return { ok: true, member };
    }

    const mergeCmd = branch ? `git merge --ff-only ${remote}/${branch}` : 'git merge --ff-only';
    const merge = await runGitStep({
        command, member, cmd: mergeCmd,
        label: `G-pull ff-only merge for '${member}'`, log, maxTransientRetries, onAuthFailure, provider,
    });
    if (!merge.ok) {
        if (merge.kind === 'diverged') {
            throw new GitDivergedError(
                `[Sync] G-pull for member '${member}' could not fast-forward -- it has DIVERGED from the shared branch and must not be auto-merged: ${merge.error}`,
                { member, gitOutput: merge.error, operation: 'pull' },
            );
        }
        throw new GitSyncError(
            `[Sync] G-pull ff-only merge failed for member '${member}': ${merge.error}`,
            { member, gitOutput: merge.error },
        );
    }

    return { ok: true, member };
}

/**
 * G-push: publish `member`'s committed work to the shared branch after a
 * dispatch -- `git push` with ONE bounded pull-rebase retry. If the
 * push is rejected as non-FF (another writer got there first), do a single
 * `git pull --rebase` and re-push exactly once; if it is STILL rejected, raise
 * a typed GitDivergedError -- the single-writer invariant is violated and the
 * push must never be retried further/blindly. Transient (network/lock)
 * failures are retried up to `maxTransientRetries`; divergence is never
 * retried beyond the one bounded rebase.
 *
 * `pushCode: false` makes this a no-op (a read-only bracket has nothing to
 * publish). Every git command is issued via the injected command() with an
 * explicit member_name.
 *
 * Tier 2 of the git conflict ladder: when the pull-rebase retry hits a REAL
 * content conflict (unmerged paths, not just a plain non-FF race), an optional
 * injected `agent()` gets exactly ONE bounded conflict-resolution-runbook
 * dispatch before this function gives up and throws the typed
 * GitDivergedError. The agent's own claim of success is never trusted: this
 * function mechanically re-checks `git status --porcelain` for a clean tree and
 * then attempts one real re-push; only that observed outcome decides whether
 * Tier 2 resolved the conflict. Omitting `agent` leaves Tier 1 only.
 *
 * An optional injected `onAuthFailure` is threaded through to every runGitStep
 * call below for a bounded one-shot self-heal (call it once, retry the same
 * command once) whenever a step is classified 'auth'.
 *
 * apra-fleet-417.7: an optional injected `resolveMemberProvider` (see
 * createMemberVcsProviderResolver) is resolved ONCE at the top of this call
 * and threaded into every runGitStep call below, so a G-push auth failure for
 * a non-GitHub member classifies via that member's own provider chain.
 *
 * @param {string} member
 * @param {{
 *   command: Function, pushCode?: boolean, log?: Function,
 *   maxTransientRetries?: number, remote?: string, branch?: string,
 *   agent?: Function, resolveConflictModel?: string, onAuthFailure?: Function,
 *   resolveMemberProvider?: (member: string) => Promise<string|undefined>,
 * }} opts
 * @returns {Promise<{ ok: true, member: string, pushed: boolean, rebased: boolean, tier2Resolved?: boolean }>}
 */
export async function syncMemberAfter(member, opts = {}) {
    const {
        command, pushCode = true, log = () => {}, maxTransientRetries = 1, remote = 'origin', branch,
        agent, resolveConflictModel, onAuthFailure, resolveMemberProvider, setUpstream = false,
    } = opts;
    if (typeof command !== 'function') {
        throw new Error("syncMemberAfter requires an injected command() in opts");
    }

    if (!pushCode) {
        return { ok: true, member, pushed: false, rebased: false };
    }
    const provider = await resolveGitProviderForClassification(resolveMemberProvider, member, log);

    // apra-fleet: `setUpstream` (opt-in, default false -- every existing
    // caller's command text is byte-for-byte unchanged) is for Publish PR's
    // push specifically: it needs `-u` to set the tracking branch on a brand
    // new sprint branch's first push, AND that distinct spelling is what lets
    // mock-sprint-publish-push-failure.test.mjs's `gitGhFailurePattern` (and
    // any real-world log grep) target Publish's push in isolation from every
    // OTHER per-dispatch G-push in the same sprint, which all share the plain
    // `git push <remote> <branch>` spelling below.
    const pushCmd = branch ? `git push${setUpstream ? ' -u' : ''} ${remote} ${branch}` : 'git push';

    let push = await runGitStep({
        command, member, cmd: pushCmd,
        label: `G-push for '${member}'`, log, maxTransientRetries, onAuthFailure, provider,
    });
    if (push.ok) {
        return { ok: true, member, pushed: true, rebased: false };
    }

    if (push.kind !== 'diverged') {
        // Transient-exhausted or unknown non-FF failure -- not a divergence,
        // so no rebase retry; surface the (non-diverged) sync error.
        throw new GitSyncError(
            `[Sync] G-push for member '${member}' failed: ${push.error}`,
            { member, gitOutput: push.error },
        );
    }

    // Non-FF push: attempt EXACTLY ONE pull --rebase then re-push.
    log(`[Sync] G-push for member '${member}' was rejected as non-fast-forward; attempting a single pull --rebase then one re-push.`);
    const rebaseCmd = branch ? `git pull --rebase ${remote} ${branch}` : 'git pull --rebase';
    const rebase = await runGitStep({
        command, member, cmd: rebaseCmd,
        label: `G-push pull-rebase retry for '${member}'`, log, maxTransientRetries, onAuthFailure, provider,
    });
    if (!rebase.ok) {
        // Tier 1 scripted detection: confirm from git's own porcelain status --
        // not from this failing command's exit code/message classification --
        // whether the rebase actually left unmerged paths, and if so restore a
        // clean tree via `git rebase --abort` BEFORE the typed divergence error
        // below propagates. This is the single Tier 1 -> Tier 2 escalation
        // point.
        const unmergedPaths = await detectAndAbortRebaseConflict({ command, member, log, maxTransientRetries, runGitStep });

        // Tier 2: unmergedPaths.length > 0 means a real content conflict, not
        // just a non-FF race. Attempt exactly ONE bounded agent-with-runbook
        // dispatch (when an agent() was injected) before falling back to the
        // typed GitDivergedError below. Every outcome (agent throws, agent
        // returns, or agent unavailable) is mechanically re-verified against
        // real git state -- never the agent's own claim.
        if (unmergedPaths.length > 0 && typeof agent === 'function') {
            try {
                await dispatchConflictResolutionAgent({
                    agent, member, branch, unmergedPaths, log, model: resolveConflictModel, remote,
                });
            } catch (tier2Err) {
                log(`[Sync] Tier 2 conflict-resolution dispatch for member '${member}' threw and will not be retried (script-first: no further escalation): ${tier2Err.message}`);
            }

            const postTier2Status = await command('git status --porcelain', { member_name: member, silent: true, failSoft: true, label: `Tier 2 post-resolution clean-state check for '${member}'` });
            const stillUnmerged = parseUnmergedPaths(postTier2Status && postTier2Status.output ? postTier2Status.output : '');
            if (stillUnmerged.length === 0) {
                const rePush = await runGitStep({
                    command, member, cmd: pushCmd,
                    label: `G-push after Tier 2 conflict resolution for '${member}'`, log, maxTransientRetries, onAuthFailure, provider,
                });
                if (rePush.ok) {
                    log(`[Sync] Tier 2 conflict resolution for member '${member}' succeeded -- working tree clean and the resolved code was pushed.`);
                    return { ok: true, member, pushed: true, rebased: true, tier2Resolved: true };
                }
                log(`[Sync] Tier 2 conflict resolution for member '${member}' left a clean tree but the re-push still failed: ${rePush.error}`);
            } else {
                log(`[Sync] Tier 2 conflict resolution for member '${member}' did not fully resolve -- porcelain still shows unmerged path(s): ${stillUnmerged.join(', ')}. Restoring a clean tree before failing this streak.`);
                await detectAndAbortRebaseConflict({ command, member, log, maxTransientRetries, runGitStep });
            }
        }

        if (rebase.kind === 'diverged' || unmergedPaths.length > 0) {
            throw new GitDivergedError(
                `[Sync] G-push pull-rebase for member '${member}' hit unmergeable divergence (conflict) -- must not be retried blindly: ${rebase.error}`,
                { member, gitOutput: rebase.error, operation: 'push-rebase', details: { unmergedPaths } },
            );
        }
        throw new GitSyncError(
            `[Sync] G-push pull-rebase for member '${member}' failed: ${rebase.error}`,
            { member, gitOutput: rebase.error },
        );
    }

    push = await runGitStep({
        command, member, cmd: pushCmd,
        label: `G-push re-push after rebase for '${member}'`, log, maxTransientRetries, onAuthFailure, provider,
    });
    if (push.ok) {
        return { ok: true, member, pushed: true, rebased: true };
    }

    // Still rejected after the one bounded rebase -- diverged, never retried further.
    throw new GitDivergedError(
        `[Sync] G-push for member '${member}' still rejected after one pull-rebase retry -- the single-writer token invariant is violated; refusing to retry further: ${push.error}`,
        { member, gitOutput: push.error, operation: 'push' },
    );
}

/**
 * The ordered post-dispatch sync step every withGitSync() bracket's `finally`
 * runs: G-push (code) BEFORE D-push (beads).
 *
 * For code-writing roles (pushCode:true), G-push MUST succeed before D-push is
 * attempted. If G-push throws at all, D-push is skipped ENTIRELY and the error
 * is rethrown, never swallowed -- closing a bead in dolt while the code that
 * justifies the close never left this member's checkout would advertise an
 * UNREACHABLE CLOSE: a reviewer, or the next streak's G-pull, would see the
 * bead done and find no matching commit on the shared branch.
 *
 * With pushCode:false, syncMemberAfter never touches git and cannot throw, so
 * D-push always still runs.
 *
 * `agent`/`resolveConflictModel` are threaded through to syncMemberAfter's
 * conflict-resolution escalation; `onAuthFailure` is threaded through to BOTH
 * syncMemberAfter and doltPushAfter for their bounded one-shot self-heal.
 *
 * @param {string} member
 * @param {{
 *   command: Function, pushCode?: boolean, pushBeads?: boolean,
 *   log?: Function, mutex?: { acquire: Function, release: Function },
 *   sprintId?: string, branch?: string, maxTransientRetries?: number,
 *   remote?: string, agent?: Function, resolveConflictModel?: string,
 *   onAuthFailure?: Function,
 *   resolveMemberProvider?: (member: string) => Promise<string|undefined>,
 *   args?: { callTool?: Function },
 *   sprintState?: object,
 * }} opts
 * @returns {Promise<{ ok: true, member: string, gPush: object, dPush: object }>}
 */
export async function syncMemberAfterOrdered(member, opts = {}) {
    const {
        command, pushCode = true, pushBeads = true, log = () => {},
        mutex, sprintId, branch, maxTransientRetries = 1, remote = 'origin',
        agent, resolveConflictModel, onAuthFailure, resolveMemberProvider, args, sprintState,
    } = opts;

    let gPush;
    try {
        gPush = await syncMemberAfter(member, { command, pushCode, log, branch, maxTransientRetries, remote, agent, resolveConflictModel, onAuthFailure, resolveMemberProvider });
    } catch (gPushErr) {
        log(`[Sync] G-push failed for member '${member}' -- skipping D-push and failing this streak rather than advertising an unreachable close (a beads close whose justifying code never reached the shared branch): ${gPushErr.message}`);
        throw gPushErr;
    }

    // EXPLICITLY FATAL (apra-fleet-417.3.1): DoltSync.syncAfter is degraded by
    // default, but this is the post-dispatch bracket -- the member's beads
    // closes must reach the shared remote or the orchestrator's next read sees
    // a bead this streak believes it closed. A silent degrade here would
    // advertise an unreachable close, exactly what the G-push-before-D-push
    // ordering above exists to prevent, and would erase the
    // BEADS_SYNC_CONFLICT terminal reason the dashboard reports.
    //
    // Before that fatal divergence surfaces, run the deterministic settle
    // (settleDoltConflicts, dolt-settle.mjs). It is TOTAL over row-level
    // conflicts -- no gates, no allowlist, no LLM escalation -- and a resolved
    // settle is a VERIFIED recovery, because settle republishes (bd dolt pull
    // + push) and checks the push actually landed before returning. The streak
    // only fails (DoltDivergedError -> BEADS_SYNC_CONFLICT) when settle itself
    // hits an operational failure (no usable dolt binary, the ephemeral server
    // would not start, a SQL statement errored).
    //
    // Notably, the data-loss hazard that forced the old ladder's Path B to be
    // disabled at THIS call site does not exist for settle: it never discards
    // and re-bootstraps a clone, so an arbitrary multi-command dispatch's bead
    // mutations cannot be silently thrown away here. There is no pendingMutation
    // to capture and replay because nothing is ever dropped.
    // Thread this member's REGISTERED shell into dolt-settle the same way
    // the pre-dispatch bracket does (apra-fleet-7dir.16/.24), guarded on
    // `args.callTool` so a caller with no MCP client (mock-sprint scenarios)
    // keeps the pre-shell-aware default.
    const shell = await resolveSettleShell({ args, member, log, sprintState });
    const settle = buildSettleCallback(member, { command, log, shell });
    const dPush = await DoltSync.syncAfter(member, { command, pushBeads, log, mutex, sprintId, onAuthFailure, fatal: true, settle });
    return { ok: true, member, gPush, dPush };
}

/**
 * (apra-fleet-p2to.4.2) Re-sync ONE member that was just re-acquired on resume.
 * Runs -- UNCONDITIONALLY, never gated on a "looks unchanged" heuristic -- the
 * same three reconciliation steps a fresh dispatch would rely on, because while
 * this sprint was paused both origin and the beads DB can have moved (another
 * sprint, a human push) on top of the released member:
 *
 *   1. `git fetch` (base branch, then the sprint branch soft -- a brand-new
 *      branch legitimately has no remote ref yet).
 *   2. The pure decideEnsureBranchAction() probe: fetch outcome + a local-branch
 *      existence probe + (when both tips exist) a two-way ancestor comparison,
 *      fed into the SAME decision helper the Ensure Sprint Branch phase uses.
 *      An 'abort' decision (fetch failed for a non-"missing ref" reason, or the
 *      tips diverged) THROWS rather than touch git -- resuming onto a diverged
 *      branch could silently discard real pushed work. A 'checkout' decision is
 *      executed so the member's working branch is reconciled to origin's new
 *      tip before work continues.
 *   3. `bd dolt pull` -- re-sync the beads clone to whatever landed while paused.
 *
 * All I/O is injected so this stays transport-agnostic and unit-testable:
 *   - `runGit(cmd)` -> Promise<{ ok: boolean, stdout?: string, error?: string }>
 *     (a SOFT git runner: it never throws; this function decides which failures
 *     are fatal).
 *   - `doltPull(member)` -> Promise<any> (runs `bd dolt pull` on the member).
 *
 * @param {{ member: string, branch: string, baseBranch: string,
 *           runGit: (cmd: string) => Promise<{ ok: boolean, stdout?: string, error?: string }>,
 *           doltPull: (member: string) => Promise<any>, log?: Function }} opts
 * @returns {Promise<void>}
 */
export async function resyncReacquiredMember(opts = {}) {
    const { member, branch, baseBranch, runGit, doltPull, log = () => {} } = opts;
    if (typeof runGit !== 'function' || typeof doltPull !== 'function') {
        throw new TypeError('resyncReacquiredMember requires runGit() and doltPull() to be injected');
    }

    async function gitStep(cmd, { failSoft = false } = {}) {
        const res = await runGit(cmd);
        if (!failSoft && !(res && res.ok)) {
            throw new Error(
                `[resume-resync] '${cmd}' failed on member '${member}': ${(res && (res.error || res.stdout)) || 'unknown error'}`
            );
        }
        return res || { ok: false };
    }

    // 1. git fetch: base (hard -- a missing base is a real problem) then the
    //    sprint branch (soft -- a brand-new branch has no remote ref yet).
    await gitStep(`git fetch origin ${baseBranch} --quiet`);
    const branchFetch = await gitStep(`git fetch origin ${branch} --quiet`, { failSoft: true });

    // 2. decideEnsureBranchAction probe: local-branch existence + tip comparison.
    const localProbe = await gitStep(`git rev-parse --verify --quiet refs/heads/${branch}`, { failSoft: true });
    const localBranchExists = localProbe.ok;
    let localTipStatus;
    if (branchFetch.ok && localBranchExists) {
        const localIsAncestorOfRemote = await gitStep(
            `git merge-base --is-ancestor ${branch} origin/${branch}`, { failSoft: true }
        );
        const remoteIsAncestorOfLocal = await gitStep(
            `git merge-base --is-ancestor origin/${branch} ${branch}`, { failSoft: true }
        );
        if (localIsAncestorOfRemote.ok) {
            localTipStatus = 'behind-or-equal';
        } else if (remoteIsAncestorOfLocal.ok) {
            localTipStatus = 'ahead';
        } else {
            localTipStatus = 'diverged';
        }
    }
    const decision = decideEnsureBranchAction({
        branch,
        baseBranch,
        branchFetchOk: branchFetch.ok,
        branchFetchError: branchFetch.error,
        localBranchExists,
        localTipStatus,
    });
    if (decision.action === 'abort') {
        throw new Error(`[resume-resync] ${decision.message} (member '${member}')`);
    }
    // Reconcile the member's working branch to origin's (possibly moved) tip.
    await gitStep(decision.command);

    // 3. bd dolt pull: re-sync the beads clone.
    await doltPull(member);

    log(`[resume-resync] member '${member}' re-synced (git fetch + branch reconcile + beads D-pull) before work resumed`);
}
