// =============================================================================
// fleet-sprint git/dolt SYNC BRACKETS (apra-fleet-3swo.4.1).
//
// This module owns `openSyncBracketCount` -- the clean-state pause-guard
// counter that used to live as a closure variable inside runSprintCycle() in
// runner.js. Owning it here is the point of the extraction: every git/dolt
// sync and every push now runs inside a bracket THIS module opens and closes,
// so a caller cannot forget the bracket and leave the engine reporting
// "safe to pause" while a pull/push is in flight.
//
// EVERY sync/push goes through one of the entry points createGitSync()
// returns:
//   withGitSync()     -- the full dispatch bracket (pre-dispatch G-pull/D-pull,
//                        the dispatch itself, post-dispatch G-push/D-push).
//   syncBeadsBefore() -- a standalone bracketed DoltSync.syncBefore().
//   syncBeadsAfter()  -- a standalone bracketed DoltSync.syncAfter().
//   pushBeadsAfter()  -- a standalone bracketed DoltSync.syncAfter() D-push
//                        (apra-fleet-3swo.4.9 part b -- routes through the
//                        same degrade-by-default/settle-callback surface as
//                        syncBeadsAfter, no longer a bare doltPushAfter()).
//   pushGitAfter()    -- a standalone bracketed syncMemberAfter() G-push.
// runner.js holds NO counter arithmetic and hand-rolls NO bracket of its own.
//
// STATE IS INJECTED, NEVER CAPTURED: withGitSync() and withOpenSyncBracket()
// were nested closures over runSprintCycle()'s `command`, `log`, `validated`,
// `doltPushMutex`, `sprintMutexId`, `agent` and `setPauseGuard`, so the move
// has to pass that state in explicitly. createGitSync(deps) takes it once and
// binds it; withGitSync() itself is exported as a plain function whose first
// argument is that dependency context, so it stays unit-testable without a
// live sprint.
//
// DOLT LITERAL CONSTRAINT (dolt-literal-guard.mjs): this module must call
// dolt-sync.mjs's exported entry points and must NEVER re-inline a
// `bd dolt pull`/`bd dolt push` command string. dolt-sync.mjs is the single
// permitted dolt command surface.
// =============================================================================

import { ApraFleet } from "@apralabs/apra-fleet-client";
import { DoltSync } from "./dolt-sync.mjs";
import { buildSettleCallback } from "./dolt-settle.mjs";
import { PostDispatchSyncError, ConcurrentSyncBracketError } from "./errors.mjs";
import { resolveMemberTarget } from "./member-target.mjs";

// (apra-fleet-3swo.4.9 part a) The shared `exclusiveKey` every CODE-WRITING
// (pushCode:true) withGitSync() bracket opens under. This is the resource
// mutual exclusion actually protects: the shared git branch a G-push lands
// on, not any one member -- two DIFFERENT members' pushCode:true dispatches
// overlapping is exactly as damaging to the fast-forward-by-construction
// invariant as the same member somehow dispatching twice at once. Read-only
// brackets (pushCode:false) and the standalone D-only/G-only helpers never
// pass an exclusiveKey -- their concurrency is either harmless (nothing is
// pushed) or already serialized by a purpose-built mechanism of their own
// (the dolt push mutex), so folding them into this check would only add
// false-positive risk with no corresponding safety gain.
export const CODE_WRITE_BRACKET_KEY = 'code-write';

// Backoff for retrying ONLY the post-dispatch sync step of a bracket whose
// dispatch already completed. Short and bounded: this is a git/dolt push round
// trip, not an LLM turn, and letting the failure escape the bracket would
// redispatch the whole turn.
export const POST_DISPATCH_SYNC_RETRY_DELAYS_MS = [0, 5000, 15000];

/** True when the hermetic mock harness has opted into zero-wait backoffs
 *  (APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF=1, set by mock-sprint-harness.mjs).
 *  Production behavior -- real timed sleeps -- is unaffected. */
const mockInstantRetryBackoff = () => process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF === "1";

/**
 * Creates the open-sync-bracket counter and its withOpenSyncBracket() wrapper,
 * registering the clean-state pause guard with the engine when one is wired.
 * The returned object is the ONLY handle to the counter: nothing outside this
 * module can increment or decrement it.
 *
 * @param {{ setPauseGuard?: Function }} deps
 * @returns {{ withOpenSyncBracket: (fn: () => Promise<any>, opts?: { exclusiveKey?: string, label?: string }) => Promise<any>, openBracketCount: () => number }}
 */
export function createSyncBrackets({ setPauseGuard } = {}) {
    // (apra-fleet-p2to.4.1) Clean-state pause guard: this is fleet-sprint's OWN
    // pause-awareness -- the engine's cooperative pause primitive
    // (apra-fleet-p2to.1's requestPause()/setPauseGuard()) only ever engages
    // a pending pause at a zero-in-flight-activity boundary that ALSO passes
    // this predicate, so registering it here is what keeps a pause from
    // landing mid-git/mid-dolt-sync (e.g. between a pull and its matching
    // push, or mid-D-push) and leaving the workspace/beads clone in an
    // inconsistent state to resume from. `openSyncBracketCount` counts every
    // currently-open "bracket": withGitSync()'s FULL body (pre-dispatch sync
    // through post-dispatch sync, wrapped as a single bracket below) and
    // every standalone DoltSync.syncBefore()/syncAfter()/doltPushAfter()/
    // syncMemberAfter() call in runner.js that is NOT already nested inside a
    // withGitSync bracket (a
    // nested one is harmless double-counting, never a leak, since
    // withOpenSyncBracket()'s increment/decrement is always paired). The
    // guard itself is trivial and adds NO behavior when no pause is pending
    // -- the engine only ever consults it while a pause is deferred (see
    // FleetWorkflow._guardPermitsPause(), packages/apra-fleet-workflow/src/
    // workflow/index.mjs), so a clean run with setPauseGuard registered but
    // no pause ever requested behaves identically to one with no guard at
    // all. `setPauseGuard` is only present on `context` when this script
    // runs through WorkflowEngine.executeFile() (see that module's
    // _bindPrimitives()) -- guarded so direct/legacy callers of
    // runSprintCycle() that never go through the engine (existing tests)
    // keep working unchanged.
    let openSyncBracketCount = 0;
    if (typeof setPauseGuard === 'function') {
        setPauseGuard(() => openSyncBracketCount === 0);
    }

    // MUTUAL-EXCLUSION TRACKING (apra-fleet-3swo.4.9 part a). Before this, the
    // counter above ONLY counted -- it could not tell a legitimately NESTED
    // pair of brackets (bracket B opens and fully closes while bracket A,
    // opened first, is still open -- harmless, LIFO) apart from a genuine
    // OVERLAP (bracket A closes while a LATER-opened bracket B is still
    // open -- a crossing, non-LIFO close that proves the two never should
    // have been open at the same time). A caller that opts in by passing
    // `exclusiveKey` gets that distinction enforced: brackets sharing a key
    // are tracked on a per-key STACK, so any depth of legitimate nesting for
    // that key is free (push on open, pop on close, never throws as long as
    // closes happen LIFO), and a crossing close throws
    // ConcurrentSyncBracketError naming both the closing bracket and every
    // other bracket sharing the key that is still open. Every bracket that
    // does NOT pass `exclusiveKey` (the default) is completely unaffected --
    // this is opt-in per key, not a global exclusivity rule, because most
    // concurrent brackets in this codebase are LEGITIMATE (different
    // members' D-pushes serialize via their own dolt push mutex, not via
    // this counter) and must never throw.
    const exclusiveStacks = new Map();
    let bracketSeq = 0;

    /**
     * Runs `fn` with the open-sync-bracket counter incremented for its
     * duration, decrementing again on EVERY exit path (success or throw) via
     * `finally` -- never leaves a stale increment behind on an error.
     * @template T
     * @param {() => Promise<T>} fn
     * @param {{ exclusiveKey?: string, label?: string }} [opts] - opt in to
     *   mutual-exclusion tracking for `exclusiveKey`; `label` is cosmetic,
     *   used only in the thrown error's message.
     * @returns {Promise<T>}
     */
    async function withOpenSyncBracket(fn, { exclusiveKey, label } = {}) {
        openSyncBracketCount += 1;
        let token = null;
        if (exclusiveKey !== undefined && exclusiveKey !== null) {
            token = { id: ++bracketSeq, label: label || exclusiveKey };
            const stack = exclusiveStacks.get(exclusiveKey) || [];
            stack.push(token);
            exclusiveStacks.set(exclusiveKey, stack);
        }
        try {
            return await fn();
        } finally {
            openSyncBracketCount -= 1;
            if (token) {
                const stack = exclusiveStacks.get(exclusiveKey) || [];
                const top = stack[stack.length - 1];
                if (top && top.id === token.id) {
                    // Normal case, whatever the nesting depth: we are the
                    // most-recently-opened bracket for this key, so this is
                    // a valid LIFO close.
                    stack.pop();
                    if (stack.length === 0) exclusiveStacks.delete(exclusiveKey);
                } else {
                    // CROSSING close: a bracket that opened AFTER us, sharing
                    // our key, is still open. That is true overlap, not
                    // nesting -- remove ourselves from the stack (wherever we
                    // are in it) and throw, naming every bracket still open.
                    const idx = stack.findIndex((t) => t.id === token.id);
                    if (idx !== -1) stack.splice(idx, 1);
                    if (stack.length === 0) exclusiveStacks.delete(exclusiveKey);
                    else exclusiveStacks.set(exclusiveKey, stack);
                    const stillOpenLabels = stack.map((t) => t.label);
                    throw new ConcurrentSyncBracketError(
                        `[Sync] mutual-exclusion violation on key '${exclusiveKey}': bracket '${token.label}' closed while ` +
                        `${stack.length} other bracket(s) sharing the same key ${stack.length === 1 ? 'is' : 'are'} still open ` +
                        `(${stillOpenLabels.join(', ')}) -- these OVERLAPPED rather than nested, which breaks the ` +
                        `fast-forward-by-construction invariant this key protects.`,
                        { exclusiveKey, closingLabel: token.label, stillOpenLabels },
                    );
                }
            }
            // (apra-fleet-p2to.4.4.1) Closing the LAST open sync bracket is
            // itself a clean-state boundary a deferred pause may complete at,
            // but the engine only re-checks its pause-engage condition
            // (WorkflowEngine._maybeEngagePause()) at specific trigger points
            // -- requestPause(), an in-flight activity draining to zero, the
            // gate at the next agent()/command() dispatch, or setPauseGuard()
            // itself (which re-checks as a side effect of registering). None
            // of those necessarily fire here: this bracket can close with no
            // further dispatch immediately following. Re-registering the SAME
            // guard predicate is a deliberate poke -- it engages a pause
            // requested while sync brackets were open the instant this guard
            // opens, rather than leaving it stranded until some later
            // dispatch happens to hit the gate.
            if (openSyncBracketCount === 0 && typeof setPauseGuard === 'function') {
                setPauseGuard(() => openSyncBracketCount === 0);
            }
        }
    }

    return {
        withOpenSyncBracket,
        /** Current number of open sync brackets -- read-only observability. */
        openBracketCount: () => openSyncBracketCount,
    };
}

// ONE shared bracket wrapping EVERY role-identified agent() dispatch below
// -- planner, plan-reviewer, doer, reviewer, deployer, integ-test-runner,
// harvester. No phase-based exemptions: a deployer or integ-test-runner
// running against a stale checkout/beads clone is exactly as damaging as a
// stale doer/reviewer diff. Bracket order: VCS-auth preflight gate, G-pull,
// D-pull, dispatch, G-push, D-push.
//
// Two orthogonal sync axes, each pulled before and (optionally) pushed
// after:
//   - CODE (git): `pushCode` is true ONLY for the code-writing roles (doer,
//     harvester); every other role is read-side (G-pull before, a no-op
//     G-push after -- see syncMemberAfter's short-circuit).
//   - BEADS (dolt): `pushBeads` is true for every role that MUTATES beads
//     -- planner (creates tasks), doer (closes them), integ-test-runner
//     (closes features / files bugs), harvester (defers issues). The pure
//     read-side roles (reviewer, plan-reviewer, deployer) D-pull before and
//     no-op D-push after. integ-test-runner D-pushes WITHOUT a git push: it
//     never touches code, only beads.
//
// The orchestrator's OWN beads mutations/reads are NOT dispatches and are
// bracketed separately at their own call sites below. Deliberately NOT
// applied to the Streak Assignment call: that dispatch carries no
// `agentType`/persona of its own and is not one of the seven types.
//
// Option flags:
//   - needsVcsAuth: gates the proactive ensureVcsAuthFresh preflight,
//     independently of `pushCode` (apra-fleet-647.1.1.2). Defaults to
//     `pushCode || pushBeads`: a code-writing role always needed it
//     already, and this extends the same proactive preflight to read-side
//     roles whose bracket still D-pushes beads (planner, integ-test-
//     runner, regression-test-runner) -- `bd dolt push` hits the same
//     credential surface as `git push`. Explicitly pass `needsVcsAuth:
//     true` for a bracket that will raise a PR (or otherwise needs a
//     fresh credential) even with pushCode:false and pushBeads:false.
//   - skipPreDispatchSync: the prior attempt failed TERMINALLY with nothing
//     published, so the local G/D workspace is unchanged since that
//     attempt's pull -- skip the pre-dispatch sync entirely.
//   - skipPreDispatchDoltPull: skip only the `bd dolt pull` spawn while
//     still running doltPullBefore's sync.remote pre-gate probe and the
//     G-side pull; for a dispatch whose beads clone was provably just
//     freshened.
//   - resumeOntoRemoteTip: the prior attempt was NOT provably a no-mutation
//     failure (it may have committed and/or pushed), so run the full
//     pre-dispatch sync in syncMemberBefore's resetToRemoteTip mode -- fetch
//     and reset onto the remote tip BEFORE the doer can commit, resuming on
//     published work instead of re-implementing it and diverging.
//   skipPreDispatchSync and resumeOntoRemoteTip encode opposite assumptions
//   about whether the prior attempt published anything and MUST never be
//   passed together. Nothing in the code enforces this today.
//
// Post-dispatch: when the dispatch COMPLETED, only the SYNC step is retried
// on failure -- the turn is never re-dispatched. A push failure is
// frequently transient (a racing writer, a momentarily unreachable remote,
// a credential refresh in flight) and re-running the sync costs nothing,
// whereas re-running the LLM turn costs a full dispatch and risks duplicate
// beads/commit mutations. `agent` is threaded to syncMemberAfterOrdered so
// a G-push hitting a real content conflict can attempt exactly one
// agent-with-runbook resolution before failing the streak (a no-op for
// non-code-writing roles; never fires for a plain divergence).
//
// `ctx` is the dependency context createGitSync() binds: the sync-bracket
// handle plus the runSprintCycle state this function used to close over
// lexically (command, log, branch, args, agent, doltPushMutex, sprintId,
// onAuthFailure, resolveMemberProvider, ensureVcsAuthFresh) and the three
// runner.js helpers it calls (syncMemberBefore, syncMemberAfterOrdered,
// isNoMutationDispatchFailure), injected rather than imported so this
// module never has to import runner.js back (a cycle).
export async function withGitSync(ctx, member, pushCode, dispatchFn, { pushBeads = false, needsVcsAuth = pushCode || pushBeads, skipPreDispatchSync = false, skipPreDispatchDoltPull = false, resumeOntoRemoteTip = false } = {}) {
    const {
        brackets, command, log, branch, args, agent, doltPushMutex, sprintId,
        onAuthFailure, resolveMemberProvider, ensureVcsAuthFresh,
        syncMemberBefore, syncMemberAfterOrdered, isNoMutationDispatchFailure,
    } = ctx;
    // (apra-fleet-p2to.4.1) The WHOLE withGitSync bracket -- pre-dispatch
    // G-pull/D-pull, the dispatch itself, and post-dispatch G-push/D-push
    // -- counts as ONE open sync bracket for the clean-state pause guard
    // above: a pause must never land between, say, a pre-dispatch pull and
    // its matching post-dispatch push, which would leave the workspace/
    // beads clone mid-cycle. It runs through the SAME withOpenSyncBracket()
    // every standalone bracket uses (apra-fleet-3swo.4.1 -- it used to
    // hand-roll its own increment/try/finally copy), whose `finally`
    // guarantees the decrement fires on every exit path (the normal return,
    // or any of the throws below), never leaving a stale increment behind.
    return brackets.withOpenSyncBracket(async () => {
        if (skipPreDispatchSync) {
            log(`[Sync] Skipping pre-dispatch G-pull/D-pull for member '${member}' on a retry after a terminal no-mutation dispatch failure (prior attempt published nothing -- workspace unchanged since the last pull).`);
        } else {
            // Proactively refresh this member's VCS credentials before the
            // G-pull/D-push, gated on `needsVcsAuth` rather than directly on
            // `pushCode`: a code-writing role always needs it (pushCode implies
            // needsVcsAuth by the default above), but so does any read-side
            // role whose bracket still D-pushes beads (planner, integ-test-
            // runner, regression-test-runner) or will raise a PR -- `bd dolt
            // push` shells out to git under the hood and hits the exact same
            // credential surface a `git push` does (apra-fleet-647.1.1.2). A
            // pure read-only role (reviewer, plan-reviewer, deployer -- no
            // push of either kind) passes needsVcsAuth:false (the computed
            // default) and gets no preflight, since it has nothing to
            // preflight for. ensureVcsAuthFresh is itself a no-op when a
            // still-fresh credential is cached, and NEVER throws -- a
            // preflight failure degrades silently and never aborts a
            // dispatch.
            if (needsVcsAuth) {
                log(`[Sync] preflight: member '${member}' needs a fresh VCS credential before this dispatch (pushCode=${pushCode}, pushBeads=${pushBeads}, needsVcsAuth=${needsVcsAuth}).`);
                await ensureVcsAuthFresh(member);
            }
            await syncMemberBefore(member, { command, log, branch, onAuthFailure, resetToRemoteTip: resumeOntoRemoteTip, resolveMemberProvider });
            // EXPLICITLY FATAL (apra-fleet-417.3.1): a pre-dispatch D-pull that
            // silently degraded would hand the agent a STALE beads clone and
            // let it act on it -- worse than not dispatching at all.
            //
            // Thread this member's REGISTERED shell into dolt-settle
            // (apra-fleet-7dir.16) so a settle triggered for a Windows member
            // whose shell is Git-for-Windows bash gets bash-dialect dolt
            // commands instead of being force-assumed PowerShell.
            // resolveMemberTarget never throws (degrades to { os: 'linux',
            // shell: '' } on any lookup failure), and is a no-op when no
            // callTool is wired (e.g. a mock-sprint scenario with no MCP
            // client), matching this call site's pre-existing behavior.
            const settleTarget = (args && typeof args.callTool === 'function')
                ? await resolveMemberTarget({ fleetApi: new ApraFleet({ callTool: args.callTool }), member, log })
                : { os: 'linux', shell: '' };
            await DoltSync.syncBefore(member, { command, log, skipRefresh: skipPreDispatchDoltPull, onAuthFailure, fatal: true, settle: buildSettleCallback(member, { command, log, shell: settleTarget.shell }) });
        }
        // The teardown is deliberately NOT a `finally`. A throw out of a
        // `finally` replaces the (successful) dispatch result and is
        // indistinguishable, to the caller's retry ladder, from "the dispatch
        // itself failed" -- which would let a pure sync failure trigger a brand
        // new LLM turn over work already committed locally. Splitting the two
        // lets the sync be retried on its own and, if it still fails, surfaced
        // as a typed PostDispatchSyncError no retry caller may answer by
        // redispatching.
        let dispatchThrew = null;
        let dispatchResult;
        try {
            dispatchResult = await dispatchFn();
        } catch (err) {
            dispatchThrew = err;
        }
        {
            // On a TERMINAL dispatch failure the agent never delivered a usable
            // result, so there is provably nothing new to publish -- skip the
            // G-push/D-push teardown entirely. This deliberately EXCLUDES
            // every case where the agent DID run and may have committed code/
            // beads that still must be published: max_turns_exhausted and
            // watchdog_timeout dispatch failures, and an AgentOutputError
            // (the LLM answered, only its output was unusable).
            if (dispatchThrew && isNoMutationDispatchFailure(dispatchThrew)) {
                log(`[Sync] Skipping post-dispatch G-push/D-push for member '${member}' after a terminal dispatch failure (nothing to publish): ${dispatchThrew.message}`);
            } else {
                // G-push (code) before D-push (beads) -- see
                // syncMemberAfterOrdered() for the unreachable-close rationale
                // behind that ordering. When the dispatch already threw, the
                // teardown keeps a single-attempt shape: the dispatch error is
                // what surfaces either way, so retrying the sync buys nothing.
                const syncAttemptDelaysMs = dispatchThrew ? [0] : POST_DISPATCH_SYNC_RETRY_DELAYS_MS;
                let syncErr = null;
                for (let attempt = 0; attempt < syncAttemptDelaysMs.length; attempt++) {
                    if (syncAttemptDelaysMs[attempt] > 0) {
                        log(`[Sync] Post-dispatch sync for member '${member}' failed; retrying ONLY the sync step in ${syncAttemptDelaysMs[attempt] / 1000}s (attempt ${attempt + 1}/${syncAttemptDelaysMs.length}) -- the dispatch already completed and must NOT be re-run.`);
                        if (!mockInstantRetryBackoff()) {
                            await new Promise((resolve) => setTimeout(resolve, syncAttemptDelaysMs[attempt]));
                        }
                    }
                    try {
                        await syncMemberAfterOrdered(member, {
                            command, pushCode, pushBeads, log, branch,
                            mutex: doltPushMutex, sprintId, agent, onAuthFailure,
                            resolveMemberProvider, args,
                        });
                        syncErr = null;
                        break;
                    } catch (err) {
                        syncErr = err;
                    }
                }
                if (syncErr) {
                    // A dispatch error always wins over a sync error: it is the
                    // more fundamental failure.
                    if (dispatchThrew) throw dispatchThrew;
                    throw new PostDispatchSyncError(
                        `Post-dispatch sync (G-push/D-push) failed for member '${member}' AFTER the dispatch completed successfully: ${syncErr.message}. The dispatch's work is already committed locally -- it must NOT be re-dispatched; fix the sync (credentials/remote) and re-run.`,
                        { member, dispatchResult, syncAttempts: syncAttemptDelaysMs.length, cause: syncErr },
                    );
                }
            }
        }
        if (dispatchThrew) throw dispatchThrew;
        return dispatchResult;
    }, pushCode ? { exclusiveKey: CODE_WRITE_BRACKET_KEY, label: `withGitSync(${member})` } : undefined);
}

/**
 * Binds the sync-bracket handle and every piece of runSprintCycle state the
 * bracketed helpers need, and returns the sync/push surface runner.js calls.
 * Pass either an existing `brackets` handle (runner.js creates one early, so
 * the pause guard is registered before any dispatch can happen) or a
 * `setPauseGuard` for this factory to create one from.
 */
export function createGitSync(deps = {}) {
    const brackets = deps.brackets ?? createSyncBrackets({ setPauseGuard: deps.setPauseGuard });
    const ctx = { ...deps, brackets };
    const { command, log, branch, doltPushMutex, sprintId, onAuthFailure, resolveMemberProvider, syncMemberAfter } = ctx;
    return {
        brackets,
        /** Current number of open sync brackets -- read-only observability. */
        openBracketCount: () => brackets.openBracketCount(),
        /**
         * The generic bracket, for a caller whose sync is not one of the
         * named helpers below -- e.g. a runner.js helper that D-pulls
         * internally and must count as ONE bracket around its whole call.
         * This is the only way to open a bracket from outside this module:
         * the counter itself is unreachable.
         */
        withOpenSyncBracket: (fn, options) => brackets.withOpenSyncBracket(fn, options),
        /** The full dispatch bracket. See withGitSync() above. */
        withGitSync: (memberName, pushCode, dispatchFn, options) => withGitSync(ctx, memberName, pushCode, dispatchFn, options),
        /**
         * A standalone bracketed beads D-pull. `command`/`log` default to the
         * bound sprint state; anything else (fatal, readinessGate, settle) is
         * passed through verbatim.
         */
        syncBeadsBefore: (memberName, options = {}) => brackets.withOpenSyncBracket(
            () => DoltSync.syncBefore(memberName, { command, log, ...options }),
        ),
        /**
         * A standalone bracketed beads D-push. `command`/`log` and the
         * cross-member D-push mutex default to the bound sprint state.
         */
        syncBeadsAfter: (memberName, options = {}) => brackets.withOpenSyncBracket(
            () => DoltSync.syncAfter(memberName, { command, log, mutex: doltPushMutex, sprintId, ...options }),
        ),
        /**
         * A standalone bracketed beads D-push, routed through
         * DoltSync.syncAfter() (apra-fleet-3swo.4.9 part b) exactly like its
         * sibling syncBeadsAfter() above. This is what closes the Final
         * Review findings D-push hole: that site used to call doltPushAfter()
         * bare, outside every bracket, so the pause guard read "safe to
         * pause" with a dolt push in flight (apra-fleet-3swo.4.1). Routing
         * through DoltSync.syncAfter() (rather than calling doltPushAfter()
         * directly the way this function used to) closes a SECOND gap: a
         * bare doltPushAfter() always THROWS on an unresolved failure, which
         * made this call site behave inconsistently with every other
         * orchestrator post-mutation D-push (all of which go through
         * syncBeadsAfter and are deliberately non-fatal -- see dolt-sync.mjs's
         * module header, "The orchestrator's post-mutation D-pushes are
         * deliberately NOT fatal"). Now this site DEGRADES the same way: an
         * unresolved D-push here is logged and recorded
         * (DoltSync.getDegradedSyncRecords()) rather than aborting the
         * sprint, and the next D-push bracket for this member is the queued
         * retry, same as every sibling site. Pass `fatal: true` in `options`
         * to opt back into the old throwing behavior at this call site.
         */
        pushBeadsAfter: (memberName, options = {}) => brackets.withOpenSyncBracket(
            () => DoltSync.syncAfter(memberName, { command, log, mutex: doltPushMutex, sprintId, ...options }),
        ),
        /**
         * A standalone bracketed G-push through runner.js's syncMemberAfter().
         * This is what closes the Publish-PR git-push hole: that site used to
         * call syncMemberAfter() bare, outside any bracket.
         */
        pushGitAfter: (memberName, options = {}) => brackets.withOpenSyncBracket(
            () => syncMemberAfter(memberName, { command, log, branch, onAuthFailure, resolveMemberProvider, ...options }),
        ),
    };
}
