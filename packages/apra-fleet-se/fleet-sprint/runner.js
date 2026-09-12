import fs from 'fs/promises';
import { createHash } from 'crypto';
import { AgentOutputError, AgentDispatchError, FleetTransportError, CommandError, WorkflowError, BudgetExceededError, CancelledError } from '@apralabs/apra-fleet-workflow';
import {
    ROLES, planReviewerVerdict, doerReport, reviewerVerdict, streakAssignment,
    deployerReport, integReport, regressionReport, finalVerdict, harvesterReport, wrapUntrustedBlock,
} from './contracts.mjs';
import { SprintPlanRejectedError, StalledSprintError, ReviewerContractViolationError, DoltDivergedError, DoltSyncError, PlanReviewDispatchFailedError, isNonRetryableDispatchError, isAuthDispatchError, isInfraDispatchFailure, isPostDispatchSyncFailure } from './errors.mjs';
// The ONLY dolt command surface in fleet-sprint (apra-fleet-417.2.1). Every
// runner.js call site uses the purpose-based entry points on DoltSync
// (apra-fleet-417.2.2); the named primitives are imported here only to be
// re-exported below for the existing unit suites that drive them directly.
import { DoltSync, doltPullBefore, doltPushAfter, preflightBeadsHealthGate } from './dolt-sync.mjs';

import { parseUnmergedPaths } from './conflict-ladder.mjs';
// The deterministic dolt conflict settlement callback (docs/dolt-sync-
// redesign.md). It REPLACES the retired Path A -> Path B -> Tier 2 ladder at
// BOTH divergence terminals: the post-dispatch D-push bracket
// (syncMemberAfterOrdered) and the pre-dispatch D-pull / readiness gate, so a
// wedged beads clone self-heals instead of surfacing BEADS_SYNC_CONFLICT or
// hard-aborting the run at its readiness gate.
import { buildSettleCallback } from './dolt-settle.mjs';
import { acquireSprintLock } from './sprint-lock.mjs';
// apra-fleet-3swo.6.9: `capabilities as vcsCapabilities` is no longer imported
// here. Its ONE consumer was the Publish-PR capability gate, which moved with
// the phase into ./phases/publish-pr.mjs (that module imports it directly);
// finalizeAbort's identical gate already imports it in ./abort.mjs. Keeping a
// dead alias behind would have read as "runner.js still makes a VCS capability
// decision", which is exactly what test/vcs-capabilities-table.test.mjs now
// pins at zero.
// apra-fleet-3swo.6.3: `classifyFailure` and `toGitVerdict` are no longer
// imported here. Their ONE call site was classifyGitFailure(), which moved to
// ./git-topology.mjs with the rest of the git-failure classification layer;
// that module imports them from vcs-module.mjs directly. Keeping the names
// here would have been a dead import reading as "runner.js still parses VCS
// stderr", which is exactly what test/vcs-nongithub-auth-selfheal.test.mjs
// pins at zero.
import { buildCreatePrCommand, resolveProvider, parseProviderRepoRef, getVcsProvider } from './vcs-module.mjs';
// apra-fleet-3swo.6.3: the git-topology layer the sync brackets below sit on
// top of -- the pre-sprint multi-member topology precondition, the ONE git
// failure classifier and the retrying git-command primitive every bracket
// issues its commands through, and the exit-code-based soft-git result
// adapter. Moved verbatim out of runner.js; see that module's header for
// where the boundary is drawn.
//
// apra-fleet-3swo.6.10: the brackets that used to sit here on top of it --
// syncMemberBefore/syncMemberAfter/syncMemberAfterOrdered and the resume
// path's resyncReacquiredMember -- have since moved to ./member-sync.mjs, so
// nothing in THIS file calls the git-topology layer any more. These four names
// are imported purely to be re-exported below (bin/cli.mjs and abort.mjs take
// them from runner.js); resolveGitProviderForClassification left with the
// brackets that were its only caller here.
import {
    checkMemberTopology, classifyGitFailure, runGitStep, commandResultToSoftGit,
} from './git-topology.mjs';
import { getSeCommands } from './se-os-commands.mjs';
import { resultText, toolErrorText } from './mcp-result.mjs';
import { resolveMemberTarget, resolveMemberOs, clearMemberOsCache } from './member-target.mjs';
import { createSprintState, sprintScopedFleetApi, resolveSettleShellWith } from './sprint-state.mjs';
// apra-fleet-3swo.6.10: the per-member git/dolt sync brackets, moved verbatim
// out of this file into ./member-sync.mjs (see that module's header for the
// boundary and for why resolveSettleShell travelled with them). The four
// bracket entry points are imported only to be re-exported below, unchanged,
// so no importer of runner.js is edited by the move. resolveSettleShell did NOT
// move: test/sprint-state.test.mjs anchors it to this file by symbol, and six of
// its seven call sites are this file's own orchestrator-side settle brackets, so
// member-sync.mjs imports it back from here.
import {
    syncMemberBefore, syncMemberAfter, syncMemberAfterOrdered, resyncReacquiredMember,
} from './member-sync.mjs';
// apra-fleet-3swo.6.12: createMemberSessionGuard, createUnattendedAutoProvisioner,
// createDeployPermissionsProvisioner and stageCommandBodyMemberSide, moved
// verbatim out of this file into ./member-provisioning.mjs (see that module's
// header for the boundary). They are imported only to be re-exported below,
// unchanged, so no importer of runner.js is edited by the move.
// resolveSettleShell did NOT move -- it sat in the middle of this group and is
// module-private composition-root wiring that test/sprint-state.test.mjs
// anchors to this file by symbol -- so member-provisioning.mjs does not import
// it back (none of the four moved symbols call it).
import {
    createMemberSessionGuard, createUnattendedAutoProvisioner,
    createDeployPermissionsProvisioner, stageCommandBodyMemberSide,
} from './member-provisioning.mjs';
import {
    parseOwnerRepoFromRemoteUrl, parseRepoScopeFromRemoteUrl, vcsCredentialLabelForProvider,
    // raiseVcsPrForMember left this import with the Publish PR phase
    // (apra-fleet-3swo.6.9) -- ./phases/publish-pr.mjs imports it from
    // vcs-auth.mjs directly, and it was never part of runner.js's export
    // facade (test/vcs-auth-extraction-facade.test.mjs pins it as private).
    buildCredentialReadCommand, PR_SKIPPED_NO_MCP_CLIENT,
    createMemberVcsProviderResolver, createVcsAuthSelfHealCallback, createVcsAuthPreflightCallback,
    createLlmAuthSelfHealCallback,
} from './vcs-auth.mjs';
import { validateIssueId, validateBranchName, validateArgs } from './sprint-args.mjs';
import {
    buildPlannerPrompt, buildPlanReviewerPrompt, buildStreakAssignmentPrompt, buildDoerPrompt,
    buildReviewerPrompt, buildFinalVerdictPrompt, buildHarvesterPrompt,
} from './prompts.mjs';
import {
    selectStreaks, groupStreaksFromLaneMetadata, SIZE_POINTS, MODEL_WEIGHT, DEFAULT_EFFORT_THRESHOLD,
    computeLaneEffort, streakRequiredTier, streakMinPriority, streakEffortPoints, beadBlocksDependencyIds,
    resolveWorklistTierPolicy, hasContextHeadroomForResume, assignDoerWorklists,
} from './worklists.mjs';
import {
    isTypedAbortError, finalizeAbort, persistNewTaskBestEffort, validateNewTask,
    appendRejectedFindingToParentNotes, sanitizeNewTaskTitle, sanitizeNewTaskDescription,
} from './abort.mjs';
import { decideEnsureBranchAction } from './branch-ensure.mjs';
// The git/dolt sync brackets: withGitSync (the full dispatch bracket), the
// standalone bracket helpers every other sync/push site here goes through,
// and the openSyncBracketCount clean-state pause-guard counter they share.
// POST_DISPATCH_SYNC_RETRY_DELAYS_MS and the mock instant-backoff switch
// moved with them (apra-fleet-3swo.4.1).
import { createSyncBrackets, createGitSync } from './git-sync.mjs';
// The ONE dispatch engine (apra-fleet-3swo.5.3). It executes a role's ladder
// out of role-policies.mjs's data table; TURN_BASES is imported alongside it
// because the turn-budget constants moved there with the dispatch that
// consumes them, and a few runner-side presentation labels still interpolate
// a resume's doubled budget.
import { dispatchRole, TURN_BASES } from './dispatch-role.mjs';
// The policy TABLE the engine executes. runner.js reads it only to state, in a
// log line, the bound the row itself sets -- never to re-implement a ladder.
import { policyFor } from './role-policies.mjs';
// apra-fleet-3swo.6.2: the first two of runSprintCycle's twelve phase()
// boundaries, sliced into their own modules under ./phases/. Each takes ONE
// explicit state argument instead of closing over runSprintCycle's locals; the
// call sites below are the only places they are used, and the phase ORDER is
// unchanged -- Ensure Sprint Branch still runs where it ran, Plan still runs
// at the top of every cycle.
import { runEnsureSprintBranchPhase } from './phases/ensure-sprint-branch.mjs';
import { runPlanPhase } from './phases/plan.mjs';
// apra-fleet-3swo.6.7: the next two phase() boundaries, sliced the same way
// -- the in-cycle scoped Replan and one Develop round. Both live INSIDE the
// Develop/Review round loop below, so both take the round's `devRounds`
// already incremented; see each module's header for where its boundary is
// drawn and why the loop control around it stayed here.
import { runReplanPhase } from './phases/replan.mjs';
import { runDevelopPhase } from './phases/develop.mjs';
// apra-fleet-3swo.6.5: the next two phase() boundaries -- the per-round Review
// and the per-cycle Deploy. Review still runs inside the Develop/Review round
// loop (so it too takes `devRounds` already incremented) and hands back the
// three values it REASSIGNS rather than mutates; Deploy is the body of the
// `if (hasDeploy)` branch below and hands back `deployedThisCycle`. See each
// module's header for where its boundary is drawn and why the probe/else
// around Deploy, and the dashboard/still-open loop control after Review,
// stayed here.
import { runReviewPhase } from './phases/review.mjs';
import { runDeployPhase } from './phases/deploy.mjs';
// apra-fleet-3swo.6.8: the next two phase() boundaries -- the per-cycle Integ
// Test and the Re-Review that Cycle Evaluation dispatches when the goal-
// priority count already reads 0 but no review ran this cycle. Integ Test is
// the body of the `if (hasPlaybook && deployedThisCycle)` branch below (its two
// runbook probes, the hoisted `verifySetForIntegTest` declaration and both
// "Skipping Integration Test Phase" else branches stay here) and hands back the
// three values it REASSIGNS; Re-Review is the body of the
// `if (openAtGoal.length === 0 && !reviewedThisCycle)` branch and hands back
// the same three the per-round Review does. See each module's header for where
// its boundary is drawn and why the surrounding `if`/exit-gate stayed here.
import { runIntegTestPhase } from './phases/integ-test.mjs';
import { runReReviewPhase } from './phases/re-review.mjs';
// apra-fleet-3swo.6.6: the next two phase() boundaries -- the sprint's closing
// Final Review and the once-per-sprint Regression Test. Final Review runs from
// its own phase() call to the findings D-push and RETURNS the sprint verdict
// plus the two closing counts the analysis doc renders; the group('Finalization')
// banner around it stays here because it wraps all four Finalization phases.
// Regression Test is the body of the `if (hasRegressionPlaybook)` branch below
// (its probe, the null default and the "Skipping Regression Test Phase" else
// stay here). Their ORDER is a safety property, not a preference: Final Review
// producing finalVerdictResult before Regression Test runs is what makes a
// regression failure unable to perturb the sprint verdict. See each module's
// header for where its boundary is drawn.
import { runFinalReviewPhase } from './phases/final-review.mjs';
import { runRegressionTestPhase } from './phases/regression-test.mjs';
// apra-fleet-3swo.6.9: the LAST two phase() boundaries -- Harvest and Publish
// PR -- which completes the slice: runSprintCycle now contains no inline phase
// body at all. Harvest runs from its own phase() call to the last of its three
// harvest-report log branches; Publish PR runs from its own phase() call to
// where the final endGroup() used to sit and RETURNS `{ pushed }`, from which
// runner.js builds both of runSprintCycle's return objects (the function's
// return value is its own contract, and group('Finalization')/endGroup() wrap
// all four Finalization phases rather than either of these two). Their ORDER
// is load-bearing: the harvester is a code-writing role whose
// docs/changelog/sprint-analysis commits must be G-pushed by its own policy
// bracket before Publish PR pushes the branch and raises the PR a human reads.
// See each module's header for where its boundary is drawn.
import { runHarvestPhase } from './phases/harvest.mjs';
import { runPublishPrPhase } from './phases/publish-pr.mjs';
// The dolt-push-mutex/child-id-allocator clients (HTTP + MCP transport) and
// the fleet server's own per-member reservation-ledger client. Moved
// verbatim out of runner.js (apra-fleet-3swo.4.3).
import {
    createHttpDoltPushMutexClient, createHttpChildIdAllocatorClient,
    createMcpDoltPushMutexClient, createMcpChildIdAllocatorClient,
    createMemberReservationClient,
} from './coordination.mjs';
// The KB work concern: the URL-based scope selector, the per-dispatch
// kb_query read, kb_captures/kb_promotions vetting and forwarding, and the
// canonical-bible publish. Moved verbatim out of runner.js
// (apra-fleet-3swo.4.4). KB_MAX_KNOWLEDGE_ENTRIES is imported back here so it
// can be re-exported below for existing importers of runner.js.
import {
    KB_MAX_KNOWLEDGE_ENTRIES, KB_PROMOTER_ROLES, KB_MIN_PROMOTE_REASON,
    KB_CAPTURE_TYPES, KB_MAX_PROMOTION_CANDIDATES, vetKbWork, createKbWorkClient,
} from './kb.mjs';
// The KB priming client (kb_session_prime/kb_import warm-up, once per
// sprint) and the prompt-construction helpers (the self-injecting-role
// check, the per-dispatch kb_query FTS terms, and the two "KNOWLEDGE BANK"
// prompt blocks). Moved verbatim out of runner.js into the existing
// kb.mjs (apra-fleet-3swo.6.11) -- kb.mjs already owned the rest of the KB
// surface (createKbWorkClient, kbScope, vetKbWork, the KB_* limit
// constants), so these five join that single home rather than starting a
// second one.
import {
    createKbPrimingClient, KB_SELF_INJECTING_ROLES, kbQueryTerms,
    kbKnowledgeBlock, kbPromotionBlock,
} from './kb.mjs';
// Beads scope discovery + the shared full-DB snapshot: the single in-memory
// BFS scope rule (now shared by bdListScoped and classifyVerifySet instead of
// duplicated), the `bd list --all --limit 0 --json` snapshot, and the
// command/phase wrappers that implement its invalidation contract. Extracted
// out of runner.js (apra-fleet-3swo.4.6); beads-scope.mjs's header is the
// written-down version of that contract.
import { createBeadsScope, classifyVerifySet } from './beads-scope.mjs';
// The reviewer-verdict bead transitions: the ONE goal-scope-guarded reopen
// path all three verdict sites (per-round reviewer, Final Review, Re-Review)
// now take, the replanIds fold, and the verdict-contract predicate. Extracted
// out of runner.js (apra-fleet-3swo.4.7), which also brought the previously
// UNGUARDED Re-Review site under the same guard as the other two.
//
// apra-fleet-3swo.6.5: `foldReplanIds` is NOT imported here any more. Its only
// caller was the per-round reviewer site, which moved to ./phases/review.mjs
// with the Review phase; that module imports it from this same sibling. Final
// Review and Re-Review use `applyGuardedReopens` but never fold replanIds, so
// keeping the name here would have been a dead import, not a seam.
//
// apra-fleet-3swo.6.8: `applyGuardedReopens` is still imported here, but for
// ONE remaining site -- Final Review's. The Re-Review site moved verbatim into
// ./phases/re-review.mjs, which imports it from this same sibling; the guarded
// verdict path this bead's predecessor established was carried across intact,
// not reimplemented there.
import {
    isReviewerContractViolation, applyGuardedReopens,
    parseIdWithReasonEntry,
} from './beads-transitions.mjs';

// Re-exported so importers of parseUnmergedPaths from runner.js keep working;
// conflict-ladder.mjs is the single source of truth for its implementation.
export { parseUnmergedPaths };
// Re-exported so importers of the MCP result-text/tool-error-text helpers
// from runner.js keep working; mcp-result.mjs is the single source of truth
// for their implementation (apra-fleet-3swo.2.4).
export { resultText, toolErrorText };
// Re-exported so importers of the member OS/shell registry from runner.js
// keep working; member-target.mjs is the single source of truth for their
// implementation (apra-fleet-3swo.2.5).
export { resolveMemberTarget, resolveMemberOs, clearMemberOsCache };
// Re-exported so importers of the VCS/LLM auth helpers from runner.js keep
// working; vcs-auth.mjs is the single source of truth for their implementation
// (apra-fleet-3swo.3.1). Every symbol this region exported before the move is
// listed here, under its original name.
export {
    parseOwnerRepoFromRemoteUrl, parseRepoScopeFromRemoteUrl, vcsCredentialLabelForProvider,
    buildCredentialReadCommand, createMemberVcsProviderResolver, createVcsAuthSelfHealCallback,
    createVcsAuthPreflightCallback, createLlmAuthSelfHealCallback,
};
// Re-exported so importers of the CLI arg-contract validators from runner.js
// keep working (notably bin/cli.mjs); sprint-args.mjs is the single source of
// truth for their implementation (apra-fleet-3swo.3.3).
export { validateIssueId, validateBranchName, validateArgs };
// Re-exported so importers of the five previously-exported prompt builders
// from runner.js keep working; prompts.mjs is the single source of truth for
// their implementation (apra-fleet-3swo.3.4). buildPlanReviewerPrompt and
// buildStreakAssignmentPrompt were module-private before the move and are
// imported (not re-exported) purely for this file's own in-runner call sites.
export { buildPlannerPrompt, buildDoerPrompt, buildReviewerPrompt, buildFinalVerdictPrompt, buildHarvesterPrompt };
// Re-exported so importers of the worklist tier policy, effort-budget packing
// and streak-assignment helpers from runner.js keep working; worklists.mjs is
// the single source of truth for their implementation (apra-fleet-3swo.3.5).
// selectStreaks was module-private before the move and is imported (not
// re-exported) purely for this file's own in-runner call sites.
export {
    groupStreaksFromLaneMetadata, SIZE_POINTS, MODEL_WEIGHT, DEFAULT_EFFORT_THRESHOLD,
    computeLaneEffort, streakRequiredTier, streakMinPriority, streakEffortPoints, beadBlocksDependencyIds,
    resolveWorklistTierPolicy, hasContextHeadroomForResume, assignDoerWorklists,
};
// Re-exported so importers of the typed sprint-abort predicate, the
// abort-path PR publish helper and the newTask validation/persistence
// helpers from runner.js keep working; abort.mjs is the single source of
// truth for their implementation (apra-fleet-3swo.3.6).
export {
    isTypedAbortError, finalizeAbort, persistNewTaskBestEffort, validateNewTask,
    appendRejectedFindingToParentNotes, sanitizeNewTaskTitle, sanitizeNewTaskDescription,
};
// Re-exported so importers of the pure Ensure Sprint Branch decision helper
// from runner.js keep working; branch-ensure.mjs is the single source of
// truth for its implementation (apra-fleet-3swo.3.6).
export { decideEnsureBranchAction };
// Re-exported so importers of the dolt-push-mutex/child-id-allocator clients
// and the member-reservation-ledger client from runner.js keep working;
// coordination.mjs is the single source of truth for their implementation
// (apra-fleet-3swo.4.3).
export {
    createHttpDoltPushMutexClient, createHttpChildIdAllocatorClient,
    createMcpDoltPushMutexClient, createMcpChildIdAllocatorClient,
    createMemberReservationClient,
};
// Re-exported so importers of the KB work helpers (scope, kb_query,
// kb_capture/kb_promote vetting+forwarding, kb_export) from runner.js keep
// working; kb.mjs is the single source of truth for their implementation
// (apra-fleet-3swo.4.4).
export {
    KB_MAX_KNOWLEDGE_ENTRIES, KB_PROMOTER_ROLES, KB_MIN_PROMOTE_REASON,
    KB_CAPTURE_TYPES, KB_MAX_PROMOTION_CANDIDATES, vetKbWork, createKbWorkClient,
};
// Re-exported so importers of the KB priming client and the prompt-
// construction helpers (kbKnowledgeBlock, kbPromotionBlock, kbQueryTerms,
// KB_SELF_INJECTING_ROLES) from runner.js keep working; kb.mjs is the
// single source of truth for their implementation (apra-fleet-3swo.6.11).
export {
    createKbPrimingClient, KB_SELF_INJECTING_ROLES, kbQueryTerms,
    kbKnowledgeBlock, kbPromotionBlock,
};
// Re-exported so importers of the verify-set classifier from runner.js keep
// working; beads-scope.mjs is the single source of truth for its
// implementation, and for the BFS scope-discovery rule it now shares with
// bdListScoped (apra-fleet-3swo.4.6). buildBeadGraph/discoverScope/
// isBeadsMutatingCommand were module-private to the pre-move region and stay
// reachable only from beads-scope.mjs.
export { classifyVerifySet };
// Re-exported so importers of the reviewer verdict-contract predicate from
// runner.js keep working; beads-transitions.mjs is the single source of truth
// for it and for the reopen/replan transitions it gates
// (apra-fleet-3swo.4.7).
export { isReviewerContractViolation };
// Re-exported so importers of the git-topology helpers from runner.js keep
// working (bin/cli.mjs takes checkMemberTopology and commandResultToSoftGit
// from here, and abort.mjs takes runGitStep); git-topology.mjs is the single
// source of truth for their implementation (apra-fleet-3swo.6.3). Every
// symbol this region exported before the move is listed here, under its
// original name. resolveGitProviderForClassification is deliberately absent:
// it was module-private to the pre-move region and stays reachable only from
// git-topology.mjs.
export { checkMemberTopology, classifyGitFailure, runGitStep, commandResultToSoftGit };
// Re-exported so importers of the per-member sync brackets from runner.js keep
// working (git-sync.mjs takes syncMemberBefore/syncMemberAfter/
// syncMemberAfterOrdered through injection, abort.mjs and the resume path take
// resyncReacquiredMember, and several unit suites import them straight from
// here); member-sync.mjs is the single source of truth for their
// implementation (apra-fleet-3swo.6.10). Every symbol that region exported
// before the move is listed here, under its original name.
export { syncMemberBefore, syncMemberAfter, syncMemberAfterOrdered, resyncReacquiredMember };
// Re-exported so importers of the member-provisioning helpers from runner.js
// keep working; member-provisioning.mjs is the single source of truth for
// their implementation (apra-fleet-3swo.6.12). Every symbol that region
// exported before the move is listed here, under its original name.
// resolveSettleShell is deliberately absent from this line: it did not move
// and keeps its own `export async function resolveSettleShell` declaration
// above.
export {
    createMemberSessionGuard, createUnattendedAutoProvisioner,
    createDeployPermissionsProvisioner, stageCommandBodyMemberSide,
};

// ---------------------------------------------------------------------------
// Canonical role-name constants for the Develop/Review loop
// ---------------------------------------------------------------------------
//
// Role names must come from `contracts.ROLES` (the single canonical, lowercase
// role enum) rather than string literals: roleConst() throws at module-load
// time if a name is not a member of that enum, so a rename or casing/typo
// mismatch cannot silently collapse a role's member pool at runtime.
function roleConst(name) {
    if (!ROLES.includes(name)) {
        throw new Error(`[Role Contract] '${name}' is not a member of contracts.ROLES: ${ROLES.join(', ')}`);
    }
    return name;
}
const ROLE_DOER = roleConst('doer');
const ROLE_REVIEWER = roleConst('reviewer');

// ---------------------------------------------------------------------------
// 'orchestrator' pseudo-role
// ---------------------------------------------------------------------------
//
// 'orchestrator' is deliberately NOT a member of `contracts.ROLES` and must
// never be added to it: that enum is vendored (it mirrors the `name:`
// frontmatter of packages/apra-fleet-se/apra-pm/agents/*.md 1:1) and this repo
// must not diverge from it. 'orchestrator' has no agent definition, no
// input/output schema, and is never passed to `agent()` -- it is never
// dispatched as a fleet agent at all. It is an APPLICATION-LEVEL pseudo-role:
// a `roleMap` key pinning which physical fleet member the orchestrating
// PROCESS ITSELF (this file, issuing `bd`/`git` commands directly) acts as.
// Being non-vendored, it must not be passed through `roleConst()`/`ROLES`
// membership checks (that would throw), and must never be used as a key into
// a `bd show`-derived model-metadata lookup or any vendored schema table.
// Always reference it via this constant (the canonical lowercase form) rather
// than a literal, so a roleMap author's lowercase key is always honored.
const ROLE_ORCHESTRATOR = 'orchestrator';

// ---------------------------------------------------------------------------
// Fixed-role tier defaults
// ---------------------------------------------------------------------------
//
// Doer dispatches price themselves off the PER-BEAD model tier the planner
// records in beads metadata (see the streak model resolution near the
// Develop/Review loop below). The other roles this runner dispatches each run
// once per cycle/run and have no bead of their own to read a tier from, so
// they use a FIXED tier chosen for the nature of the work. Passing no `model`
// is not an option: FleetWorkflow would fall back to a 'default' bucket that
// matches no entry in pricing.mjs and is therefore never priced.
//   planner            -> 'premium'  (drafts/redrafts the whole task DAG; highest-stakes single dispatch of a cycle)
//   plan-reviewer      -> 'premium'  (adversarial DAG review; vendor contract treats reviewer-class work as premium-tier)
//   reviewer           -> 'premium'  (both per-round AND final review; vendor contract: "always use model: premium")
//   deployer           -> 'standard' (mostly mechanical: follow deploy.md)
//   integ-test-runner  -> 'standard' (mostly mechanical: follow integ-test-playbook.md)
//   regression-test-runner -> 'standard' (mostly mechanical: follow regression-test-playbook.md)
//   harvester          -> 'standard' (docs/CHANGELOG synthesis, not code-critical)
// These tier keywords ('cheap' | 'standard' | 'premium') are resolved to a
// concrete model PER MEMBER, server-side, by execute-prompt.ts's
// resolveModelForTier() (via each member's registered model_tiers). That is
// what makes a mixed-provider fleet work: a fixed 'premium' dispatch resolves
// to whatever each target member's own premium tier is configured to, instead
// of a provider-specific model literal being passed verbatim to a member where
// it means nothing. Real per-member cost lookup (rather than a tier-band
// estimate) is available via the get_member_model_pricing MCP tool; see
// pricing.mjs.
const FIXED_ROLE_TIER = {
    planner: 'premium',
    'plan-reviewer': 'premium',
    reviewer: 'premium',
    deployer: 'standard',
    'integ-test-runner': 'standard',
    'regression-test-runner': 'standard',
    harvester: 'standard',
    // Streak Assignment is this runner's own ad-hoc "group these ready bead
    // ids" call (no vendored persona): a small, fully-specified classification
    // task with no exploration or judgment beyond what the prompt already
    // states, so it gets 'cheap' even though it borrows the planner MEMBER for
    // routing convenience.
    streakAssignment: 'cheap',
};

export const meta = { name: 'fleet-sprint-runner' };

// ---------------------------------------------------------------------------
// bd JSON-parse helper
// ---------------------------------------------------------------------------
//
// All `bd ... --json` output must be parsed through this rather than a bare
// JSON.parse: non-JSON noise on stdout (a warning or deprecation line) would
// otherwise raise an anonymous SyntaxError deep inside a multi-cycle run. This
// names the offending command and includes a snippet of the raw output.
/**
 * @param {string} raw - the raw text returned by `command()`
 * @param {string} commandLabel - the `bd` command that produced `raw`, for diagnostics
 * @returns {any}
 */
export function parseBdJson(raw, commandLabel) {
    const text = raw === undefined || raw === null || raw === '' ? '[]' : raw;
    try {
        return JSON.parse(text);
    } catch (err) {
        const snippet = text.length > 500 ? `${text.slice(0, 500)}... (truncated, ${text.length} chars total)` : text;
        throw new Error(
            `[bd JSON Parse Error] Failed to parse JSON output from '${commandLabel}': ${err.message}. ` +
            `Raw output snippet: ${JSON.stringify(snippet)}`
        );
    }
}

// ---------------------------------------------------------------------------
// Goal-priority helpers
// ---------------------------------------------------------------------------
//
// `validated.goal` is a slash-separated priority list (e.g. 'P1', 'P1/P2'),
// already validated against GOAL_PATTERN above. The sprint's exit condition
// (distinct from "is there work dispatchable right now", which `--ready`
// answers) is: are there any NOT-YET-CLOSED beads in scope at or above
// (numerically <=) the worst priority named in the goal? `bd list
// --priority-max=Pn` is inclusive of Pn, so the worst (highest numeric)
// priority in the goal is exactly the right `--priority-max` value.
/**
 * @param {string} goal - e.g. 'P1', 'P1/P2', 'P1/P2/P3'
 * @returns {string} the lowest-priority (highest 'Pn' number) tier named in `goal`, e.g. 'P2'
 */
export function goalPriorityMax(goal) {
    const tiers = goal.split('/').map((p) => Number(p.slice(1)));
    const worst = Math.max(...tiers);
    return `P${worst}`;
}

// apra-fleet-eft.52.1.3: server-side goal-membership placement for the
// fleet-sprint dashboard's Sprint vs Backlog split. The viewer must NOT
// decide this itself (no CSS display:none hiding in the browser, no
// priority-only guess): goal membership is graph knowledge -- it needs the
// full dependency edge set to honor the blocks-edge exception below -- so it
// is computed here, in the state payload, and every task is returned tagged
// with a `placement` field ('sprint' | 'backlog') the viewer consumes
// verbatim.
//
// Rules, applied to TOP-LEVEL items only (an item whose `parent` points at no
// other item in the dataset -- same "only an in-dataset parent nests" rule
// the viewer's containment tree uses; descendants inherit their root's
// placement):
//
//   - A top-level item is a SPRINT item unless it is DEFINITIVELY below the
//     sprint's goal band -- i.e. it has a finite numeric priority strictly
//     greater (numerically) than goalPriorityMax(goal). An item with no /
//     non-numeric priority is NOT demoted (it is in-scope sprint work of
//     unknown rank, not deliberately-deferred backlog).
//   - EXCEPTION (visual continuity): a below-goal top-level item connected to
//     an in-goal top-level item by a 'blocks'-type dependency edge (in either
//     direction) stays a SPRINT item, so it renders alongside the sprint
//     subtree it blocks / is blocked by rather than being split off into the
//     Backlog section.
//
// Descendants of a top-level item always inherit that item's placement, so a
// whole subtree lands in one section.
/**
 * @param {Array<{id: (string|number), parent?: (string|number), priority?: number, dependencies?: Array<{depends_on_id: (string|number), type: string}>}>} tasks - scoped bead objects
 * @param {string} goal - sprint goal band, e.g. 'P1/P2'
 * @returns {{ sprintTasks: object[], backlogTasks: object[] }} the same tasks, each tagged with a `placement` field, partitioned by section
 */
export function partitionByGoalMembership(tasks, goal) {
    const list = Array.isArray(tasks) ? tasks : [];
    const byId = new Map();
    list.forEach((t) => {
        if (t && t.id !== undefined && t.id !== null) byId.set(String(t.id), t);
    });

    const hasInDatasetParent = (t) => {
        const p = t && t.parent;
        return p !== undefined && p !== null && byId.has(String(p));
    };

    // Walk `parent` up to the top-level in-dataset ancestor (cycle-guarded).
    const rootOf = (t) => {
        let cur = t;
        const seen = new Set();
        while (hasInDatasetParent(cur) && !seen.has(String(cur.id))) {
            seen.add(String(cur.id));
            cur = byId.get(String(cur.parent));
        }
        return cur;
    };

    const goalMaxNum = Number(goalPriorityMax(goal).slice(1));
    const isBelowGoal = (t) =>
        typeof t.priority === 'number' && Number.isFinite(t.priority) && t.priority > goalMaxNum;

    const topLevel = list.filter((t) => t && !hasInDatasetParent(t));
    // In-goal top-level items: everything not definitively below the goal band.
    const inGoalTopIds = new Set(
        topLevel.filter((t) => !isBelowGoal(t)).map((t) => String(t.id))
    );

    // Sprint set starts as the in-goal top-levels, then absorbs below-goal
    // top-levels connected to an in-goal top-level by a 'blocks' edge, in
    // either direction.
    const sprintTopIds = new Set(inGoalTopIds);
    topLevel.forEach((t) => {
        const id = String(t.id);
        if (sprintTopIds.has(id)) return;
        // Outgoing: this below-goal top-level depends_on (is blocked by) an
        // in-goal top-level -> keep it in Sprint.
        const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
        if (deps.some((d) => d && d.type === 'blocks' && inGoalTopIds.has(String(d.depends_on_id)))) {
            sprintTopIds.add(id);
        }
    });
    // Incoming: an in-goal top-level depends_on (is blocked by) a below-goal
    // top-level -> keep that below-goal item in Sprint too.
    topLevel.forEach((t) => {
        if (!inGoalTopIds.has(String(t.id))) return;
        const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
        deps.forEach((d) => {
            if (!d || d.type !== 'blocks') return;
            const other = byId.get(String(d.depends_on_id));
            if (other && !hasInDatasetParent(other)) sprintTopIds.add(String(other.id));
        });
    });

    const sprintTasks = [];
    const backlogTasks = [];
    list.forEach((t) => {
        if (!t) return;
        const root = rootOf(t);
        const placement = sprintTopIds.has(String(root.id)) ? 'sprint' : 'backlog';
        const tagged = { ...t, placement };
        if (placement === 'backlog') backlogTasks.push(tagged);
        else sprintTasks.push(tagged);
    });
    return { sprintTasks, backlogTasks };
}

// Every status that means "not yet done" for exit-condition purposes --
// deliberately NOT `--ready`, which only reflects "dispatchable right now" and
// silently excludes blocked and orphaned in_progress beads, so an empty
// `--ready` list must never be read as "the sprint is done".
// The value is quoted, not a bare comma list: on Windows commands dispatch via
// `spawn(command, { shell: 'powershell.exe' })`, and PowerShell's parser treats
// an unquoted comma-separated value as an array literal, re-stringifying it
// space-joined ($OFS) so `bd` receives an invalid status. The quotes MUST be
// double, not single: the same string also reaches `bd` through
// `child_process.exec()` under cmd.exe, which has no single-quote quoting and
// would pass them literally into argv. Double quotes are stripped as real
// quoting by PowerShell and cmd.exe alike, and are a harmless no-op under POSIX
// shells.
const NOT_DONE_STATUSES = '"open,in_progress,blocked,deferred"';

// ---------------------------------------------------------------------------
// Git sync brackets: G-pull / G-push -- MOVED to ./member-sync.mjs
// ---------------------------------------------------------------------------
//
// apra-fleet-3swo.6.10: syncMemberBefore, syncMemberAfter,
// syncMemberAfterOrdered and the resume path's resyncReacquiredMember moved
// verbatim to ./member-sync.mjs, together with the single-writer-token-passing
// stance that governs them. All four are re-exported by the facade region
// above, so nothing that imported them from runner.js had to change. Do NOT
// re-inline a bracket here: add it to member-sync.mjs, which is registered in
// guarded-modules.mjs and is therefore the file unbracketed-push-guard.mjs
// resolves syncMemberAfterOrdered's sanctioned-wrapper range inside.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dolt sync brackets: D-pull / D-push -- MOVED to ./dolt-sync.mjs
// ---------------------------------------------------------------------------
//
// apra-fleet-417.2.1: every `bd dolt pull` / `bd dolt push` spawn, its failure
// classification, its retry/auth self-heal, its sync.remote gating and its
// conflict handling now live in ONE module -- ./dolt-sync.mjs -- which is the
// only permitted dolt command surface in fleet-sprint. Do NOT re-inline a
// `bd dolt ...` command here or anywhere else: add to DoltSync instead.
//
// runner.js calls the purpose-based entry points DoltSync.syncBefore() /
// DoltSync.syncAfter() / DoltSync.status() at every call site (apra-fleet-
// 417.2.2 migrated the last direct doltPullBefore()/doltPushAfter() callers).
// The lower-level primitives are re-exported below UNCHANGED so the existing
// unit suites (which import them directly from runner.js) keep working; they
// are IMPLEMENTATION DETAIL of the purpose-based API, not a second supported
// call surface for new code.
//
// apra-fleet-417.3.1 -- DEGRADED BY DEFAULT. DoltSync.syncBefore/syncAfter now
// return a structured outcome and do NOT throw on an unresolved sync failure;
// they log loudly, record the failure (DoltSync.getDegradedSyncRecords()) and
// let the sprint continue, because a beads-sync hiccup during concurrent
// multi-agent pushing is a NORMAL condition and must not fail an otherwise
// healthy sprint. Every call site below that must STILL hard-abort says so
// explicitly with `fatal: true`, and only these four classes do:
//   - the post-dispatch sync bracket (syncMemberAfterOrdered): a degraded
//     D-push there would advertise an unreachable close;
//   - the pre-dispatch D-pull: a degraded pull hands the agent a stale clone;
//   - the orchestrator's read-freshness D-pulls before streak verification,
//     cycle-evaluation counts and final-review counts: a stale read misreports
//     every remote member's work as unfinished;
//   - the pre-flight beads-health gate (`readinessGate: true`, the
//     apra-fleet-417.5 rename of `healthGate`, which implies fatal): its
//     entire purpose is to stop the run before anything mutates.
// The orchestrator's post-mutation D-pushes are deliberately NOT fatal: those
// beads writes are already committed in the orchestrator's local clone, so an
// unresolved push is a publication delay, not data loss, and the next D-push
// bracket is its queued retry.
export {
    extractDoltRemoteUrl,
    classifyDoltFailure,
    isMemberSyncRemoteConfigured,
    doltPullBefore,
    extractConflictingTables,
    preflightBeadsHealthGate,
    doltPushAfter,
} from './dolt-sync.mjs';

/**
 * Resolve a member's registered shell for a buildSettleCallback call site,
 * guarded on the presence of a callTool the same way the original
 * pre-dispatch wiring at runSprintCycle's dispatch bracket is (apra-
 * fleet-7dir.16) -- so a mock-sprint scenario with no MCP client wired keeps
 * its pre-shell-aware default ('', PowerShell dialect on Windows) instead of
 * throwing or hanging on a fleetApi call that has nothing to answer it.
 * Shared by every remaining buildSettleCallback call site so each one does
 * not have to re-implement the guard (apra-fleet-7dir.24).
 *
 * apra-fleet-3swo.6.1: this no longer builds a fleet client of its own. It
 * used to run `new ApraFleet({ callTool: args.callTool })` on EVERY call, at
 * seven call sites, several of them per dispatch. The client is now
 * sprint-scoped state (fleet-sprint/sprint-state.mjs), resolved once per
 * sprint:
 *   1. `sprintState` -- the object runSprintCycle creates once at sprint start
 *      and threads down. Every in-cycle call site passes it.
 *   2. `args.callTool` alone -- the fallback for the call sites reached from
 *      OUTSIDE runSprintCycle's closure (syncMemberAfterOrdered, called by
 *      git-sync.mjs's withGitSync teardown, which is handed `args` and no
 *      sprint state). sprintScopedFleetApi memoizes per callTool identity, so
 *      this path shares the sprint's single client rather than building one
 *      per call.
 *   3. neither -- the empty string, the pre-shell-aware default (see above).
 *
 * The resolved { os, shell } itself is deliberately NOT memoized here or in
 * sprint state: member-target.mjs owns that cache and does not cache its
 * degrade, so a transiently-unreachable member is re-resolved next call
 * (apra-fleet-ot2z.13). See sprint-state.mjs's header.
 *
 * @param {{ args?: { callTool?: Function }, member: string, log?: Function, sprintState?: object }} opts
 * @returns {Promise<string>}
 */
// apra-fleet-3swo.6.10: exported (it was module-private) so ./member-sync.mjs's
// syncMemberAfterOrdered can reach it. It stays HERE rather than moving with the
// bracket because test/sprint-state.test.mjs anchors it to runner.js by symbol
// and six of its seven call sites are this file's own settle brackets.
export async function resolveSettleShell({ args, member, log = () => {}, sprintState }) {
    if (sprintState) return sprintState.resolveSettleShell({ member, log });
    if (!(args && typeof args.callTool === 'function')) return '';
    return resolveSettleShellWith({
        fleetApi: sprintScopedFleetApi({ callTool: args.callTool, log }),
        member,
        log,
    });
}

/**
 * The count of children a parent ALREADY has, i.e. the highest trailing `.N`
 * segment across its direct children. Passed to the allocator as `floor` so
 * that on its FIRST allocation under a parent it never mints an id colliding
 * with a child created before the allocator's persisted state was seeded.
 * Best-effort: a failed or unparseable list yields 0 (the allocator's own
 * persisted high-water still guards against re-minting after that).
 *
 * @param {{ command: Function, member: string, parentId: string }} opts
 * @returns {Promise<number>}
 */
export async function computeChildFloor({ command, member, parentId }) {
    try {
        const label = `bd list --parent ${parentId} --json`;
        const raw = await command(label, { member_name: member, silent: true });
        const beads = parseBdJson(raw, label);
        let max = 0;
        const prefix = `${parentId}.`;
        for (const b of beads) {
            if (!b || typeof b.id !== 'string' || !b.id.startsWith(prefix)) continue;
            const tail = b.id.slice(prefix.length);
            // Only a DIRECT child (single trailing numeric segment) counts.
            if (!/^\d+$/.test(tail)) continue;
            const n = Number(tail);
            if (Number.isInteger(n) && n > max) max = n;
        }
        return max;
    } catch {
        return 0;
    }
}

/**
 * Create a child bead under `parentId` using an allocator-minted,
 * collision-free explicit id. This is the single bead-creation seam every
 * proposed newTask flows through, so that two concurrent sprints never mint
 * the same child id.
 *
 * Sequence (mirrors the allocator's reserve -> confirm/release contract):
 *   1. allocate() reserves the next distinct child id under the shared parent.
 *   2. `bd create` runs with `--id <childId>` (or, under the null client where
 *      childId is null, lets bd derive the id from `--parent`).
 *   3. On the explicit-id path only, a follow-up `bd update <childId> --parent
 *      <parentId>` establishes the real parent edge.
 *   4. confirm() on success (the id is now durably used) or release() on
 *      failure (the reserved id returns to the pool, never a permanent gap).
 *
 * `bd create` REJECTS `--id` and `--parent` together, so on the explicit-id
 * path `--parent` must be dropped: the allocator's `${parentId}.${seq}` id
 * shape already encodes the hierarchy. A dotted id alone does NOT record the
 * explicit parent edge, which is what the separate `bd update --parent`
 * supplies; that link step is deliberately NOT best-effort -- a failure
 * throws, releases the reservation, and degrades loudly rather than leaving
 * an edgeless child.
 *
 * @param {{
 *   command: Function, allocator: { allocate: Function, confirm: Function, release: Function },
 *   member: string, title: string, description: string, priority: string,
 *   parentId: string, sprintId?: string, floor?: number, label?: string,
 *   log?: Function,
 * }} opts
 * @returns {Promise<{ childId: string|null }>}
 */
export async function createChildBeadWithAllocatedId(opts) {
    const { command, allocator, member, title, description, priority, parentId, sprintId, floor, label, log = () => {} } = opts;
    const grant = await allocator.allocate(parentId, { pid: process.pid, sprintId, floor });
    // The explicit-id path relies on the allocator's `${parentId}.${seq}` id
    // shape to carry the hierarchy that `--parent` can no longer carry
    // alongside `--id` (see the doc comment above). Fail loudly rather than
    // create a child whose id does not place it under this parent at all.
    if (grant.childId && !String(grant.childId).startsWith(`${parentId}.`)) {
        await allocator.release(grant.token);
        throw new Error(
            `[id-allocator] allocated child id '${grant.childId}' is not a child of parent '${parentId}' ` +
            '(expected the `<parentId>.<seq>` shape); released the reservation rather than creating an unparented bead',
        );
    }
    // `bd create` refuses `--id` together with `--parent`: carry EITHER the
    // allocator-minted explicit id (hierarchy encoded in the id, parent edge
    // linked immediately after the create) OR `--parent` and let bd derive the
    // id (null-allocator path).
    const parentageFlags = grant.childId ? `--id ${grant.childId}` : `--parent ${parentId}`;
    // The description is LLM-authored free text: stage it to a member-local
    // temp file (see stageCommandBodyMemberSide) and hand THAT path to `bd
    // create --body-file` rather than interpolating it into the shell command
    // string. Only `title` (short, allowlist-validated by validateNewTask)
    // remains inline.
    try {
        const descriptionFile = await stageCommandBodyMemberSide({
            command, member, content: description,
            label: `Stage newTask description for '${title}'`,
        });
        await command(
            `bd create "${title}" --body-file "${descriptionFile}" -p "${priority}" ${parentageFlags} --silent`,
            { member_name: member, silent: true, label: label ?? `Create follow-up task: ${title}` }
        );
        // Explicit-id path only: record the real parent edge that `--parent`
        // would have recorded, had bd allowed it on the same create.
        if (grant.childId) {
            await command(
                `bd update ${grant.childId} --parent ${parentId}`,
                { member_name: member, silent: true, label: `Link follow-up task ${grant.childId} under ${parentId}` }
            );
        }
    } catch (err) {
        // The create did NOT land -- return the reserved id to the pool so the
        // next allocation reuses it (no permanent gap), then re-throw.
        await allocator.release(grant.token);
        log(`[id-allocator] bd create failed for '${grant.childId ?? '(bd-derived)'}'; released reservation: ${err.message}`);
        throw err;
    }
    // The create landed locally -- durably commit the id BEFORE the D-push, so a
    // crash after this point can never reclaim an id that now genuinely exists.
    await allocator.confirm(grant.token);
    return { childId: grant.childId ?? null };
}

/**
 * The orchestrator's post-streak verification read, with its mandatory
 * D-pull. A remote doer closes its assigned beads in its OWN clone and
 * D-pushes them, so the orchestrator MUST D-pull its own clone BEFORE the `bd
 * show` -- otherwise it reads stale (still-open) status and falsely reports
 * every remote doer streak as FAILED.
 *
 * Returns the ids that are NOT closed after the D-pull-then-read. An empty
 * array means the streak genuinely closed everything it was assigned.
 *
 * @param {{ command: Function, orchestratorMember: string, beadIds: string[], log?: Function, args?: { callTool?: Function }, sprintState?: object }} opts
 * @returns {Promise<string[]>} the still-unclosed bead ids
 */
export async function verifyDoerStreakClosed({ command, orchestratorMember, beadIds, log = () => {}, args, sprintState }) {
    // D-pull FIRST so the orchestrator's clone observes the doer's just-pushed
    // closes. Routed through the single dolt-sync module's purpose-based BEFORE
    // bracket (apra-fleet-417.2.1); behavior is identical to the previous
    // direct doltPullBefore() call.
    // Thread the orchestrator member's REGISTERED shell into dolt-settle,
    // guarded on args.callTool the same way the pre-dispatch bracket is
    // (apra-fleet-7dir.24).
    const shell = await resolveSettleShell({ args, member: orchestratorMember, log, sprintState });
    await DoltSync.syncBefore(orchestratorMember, { command, log, fatal: true, settle: buildSettleCallback(orchestratorMember, { command, log, shell }) });
    const label = `bd show ${beadIds.join(' ')} --json`;
    const showRes = await command(label, { member_name: orchestratorMember, silent: true });
    const showBeads = parseBdJson(showRes, label);
    const statusById = new Map(showBeads.map((b) => [b.id, b.status]));
    return beadIds.filter((id) => statusById.get(id) !== 'closed');
}

/**
 * Batched per-streak work-claiming (apra-fleet-7h6n.7, audit R6): claims
 * every id in `beadIds` with ONE `bd update <id...> --claim --json`
 * invocation instead of one `bd update <id> --claim` call per bead.
 *
 * RESEARCH FINDING this batching relies on (verified against real `bd`
 * 1.1.0, both by reading `bd update --help`'s `Usage: bd update [id...]`
 * and by exercising a scratch sandbox DB): `bd update` DOES accept a
 * variadic id list, and `--claim --json` on a MULTI-id invocation returns a
 * JSON array containing ONLY the issues that were successfully claimed --
 * an id that fails to resolve, or is already claimed by a DIFFERENT
 * assignee, is silently dropped from the array (its error goes to stderr,
 * not stdout) rather than aborting the whole call. Two non-obvious
 * consequences, both load-bearing for this function's design:
 *   1. This is NOT atomic in the transactional sense -- ids before a
 *      failing one are still committed, there is no all-or-nothing
 *      rollback. It IS enough to cut the streak's claim step from N
 *      subprocess spawns to 1, which is this bead's actual goal.
 *   2. The process exit code stays 0 even when SOME ids in the batch
 *      failed to claim (verified: a lone failing id exits 1, but the exact
 *      same failure mixed into a multi-id batch with a succeeding id exits
 *      0) -- so, unlike the old single-id-per-call loop, success can NEVER
 *      be inferred from "command() did not throw". The returned JSON array
 *      is the only reliable signal, which is why this function always
 *      diffs `beadIds` against the parsed array rather than relying on a
 *      catch block.
 *
 * A total call failure (command() itself throws -- e.g. a transient
 * dispatch/network fault reaching the member) is treated the same way the
 * old loop treated "every id failed": every id is reported skipped, never
 * thrown, so one bad batch degrades the streak (all its beads stay
 * unclaimed, caller decides whether to skip the streak) rather than
 * crashing the sprint.
 *
 * @param {{ command: Function, orchestratorMember: string, beadIds: string[], log?: Function }} opts
 * @returns {Promise<{ claimedBeadIds: string[], skippedBeadIds: string[] }>}
 */
export async function claimBeadsBatched({ command, orchestratorMember, beadIds, log = () => {} }) {
    if (!Array.isArray(beadIds) || beadIds.length === 0) {
        return { claimedBeadIds: [], skippedBeadIds: [] };
    }
    const label = `bd update ${beadIds.join(' ')} --claim --json`;
    let raw;
    try {
        raw = await command(label, { member_name: orchestratorMember, silent: true });
    } catch (err) {
        // A dispatch/exec-level failure (member unreachable, transient
        // network fault) degrades gracefully -- every id in this batch
        // stays unclaimed, same as the old per-id loop's catch-and-skip.
        // This is DISTINCT from a malformed-JSON parse failure below, which
        // stays fatal (per parseBdJson's own doc comment: a parse failure
        // must be LOUD, never silently swallowed as "everything skipped").
        log(`Batched claim failed for [${beadIds.join(', ')}]: ${err.message}`);
        return { claimedBeadIds: [], skippedBeadIds: [...beadIds] };
    }
    const claimed = parseBdJson(raw, label);
    const claimedIds = new Set((Array.isArray(claimed) ? claimed : []).map((b) => b && b.id).filter(Boolean));
    const claimedBeadIds = beadIds.filter((id) => claimedIds.has(id));
    const skippedBeadIds = beadIds.filter((id) => !claimedIds.has(id));
    if (skippedBeadIds.length > 0) {
        log(`Batched claim: claimed ${claimedBeadIds.length} bead(s) [${claimedBeadIds.join(', ')}]; skipped ${skippedBeadIds.length} already-claimed/unresolvable bead(s) [${skippedBeadIds.join(', ')}].`);
    }
    return { claimedBeadIds, skippedBeadIds };
}

// ---------------------------------------------------------------------------
// Plan phase prompt builder
// ---------------------------------------------------------------------------
//
// Builds a self-contained planner prompt per the vendored
// apra-pm/agents/planner.md contract: the planner has no memory of this
// conversation, so every fact it needs (which sprint root issue(s) are in
// scope, the goal priority, the requirements file content, and -- for a
// re-planning cycle -- explicit "gaps only" framing) must be spelled out in
// the prompt text rather than assumed.
//
// Model-tier convention: planner.md Step 3 is the authoritative source and
// makes beads *metadata* set at creation time (`bd create ... --metadata
// '{"model": "<tier>"}'`) the ONLY location the model tier is recorded --
// never `--notes` or a METADATA-section comment. Every consumer (the
// plan-reviewer, and the orchestrator that dispatches doers) reads it back
// from that same field, so this prompt's instruction MUST stay aligned with
// planner.md Step 3.
// classifyVerifySet lives in beads-scope.mjs (apra-fleet-3swo.4.6) so it and
// bdListScoped share ONE BFS scope-discovery implementation instead of the two
// independent copies they used to carry; it is re-exported from this file
// above.

// ---------------------------------------------------------------------------
// Develop/Review loop prompt builders + pure helpers
// ---------------------------------------------------------------------------

// Ceiling, in estimated tokens, above which a resumed session is treated as
// near its context window (see createRoundSessionRegistry).
export const DEFAULT_CONTEXT_CEILING = 150000;

/**
 * Per-role, per-cycle session registry driving "round resume": within ONE
 * sprint cycle's approval loop a role (planner, reviewer, ...) resumes its OWN
 * prior-round session by explicit session id, so a re-plan / re-review keeps
 * the context it already built. The session id comes from agent()'s
 * onSessionId callback (packages/apra-fleet-workflow).
 *
 * Guards, all enforced here so the call sites stay tiny:
 *   - NEVER resume across cycles (fresh eyes): an entry is keyed to the cycle
 *     it was recorded in; asking for another cycle yields a fresh session.
 *   - A failed/timed-out round resumes nothing: its call site invokes
 *     clear(role), so a broken partial context is never carried forward.
 *   - An entry whose recorded usage was at/above `ceilingFraction` of
 *     `contextCeiling` yields a fresh session, since resuming a session near
 *     its window limit starts the next round out of room. This only bites when
 *     the provider actually reported usage: with no usage number the entry is
 *     never flagged near-ceiling and resume proceeds.
 *   - Resume support is detected by CAPABILITY, not provider name: a provider
 *     that cannot resume returns no session id, record() stores nothing, and
 *     resumeArgFor() yields `false`. There is deliberately no
 *     `provider === 'claude'`-style name test anywhere.
 *
 * @param {{ log?: (msg: string) => void, contextCeiling?: number, ceilingFraction?: number }} [opts]
 */
export function createRoundSessionRegistry(opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    const contextCeiling = typeof opts.contextCeiling === 'number' && opts.contextCeiling > 0
        ? opts.contextCeiling
        : DEFAULT_CONTEXT_CEILING;
    const ceilingFraction = typeof opts.ceilingFraction === 'number' && opts.ceilingFraction > 0
        ? opts.ceilingFraction
        : 0.9;
    // role -> { cycle: number, sessionId: string, nearCeiling: boolean }
    const byRole = new Map();

    /**
     * Record the session id a dispatch of `role` returned during `cycle`.
     * A no-op for a missing/empty id (e.g. a provider that does not support
     * resume) so the next round stays fresh.
     */
    function record(role, cycle, sessionId, meta = {}) {
        if (!role || typeof sessionId !== 'string' || sessionId === '') {
            return;
        }
        const totalTokens = meta && meta.usage && typeof meta.usage.total_tokens === 'number'
            ? meta.usage.total_tokens
            : null;
        const nearCeiling = totalTokens !== null && totalTokens >= contextCeiling * ceilingFraction;
        byRole.set(role, { cycle, sessionId, nearCeiling });
        if (nearCeiling) {
            log(`[round-resume] ${role} session recorded near the context ceiling ` +
                `(~${totalTokens} tokens >= ${Math.round(contextCeiling * ceilingFraction)}); ` +
                `the next round in this cycle will start a FRESH session.`);
        }
    }

    /**
     * The `resume` argument the NEXT dispatch of `role` in `cycle` should carry:
     * the stored session id (a string) to resume that same session, or `false`
     * to start fresh. Fresh whenever there is no prior round, the prior round
     * was in a different cycle, the prior round ended near the context ceiling,
     * or no session id was ever captured (provider without resume support).
     */
    function resumeArgFor(role, cycle) {
        const entry = byRole.get(role);
        if (!entry) return false;                 // no prior round -> fresh (R1)
        if (entry.cycle !== cycle) return false;  // never resume across cycles
        if (entry.nearCeiling) return false;      // near context ceiling -> fresh
        if (!entry.sessionId) return false;       // no captured id -> fresh
        return entry.sessionId;                   // resume THAT session explicitly
    }

    /**
     * Drop any stored session for `role` so its next round starts fresh. Called
     * by a dispatch site when the just-run round failed/timed out -- resuming a
     * failed session would carry a broken/partial context forward.
     */
    function clear(role) {
        byRole.delete(role);
    }

    return { record, resumeArgFor, clear };
}

/**
 * Builds the self-contained reviewer dispatch prompt. The reviewer is
 * dispatched without resume and so has no memory of this run: the exact bead
 * ids just worked, their full `bd show` detail (acceptance criteria), the diff
 * range, and the sprint goal priority are all spelled out rather than assumed.
 *
 * CRITICAL: explicitly, redundantly forbids the reviewer from mutating
 * beads itself. agents/reviewer.md's own prose (Step 5, Rules) already
 * states this same prohibition -- prose and dispatch prompt agree today --
 * but the schema alone doesn't stop the reviewer from shelling out `bd`
 * commands on the member side regardless of what either document says, so
 * the prohibition is stated here too as defense in depth, not because of
 * any known prose/code divergence.
 * apra-fleet-s6d: `beadIds` may legitimately be EMPTY. The Cycle Evaluation
 * re-review asks a scope-wide question ("no goal-priority beads are open --
 * is the sprint actually done?"), so it has no bead ids to name. Rendering
 * the per-bead framing anyway produced the literal dangling sentence
 * "...for the following bead id(s): ." plus a SPRINT SCOPE block ordering the
 * reviewer to judge "ONLY against the named bead id(s) above" -- against an
 * empty set. The reviewer answered honestly (CHANGES_NEEDED with nothing to
 * reopen and nothing to create), which is exactly what
 * isReviewerContractViolation flags; the retry re-sent the identical
 * incoherent prompt, so the sprint aborted on ReviewerContractViolationError.
 * The empty case therefore gets its own coherent scope-wide framing.
 *
 * @param {{ beadIds: string[], acceptanceCriteriaJson: string, baseBranch: string, branch: string, goal?: string, kbCandidates?: object[] }} opts
 * @returns {string}
 */

// isReviewerContractViolation lives in beads-transitions.mjs
// (apra-fleet-3swo.4.7) alongside the reopen/replan transitions that consume
// the same verdict contract; it is re-exported from this file above.

/**
 * Determines whether a plan-reviewer verdict is CONFINED to specific beads
 * rather than spanning the whole plan. plan-reviewer.md carries no structured
 * per-bead findings field -- `notes` is free text that names the offending
 * bead ids -- so this scans `notes` for literal occurrences of each id already
 * known to be in scope via `taskAssignments`, which plan-reviewer.md requires
 * to be populated on every round including CHANGES_NEEDED.
 *
 * An id matches only at a non-identifier-character boundary (or the string
 * start/end), so a shorter id cannot false-positive inside a longer one that
 * merely extends it.
 *
 * @param {{ notes?: string, taskAssignments?: Array<{ id?: string }> }} verdict
 * @returns {string[]} the subset of taskAssignments ids that notes calls out by name
 */
export function extractContestedBeadIds(verdict) {
    if (!verdict || typeof verdict.notes !== 'string' || !Array.isArray(verdict.taskAssignments)) {
        return [];
    }
    const notes = verdict.notes;
    const allIds = verdict.taskAssignments
        .map((a) => a && a.id)
        .filter((id) => typeof id === 'string' && id.length > 0);
    return allIds.filter((id) => {
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const boundary = '(?:^|[^A-Za-z0-9_-])';
        const endBoundary = '(?:$|[^A-Za-z0-9_-])';
        const re = new RegExp(`${boundary}${escaped}${endBoundary}`);
        return re.test(notes);
    });
}

// ---------------------------------------------------------------------------
// newTasks validation. Reviewer-authored newTasks are LLM output, and the
// reviewer's context includes the diff under review, so an adversarial
// diff/commit could try to steer it into emitting text crafted to break out of
// a shell command.
//
// SAFE_TEXT_RE (title only) deliberately excludes: backtick, `$`,
// double-quote (the command's own quoting delimiter -- allowing it back in
// would let a title close the quote early regardless of any other
// restriction), and backslash (blocks a trailing-backslash "escape the
// closing quote" trick as well as any other backslash-based escape
// sequence). The allowed punctuation (`.,:;!?()'-_/+[]` plus space) covers
// realistic task titles while remaining inert as shell syntax in both POSIX
// and Windows member shells.
//
// apra-fleet-v75: `[`, `]` and `+` are allowed. The title is interpolated as
// `bd create "${title}"` -- inside double quotes, brackets never glob and `+`
// has no meaning, in POSIX shells or PowerShell. Excluding them rejected this
// project's own bead-title convention ([bug]/[epic]/[test] prefixes), which
// `bd create` itself accepts; a real reviewer follow-up was dropped mid-sprint
// on exactly that. The characters that ARE live inside double quotes --
// `"`, `\`, backtick, `$` -- remain excluded, which is what this guard is for.
//
// `description` no longer reaches this shell-interpolation risk at all
// (apra-fleet-eft.56.1, transport hardened in eft.73.1):
// createChildBeadWithAllocatedId() stages it to a member-local temp file
// (base64-carried, member-side) and hands that path to `bd create
// --body-file`, never interpolating it into a command string. That removed
// the injection
// surface SAFE_TEXT_RE existed to close for descriptions, so
// SAFE_DESCRIPTION_RE only enforces the repo's own ASCII-only convention
// (plus non-empty) -- legitimate technical characters ('=', '&', '+', '"',
// backticks-as-text, '%', '#', '[', ']', etc.) are allowed again.
export const SAFE_TEXT_RE = /^[A-Za-z0-9 .,:;!?()'_/+[\]-]+$/;

/**
 * Normalizes a bead-metadata model value by CONTAINMENT: a value that
 * (case-insensitively) contains exactly ONE of the three tier names --
 * 'cheap', 'standard', 'premium' -- becomes that bare tier name, so
 * 'standard-tier', 'tier-standard' and 'Standard (default)' all resolve to
 * 'standard'. A value containing zero tier names (an explicit provider model
 * id) or more than one (ambiguous) passes through unchanged. This is the
 * single read site for that metadata: an un-normalized alias would reach the
 * dispatch as a literal provider model name and fail it outright.
 * @param {unknown} raw
 * @returns {unknown}
 */
export function normalizeTierToken(raw) {
    if (typeof raw !== 'string') return raw;
    const lowered = raw.toLowerCase();
    const matches = ['cheap', 'standard', 'premium'].filter((tier) => lowered.includes(tier));
    return matches.length === 1 ? matches[0] : raw;
}

// ---------------------------------------------------------------------------
// Resurfacing rejected newTasks into the next planning dispatch
// ---------------------------------------------------------------------------
//
// A note appended by appendRejectedFindingToParentNotes() is readable by a
// human but invisible to the planner, which is dispatched without resume and
// never reads bead notes. These helpers instead track the current set of
// not-yet-resubmitted rejected newTasks in run state so the planner prompt can
// carry them as explicit "previously rejected, fix and resubmit" items, and
// drop each one once resubmitted so the list cannot grow without bound. All
// are pure: the caller owns the array and none of these mutate it in place.

/**
 * Records a newly-rejected newTask into the pending resurface list, keyed by
 * title -- a newTask rejected twice under the same title keeps only the
 * LATEST rejection reason/cycle (dedup by title), so a repeatedly-resubmitted-
 * and-repeatedly-rejected item cannot grow the list unboundedly.
 * @param {Array<{title: string, description: string, reason: string, cycle: number|string}>} pending
 * @param {{title: unknown, description: unknown, reason: string, cycle: number|string}} rejected
 * @returns {Array<{title: string, description: string, reason: string, cycle: number|string}>} a NEW array
 */
export function trackRejectedNewTaskForResurfacing(pending, rejected) {
    const title = String((rejected && rejected.title) || '(untitled)');
    const description = String((rejected && rejected.description) || '');
    const entry = { title, description, reason: String(rejected && rejected.reason), cycle: rejected && rejected.cycle };
    const withoutDup = (Array.isArray(pending) ? pending : []).filter((p) => p.title !== title);
    return [...withoutDup, entry];
}

/**
 * Drops any pending rejected-newTask entries matching a newTask that has now
 * been successfully created.
 *
 * `resubmitted` may be a bare title string (title-only match) or a
 * `{title, description}` object, in which case a match on EITHER the title OR
 * a non-empty description clears the entry. Description matching is what
 * clears a resubmission whose title was corrected in response to the
 * rejection reason -- title-only matching would leave such an item pending
 * forever.
 * @param {Array<{title: string, description?: string}>} pending
 * @param {string|{title?: string, description?: string}} resubmitted
 * @returns {Array<{title: string}>} a NEW array
 */
export function clearResubmittedNewTask(pending, resubmitted) {
    const list = Array.isArray(pending) ? pending : [];
    const title = typeof resubmitted === 'string' ? resubmitted : String((resubmitted && resubmitted.title) || '');
    const description = (resubmitted && typeof resubmitted === 'object' && resubmitted.description)
        ? String(resubmitted.description) : '';
    return list.filter((p) => {
        const titleMatches = p.title === title;
        const descriptionMatches = description.length > 0 && String((p && p.description) || '') === description;
        return !(titleMatches || descriptionMatches);
    });
}

/**
 * Reconciles the pending resurface list against the parent bead's CURRENT
 * children, matching purely on description and ignoring titles. The planner
 * resubmits a corrected finding directly via `bd create` and never calls
 * clearResubmittedNewTask(), so without this pass a planner resubmission would
 * stay pending and reappear in every later planning prompt of the run. Call it
 * after any phase that may have created children under the parent (chiefly the
 * Plan phase), passing the live child list.
 * @param {Array<{title: string, description?: string}>} pending
 * @param {Array<{description?: string}>} currentChildren
 * @returns {Array<{title: string, description?: string}>} a NEW array
 */
export function reconcilePendingRejectedNewTasks(pending, currentChildren) {
    const list = Array.isArray(pending) ? pending : [];
    if (list.length === 0) return list;
    const children = Array.isArray(currentChildren) ? currentChildren : [];
    const childDescriptions = new Set(
        children
            .map((c) => String((c && c.description) || '').trim())
            .filter((d) => d.length > 0)
    );
    if (childDescriptions.size === 0) return list;
    return list.filter((p) => {
        const description = String((p && p.description) || '').trim();
        return description.length === 0 || !childDescriptions.has(description);
    });
}

/**
 * Formats the pending rejected-newTask items as explicit "previously rejected,
 * fix and resubmit" prompt lines for the planner prompt. Returns `[]` when
 * nothing is pending, so the prompt is unchanged in that case.
 * @param {Array<{title: string, description: string, reason: string, cycle: number|string}>} pending
 * @returns {string[]}
 */
export function buildRejectedNewTaskResurfaceLines(pending) {
    if (!Array.isArray(pending) || pending.length === 0) return [];
    const lines = [
        `${pending.length} previously REJECTED newTask(s) from an earlier round must be fixed and ` +
        're-submitted this planning pass. Verbatim title/description below, plus why each was ' +
        'rejected -- correct the stated defect (do not just resend the item unchanged), then create ' +
        'it via bd create as normal:',
    ];
    pending.forEach((r, i) => {
        lines.push(`${i + 1}. Title: "${r.title}"\nDescription: ${r.description}\nRejected because: ${r.reason} (cycle ${r.cycle})`);
    });
    return lines;
}

// ---------------------------------------------------------------------------
// PR body/title text sanitization. The final reviewer's verdict notes are LLM
// output embedded in the PR title/body that the Publish PR step passes into
// VCSModule's create-pull-request command builder, which JSON-encodes them
// into the curl request payload -- the same injection class SAFE_TEXT_RE
// exists to close for newTask titles, at a different call site.
//
// Unlike validateNewTask(), rejecting is not an option here: the PR must still
// carry the sprint's verdict to a human even when the notes are malformed, and
// failing closed would drop the one thing that human most needs to read. So
// this strips instead: every character outside SAFE_TEXT_RE becomes a space,
// keeping the notes readable while nothing that could break out of the
// shell-quoted command string VCSModule builds around it.
/**
 * Sanitizes LLM-authored free text (e.g. finalVerdictResult.notes) before it
 * is embedded in a VCSModule-built PR title/body and dispatched via
 * `command()`. Replaces every character outside SAFE_TEXT_RE with a space,
 * collapses the resulting whitespace, and returns the readable remainder.
 * @param {unknown} text
 * @returns {string}
 */
export function sanitizePrText(text) {
    const str = String(text ?? '');
    let out = '';
    for (const ch of str) {
        // Newlines and tabs collapse to a space along with every other
        // disallowed character: SAFE_TEXT_RE has no multi-line allowance,
        // because a literal newline inside a double-quoted command-string
        // argument is not reliably safe across mixed POSIX/Windows shells.
        out += SAFE_TEXT_RE.test(ch) ? ch : ' ';
    }
    return out.replace(/\s+/g, ' ').trim();
}

// The Regression Test phase is informational-only and must never gate the
// sprint; packages/apra-fleet-se/test/regression-phase-never-gates.test.mjs
// enforces that.
// ---------------------------------------------------------------------------
// Finalization prompt builders
// ---------------------------------------------------------------------------

/**
 * Assembles the `analysisText` block for the Harvester dispatch from this
 * run's in-memory tracking state: cycle-by-cycle closed-bead progress,
 * deploy/integration outcomes, rejected reviewer newTasks, the final verdict,
 * and the regression pass. Pure formatting -- every value is computed
 * elsewhere. harvester.md requires this content be written verbatim to
 * `analysisArtifactFile`.
 * @param {object} opts
 * @returns {string}
 */
function buildAnalysisText({
    targetIssues, branch, baseBranch, cyclesRun,
    closedCountHistory, highWaterClosedCount,
    deployFailures, integFailures, rejectedNewTasks,
    finalVerdictResult, finalClosedCount, finalOpenAtGoalCount,
    regressionResult = null,
}) {
    // The once-per-sprint Regression Test phase runs after the final verdict
    // and never gates it. Its failures are filed as parent-less carry-over
    // beads, so they never appear in the open-at-goal count and are reported
    // separately here.
    const regressionLines = regressionResult === null
        ? ['Regression pass: not run this sprint (no regression-test-playbook.md, or the probe failed).']
        : [
            `Regression pass: ${regressionResult.passed === true ? 'PASSED' : 'FAILED'} `
            + `(real-bd suite: ${regressionResult.suitePassed === true ? 'pass' : 'fail'}, `
            + `smoke test: ${regressionResult.smokePassed === true ? 'pass' : 'fail'}).`,
            `Carry-over beads filed: ${(regressionResult.bugsFiled || []).join(', ') || 'none'}.`,
            `Summary: ${regressionResult.summary || '(none reported)'}`,
            'Informational only -- this pass ran after the final verdict and did not gate it; any bead '
            + 'above is parent-less by design and carries over to a future sprint.',
        ];
    const lines = [
        `# Sprint Analysis: ${branch}`,
        '',
        `Scope issue id(s): ${targetIssues.join(', ') || '(none specified)'}.`,
        `Base branch: ${baseBranch}.`,
        `Cycles run: ${cyclesRun}.`,
        '',
        '## Progress',
        '',
        `Closed-bead count history (per cycle evaluation): [${closedCountHistory.join(', ') || 'none recorded'}].`,
        `High-water-mark closed count this sprint: ${highWaterClosedCount}.`,
        `Final closed count: ${finalClosedCount}.`,
        `Final open-at-goal-priority count: ${finalOpenAtGoalCount}.`,
        '',
        '## Deploy/Integration outcomes',
        '',
        deployFailures.length > 0
            ? `Deploy failures (${deployFailures.length}): ` + deployFailures.map((f) => `C${f.cycle}: ${f.notes}`).join(' | ')
            : 'No deploy failures recorded this sprint.',
        integFailures.length > 0
            ? `Integration test failures (${integFailures.length}): ` + integFailures.map((f) => `C${f.cycle}: ${f.notes} (bugs filed: ${(f.bugsFiled || []).join(', ') || 'none'})`).join(' | ')
            : 'No integration test failures recorded this sprint.',
        '',
        '## Reviewer-proposed newTask rejections',
        '',
        rejectedNewTasks.length > 0
            ? `${rejectedNewTasks.length} newTask(s) rejected before reaching bd create: ` + rejectedNewTasks.map((r) => `C${r.cycle}: ${r.reason}`).join(' | ')
            : 'None.',
        '',
        '## Final verdict',
        '',
        `${finalVerdictResult.verdict}${finalVerdictResult.notes ? ` -- ${finalVerdictResult.notes}` : ''}`,
        '',
        '## Regression pass (once per sprint, informational)',
        '',
        ...regressionLines,
    ];
    return lines.join('\n');
}

/**
 * Builds the `costAnalysis` block for the Harvester dispatch from the live
 * `budget` object. Reports only what is known: an unset ceiling, an absent
 * spent() and an unpriced-model spend gap are each stated as such rather than
 * backfilled with a fabricated number, since harvester.md inserts this block
 * verbatim and never recomputes it. The remaining budget is derived from
 * `total` and `spent()`, not read from the budget object.
 * @param {{ total: number|null, spent?: () => number, pricingSummary?: () => { real: number, fallback: number } }} budget
 * @param {{ spend?: number, dispatchCount?: number }} [integTestRunnerStats] -- apra-fleet-nwh.1:
 *   this sprint's own tracked integ-test-runner spend (a before/after
 *   `budget.spent()` delta accumulated by the caller around each Integ Test
 *   phase dispatch, see runSprintCycle's integTestRunnerSpend/
 *   integTestRunnerDispatchCount) and how many times that phase dispatched.
 *   Reported as its OWN line, distinct from doer/reviewer/overhead, instead
 *   of being silently folded into "overhead" -- often the single longest/
 *   most expensive phase (a full playbook run against a real sandbox).
 * @returns {string}
 */
export function buildCostAnalysis(budget, integTestRunnerStats = {}) {
    const total = budget && budget.total;
    const spent = budget && typeof budget.spent === 'function' ? budget.spent() : null;
    const lines = [
        total !== null && total !== undefined
            ? `Budget ceiling: $${total.toFixed(4)}.`
            : 'Budget ceiling: not set (no --budget flag) -- unlimited for this run.',
        typeof spent === 'number'
            ? `Tracked spend (priced dispatches only): $${spent.toFixed(4)}.`
            : 'Tracked spend: not tracked -- the budget object did not expose spent() for this run.',
    ];
    if (total !== null && total !== undefined && typeof spent === 'number') {
        lines.push(`Remaining budget: $${(total - spent).toFixed(4)}.`);
    } else {
        lines.push('Remaining budget: unknown/unbounded.');
    }
    // apra-fleet-nwh.1: an explicit integ-test-runner spend line, broken out
    // of the totals above (it is a SUBSET of `spent`, not additional spend)
    // so this often-longest phase is never silently bucketed into
    // "overhead" by a reader of this block. Honest about all three states:
    // the phase never dispatched this run, it dispatched but spend was not
    // trackable (same `spent()`-unavailable case as above), or a real
    // tracked figure.
    const integDispatchCount = Number.isInteger(integTestRunnerStats.dispatchCount) ? integTestRunnerStats.dispatchCount : 0;
    if (integDispatchCount === 0) {
        lines.push('Integ-test-runner spend: $0.0000 -- no integ-test-runner dispatch ran this sprint (no playbook found, or deploy never succeeded).');
    } else if (typeof spent !== 'number') {
        lines.push(`Integ-test-runner spend: not tracked -- ${integDispatchCount} dispatch(es) ran but the budget object did not expose spent() for this run.`);
    } else {
        const integSpend = typeof integTestRunnerStats.spend === 'number' ? integTestRunnerStats.spend : 0;
        lines.push(`Integ-test-runner spend: $${integSpend.toFixed(4)} across ${integDispatchCount} dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).`);
    }
    // Report the SOURCE of each priced dispatch's cost -- real per-member
    // rates vs. pricing.mjs's tier-band fallback -- so the figures above are
    // not read as uniformly exact.
    const summary = budget && typeof budget.pricingSummary === 'function' ? budget.pricingSummary() : null;
    if (summary) {
        const { real, fallback } = summary;
        if (real === 0 && fallback === 0) {
            lines.push('Pricing source: no dispatch was priced this run.');
        } else if (real > 0 && fallback === 0) {
            lines.push(`Pricing source: all ${real} priced dispatch(es) used real per-member rates (get_member_model_pricing).`);
        } else if (real === 0 && fallback > 0) {
            lines.push(`Pricing source: all ${fallback} priced dispatch(es) used the tier-band/concrete-model fallback estimate (real per-member pricing was unavailable) -- see pricing.mjs.`);
        } else {
            lines.push(`Pricing source: mixed -- ${real} dispatch(es) priced via real per-member rates, ${fallback} via the tier-band/concrete-model fallback estimate.`);
        }
    }
    lines.push(
        'Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- '
        + 'this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.'
    );
    return lines.join('\n');
}

/**
 * Computes the collision-resistant filesystem slug used for
 * `docs/sprint-analysis-<slug>.md`, the harvester's `analysisArtifactFile`
 * input.
 *
 * Replacing separators alone is not collision-free: two branches differing
 * only in a `/` versus a pre-existing `-` at the same position (e.g.
 * `feat/fleet-reorg` and `feat-fleet-reorg`) would collapse to the same slug
 * and clobber each other's artifact. Appending a short hash of the RAW branch
 * name disambiguates them while staying deterministic per branch, so reruns
 * still produce the same slug.
 * @param {string} branch
 * @returns {string}
 */
export function computeBranchSlug(branch) {
    const humanReadablePrefix = branch.replace(/[\\/]+/g, '-');
    const disambiguatingHash = createHash('sha256').update(branch).digest('hex').slice(0, 8);
    return `${humanReadablePrefix}-${disambiguatingHash}`;
}

// Deliberately BROADER than isTypedAbortError(): every terminal WorkflowError
// except a cooperative cancellation. The two predicates answer two different
// questions in main()'s catch and must not be collapsed:
//   - isTerminalSprintFailure() gates the terminal run-state record, which
//     exists so the supervisor watchdog can classify a run whose PID is gone as
//     FINISHED-with-a-reason rather than CRASHED. EVERY terminal typed failure
//     needs that, not just the aborts -- e.g. a Planner AgentDispatchError from
//     a dead interactive session must surface a reason, not look like a crash.
//   - isTypedAbortError() gates finalizeAbort()'s branch push + [ABORTED] PR,
//     which is only worth doing where there is a genuine sprint abort whose
//     partial work a human should look at.
// An untyped throw (a plain Error/TypeError -- i.e. a real bug) is deliberately
// NOT terminal here: it keeps flowing to the CLI's top-level catch with no
// record, so the watchdog still reports it as CRASHED.
export function isTerminalSprintFailure(err) {
    if (!err || err instanceof CancelledError) return false;
    return err instanceof WorkflowError || isTypedAbortError(err);
}

// AgentDispatchError reasons that mean the agent PROVABLY RAN before the
// dispatch failed, so its (possibly partial) code/beads work still has to be
// published and its teardown must run normally:
//   - 'max_turns_exhausted': the resumable partial-work case -- the agent hit
//     its turn ceiling after doing real work;
//   - 'watchdog_timeout': withDispatchWatchdog() fired locally on an
//     already-in-flight dispatch. The prompt was DELIVERED and the member is
//     alive-but-silent, so the turn may have run to completion (a stalled
//     planner can have created the whole DAG) with only the RESULT lost. The
//     watchdog abandons the dispatch promise, not the member's work.
const AGENT_RAN_DISPATCH_REASONS = new Set(['max_turns_exhausted', 'watchdog_timeout']);

// True when a thrown dispatch error means the dispatch delivered no usable
// result and therefore produced no code/beads mutation to publish: a failed
// agent dispatch (AgentDispatchError, minus the AGENT_RAN_DISPATCH_REASONS
// above), a dispatch-channel transport failure (FleetTransportError), or a
// PRE-dispatch typed sprint abort. The orchestrator's post-dispatch sync
// teardown is then wasted work and is skipped (see withGitSync).
//
// Deliberately EXCLUDED:
//   - AgentOutputError: the LLM RESPONDED and only its output was
//     empty/unparseable/schema-invalid. A schema-invalid response routinely
//     follows real committed work (the agent did the job, then botched the
//     report), so its teardown must run. This is the status quo -- the class
//     was never named here and, post-apra-fleet-9ta.1, isTypedAbortError() is
//     false for it -- pinned explicitly so a future edit cannot silently
//     re-sweep it in;
//   - every POST-dispatch typed abort. The predicate used to fold in the whole
//     of isTypedAbortError(), but only errors thrown from INSIDE withGitSync's
//     `dispatchFn` can ever reach it, and the curated abort set is dominated by
//     aborts the runner raises AFTER a dispatch already returned and mutated
//     beads (SprintPlanRejectedError, ReviewerContractViolationError,
//     StalledSprintError) or by divergences the SYNC brackets themselves throw
//     (GitDivergedError/DoltDivergedError), none of which are reachable here.
//     BudgetExceededError is the one genuinely pre-dispatch member: agent()/
//     command() throw it from inside the dispatch closure BEFORE any dispatch
//     is issued (packages/apra-fleet-workflow/src/workflow/errors.mjs), so it
//     alone provably mutated nothing.
export function isNoMutationDispatchFailure(err) {
    if (!err) return false;
    if (err instanceof AgentOutputError) return false;
    if (err instanceof AgentDispatchError && err.details && AGENT_RAN_DISPATCH_REASONS.has(err.details.reason)) {
        return false;
    }
    return err instanceof AgentDispatchError || err instanceof FleetTransportError || err instanceof BudgetExceededError;
}

// ---------------------------------------------------------------------------
// Client-side dispatch watchdog
// ---------------------------------------------------------------------------
//
// A member process can stay alive while producing no further output after a
// prompt is delivered -- a state no liveness check detects. `timeout_s` is
// threaded to execute_prompt on every dispatch, but server-side enforcement
// cannot be the only guard against an alive-but-silent orchestrator, so this
// adds a client-side backstop that depends on nothing the server does.
//
// withDispatchWatchdog() races an already-in-flight dispatch promise against a
// local timer of `timeoutS` plus this grace period, the grace existing so the
// server's own timeout gets first refusal at producing a clean error. If the
// dispatch has not settled by then, the race rejects with a typed
// AgentDispatchError (reason 'watchdog_timeout') rather than leaving the caller
// awaiting silently, and that typed error follows the same abort routing as
// every other typed dispatch failure here. Promise.race() attaches its own
// handler to the abandoned dispatch promise, so a late settlement after the
// watchdog fired is dropped rather than becoming an unhandled rejection.
const DISPATCH_WATCHDOG_GRACE_S = 30;

/**
 * @param {Promise<any>} dispatchPromise - an ALREADY-STARTED dispatch (e.g. an agent() call).
 * @param {{ timeoutS: number, member?: string, label?: string, log?: (msg: string) => void }} opts
 * @returns {Promise<any>}
 */
export function withDispatchWatchdog(dispatchPromise, opts = {}) {
    const { timeoutS, member = 'unknown', label = 'dispatch', log = () => {} } = opts;
    const budgetMs = (timeoutS + DISPATCH_WATCHDOG_GRACE_S) * 1000;
    let timer;
    const watchdogPromise = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            const message = `[dispatch-watchdog] ${label} to member '${member}' produced no result within ${timeoutS}s (+${DISPATCH_WATCHDOG_GRACE_S}s grace) -- treating this attempt as a stalled/dead session and aborting it (no code path may leave this orchestrator alive-but-silent past its configured dispatch_timeout_s).`;
            log(message);
            reject(new AgentDispatchError(
                `[Workflow Error] ${label} timed out (watchdog): no response from '${member}' within ${timeoutS}s (+${DISPATCH_WATCHDOG_GRACE_S}s grace).`,
                { details: { reason: 'watchdog_timeout', member, timeoutS, graceS: DISPATCH_WATCHDOG_GRACE_S } }
            ));
        }, budgetMs);
        // The timer is deliberately NOT unref'd. A never-settling dispatch can
        // leave this timer as the only work on the event loop; an unref'd timer
        // would then let the loop drain before it fires, so the abort would
        // never happen and the process would hang -- exactly what this watchdog
        // exists to prevent. Keeping it ref'd holds the loop open until the
        // abort fires; a dispatch that settles first is released by the
        // clearTimeout() below, so a fast dispatch never delays process exit.
    });
    return Promise.race([dispatchPromise, watchdogPromise]).finally(() => clearTimeout(timer));
}

async function runSprintCycle(context) {
    const { agent: agentRaw, command: rawCommand, parallel, log, phase: rawPhase, group, endGroup, publishState, args, budget, setPauseGuard } = context;

    // Validate BEFORE any agent()/command() dispatch: a rejected/malformed arg
    // must result in zero fleet dispatches. This must happen early so the
    // validated result is available to setup code that builds callbacks below.
    const validated = validateArgs(args);

    // (apra-fleet-p2to.4.1 / apra-fleet-3swo.4.1) Clean-state pause guard.
    // The openSyncBracketCount counter, its withOpenSyncBracket() wrapper and
    // this setPauseGuard registration all live in git-sync.mjs now, so this
    // file holds NO counter arithmetic and hand-rolls NO bracket of its own --
    // a sync or push site here cannot forget one. Created HERE, at the same
    // point in runSprintCycle() the counter was always declared, so the guard
    // is registered with the engine before any dispatch can happen. See
    // createSyncBrackets() in git-sync.mjs for the full rationale: why the
    // guard exists, why it costs nothing when no pause is pending, and why
    // `setPauseGuard` is optional (direct/legacy callers of runSprintCycle()
    // that never go through WorkflowEngine.executeFile() supply none).
    const syncBrackets = createSyncBrackets({ setPauseGuard });

    // The shared full-DB beads snapshot, the two choke points that keep it
    // correct, and the scope-discovery BFS all live in beads-scope.mjs now
    // (apra-fleet-3swo.4.6) -- see that module's header for the FULL snapshot
    // invalidation contract (invalidated at every phase boundary, at every
    // beads-mutating command through this wrapper, and explicitly after every
    // successful planner dispatch) and for the three read sites that
    // deliberately bypass the snapshot.
    //
    // Both wrappers are installed HERE, before any other statement in this
    // function uses either name, so every direct `command(...)`/`phase(...)`
    // call below -- and every helper (doltPullBefore, persistNewTaskBestEffort,
    // withGitSync, ...) that receives `command` via an options object built
    // from this closure variable -- transparently goes through the wrapped
    // version.
    const beadsScope = createBeadsScope({
        targetIssues: validated.targetIssues,
        assignee: validated.assignee,
        parseBdJson,
        // A getter, not a value: `orchestratorMember` is resolved from the
        // role->member mapping further down this function, but this client
        // has to exist BEFORE `command` does. No beads read can happen in
        // between, so the getter is always called on a resolved value.
        getOrchestratorMember: () => orchestratorMember,
    });
    const { invalidateAllBeadsCache, fetchAllBeadsShared, bdListScoped } = beadsScope;
    const command = beadsScope.wrapCommand(rawCommand, {
        // DoltSync memoizes each member's `bd config get sync.remote` answer
        // for the process lifetime (it was being re-spawned 90-160 times per
        // sprint for a value that never changes mid-run). This is the
        // invalidation seam: the handful of commands that CAN rewire a
        // member's remote (`bd config set`, `bd dolt remote`, `bd init`,
        // `bd bootstrap`) drop that member's memo here, at the one wrapper
        // every orchestrator-side member command passes through.
        // Non-matching commands are a cheap regex test. This seam only sees
        // the ORCHESTRATOR's own commands; an agent's commands on the member
        // are covered by the agent() wrapper below
        // (DoltSync.noteMemberDispatchCompleted), which marks the member for
        // a lazy re-check rather than dropping anything.
        onCommand: (trimmed, opts) => {
            const memberName = opts && opts.member_name;
            if (memberName) DoltSync.noteMemberCommand(memberName, trimmed);
        },
    });
    const phase = beadsScope.wrapPhase(rawPhase);

    // A stable per-sprint id for mutex fairness/introspection: the sprint branch
    // is unique per concurrent sprint on the shared remote.
    const sprintMutexId = (args && args.branch) ? String(args.branch) : 'sprint';

    // Every agent() dispatch carries sprint_id -- the same opaque sprint-identity
    // token members are reserved under (bin/cli.mjs) -- so the server can
    // serialize cross-sprint member access and recognize a dispatch as coming
    // from the reservation's OWNING sprint, even when it dispatches through a
    // shared fleet HTTP singleton with no per-sprint identity of its own. One
    // wrapper covers every call site in this file; an explicit `sprint_id` in an
    // individual call's opts wins via the spread order.
    //
    // KB audit follow-up: this wrapper is also where the KNOWLEDGE BANK block
    // reaches the roles whose prompt builders do not place it themselves.
    //
    // Every one of the ten role contracts carries a Step 0 telling it to call
    // kb_session_prime, and on a member dispatch NONE of them can (the fleet MCP
    // server is disabled there) -- so the engine has to hand the knowledge over
    // as prompt text. buildDoerPrompt / buildReviewerPrompt / buildFinalVerdict-
    // Prompt already do that at a position that matters (the reviewer's block
    // must precede its promotion candidates), so those roles are excluded here
    // and handled there. Everyone else -- planner, plan-reviewer, deployer, the
    // two test runners, harvester -- got nothing at all until now, which is
    // exactly the population most likely to benefit from a `runbook` entry.
    //
    // DoltSync dispatch seam (dolt sync budget review rounds 3-4): this
    // wrapper is also the ONE place every dispatch to a member settles, so it
    // is where DoltSync learns that an agent has run on the member. A
    // dispatched agent runs its `bd` commands in its own session -- never
    // through the command() wrapper above, whose noteMemberCommand() seam
    // therefore cannot see an agent-side `bd config set sync.remote`. The
    // seam MARKS the member (dispatched-since-verified); it drops neither the
    // sync.remote memo nor the remote-tip fingerprint. DoltSync re-reads the
    // member's sync.remote lazily, only at the moment a D-pull would be
    // SKIPPED on that fingerprint (round 3's unconditional wipe emptied the
    // fingerprint before every dispatch bracket and defeated the memo; see
    // DoltSync.noteMemberDispatchCompleted for the per-event reasoning). It
    // fires in a `finally`, so it precedes the post-dispatch D-push bracket
    // in withGitSync (which awaits this promise before syncing) on success
    // AND on failure, and covers the dispatches outside withGitSync too
    // (Streak Assignment).
    const agent = async (prompt, opts = {}) => {
        let finalPrompt = prompt;
        if (opts.agentType && !KB_SELF_INJECTING_ROLES.has(opts.agentType) && opts.member_name) {
            const [block] = kbKnowledgeBlock(kbPriming.knowledgeOf(opts.member_name));
            if (block) finalPrompt = prompt + '\n\n' + block;
        }
        try {
            return await agentRaw(finalPrompt, { sprint_id: sprintMutexId, ...opts });
        } finally {
            if (opts.member_name) DoltSync.noteMemberDispatchCompleted(opts.member_name);
        }
    };

    // The global dolt push mutex client. Every D-push below serializes through
    // it so two sprints never push at the same time. Four sources, in
    // precedence:
    //   1. `context.doltPushMutex` -- an explicitly-injected client (tests wire
    //      an in-process one here to prove the bracket serializes without HTTP).
    //   2. `args.serviceUrl` present -- an HTTP-backed client acquiring against
    //      the always-on supervisor's mutex routes, so two independently-
    //      detached sprint children serialize through one supervisor.
    //   3. `args.callTool` present -- the SUPERVISOR-LESS path: a standalone /
    //      detached-binary launch has no supervisor to reach but always holds a
    //      connected MCP client to the shared fleet HTTP singleton, so that
    //      server's own `dolt_push_mutex` tool coordinates the topology.
    //   4. none of the above -- a no-op client: a lone sprint has, by
    //      definition, no second sprint to conflict with, so the push is
    //      unguarded and the D-push call sites stay uniform (they always
    //      acquire/release; only the wiring differs). This is a real
    //      DEGRADATION whenever a second sprint could exist, so it is logged
    //      rather than taken silently.
    const doltPushMutex = context.doltPushMutex ?? (() => {
        if (args && args.serviceUrl) {
            return createHttpDoltPushMutexClient({ serviceUrl: args.serviceUrl, sprintId: sprintMutexId, log });
        }
        if (args && typeof args.callTool === 'function') {
            log(`[dolt-mutex] no supervisor serviceUrl; coordinating the global push mutex through the fleet MCP server's dolt_push_mutex tool (sprint '${sprintMutexId}').`);
            return createMcpDoltPushMutexClient({ callTool: args.callTool, sprintId: sprintMutexId, log });
        }
        log('[dolt-mutex] DEGRADED: no supervisor serviceUrl and no fleet MCP connection -- falling back to an UNGUARDED no-op push mutex. Concurrent sprints could push dolt at the same time and hard-conflict (PoC constraints C.2/C.3).');
        return {
            async acquire() { return { token: null }; },
            async release() { return true; },
        };
    })();

    // The global child-id allocator client. Every reviewer-proposed newTask
    // create below mints its id through it so two sprints creating children
    // under the SAME parent never derive the same child id. Same four-source
    // precedence as the push mutex above:
    //   1. `context.idAllocator` -- an explicitly-injected client (tests wire an
    //      in-process one to prove the create path allocates without HTTP).
    //   2. `args.serviceUrl` present -- an HTTP-backed client allocating and
    //      confirming against the supervisor's allocator routes, so two
    //      detached sprint children serialize id minting through one authority.
    //   3. `args.callTool` present -- the SUPERVISOR-LESS path: the fleet
    //      server's own `child_id_allocator` tool, over the MCP connection
    //      every standalone launch already holds.
    //   4. none of the above -- a no-op client: a lone sprint has no second
    //      sprint that could mint a colliding id, so bd derives the id itself
    //      (childId null -> no `--id` flag) and the create call sites stay
    //      uniform. Logged, not silent: a real degradation whenever a second
    //      sprint could exist.
    const childIdAllocator = context.idAllocator ?? (() => {
        if (args && args.serviceUrl) {
            return createHttpChildIdAllocatorClient({ serviceUrl: args.serviceUrl, sprintId: sprintMutexId, log });
        }
        if (args && typeof args.callTool === 'function') {
            log(`[id-allocator] no supervisor serviceUrl; minting child ids through the fleet MCP server's child_id_allocator tool (sprint '${sprintMutexId}').`);
            return createMcpChildIdAllocatorClient({ callTool: args.callTool, sprintId: sprintMutexId, log });
        }
        log('[id-allocator] DEGRADED: no supervisor serviceUrl and no fleet MCP connection -- falling back to a no-op allocator; bd derives child ids locally, so two concurrent sprints under the same parent could mint the SAME child id (PoC constraint C.4).');
        return {
            async allocate() { return { childId: null, token: null }; },
            async confirm() { return true; },
            async release() { return true; },
        };
    })();

    // (apra-fleet-3swo.6.1) THE sprint's resolved state, created exactly ONCE
    // here at sprint start and threaded from this point down -- never rebuilt
    // per phase, per cycle or per call site. It owns two things that used to
    // be re-derived at their point of use:
    //   - the sprint-scoped fleet client every settle-shell resolution shares
    //     (resolveSettleShell used to build a fresh ApraFleet per call, at
    //     seven call sites);
    //   - the per-member VCS provider resolver, RELOCATED here from the
    //     construction site a few statements below (it was already built once
    //     per sprint and already carried its own per-member cache, so this is
    //     a relocation, not new caching) so the phase modules Phase 4 slices
    //     out of this function receive it through sprint state instead of
    //     closing over a local.
    // See sprint-state.mjs's header for what it deliberately does NOT cache
    // (the resolved { os, shell }, whose degrade must stay re-resolvable).
    const sprintState = createSprintState({
        callTool: (args && typeof args.callTool === 'function') ? args.callTool : undefined,
        log,
    });

    // Guards every resume re-dispatch below against spawning a second
    // concurrent session on top of a prior one that is presumed dead/timed out
    // but may still be alive (see createMemberSessionGuard's doc comment).
    // There is no supervisor-HTTP source here: `stop_prompt` lives on the fleet
    // MCP server every launch path already connects to.
    //   1. `context.memberSessionGuard` -- an explicitly-injected guard (tests
    //      wire an in-process one to prove the pre-resume kill fires without a
    //      live fleet server).
    //   2. `args.callTool` -- bin/cli.mjs's already-connected
    //      `mcpClient.callTool`, so a resume can call `stop_prompt`.
    //   3. neither -- a no-op guard: nothing to call `stop_prompt` against, so
    //      every resume proceeds unguarded.
    const memberSessionGuard = context.memberSessionGuard ?? createMemberSessionGuard({
        callTool: (args && typeof args.callTool === 'function') ? args.callTool : undefined,
        log,
    });

    // The REACTIVE git/dolt credential self-heal callback every withGitSync
    // bracket passes to syncMemberBefore/doltPullBefore (G-pull/D-pull) and
    // syncMemberAfterOrdered (G-push/D-push) as `onAuthFailure`. Same
    // precedence shape as memberSessionGuard above:
    //   1. `context.onAuthFailure` -- an explicitly-injected callback (tests
    //      wire an in-process one to prove the self-heal fires without a live
    //      fleet server).
    //   2. `args.callTool` -- the real provision_vcs_auth self-heal via
    //      createVcsAuthSelfHealCallback (packages/apra-fleet-client).
    //   3. neither -- undefined: an 'auth'-classified git/dolt failure falls
    //      straight through to the GitSyncError/DoltSyncError throw. Every
    //      dispatch site therefore guards with `typeof onAuthFailure ===
    //      'function'`.
    const onAuthFailure = context.onAuthFailure ?? (
        (args && typeof args.callTool === 'function')
            ? createVcsAuthSelfHealCallback({ callTool: args.callTool, command, log, azdevopsPatSecretName: validated.azdevopsPatSecretName })
            : undefined
    );

    // apra-fleet-417.7: the member-provider resolver every withGitSync bracket
    // passes to syncMemberBefore (G-pull) and syncMemberAfterOrdered (G-push)
    // as `resolveMemberProvider`, so a git failure classifies via that
    // member's OWN resolved VCS provider chain instead of always falling back
    // to the default 'github' chain -- what makes azure-devops.mjs's
    // TF401019 and bitbucket.mjs's app-password AUTH rules reachable at
    // runtime. Same precedence shape as onAuthFailure above:
    //   1. `context.resolveMemberVcsProvider` -- an explicitly-injected
    //      resolver. NOT reachable through the production entry point:
    //      every real caller (bin/cli.mjs, and every mock-sprint scenario)
    //      drives this file via `WorkflowEngine.executeFile()`, whose
    //      `runWithContext()` always builds `context` as `{
    //      ...this._bindPrimitives(), args, budget }` (apra-fleet-workflow/
    //      src/workflow/index.mjs) -- there is no key through which an
    //      `executeFile()` caller can set `context.resolveMemberVcsProvider`
    //      (or its onAuthFailure/memberSessionGuard/ensureVcsAuthFresh/
    //      onLlmAuthFailure siblings above/below). This tier only exists for
    //      a direct `main()`/`runSprintCycle()` call built by hand (e.g. via
    //      `FleetWorkflow.createContext()`), which nothing in this codebase
    //      does today (apra-fleet-417.9) -- kept for parity with its
    //      siblings' shape, not because it is exercised.
    //   2. `sprintState.resolveMemberProvider` -- the real
    //      VCSModule.resolveProvider() lookup via
    //      createMemberVcsProviderResolver, which sprint-state.mjs now
    //      constructs (apra-fleet-3swo.6.1 RELOCATED the construction out of
    //      this statement; the resolver is still built exactly once per
    //      sprint, still carries its own per-member cache, and is undefined
    //      when no `args.callTool` is wired -- the behavior here is
    //      unchanged). THIS is the tier every real caller and every
    //      mock-sprint scenario reaches (see
    //      mock-sprint-member-vcs-provider-threading.test.mjs, apra-fleet-
    //      417.9, for end-to-end coverage of a non-GitHub member's G-push
    //      auth failure classifying via this exact wiring).
    //   3. neither -- undefined: every runGitStep call below falls back to
    //      the default 'github' chain, exactly as before this bead.
    const resolveMemberVcsProvider = context.resolveMemberVcsProvider ?? sprintState.resolveMemberProvider;

    // The PROACTIVE counterpart to onAuthFailure above. Unlike onAuthFailure,
    // this defaults to a callable async no-op rather than undefined, so
    // withGitSync's pre-dispatch bracket can call it unconditionally (gated
    // only on `pushCode`, never on whether it was wired).
    //   1. `context.ensureVcsAuthFresh` -- an explicitly-injected callback
    //      (tests wire an in-process one to prove the preflight fires/skips
    //      without a live fleet server).
    //   2. `args.callTool` -- createVcsAuthPreflightCallback (this file).
    //   3. neither -- a no-op: no proactive provision_vcs_auth call is ever
    //      made and the reactive onAuthFailure self-heal is the only
    //      auth-recovery path.
    const ensureVcsAuthFresh = context.ensureVcsAuthFresh ?? (
        (args && typeof args.callTool === 'function')
            ? createVcsAuthPreflightCallback({ callTool: args.callTool, command, log, azdevopsPatSecretName: validated.azdevopsPatSecretName })
            : async () => {}
    );

    // LLM-auth counterpart to onAuthFailure above, same precedence shape.
    // Dispatch-site catch handlers call this (via isAuthDispatchError(err))
    // before deciding whether to retry an otherwise non-retryable dispatch
    // failure; it resolves true ("healed, retry once") or false ("not healed,
    // abort").
    const onLlmAuthFailure = context.onLlmAuthFailure ?? (
        (args && typeof args.callTool === 'function')
            ? createLlmAuthSelfHealCallback({ callTool: args.callTool, log })
            : undefined
    );

    // Provisions a member unattended='auto' right before its deployer /
    // integ-test-runner / regression-test-runner dispatch, so those
    // real-command/real-suite roles never stall on an interactive permission
    // prompt. See createUnattendedAutoProvisioner's doc comment for why this
    // is one-way (never reverted) and safe in a single-member sprint.
    //   1. `context.ensureUnattendedAuto` -- an explicitly-injected function
    //      (tests wire an in-process one to prove the call site fires
    //      without a live fleet server).
    //   2. `args.callTool` -- the real update_member call via
    //      createUnattendedAutoProvisioner (this file).
    //   3. neither -- a no-op: no provisioning call is made and the member
    //      dispatches under whatever permission mode it already has.
    const ensureUnattendedAuto = context.ensureUnattendedAuto ?? (
        (args && typeof args.callTool === 'function')
            ? createUnattendedAutoProvisioner({ callTool: args.callTool, log })
            : async () => {}
    );

    // The per-dispatch time budget used for BOTH timeout_s and max_total_s:
    // silent-until-done CLIs make inactivity indistinguishable from total
    // runtime, so the two must be equal. The integ-test dispatch alone gets a
    // 2x ceiling.
    const DISPATCH_TIMEOUT_S = validated.dispatchTimeoutS;
    const INTEG_MAX_TOTAL_S = DISPATCH_TIMEOUT_S * 2;
    // Hoisted here with its siblings (apra-fleet-3swo.5.7): role-policies.mjs
    // records a dispatch's budgets by the NAME of the runner constant that
    // supplies them, so every named budget must exist by the time dispatchCtx
    // is built. Same shape as the integ ceiling -- keep the shorter INACTIVITY
    // timer (a genuinely hung runner still dies) while giving the HARD
    // elapsed-time ceiling real headroom, since a max_total_s kill surfaces as
    // a plain AgentDispatchError that the max_turns resume ladder cannot catch.
    const REGRESSION_TEST_MAX_TOTAL_S = DISPATCH_TIMEOUT_S * 3;

    // Apply the optional `budget` arg ceiling to THIS run's budget object.
    // Setting it here, before any dispatch, is what makes the ceiling
    // enforceable for the whole run: agent() checks `budget.remaining() <= 0`
    // before every dispatch, but a `budget.total` left null means unlimited.
    if (validated.budget !== undefined) {
        budget.total = validated.budget;
    }

    // apra-fleet-5co8.37: this sprint's own reservation identity, handed to
    // the deployer so deploy.md's active-sprints gate can tell this sprint's
    // OWN ledger entry (a sprint is always reserved while it runs, so the
    // entry is ALWAYS there) from a genuinely foreign one. Without it the
    // gate stopped on every deploy and no sprint could deploy its own work.
    // The gate keys on the literal sentence "Your dispatching sprint's own
    // supervisor reservation id (sprintId): <id>" in the prompt -- keep that
    // phrase verbatim. `sprintSelfId` is the SAME string the supervisor keys
    // the reservation by: the forwarded --run-id, or the branch name for a
    // direct/standalone launch (bin/cli.mjs reserves under the branch name
    // in that case).
    //
    // The integ-test-runner (per cycle) and regression-test-runner (after
    // the cycle loop, hence the function-scope declaration) prompts carry
    // the same line: a target repo whose deploy.md stands up an isolated
    // test instance per sprint can key that instance's location on the
    // sprintId, so a later, separately dispatched phase finds and tears
    // down the SAME instance without any output plumbing through here.
    // What (if anything) to do with the id is the target repo's own
    // runbook/playbook's business -- nothing target-specific lives here.
    const sprintSelfId = validated.runId || validated.branch;
    const sprintSelfIdLine = `Your dispatching sprint's own supervisor reservation id (sprintId): ${sprintSelfId}`;

    let cycle = 1;
    const MAX_CYCLES = validated.maxCycles;

    // Per-(role, cycle) session registry: a role's session is resumed across
    // ROUNDS within one cycle via an explicit session id, but NEVER across
    // cycles (fresh eyes), and falls back to a fresh session on a prior-round
    // dispatch error/timeout or near the context ceiling. The session id comes
    // from execute_prompt's structuredContent.sessionId, captured via agent()'s
    // onSessionId callback; a provider that does not support resume returns
    // none, so nothing is recorded and the next round is fresh -- a capability
    // signal, not a provider-name check. See createRoundSessionRegistry.
    const roundSessions = createRoundSessionRegistry({ log });

    const targetIssues = validated.targetIssues;
    // Display-only label for error/diagnostic text -- NEVER fed to an actual
    // `bd` invocation (bdListScoped below builds scope structurally, via an
    // in-memory BFS over `bd list --all`, not via a `bd list --parent` call).
    // `--parent` is only an accurate description of that BFS for the
    // single-target case (one root + all its descendants); for 2+ target
    // ids with no shared parent -- e.g. a flat batch of independent leaf
    // beads -- comma-joining them after a single `--parent` flag misdescribes
    // the scope as "all these ids are children of one parent" (they are not)
    // and, worse, LOOKS like a real, directly-runnable `bd` invocation that a
    // human debugging a "Nothing to do" failure will paste verbatim -- `bd
    // list --parent <id1>,<id2>,...` does not do a multi-root union; `bd`
    // treats a comma-joined value as one (nonexistent) parent id and returns
    // `[]`, which reads as "confirms the sprint's own finding" and sends
    // debugging in exactly the wrong direction (this shape was mistaken for
    // the root cause of a real "Nothing to do" incident before this comment
    // was added -- see the multi-id flat-leaf-scope bug writeup).
    const sprintFilter = targetIssues.length === 0
        ? ''
        : targetIssues.length === 1
            ? `--parent ${targetIssues[0]}`
            : `sprint targets (each root + its descendants): ${targetIssues.join(', ')}`;

    // Member mapping resolution
    const physicalMembers = validated.members;

    // apra-fleet-e28: prime each member's own project KB before any dispatch, so
    // the Step 0 Knowledge Bank block in every role contract has something warm
    // to read. This engine had no KB priming at all -- it lived only in the
    // Claude workflow copy. Best-effort: a cold KB never fails a sprint.
    const kbPriming = context.kbPriming ?? createKbPrimingClient({
        callTool: (args && typeof args.callTool === 'function') ? args.callTool : undefined,
        members: physicalMembers,
        log,
    });
    await kbPriming.primeAll();

    // The role output schemas are shared with apra-pm, so every role dispatched
    // below is now asked for kb_captures (and the reviewer for kb_promotions).
    // This is the consumer: without it those fields would be gathered and
    // silently dropped. Unlike apra-pm's workflow script, this engine has a real
    // callTool, so the kb_capture/kb_promote calls are made directly.
    const kbWork = context.kbWork ?? createKbWorkClient({
        callTool: (args && typeof args.callTool === 'function') ? args.callTool : undefined,
        log,
        // Scope every kb_* call below to the member's OWN project KB. The repo
        // path each call site already threads is a path on the MEMBER's host,
        // so the server cannot derive a slug from it -- without this lookup a
        // remote member's reads and writes all land in the shared 'default' KB
        // (apra-fleet-b4g.15). Resolved through the path rather than passed
        // per call site so no site can thread the path and forget the scope.
        // context.kbPriming above is an injection seam; a stub that predates
        // remoteUrlForPath degrades to no scope rather than crashing a sprint.
        remoteUrlFor: (repoPath) => (typeof kbPriming.remoteUrlForPath === 'function' ? kbPriming.remoteUrlForPath(repoPath) : null),
    });
    // A member named in ANY roleMap value is a "specialist" for whatever
    // role(s) named it -- e.g. a member pinned to roleMap.reviewer has been
    // deliberately reserved for review. Without this, a role the caller left
    // UNMAPPED falls back to raw array position (physicalMembers[0], or "all
    // members" for doer/reviewer), which can silently hand that specialist's
    // dedicated machine an unrelated role (or vice versa) purely because of
    // where it happens to sit in `members` -- not because anyone intended it.
    // Members named in NO roleMap value ("generalists") are therefore the
    // correct default pool for any unmapped role: they are, by construction,
    // the members nobody has already committed to something specific.
    // If every member is a specialist (no generalists exist), there is no
    // safer pool to prefer, so this degrades to the original physicalMembers
    // fallback -- unchanged behavior in that case, and also unchanged
    // whenever roleMap is absent entirely (every member is a generalist).
    const roleMapSpecialists = new Set();
    if (validated.roleMap) {
        for (const list of Object.values(validated.roleMap)) {
            if (Array.isArray(list)) for (const m of list) roleMapSpecialists.add(m);
        }
    }
    // apra-fleet: roleMap.orchestrator members are excluded from BOTH the
    // generalist pool and its degenerate physicalMembers fallback -- not just
    // from the generalist filter -- because the orchestrator role may be a
    // shared/unreservable, git-less member (docs/design-orchestrator-
    // worktree-model-v2.md). Without this, the "every member is a specialist"
    // degradation re-selects the orchestrator for OTHER unmapped roles
    // (harvester/planner/deployer/etc.), silently undoing the branchEnsureMembers
    // removal and every probeFileExists/publishGitMember fix elsewhere in this
    // file: those call getMemberForRole()/getMembersForRole() for roles that
    // still expect a real git checkout.
    const orchestratorRoleMapMembers = new Set(
        (validated.roleMap && Array.isArray(validated.roleMap[ROLE_ORCHESTRATOR]))
            ? validated.roleMap[ROLE_ORCHESTRATOR]
            : []
    );
    const unmappedRoleFallbackPool = (() => {
        const eligible = physicalMembers.filter((m) => !orchestratorRoleMapMembers.has(m));
        const generalists = eligible.filter((m) => !roleMapSpecialists.has(m));
        if (generalists.length > 0) return generalists;
        if (eligible.length > 0) return eligible;
        // Every physical member IS the mapped orchestrator (e.g. a single-member
        // launch that role-maps the same member as both a dispatch role and
        // orchestrator): there is no other member to fall back to, so this
        // degrades to the original physicalMembers behavior rather than
        // resolving to an empty pool.
        return physicalMembers;
    })();

    const getMemberForRole = (role) => {
        if (validated.roleMap && validated.roleMap[role] && validated.roleMap[role].length > 0) {
            return validated.roleMap[role][0];
        }
        return unmappedRoleFallbackPool[0];
    };

    const getMembersForRole = (role) => {
        if (validated.roleMap && validated.roleMap[role]) {
            return validated.roleMap[role];
        }
        // Role keys MUST be the canonical lowercase contracts.ROLES strings
        // (ROLE_DOER/ROLE_REVIEWER), which is exactly what every call site
        // passes -- a capitalized literal here would silently never match.
        if (role === ROLE_DOER || role === ROLE_REVIEWER) {
            return unmappedRoleFallbackPool; // generalists act as Doers/Reviewers by default
        }
        return [unmappedRoleFallbackPool[0]];
    };

    // Uses the canonical ROLE_ORCHESTRATOR constant, not a literal -- see its
    // doc comment for why 'orchestrator' is an application-level pseudo-role
    // deliberately outside contracts.ROLES.
    //
    // apra-fleet-TODO(orchestrator-hard-fail): an unmapped orchestrator
    // silently falling back to unmappedRoleFallbackPool[0] is a known defect
    // (docs/design-orchestrator-worktree-model-v2.md section 1/6.4) -- it has
    // repeatedly caused the orchestrator to run against a stale/wrong-scope bd
    // clone. Making this a hard launch-time failure is the intended fix, but
    // it cannot land in isolation: it requires the supervisor to
    // auto-inject roleMap.orchestrator on every launch first (section 6.2,
    // not yet implemented) -- otherwise every existing caller that relies on
    // the implicit fallback (including this file's own test harness) breaks.
    // Land 6.2, update callers, THEN make this throw.
    const orchestratorMember = getMemberForRole(ROLE_ORCHESTRATOR);

    // Self-heals deploy.md's declared Permissions onto the deployer /
    // integ-test-runner / regression-test-runner member before each of
    // those dispatches -- see createDeployPermissionsProvisioner's doc
    // comment. Same three-way precedence shape as ensureUnattendedAuto
    // above: an explicitly-injected `context.ensureDeployPermissions` (for
    // tests), else the real compose_permissions-backed provisioner built
    // from `args.callTool`, else a no-op when neither is available.
    const ensureDeployPermissions = context.ensureDeployPermissions ?? (
        (args && typeof args.callTool === 'function')
            ? createDeployPermissionsProvisioner({ callTool: args.callTool, command, log })
            : async () => {}
    );

    // ONE shared bracket wrapping EVERY role-identified agent() dispatch
    // below, plus every standalone sync/push site in this file. The bracket
    // implementation -- withGitSync, the standalone bracket helpers and the
    // openSyncBracketCount counter they all share -- lives in git-sync.mjs
    // (apra-fleet-3swo.4.1). See that module for the full Plan 3.3
    // insertion-point table and the pushCode/pushBeads axis rationale.
    //
    // Everything the bracket used to close over lexically is injected here
    // once. git-sync.mjs deliberately never imports runner.js back, so this
    // file's own sync helpers (syncMemberBefore, syncMemberAfter,
    // syncMemberAfterOrdered) and isNoMutationDispatchFailure are passed in
    // rather than imported -- importing them there would be a module cycle.
    const gitSync = createGitSync({
        brackets: syncBrackets,
        command, log, branch: validated.branch, args, agent,
        doltPushMutex, sprintId: sprintMutexId,
        onAuthFailure, resolveMemberProvider: resolveMemberVcsProvider, ensureVcsAuthFresh,
        syncMemberBefore, syncMemberAfter, syncMemberAfterOrdered, isNoMutationDispatchFailure,
    });
    // Local alias so this file's dispatch brackets keep their existing shape:
    // withGitSync member, pushCode, dispatch thunk, options.
    const withGitSync = (member, pushCode, dispatchFn, options) => gitSync.withGitSync(member, pushCode, dispatchFn, options);

    // --- dispatchRole engine context (apra-fleet-3swo.5.3) -------------------
    // Every runner-side primitive fleet-sprint/dispatch-role.mjs needs to run
    // a role's ladder out of role-policies.mjs's data table. INJECTED, never
    // imported: all of these are per-run closures over this function's state,
    // and dispatch-role.mjs importing runner.js back would be a module cycle
    // (same discipline as createGitSync above).
    //
    // Budgets and schemas arrive as NAMED maps because role-policies.mjs
    // records them symbolically -- 'DISPATCH_TIMEOUT_S', 'planReviewerVerdict'
    // -- rather than as values: the timeout comes from the validated CLI args
    // per run, and the table must stay free of runner/contract imports so it
    // can be consumed by an engine rather than by a scanner.
    const dispatchCtx = {
        agent,
        withGitSync,
        withDispatchWatchdog,
        log,
        getMemberForRole,
        memberSessionGuard,
        onLlmAuthFailure,
        fixedRoleTier: FIXED_ROLE_TIER,
        budgets: { DISPATCH_TIMEOUT_S, INTEG_MAX_TOTAL_S, REGRESSION_TEST_MAX_TOTAL_S },
        schemas: {
            planReviewerVerdict,
            streakAssignment,
            harvesterReport,
            deployerReport,
            regressionReport,
            integReport,
            finalVerdict,
            reviewerVerdict,
            doerReport,
        },
        isNoMutationDispatchFailure,
        invalidateAllBeadsCache,
        // The named steps role-policies.mjs records for a row, implemented
        // once here rather than per role: each is resolved from the POLICY the
        // engine is executing (its persona, the member it already resolved),
        // so adding a role that records the same step needs no new wiring.
        steps: {
            // The report's kb_captures/kb_promotions, executed through the same
            // kbWork path every capturing role uses. The persona names the KB
            // role and the engine hands back the member it dispatched, so this
            // one implementation serves the harvester, the doer, the per-round
            // reviewer and the final review alike.
            'kb-apply': async ({ policy, value, member }) => {
                await kbWork.apply(policy.agentType, kbPriming.folderOf(member), value);
            },
            // deploy.md's active-sprints gate stops for a FOREIGN reservation,
            // so a deployer prompt that does not state this sprint's OWN
            // reservation id makes the deploy treat the sprint as a stranger
            // and refuse to proceed. Verified here rather than assumed: the
            // prompt is assembled from several pieces, and a silent drop
            // manifests only as a mysteriously stalled deploy.
            // A CHANGES_NEEDED verdict with both reopenIds and newTasks empty
            // is self-contradictory: there is nothing for the orchestrator to
            // act on, so it can only accumulate toward stall-abort. Rejecting
            // it here (rather than at the call site) is what lets
            // retry.retryOnInvalidResult spend the ladder's OWN remaining
            // attempt on a fresh review. A verdict the engine itself
            // fabricated is exempt -- it is marked dispatchFailed and stands
            // for an infrastructure failure, not the reviewer contradicting
            // itself.
            // Claim once per streak turn, INSIDE the bracket so the claim is
            // made against the remote state the pre-dispatch D-pull just
            // brought in (role-policies.mjs's PRE_DISPATCH_STEPS_IN_BRACKET).
            // The streak's bead list is per-dispatch runner state, so the row
            // names the step and the call site supplies the work -- the same
            // discipline as a policy naming a member by binding.
            'claim-beads-batched': async ({ opts }) => {
                if (typeof opts.claimBeads !== 'function') {
                    throw new Error(
                        "dispatch: the 'claim-beads-batched' step needs opts.claimBeads -- the streak's bead list " +
                        'is per-dispatch runner state the engine cannot know.'
                    );
                }
                await opts.claimBeads();
            },
            // Never trust a doer's own success claim: verify via `bd show` that
            // the assigned beads really closed. Recorded in TWO placements, and
            // the placement decides what it means. As a preDispatch step on the
            // RESUME it is a SHORT-CIRCUIT: a turn-exhausted streak whose beads
            // are all already closed is a success that merely missed its VERIFY
            // checkpoint, and resuming it would spend a dispatch on a session
            // with nothing left to do. As a postResult step it is the
            // attribution input the caller reads back off `stepResults`.
            'verify-streak-closed': async ({ phase, opts }) => {
                if (typeof opts.verifyStreakClosed !== 'function') {
                    throw new Error(
                        "dispatch: the 'verify-streak-closed' step needs opts.verifyStreakClosed -- the streak's " +
                        'bead list is per-dispatch runner state the engine cannot know.'
                    );
                }
                const unclosed = await opts.verifyStreakClosed(phase);
                if (phase !== 'preDispatch') return unclosed;
                return unclosed.length === 0 ? { shortCircuit: true, value: null } : undefined;
            },
            'reviewer-contract-guard': ({ value }) => {
                if (!isReviewerContractViolation(value)) return undefined;
                return {
                    rejected: true,
                    // Worded so the engine's own "result rejected (<reason>)"
                    // line still names this as a contract violation: that
                    // phrase is what an operator scans the log for.
                    reason: 'contract violation: CHANGES_NEEDED with empty reopenIds AND empty newTasks -- nothing for the orchestrator to act on',
                };
            },
            // A failed round's session must not be resumed by the next round --
            // drop it so the next review starts fresh. Recorded as a DEGRADE
            // step, never a postResult one: a successful round's session is
            // exactly what the next round wants to resume.
            'clear-round-session': ({ policy }) => {
                roundSessions.clear(policy.ladder);
            },
            'sprint-self-id-in-prompt': ({ opts }) => {
                if (typeof opts.prompt === 'string' && opts.prompt.includes(sprintSelfId)) return;
                throw new Error(
                    "dispatch: the deploy prompt does not state this sprint's own reservation id " +
                    `(${sprintSelfId}) -- deploy.md's active-sprints gate would treat this sprint's own ` +
                    'reservation as a foreign one and stop.'
                );
            },
        },
    };

    // Scope discovery (`bdListScoped`) and the shared full-DB fetch
    // (`fetchAllBeadsShared`) are provided by the beads-scope.mjs client
    // destructured at the top of this function, alongside the `command`/
    // `phase` wrappers that invalidate its snapshot. See that module for the
    // in-memory BFS scope rule (`bd list --parent` cannot express it: it takes
    // one id per invocation and is single-level only) and for the snapshot
    // invalidation contract.

    // The set of scope-member ids that are themselves someone else's
    // `--parent` -- i.e. decomposed grouping nodes, not leaf units of work.
    // Built from children of ANY status, not just open ones: once a decomposed
    // bead's children all close they vanish from an open-only list, the parent
    // stops looking like a parent, and it would wrongly re-enter leaf/ready
    // treatment. bdListScoped('') is the no-extra-query path -- the
    // already-fetched project-wide any-status dump filtered to scope, with no
    // new bd command issued.
    async function decomposedParentIds() {
        const allAnyStatus = await bdListScoped('');
        return new Set(allAnyStatus.filter((b) => b.parent).map((b) => b.parent));
    }

    // Returns this scope's ready beads minus any decomposed parent (see
    // decomposedParentIds() above). Per GRAPH-SEMANTICS.md a decomposed bead's
    // "done" status comes from its children closing, never from being worked
    // directly, so it must never be seeded to a doer even when bd's own
    // `--ready` reports it. The check is STRUCTURAL (does this ready bead have
    // children?), not an issue_type check -- issue_type has no effect on
    // `--ready` inclusion, and a bead can be a leaf `type=task` or a decomposed
    // `type=bug`/`type=feature` parent, so only the has-children structure
    // tells them apart.
    async function readyLeafBeads() {
        const [ready, parentIds] = await Promise.all([
            bdListScoped('--ready --json'),
            decomposedParentIds(),
        ]);
        return ready.filter((b) => !parentIds.has(b.id));
    }

    // How many times a given bead has already been auto-reclaimed this sprint
    // (see reclaimStaleInProgress below). Keyed by bead id, lives for the
    // whole sprint process so the bounce cap accumulates across cycles, not
    // just within one call.
    const staleInProgressReclaimCounts = new Map();
    const STALE_IN_PROGRESS_RECLAIM_LIMIT = 2;
    // Stamped once, on the FIRST call to reclaimStaleInProgress (the
    // pre-sprint one) -- runSprintCycle's `context` carries no injected clock,
    // so this is a plain Date.now(), same as the other direct call sites
    // already in this file. Declared here (not at the capture site) so its
    // TDZ covers every call to reclaimStaleInProgress, including the
    // pre-sprint one.
    let sprintLaunchTime = null;

    /**
     * Reclaims 'in_progress' beads that are safe to redispatch to 'open':
     * no unmet `blocks` dependencies (nothing left to wait on) AND claimed
     * BEFORE this sprint incarnation's own launch time -- so a genuinely
     * live claim, including this very sprint's own in-flight work from an
     * earlier point in the SAME cycle, is never touched. A bead with no
     * parseable `started_at` is treated as predating this sprint (`bd
     * update --claim` always stamps `started_at`, so a bead claimed by
     * THIS sprint always has one -- an unparseable/absent value can only
     * mean orphaned state from something else).
     *
     * Bounded per bead via staleInProgressReclaimCounts: a bead that keeps
     * landing back in 'in_progress' (a doer repeatedly failing on it
     * specifically, not a one-off orphaned claim) stops being silently
     * reclaimed after STALE_IN_PROGRESS_RECLAIM_LIMIT attempts and is
     * surfaced as needing human investigation instead -- the same
     * bounce-cap precedent already used for the verify-route gap counter
     * (VERIFY_GAP_LIMIT) elsewhere in this file, applied to this failure
     * mode.
     *
     * Originally this reclaim only ran ONCE, as a pre-sprint gate, and only
     * when the pre-sprint ready set was empty -- a bead orphaned mid-sprint
     * (a crashed doer, a killed dispatch, or -- as observed in practice --
     * a prior aborted sprint incarnation whose claims were still in_progress
     * on relaunch) was invisible to every later cycle, so the sprint just
     * spun Plan-finds-nothing -> Deploy forever until the stall detector
     * eventually gave up, burning cycles/cost for zero progress. This is
     * now also called at the top of every cycle's readiness check, so an
     * orphaned claim self-heals on the very next cycle instead of silently
     * persisting for the rest of the run.
     * @param {{ notDoneBeads: object[], reasonTag: string }} opts
     * @returns {Promise<{ reclaimedIds: string[], cappedIds: string[] }>}
     */
    async function reclaimStaleInProgress({ notDoneBeads, reasonTag }) {
        if (sprintLaunchTime === null) sprintLaunchTime = Date.now();
        const notDoneIds = new Set(notDoneBeads.map((b) => b.id));
        const unmetBlockers = (bead) => (bead.dependencies || [])
            .filter((d) => d.type === 'blocks' && notDoneIds.has(d.depends_on_id))
            .map((d) => d.depends_on_id);

        const candidates = notDoneBeads.filter((b) => {
            if (b.status !== 'in_progress') return false;
            if (unmetBlockers(b).length > 0) return false;
            const startedAtMs = b.started_at ? Date.parse(b.started_at) : NaN;
            return Number.isNaN(startedAtMs) || startedAtMs < sprintLaunchTime;
        });

        const reclaimedIds = [];
        const cappedIds = [];
        for (const bead of candidates) {
            const priorAttempts = staleInProgressReclaimCounts.get(bead.id) ?? 0;
            if (priorAttempts >= STALE_IN_PROGRESS_RECLAIM_LIMIT) {
                cappedIds.push(bead.id);
                continue;
            }
            staleInProgressReclaimCounts.set(bead.id, priorAttempts + 1);
            log(`${reasonTag}: ${bead.id} is stuck 'in_progress' (started_at=${bead.started_at || 'n/a'}) with no unmet blockers and predates this sprint's launch -- reclaiming to 'open' so the sprint can dispatch it (attempt ${priorAttempts + 1}/${STALE_IN_PROGRESS_RECLAIM_LIMIT}).`);
            await command(`bd update ${bead.id} --status open`, { member_name: orchestratorMember, silent: true });
            reclaimedIds.push(bead.id);
        }
        if (cappedIds.length > 0) {
            log(`${reasonTag}: ${cappedIds.length} bead(s) hit the stale-in_progress reclaim bounce cap (limit ${STALE_IN_PROGRESS_RECLAIM_LIMIT}) and were left 'in_progress' rather than reclaimed again -- needs human investigation: ${cappedIds.join(', ')}.`);
        }
        return { reclaimedIds, cappedIds };
    }

    /**
     * Dispatches one reviewer round and returns its schema-validated verdict.
     * Shared by the per-round Develop/Review dispatch and the Cycle Evaluation
     * re-review so both apply the same contract rule: a `CHANGES_NEEDED`
     * verdict with empty `reopenIds` AND empty `newTasks` is schema-legal but
     * self-contradictory (nothing for the orchestrator to act on). The SAME
     * dispatch is retried once; if the contradiction repeats this throws
     * `ReviewerContractViolationError` rather than returning a verdict that
     * would silently accumulate toward stall-abort as legitimate no-progress.
     * @param {{ beadIds: string[], acceptanceCriteriaJson: string }} opts
     * @returns {Promise<{ verdict: string, notes: string, reopenIds: string[], replanIds?: string[], newTasks: object[] }>}
     */
    async function dispatchReview({ beadIds, acceptanceCriteriaJson }) {
        const reviewerPool = getMembersForRole(ROLE_REVIEWER);
        // apra-fleet-0ef: fetch the INFERRED entries this reviewer may promote
        // and hand them to it in the prompt. The reviewer has no MCP kb_* tools
        // of its own, so without this it can never name an entry id and
        // `kb_promotions` comes back empty every round -- which is exactly why
        // kb_promote had never once fired. Scoped to the reviewer's OWN work
        // folder (same source kbWork.apply uses to route the writes), and
        // best-effort: a cold KB must not fail the review.
        const reviewerRepoPath = kbPriming.folderOf(reviewerPool[0]);
        const kbCandidates = await kbWork.promotionCandidates(reviewerRepoPath);
        if (kbCandidates.length > 0) {
            log(`[kb-work] offering ${kbCandidates.length} INFERRED entr(ies) to the reviewer for promotion.`);
        }
        // What the KB knows about the beads UNDER REVIEW, not just whatever the
        // sprint-start prime happened to surface. Falls back to the primed set
        // when the query returns nothing (a KB with no matching rows yet).
        const reviewerQueried = await kbWork.relevantKnowledge(reviewerRepoPath, kbQueryTerms([], beadIds));
        const reviewerKnowledge = reviewerQueried.length > 0
            ? reviewerQueried
            : kbPriming.knowledgeOf(reviewerPool[0]);
        // A full-cycle review can genuinely exhaust the fleet's default turn
        // budget, and a fresh retry deterministically hits the same wall. Make
        // the budget explicit and, on max_turns exhaustion, RESUME the same
        // session at a doubled budget: the session already holds the full
        // review context, so a continue-nudge finishes the job instead of
        // restarting it.
        // apra-fleet-3swo.5.7: the per-round reviewer ladder -- its dispatch,
        // its read-side git-sync bracket, its max_turns-exhaustion resume at
        // doubled turns, its two-attempt budget, its auth self-heal, its
        // CHANGES_NEEDED degrade and its contract-violation retry -- is now the
        // 'reviewer' row of fleet-sprint/role-policies.mjs.
        //
        // TWO things about this ladder are worth naming, because both are
        // recorded as data rather than written out here:
        //
        //  1. The reviewer routes to the reviewer POOL HEAD, not to the
        //     reviewer ROLE member the final review uses. That is a
        //     'pool-head'-kind member, which the engine cannot resolve on its
        //     own -- it arrives as the `reviewerPool[0]` binding below.
        //
        //  2. The contract guard shares the ladder's attempt budget. A
        //     CHANGES_NEEDED verdict with both reopenIds and newTasks empty is
        //     self-contradictory (nothing for the orchestrator to act on) and
        //     must never be treated as an ordinary "more work needed" round.
        //     It is a postResult STEP that rejects the result, and
        //     retry.retryOnInvalidResult is what spends a second whole review
        //     on it rather than a nudge -- a verdict that contradicts itself
        //     cannot be repaired in place. Once the budget is spent the caller
        //     gets a ReviewerContractViolationError, never a fabricated verdict.
        const reviewOutcome = await dispatchRole(dispatchCtx, 'reviewer', {
            prompt: buildReviewerPrompt({
                beadIds,
                acceptanceCriteriaJson,
                baseBranch: validated.baseBranch,
                branch: validated.branch,
                goal: validated.goal,
                kbCandidates,
                kbKnowledge: reviewerKnowledge,
            }),
            // Restate the review scope: a resumed dispatch replaces the
            // delivered prompt artifact, so the scope must be repeated inline.
            resumePrompt:
                'Continue your review exactly where you left off in this same session -- do not restart or re-read the diff from scratch. ' +
                // apra-fleet-s6d: same empty-beadIds case as buildReviewerPrompt
                // -- a scope-wide re-review has no ids to restate, and "bead
                // id(s) under review  on branch..." reads as a dropped value.
                `Your scope, restated so a resumed dispatch never loses it: `
                + (Array.isArray(beadIds) && beadIds.length > 0
                    ? `bead id(s) under review ${beadIds.join(', ')} `
                    : `the entire sprint scope (no individual bead ids -- you are judging whether the sprint as a whole is complete) `)
                + `on branch ${validated.branch} against base ${validated.baseBranch}. ` +
                'Finish evaluating the remaining acceptance criteria and return your final verdict now.',
            roleLabel: 'Reviewer',
            resumeLabel: `Review (resume, max_turns=${TURN_BASES.BASE_REVIEWER_MAX_TURNS * 2})`,
            // The reviewer pool head is a runner-local value; the policy names
            // it by binding and the engine resolves it from here.
            bindings: { 'reviewerPool[0]': reviewerPool[0] },
            // Within THIS cycle's develop-review loop, resume the reviewer's own
            // prior-round session by explicit session id so a re-review of the
            // next round's fixes keeps the diff/context it already built. False
            // on the first round of any cycle (roundSessions never resumes
            // across cycles) and cleared on a failed round by the policy's
            // 'clear-round-session' degrade step. The max_turns-exhaustion
            // resume overrides this to `resume: true`, which is an in-dispatch
            // continuation, not a cross-round one.
            resumeArg: roundSessions.resumeArgFor('reviewer', cycle),
            onSessionId: (id, meta) => roundSessions.record('reviewer', cycle, id, meta),
            onResultRejected: (reason) => new ReviewerContractViolationError(
                `Reviewer returned CHANGES_NEEDED with empty reopenIds AND empty newTasks twice in a ` +
                `row (cycle ${cycle}) -- a self-contradictory verdict with nothing for the ` +
                `orchestrator to act on. Refusing to let this silently accumulate toward stall-abort.`,
                { cycle, notes: reason }
            ),
        });
        // Deliberately NO log() dump of the verdict here. Every path that
        // reaches this line already produced an activity row with the identical
        // content: agent() emits the schema-validated output verbatim on the
        // standard AGENT row (src/viewer/index.mjs), and each failure fallback
        // logs next to where the verdict is built. A second log() would render a
        // duplicate row. The same rule holds at every post-dispatch site in this
        // file, so every agent dispatch renders uniformly through its one AGENT
        // row.
        //
        // A degraded round counts toward the bounded stall-abort budget like
        // every other role's dispatch failure -- it is NOT a reviewer contract
        // violation, which is what the dispatchFailed marker records.
        return reviewOutcome.value;
    }

    // The sprint branch must be git-ensured on EVERY member that will operate
    // on it, not just the orchestrator: doers round-robin across the doer pool,
    // the reviewer runs from the reviewer pool, and every other role dispatched
    // through withGitSync's shared bracket (planner, plan-reviewer, deployer,
    // integ-test-runner, regression-test-runner, harvester -- see that bracket's
    // own doc comment a few hundred lines up) gets a pre-dispatch G-pull that
    // ASSUMES the correct branch is already checked out. On a real multi-member
    // fleet each role can resolve to its own independent checkout, so ensure on
    // the union of every role's member pool before the first doer round -- not
    // just doer/reviewer.
    //
    // Without this, a role pinned via roleMap to a member that was never
    // branch-ensured (e.g. deployer isolated onto its own machine, per the
    // fleet-supervisor skill's own recommended layout) can pass its G-pull's
    // `git merge --ff-only origin/<branch>` silently: a fast-forward merge does
    // not care what branch HEAD is currently on, only that HEAD is an ancestor
    // of the fetched tip. If that member happens to be sitting on a branch
    // (e.g. main) that is still fast-forward-compatible with the sprint branch,
    // the merge succeeds and silently advances THAT branch's pointer instead of
    // checking out/creating a correctly-named local branch -- the deploy/test
    // dispatch still gets the right code, but the member's local branch bookkeeping
    // ends up mislabeled. See apra-fleet-ivxi/u1qw/69pp sprint run
    // (fleet-sprint/ivxi-u1qw-69pp), where fleet-win-deploy's local `main`
    // silently absorbed the sprint branch's commits this way.
    //
    // SUPPORTED-TOPOLOGY NOTE: there is no cross-member bd/git sync layer here.
    // Every `bd` command below runs against the orchestrator member's beads DB
    // and a doer's own `bd close` runs against its member's DB, which only
    // coheres when all members share one workspace/DB (or there is a single
    // member). bin/cli.mjs enforces that via checkMemberTopology() before the
    // sprint starts; this ensure-everywhere is the git half of the same "every
    // member starts from the same state" guarantee. See docs/architecture.md
    // "Multi-member topology (fleet-sprint)".
    // apra-fleet: orchestratorMember is deliberately NOT included here -- the
    // orchestrator role issues only bd/Dolt commands (never git), and a
    // shared/unreservable orchestrator member used across concurrent sprints
    // cannot be checked out onto N different branches at once. If an operator
    // explicitly role-maps a dispatch member (doer/reviewer/planner/etc.) as
    // orchestrator too, that member is still included below via its dispatch
    // role, so the ensure-everywhere guarantee is unaffected for that case.
    const branchEnsureMembers = [...new Set([
        ...getMembersForRole(ROLE_DOER),
        ...getMembersForRole(ROLE_REVIEWER),
        ...getMembersForRole('planner'),
        ...getMembersForRole('plan-reviewer'),
        ...getMembersForRole('deployer'),
        ...getMembersForRole('integ-test-runner'),
        ...getMembersForRole('regression-test-runner'),
        ...getMembersForRole('harvester'),
    ])];

    // Read the requirementsFile (if any) once, up front, so its content can
    // be threaded into every Plan-phase planner prompt.
    // A missing/unreadable file is a warning, not a fatal error -- the
    // planner prompt notes the omission and the sprint proceeds without it.
    let requirementsContent = null;
    if (validated.requirementsFile) {
        try {
            requirementsContent = await fs.readFile(validated.requirementsFile, 'utf-8');
        } catch (err) {
            log(`Warning: could not read requirementsFile '${validated.requirementsFile}': ${err.message}`);
            requirementsContent = null;
        }
    }

    // Pre-flight beads-health gate: runs the D-pull probe BEFORE any setup
    // mutation (the branch-ensure loop's fetch/checkout just below), so a
    // diverged orchestrator beads clone is caught and reported -- naming the
    // workspace path, conflicting table(s), and remediation -- while the sprint
    // has still mutated nothing. This is the first fleet dispatch of the run.
    // Routed through the single dolt-sync module (apra-fleet-417.2.1):
    // readinessGate (apra-fleet-417.5 rename of healthGate) selects the
    // pre-flight variant of the BEFORE bracket.
    // Thread the orchestrator member's REGISTERED shell into dolt-settle,
    // guarded on args.callTool the same way the pre-dispatch bracket is
    // (apra-fleet-7dir.24).
    const preflightSettleShell = await resolveSettleShell({ args, member: orchestratorMember, log, sprintState });
    await gitSync.syncBeadsBefore(orchestratorMember, { readinessGate: true, settle: buildSettleCallback(orchestratorMember, { command, log, shell: preflightSettleShell }) });

    // =======================
    // 0. Git Setup: ensure the sprint branch exists off base_branch
    // =======================
    // First GIT dispatch of the run -- runs before any bd/agent activity so
    // the whole sprint develops on `branch`, branched from `base_branch`.
    // The phase body lives in ./phases/ensure-sprint-branch.mjs
    // (apra-fleet-3swo.6.2), which receives its state explicitly instead of
    // closing over the locals above.
    await runEnsureSprintBranchPhase({
        command, log, group, phase, endGroup, publishState,
        branchEnsureMembers, validated,
    });

    // NON-DESTRUCTIVE re-ensure of the sprint branch on every member: an agent
    // on any member can check something else out between cycles, so the "every
    // member is on the sprint branch" invariant has to be re-asserted rather
    // than assumed. Deliberately a plain `git checkout <branch>`, NOT the
    // initial `checkout -B <branch> origin/<base>`: once doers have committed
    // sprint work, resetting to base would discard it. failSoft, so a member
    // that cannot re-checkout never kills the sprint. A truly divergent
    // multi-member fleet is refused up front by checkMemberTopology() in
    // bin/cli.mjs, which is what makes this cheap guard sufficient.
    async function reEnsureBranchOnMembers() {
        for (const member of branchEnsureMembers) {
            await command(
                `git checkout ${validated.branch}`,
                {
                    member_name: member,
                    silent: true,
                    failSoft: true,
                    label: `Re-ensure sprint branch '${validated.branch}' checked out on member '${member}'`,
                }
            );
        }
    }

    // Keeps the dashboard UI updated with real bd data. publishState carries
    // sprintTasks only -- everything under this sprint's target scope,
    // re-fetched fresh every call, so beads added mid-run appear on the next
    // refresh with no separate wiring. The per-sprint fleet-sprint viewer
    // shows sprint progress only; project-wide backlog exploration is the
    // supervisor UX's job, not this one's (apra-fleet-eft.89.2). A failed
    // sprint-tree query returns early and publishes nothing at all this
    // round.
    async function updateDashboard() {
        let sprintTasks = [];
        try {
            // The no-args path is required here: any non-empty rest args route
            // through a second `bd list` query, and plain `bd list` defaults to
            // open/in_progress only, so CLOSED beads would never reach the
            // dashboard's sprint tree. No-args returns the shared `bd list
            // --all` fetch filtered to scope -- every status, one query fewer.
            sprintTasks = await bdListScoped('');
            // A bead whose stored `status` is 'open' but which is NOT in the
            // scope's `--ready` set is blocked. The viewer only sees stored
            // status, so without this flag a deadlocked bead renders
            // identically to a genuinely-ready one. Reuses `--ready` -- the
            // same signal dispatch decisions are based on -- rather than
            // introducing a second source of truth.
            try {
                const readyIds = new Set((await bdListScoped('--ready --json')).map((b) => b.id));
                sprintTasks = sprintTasks.map((t) => ({ ...t, ready: readyIds.has(t.id) }));
            } catch (e) {
                log(`updateDashboard: failed to compute ready/blocked badge data (non-fatal, status badges fall back to stored status): ${e.message}`);
            }
        } catch (e) {
            // Best-effort dashboard sync must never abort the sprint over a
            // transient blip, so this does not rethrow -- but it must be
            // LOGGED, or a stale/empty Beads Tasks panel is indistinguishable
            // from "just how it looks" for the whole round.
            log(`updateDashboard: failed to refresh sprint-tree panel (non-fatal, will retry next update): ${e.message}`);
            return; // sprintTasks fetch failed -- nothing to publish this round
        }

        if (typeof publishState === 'function') {
            // apra-fleet-eft.52.1.3: split the scoped tree into Sprint vs
            // Backlog SERVER-SIDE by goal membership (goal-priority band + a
            // blocks-edge exception for below-goal items wired to in-goal
            // ones). Each task carries a `placement` flag the viewer consumes
            // verbatim -- placement is never a browser-side CSS/priority
            // guess. `backlogTasks` is only added to the payload when a
            // below-goal item actually exists in scope, so a sprint whose
            // whole tree is in-goal keeps publishing sprintTasks alone (the
            // viewer/detailLookup both tolerate a missing backlogTasks key).
            const { sprintTasks: sprintPlaced, backlogTasks } = partitionByGoalMembership(sprintTasks, validated.goal);
            const payload = { sprintTasks: sprintPlaced };
            if (backlogTasks.length > 0) payload.backlogTasks = backlogTasks;
            // apra-fleet-x8r.4: plumbs the SAME two axes runner.js's own
            // completion gate (~line 8134: bdListScoped(--priority-max=
            // goalMax) MINUS decomposedParentIds()) filters on, so the
            // viewer's computeSprintProgress() required/closed counts match
            // what actually gates sprint exit -- never re-derived
            // client-side. Not `const goalMax` from the outer closure: this
            // function's FIRST call happens before that `const` initializes
            // (TDZ), so the numeric max is derived fresh here instead, from
            // the same pure goalPriorityMax() helper.
            payload.goalMax = Number(goalPriorityMax(validated.goal).slice(1));
            // sprintTasks is already this cycle's `bdListScoped('')` result
            // (any status, full scope) -- decomposedParentIds() re-derives
            // from that same no-args query, so building the set directly off
            // sprintTasks here is identical output with no extra `bd` call.
            payload.decomposedParentIds = [...new Set(
                sprintTasks.filter((b) => b && b.parent).map((b) => b.parent)
            )];
            publishState('beads', payload);
        }
    }

    // Platform-agnostic existence probe, standing in for a first-class
    // fileExists fleet API. One `node -e` invocation with plain, non-nested
    // single-quoted JS literals inside a double-quoted shell argument (no
    // escaped-quote-inside-quote traps). failSoft, so a probe failure can never
    // throw and kill the sprint -- it just means "skip the dependent phase".
    // Runs on `member` -- the role member about to consume the probed file --
    // never on orchestratorMember: a shared/unreservable orchestrator member
    // carries no git checkout to probe.
    async function probeFileExists(filename, member) {
        const res = await command(
            `node -e "console.log(require('fs').existsSync('${filename}') ? 'found' : 'not found')"`,
            { member_name: member, silent: true, label: `Probe for '${filename}'`, failSoft: true }
        );
        if (!res.ok) {
            log(`Probe for '${filename}' failed (treating as not-found, skipping the dependent phase): ${res.error}`);
            return false;
        }
        return res.output.trim() === 'found';
    }

    // Defense in depth: the pre-sprint health gate above already pulled this
    // clone, but a stale orchestrator clone here would misreport every remote
    // doer's work, so pull again immediately before the verification read.
    // DoltSync.syncBefore() is a benign no-op when the clone is current and
    // when no dolt remote is configured at all.
    // Thread the orchestrator member's REGISTERED shell into dolt-settle,
    // guarded on args.callTool the same way the pre-dispatch bracket is
    // (apra-fleet-7dir.24).
    const verifyReadSettleShell = await resolveSettleShell({ args, member: orchestratorMember, log, sprintState });
    await gitSync.syncBeadsBefore(orchestratorMember, { fatal: true, settle: buildSettleCallback(orchestratorMember, { command, log, shell: verifyReadSettleShell }) });

    await updateDashboard();

    // readyLeafBeads(), not raw bdListScoped('--ready --json'): bd's own
    // `--ready` reports a decomposed childful target (e.g. this sprint's own
    // --issue target once it has children) as ready too, which would make
    // this pre-sprint gate never see an empty ready-set for the extremely
    // common case of "open childful target, no blockers" -- silently
    // disabling the stale-in_progress reclaim, the parent-child+blocks
    // deadlock detector/auto-repair, and the "nothing to do" hard-fail below.
    let initialBeads = await readyLeafBeads();

    // apra-fleet-jfo: a sprint whose scope has zero ready leaf work can still
    // be legitimate -- a pure-verify sprint aimed at an already-implemented
    // parent (or a target bead that is itself all-children-closed). Computed
    // once here and reused below so the "nothing to do" diagnostics never
    // misreport this as a deadlock.
    const preSprintVerifyIds = initialBeads.length === 0
        ? classifyVerifySet(await fetchAllBeadsShared(), targetIssues).verifyIds
        : [];
    if (preSprintVerifyIds.length > 0) {
        log(`Pre-sprint validation: no ready leaf beads, but ${preSprintVerifyIds.length} bead(s) are implementation-complete and routed to verify: ${preSprintVerifyIds.join(', ')}. Proceeding as a verify-only sprint.`);
    }

    if (initialBeads.length === 0 && preSprintVerifyIds.length === 0) {
        // An empty `--ready` set is not by itself "nothing left to do": real
        // unblocked work can be deadlocked on a bead stuck in a stale
        // 'in_progress' state left by an interrupted run that never reached `bd
        // close`. `bd --ready` excludes non-'open' beads, so it cannot tell
        // "orphaned" from "actively being worked" -- but a bead whose 'blocks'
        // dependencies are ALL closed has nothing left to wait on, so its
        // status is the only thing blocking it. Reclaim exactly that case to
        // 'open' rather than requiring a manual `bd update`.
        const notDoneBeads = await bdListScoped(`--status=${NOT_DONE_STATUSES} --json`);
        const notDoneIds = new Set(notDoneBeads.map((b) => b.id));

        const unmetBlockers = (bead) => (bead.dependencies || [])
            .filter((d) => d.type === 'blocks' && notDoneIds.has(d.depends_on_id))
            .map((d) => d.depends_on_id);

        const { reclaimedIds: preSprintReclaimedIds } = await reclaimStaleInProgress({
            notDoneBeads,
            reasonTag: 'Pre-sprint self-heal',
        });
        if (preSprintReclaimedIds.length > 0) {
            initialBeads = await readyLeafBeads();
        }

        if (initialBeads.length === 0) {
            if (notDoneBeads.length === 0) {
                // Distinguish "every target issue is genuinely done" from "one
                // or more target ids are not visible to this orchestrator
                // member's own bd clone AT ALL" -- the latter reads
                // identically as "Nothing to do" without this check (an empty
                // `notDoneBeads` either way), but is a completely different
                // problem: those beads are not closed, they are invisible
                // here, most commonly because they were created/mutated on a
                // different clone that was never `bd dolt push`ed to the
                // shared remote before this sprint launched, or because a
                // members-persistent-across-sprints orchestrator (see
                // DoltSync.syncBefore's fatal:true D-pull above) still hasn't
                // synced them for some other reason. Reusing the already-
                // fetched project-wide snapshot -- no extra bd call.
                const allBeadsForVisibilityCheck = await fetchAllBeadsShared();
                const knownIds = new Set(allBeadsForVisibilityCheck.map((b) => b.id));
                const invisibleTargets = targetIssues.filter((id) => !knownIds.has(id));
                if (invisibleTargets.length > 0) {
                    throw new Error(
                        `Pre-sprint validation failed: ${invisibleTargets.length} of ${targetIssues.length} target issue id(s) ` +
                        `are not visible to the orchestrator member ('${orchestratorMember}')'s bd clone at all: ` +
                        `${invisibleTargets.join(', ')}. This is NOT the same as those beads being closed/done -- it usually ` +
                        `means they were created/updated on a different clone that was never synced to the shared Dolt remote ` +
                        `(dolt-push it there first) or this member's clone has not picked them up yet. Scope: '${sprintFilter}'.`
                    );
                }
                throw new Error(`Pre-sprint validation failed: No open/in-progress/blocked/deferred beads found for scope '${sprintFilter}'. Nothing to do.`);
            }

            // A specific deadlock shape: a `parent-child` edge one way plus a
            // `blocks` edge the other way between the SAME two beads (see
            // packages/apra-fleet-se/apra-pm/agents/_shared/GRAPH-SEMANTICS.md).
            // `bd dep cycles` does not detect it -- it does not walk
            // parent-child edges -- so it reads as "everything blocked" with no
            // actionable diagnosis. Check for it here, scoped to this sprint's
            // own not-done beads, before the generic deadlock message below.
            const byId = new Map(notDoneBeads.map((b) => [b.id, b]));
            const cyclePairs = [];
            for (const bead of notDoneBeads) {
                for (const dep of bead.dependencies || []) {
                    if (dep.type !== 'blocks') continue;
                    const other = byId.get(dep.depends_on_id);
                    const isParentChildPair = bead.parent === dep.depends_on_id
                        || (other && other.parent === bead.id);
                    if (isParentChildPair) {
                        cyclePairs.push({ blockedIssue: bead.id, blockedBy: dep.depends_on_id });
                    }
                }
            }
            if (cyclePairs.length > 0) {
                const fixCommands = cyclePairs.map((p) => `  bd dep remove ${p.blockedIssue} ${p.blockedBy}`);
                const cycleMessage =
                    `Pre-sprint validation failed: scope '${sprintFilter}' is deadlocked by ${cyclePairs.length} ` +
                    `parent-child + blocks cycle(s) (a bead has a 'blocks' dependency on its own --parent ` +
                    `ancestor/descendant, which fully blocks both beads even though 'bd dep cycles' will not ` +
                    `flag it). Fix by removing the offending 'blocks' edge(s):\n${fixCommands.join('\n')}`;

                // This shape is mechanically repairable -- the block above
                // already computed the precise edge(s) to remove -- so
                // auto-repair (one pass, no loop, no Planner dispatch) instead
                // of only throwing a diagnosis. A failed repair falls back to
                // the throw; it is never silently swallowed.
                try {
                    for (const pair of cyclePairs) {
                        await command(`bd dep remove ${pair.blockedIssue} ${pair.blockedBy}`, { member_name: orchestratorMember, silent: true });
                        log(`Pre-sprint auto-repair: removed the 'blocks' edge between ${pair.blockedIssue} and ${pair.blockedBy} (parent-child + blocks cycle) -- auto-removed via bd dep remove.`);
                    }
                } catch (repairErr) {
                    throw new Error(`${cycleMessage}\n\n(Auto-repair attempt itself failed: ${repairErr.message})`);
                }

                initialBeads = await readyLeafBeads();
                // Repair didn't unblock anything further -- one pass only, so
                // fall through to the existing generic deadlock diagnostics
                // below (do not loop, do not repair twice) when still empty.
                // Otherwise the sprint continues normally with the now-ready
                // beads, skipping the generic diagnostics entirely.
            }

            if (initialBeads.length === 0) {
                const diagnostics = notDoneBeads.map((b) => {
                    const blockers = unmetBlockers(b);
                    return blockers.length > 0
                        ? `  - ${b.id} [${b.status}] -- blocked by: ${blockers.join(', ')}`
                        : `  - ${b.id} [${b.status}] -- unblocked but status excludes it from --ready`;
                });
                throw new Error(
                    `Pre-sprint validation failed: No ready beads found for scope '${sprintFilter}', and ${notDoneBeads.length} ` +
                    `not-done bead(s) remain deadlocked:\n${diagnostics.join('\n')}`
                );
            }
        }
    }

    // =======================
    // Goal-priority exit condition + stall-abort bookkeeping
    // =======================
    //
    // `goalMax` is the worst ('Pn' with the highest n) priority tier named in
    // the sprint's `goal`. The real completion check below is "zero
    // NOT_DONE_STATUSES beads in scope at or above (numerically <=) this
    // priority", NOT "bd list --ready returned []".
    const goalMax = goalPriorityMax(validated.goal);

    // Stall detection: abort with a typed StalledSprintError after two
    // consecutive cycles that made no forward progress, rather than burning
    // every remaining cycle on a develop/review loop that keeps reopening and
    // re-failing the same bead(s).
    //
    // Progress is a HIGH-WATER MARK on the closed count, not a cycle-over-cycle
    // delta. A delta check is defeated by an oscillation (close a bead, reopen
    // it, close it again) whose closed-count sequence is 5,4,5,4,...: every
    // cycle differs from the one before, so the check never trips. Requiring a
    // cycle to exceed every prior cycle flags that correctly after
    // STALL_CYCLE_LIMIT non-record cycles.
    const STALL_CYCLE_LIMIT = 2;
    let staleCycles = 0;
    let highWaterClosedCount = 0;
    const closedCountHistory = [];

    // Per-bead reopen counts across the whole sprint. A bead reopened more than
    // REOPEN_THRASH_LIMIT times is flagged as thrashing -- the develop/review
    // loop is oscillating on that specific bead -- and its id is surfaced in
    // the StalledSprintError so a human sees WHICH beads are thrashing, not
    // just that the sprint stalled.
    const REOPEN_THRASH_LIMIT = 3;
    const reopenCounts = new Map();
    function recordReopen(id) {
        reopenCounts.set(id, (reopenCounts.get(id) ?? 0) + 1);
    }
    function thrashingBeadIds() {
        return [...reopenCounts.entries()]
            .filter(([, count]) => count > REOPEN_THRASH_LIMIT)
            .map(([id]) => id);
    }

    // apra-fleet-jfo: every bead id ever classified into the verify set this
    // sprint, monotone (added at classification, never removed -- even after
    // a bounce or eventual closure). Feeds the stall-detector's progress
    // score below: a bead cannot re-earn classification credit by
    // oscillating in and out of eligibility.
    const verifyEverIds = new Set();

    // apra-fleet-66u.2: separate two different facts the stall-abort message
    // used to conflate -- "closed count did not increase across N cycles"
    // (a progress fact) versus "verify-routed beads were dispatched to Integ
    // Test N times and produced ZERO closures" (a verifier fact). Only the
    // second condition licenses the "the verifier may be failing" wording.
    // verifyDispatchAttempts counts cycles where Integ Test was actually
    // handed a non-empty verify set; verifyDispatchClosures counts how many
    // of those cycles closed at least one of the beads it was handed (set at
    // Cycle Evaluation, once `stillOpenVerifyIds` -- computed on live,
    // correctly-scoped state per apra-fleet-66u.1's fix -- is available).
    let verifyDispatchAttempts = 0;
    let verifyDispatchClosures = 0;

    // apra-fleet-jfo D6: per-parent count of verify-fail bounces this sprint
    // (a gap bug filed under the parent, making it ineligible again). Capped
    // at VERIFY_GAP_LIMIT -- a parent that keeps failing verification is
    // deferred rather than bounced forever.
    const VERIFY_GAP_LIMIT = 2;
    const verifyGapCounts = new Map();

    // Deploy/Integration failure evidence, threaded into the Final Review's
    // evidence-based prompt below -- never silently swallowed.
    const deployFailures = [];
    const integFailures = [];

    // apra-fleet-nwh.1: integ-test-runner's own tracked spend, broken out of
    // the harvester's cost block so it is never silently folded into
    // "overhead" -- often the single longest/most expensive phase (a full
    // playbook run against a real sandbox). `budget` (destructured from
    // `context` above) exposes only a running total via spent(), not a
    // per-role breakdown, so this is derived here as a before/after delta
    // around each Integ Test phase dispatch (see the Integ Test Phase block
    // below) and fed into buildCostAnalysis() at Harvest time.
    // integTestRunnerDispatchCount stays 0 when the phase never dispatches
    // this run (no playbook, or deploy never succeeded), so buildCostAnalysis
    // can report that honestly instead of a fabricated/omitted line.
    let integTestRunnerSpend = 0;
    let integTestRunnerDispatchCount = 0;

    // Reviewer newTasks rejected by validateNewTask() before ever reaching
    // `command()`, threaded into the Final Review prompt so a rejection is
    // visible to a human rather than silently dropped. Rejection is non-fatal.
    // This is a cumulative AUDIT TRAIL -- every rejection ever seen this run,
    // never cleared -- distinct from pendingRejectedNewTasks below.
    const rejectedNewTasks = [];

    // The CURRENT set of not-yet-resubmitted rejected newTasks, resurfaced
    // verbatim into the next planning dispatch (buildPlannerPrompt's
    // rejectedNewTasksToResubmit) instead of dead-ending in root-bead notes.
    // Reassigned, never mutated in place, via the pure
    // trackRejectedNewTaskForResurfacing()/clearResubmittedNewTask() helpers.
    // Unlike `rejectedNewTasks`, an entry is DROPPED once resubmitted: it must
    // not accumulate forever.
    let pendingRejectedNewTasks = [];

    // The last Develop/Review loop's reviewer verdict for this cycle.
    // Goal-priority completion requires BOTH zero open goal-priority beads AND
    // an APPROVED last verdict -- a cycle whose ready-bead list emptied out
    // while the last review round was still CHANGES_NEEDED is not done.
    //
    // Both MUST be reset at the top of every cycle: an APPROVED verdict from
    // one cycle must never read as approved in the next, whose Develop/Review
    // loop may have been skipped entirely (no ready beads -> no fresh review).
    // `reviewedThisCycle` records whether a review genuinely ran THIS cycle, so
    // Cycle Evaluation can tell a fresh APPROVED from a stale one and dispatch
    // a re-review before trusting the latter.
    let lastReviewVerdict = null;
    let reviewedThisCycle = false;

    while (cycle <= MAX_CYCLES) {
        group(`Sprint Cycle ${cycle}`);

        // Reset per-cycle review state -- a verdict is only ever trustworthy
        // for the cycle that actually produced it.
        lastReviewVerdict = null;
        reviewedThisCycle = false;

        // After the first cycle, re-ensure (non-destructively) that every
        // member is still on the sprint branch before this cycle's doers run.
        // See reEnsureBranchOnMembers() above for why this never resets.
        if (cycle > 1) {
            await reEnsureBranchOnMembers();
        }

        // =======================
        // apra-fleet-jfo: Route -- classify verify-set beads BEFORE Plan
        // =======================
        // A bead whose every child is closed is implementation-complete and
        // must not be re-planned/re-decomposed -- it needs real integration-
        // test verification, not another Plan/Develop pass. Recomputed fresh
        // every cycle (no persisted list); classification itself counts as
        // sprint progress (see the stall-detector high-water-mark change
        // below), which is the actual fix for tonight's false-stall bug.
        const { verifyIds: verifySetThisCycle } = classifyVerifySet(await fetchAllBeadsShared(), targetIssues);
        for (const id of verifySetThisCycle) verifyEverIds.add(id);
        if (verifySetThisCycle.length > 0) {
            log(`Route C${cycle}: ${verifySetThisCycle.length} bead(s) implementation-complete, routed to verify (excluded from Plan/Develop): ${verifySetThisCycle.join(', ')}`);
        }

        // =======================
        // 1. Planning Loop
        // =======================
        // The phase body lives in ./phases/plan.mjs (apra-fleet-3swo.6.2),
        // which receives this cycle's state explicitly instead of closing over
        // the locals here. It hands back the three values "2. Execution Prep"
        // below still reads (planCapDeferredIds / lastVerdict / planningRounds)
        // plus the pendingRejectedNewTasks list it reassigns -- the one mutable
        // local that used to be shared through the closure.
        const planOutcome = await runPlanPhase({
            phase, log, command, dispatchCtx,
            cycle, validated, targetIssues, requirementsContent,
            orchestratorMember, getMemberForRole,
            sprintState, gitSync, args,
            verifySetThisCycle, roundSessions, pendingRejectedNewTasks,
            resolveSettleShell,
            parseBdJson,
            extractContestedBeadIds,
            reconcilePendingRejectedNewTasks,
            stageCommandBodyMemberSide,
            updateDashboard,
        });
        pendingRejectedNewTasks = planOutcome.pendingRejectedNewTasks;
        const { planCapDeferredIds, lastVerdict, planningRounds } = planOutcome;

        // =======================
        // 2. Execution Prep
        // =======================
        // `bd list --ready --json` does not guarantee a stable ordering: it
        // returns beads by `created_at` descending, but `created_at` has only
        // 1-second resolution, so beads created within the same second tie with
        // no reproducible tie-break. Bead `id` is not a safe sort key either --
        // it carries a random per-scratch-dir suffix. `title` is the only field
        // both guaranteed present and stable across runs, so it orders here
        // (with `id` as a final tie-break for identical titles). Without this,
        // dispatch order -- and which physical doer member each streak
        // round-robins to -- would vary between two otherwise-identical runs.
        //
        // The type filter mirrors, engine-side, the doer contract's "only claim
        // issue_type=task" rule at SEEDING time: a non-task bead handed to a
        // doer produces a deterministic contract-mandated refusal, so paying a
        // full LLM dispatch to hear it back is pure token waste. It touches
        // neither readiness semantics nor readyLeafBeads()'s structural parent
        // guard. Childless non-task beads stay in scope for the PLANNER, whose
        // contract decomposes them into task children; they just never reach a
        // doer streak directly.
        //
        // EXEMPTION -- target issues: a childless leaf TARGET is seeded into
        // scope whatever its recorded type, because if planning leaves it
        // childless, direct dispatch is the sprint's only path to it. The
        // filter exists to stop NON-target parents/bugs from wasting doer
        // dispatches, never to make a sprint's own target unreachable.
        const targetIssueSet = new Set(targetIssues);
        let readyBeads = (await readyLeafBeads())
            .filter((b) => targetIssueSet.has(b.id) || !b.issue_type || b.issue_type === 'task')
            .slice().sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));

        // Per-cycle self-heal (not just pre-sprint, see reclaimStaleInProgress's
        // doc comment): only when THIS cycle's ready set is otherwise empty --
        // mirrors the pre-sprint gate exactly, and keeps the common case (real
        // ready work every cycle) issuing zero extra `bd` calls, unlike an
        // unconditional per-cycle check. Reclaim any bead orphaned in_progress
        // since before this sprint launched, then recompute readiness, so a
        // claim orphaned mid-run (or reused from a prior aborted incarnation on
        // relaunch) self-heals on the very next cycle instead of silently
        // blocking every cycle after it for the rest of the sprint.
        if (readyBeads.length === 0) {
            const notDoneBeadsThisCycle = await bdListScoped(`--status=${NOT_DONE_STATUSES} --json`);
            const { reclaimedIds: cycleReclaimedIds } = await reclaimStaleInProgress({
                notDoneBeads: notDoneBeadsThisCycle,
                reasonTag: `Cycle ${cycle} self-heal`,
            });
            if (cycleReclaimedIds.length > 0) {
                log(`Cycle ${cycle} self-heal: reclaimed ${cycleReclaimedIds.length} orphaned bead(s), re-checking readiness: ${cycleReclaimedIds.join(', ')}.`);
                readyBeads = (await readyLeafBeads())
                    .filter((b) => targetIssueSet.has(b.id) || !b.issue_type || b.issue_type === 'task')
                    .slice().sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
            }
        }

        // The second plan-cap-deferral abort condition: deferring the contested
        // beads must never silently leave nothing dispatchable. An empty
        // readyBeads list is not normally an abort signal (Cycle Evaluation
        // decides completion), but immediately after a deferral it means the
        // approved remainder was empty all along, which is the same failure as
        // a whole-plan-contested exhaustion.
        if (planCapDeferredIds.length > 0 && readyBeads.length === 0) {
            throw new SprintPlanRejectedError(
                `Plan phase for cycle ${cycle}: after deferring contested bead(s) ` +
                `[${planCapDeferredIds.join(', ')}] per plan-cap exhaustion, the resulting ready set is empty. ` +
                'Refusing to proceed to Develop with nothing dispatchable.',
                {
                    notes: lastVerdict ? lastVerdict.notes : null,
                    cycle,
                    planningRounds,
                }
            );
        }

        // An empty `--ready` list is NOT, by itself, evidence the sprint
        // is complete -- it only means there's nothing dispatchable to a
        // doer THIS cycle (e.g. everything is currently blocked or
        // in_progress). The real completion decision happens in the Cycle
        // Evaluation section below, using the goal-priority `--status`
        // check. Here we simply skip the Develop/Review loop for this cycle
        // when there's nothing ready, and still run Deploy/Integration +
        // Cycle Evaluation so a permanently-blocked bead is surfaced by the
        // stall-abort / final-verdict evidence rather than by this loop
        // silently `break`-ing out and being mistaken for success.
        if (readyBeads.length === 0) {
            log('No ready beads to dispatch this cycle (may be blocked/in_progress work remaining) -- skipping Develop/Review loop for this cycle.');
        } else {
        // =======================
        // 3. Develop & Review Loop
        // =======================
        //
        // Every agent() dispatch below is consumed by the orchestrator -- no
        // result is ever logged-and-discarded. `doerPool` contains every
        // configured member, and each doer branch round-robins across the full
        // pool rather than collapsing onto one member.
        let devRounds = 0;
        let lastStillOpenCount = 0;  // Track for round-cap detection at loop exit

        // beadId -> reviewer feedback text for the NEXT round, populated only
        // for beads actually named in a CHANGES_NEEDED verdict's `reopenIds`:
        // per-bead routing, not a blanket broadcast of the whole verdict to
        // every doer.
        const perBeadFeedback = new Map();

        // Union of every bead id a reviewer verdict THIS cycle flagged via the
        // optional `replanIds` field: the bead was reopened, but its ACCEPTANCE
        // CRITERIA are themselves defective and can only be corrected by a
        // planner, not by re-development. Scoped to the cycle -- a defect
        // flagged here is re-scoped by this cycle's own handoff and must not
        // leak into the next. Populated after each round's reopenIds are
        // applied; consulted at the top of the next iteration.
        const replanIds = new Set();

        // Loop guard for the in-cycle scoped replan: bead ids that have ALREADY
        // been through one scoped planner+plan-review pass THIS cycle. Enforces
        // max one scoped replan per bead per cycle -- a bead flagged a second
        // time is refused at the reviewer fold-in below rather than re-planned,
        // so a defective bead can never ping-pong replan<->develop endlessly
        // within a cycle. Scoped to the cycle, like replanIds.
        const replannedThisCycle = new Set();

        const doerPool = getMembersForRole(ROLE_DOER);

        while (devRounds < 3) {
            // Same stable ordering and doer-dispatchability filter as
            // `readyBeads` above, and both must apply HERE too: this in-loop
            // list is the one that actually feeds the streak-assignment prompt
            // and the doerPool round-robin index. A bug/feature bead created
            // after the plan phase (a reviewer newTask, an out-of-band filing)
            // would otherwise land in a doer streak and burn a dispatch on a
            // contract-bound refusal. Same target-issue exemption as above.
            const currentReadyAll = (await readyLeafBeads())
                .filter((b) => targetIssueSet.has(b.id) || !b.issue_type || b.issue_type === 'task')
                .slice().sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));

            if (currentReadyAll.length === 0) break;

            // In-cycle SCOPED replan, taken on a bead's FIRST replan flag: when
            // a reviewer flags a still-ready bead via `replanIds` -- its
            // acceptance criteria are defective and cannot be satisfied by
            // re-development -- dispatch a scoped planner pass over exactly
            // those beads' subtree plus a scoped plan-review of the result,
            // within this same cycle, then resume develop rounds so the amended
            // bead is re-dispatched to a doer now rather than waiting on the
            // next cycle's full planner. `replannedThisCycle` makes this fire at
            // most once per bead per cycle: a second flag is refused at the
            // reviewer fold-in and falls through to the exclude/break
            // short-circuit below instead. A scoped replan pass consumes one
            // develop round, so a replan<->develop ping-pong cannot outrun the
            // round cap.
            const eligibleReplan = currentReadyAll.filter((b) => replanIds.has(b.id) && !replannedThisCycle.has(b.id));
            if (eligibleReplan.length > 0) {
                // The phase body lives in ./phases/replan.mjs
                // (apra-fleet-3swo.6.7), which receives this round's state
                // explicitly instead of closing over the loop locals here. It
                // returns nothing: its only outputs are in-place mutations of
                // the `replanIds`/`replannedThisCycle` Sets passed to it, which
                // the next iteration of this loop reads back off these same
                // bindings. The eligibility filter above, the `devRounds`
                // increment (a replan pass CONSUMES one develop round, which is
                // what stops a replan<->develop ping-pong outrunning the round
                // cap) and the `continue` below stay here: the first decides
                // whether the phase runs at all and the last is loop control.
                devRounds++;
                await runReplanPhase({
                    phase, log, dispatchCtx,
                    cycle, validated, targetIssues, requirementsContent,
                    orchestratorMember,
                    gitSync, updateDashboard,
                    verifySetThisCycle, pendingRejectedNewTasks,
                    devRounds, eligibleReplan, replanIds, replannedThisCycle,
                });
                continue;
            }

            // Replan short-circuit for beads whose scoped replan did not land.
            // Re-dispatching a replan-flagged bead to a doer is a predictably
            // wasted round: it is reopened, but its acceptance criteria are
            // defective. If EVERY still-ready bead this round is flagged, skip
            // all further develop/review rounds this cycle and let Cycle Eval
            // hand off to the next cycle's planner, which re-reads bead comments
            // and can re-scope. A MIX still runs a round with only the flagged
            // beads excluded from streak assignment, so real dev work is never
            // blocked on a defect in an unrelated bead's criteria. An empty
            // `replanIds` makes this a no-op.
            const currentReady = currentReadyAll.filter((b) => !replanIds.has(b.id));
            if (currentReady.length === 0) {
                log(
                    `[fleet-sprint] replan short-circuit: all ${currentReadyAll.length} still-ready bead(s) this cycle ` +
                    `are replan-flagged (${currentReadyAll.map((b) => b.id).join(', ')}) -- their acceptance criteria ` +
                    `need planner correction, not re-development. Skipping remaining develop/review rounds this cycle ` +
                    `and proceeding to Cycle Eval.`
                );
                break;
            }
            if (currentReady.length < currentReadyAll.length) {
                const excludedIds = currentReadyAll.filter((b) => replanIds.has(b.id)).map((b) => b.id);
                log(
                    `[fleet-sprint] replan short-circuit: excluding replan-flagged bead(s) ${excludedIds.join(', ')} from ` +
                    `this round's streak assignment (acceptance criteria defect flagged by reviewer; will be re-scoped ` +
                    `by the next cycle's planner) -- the remaining ${currentReady.length} bead(s) still run this round.`
                );
            }

            devRounds++;
            // =======================
            // 3a. Develop round
            // =======================
            // The phase body lives in ./phases/develop.mjs (apra-fleet-3swo.6.7),
            // which receives this round's state explicitly instead of closing
            // over the loop locals here. `devRounds` is incremented HERE, next
            // to the loop counter it belongs to, and handed over only to build
            // the round label. It hands back the two values the Review phase
            // below reads: this round's per-streak attribution and the stable
            // (title, id) sort key that keeps Review's evidence command and
            // reviewer prompt free of doer-completion-order drift.
            const { streakOutcomes, readyTitleById } = await runDevelopPhase({
                phase, log, command, parallel, dispatchCtx,
                cycle, validated, args, orchestratorMember,
                sprintState, gitSync, updateDashboard,
                kbPriming, kbWork,
                devRounds, currentReady, doerPool, perBeadFeedback,
                claimBeadsBatched,
                verifyDoerStreakClosed,
                normalizeTierToken,
                kbQueryTerms,
            });

            // --- Review: self-contained, schema-validated, orchestrator-applied ---
            // The phase body lives in ./phases/review.mjs
            // (apra-fleet-3swo.6.5), which receives this round's state
            // explicitly instead of closing over the loop locals here. It is
            // handed the two values the Develop phase above just returned --
            // this round's per-streak attribution and the stable (title, id)
            // sort key -- and it mutates `replanIds`, `replannedThisCycle`,
            // `perBeadFeedback` and `rejectedNewTasks` in place exactly as the
            // closure did. Only the three genuinely REASSIGNED values travel
            // back through this destructuring assignment; on the round where
            // every streak failed (empty review scope) they come back
            // unchanged, which is why no `if` is needed here.
            ({ lastReviewVerdict, reviewedThisCycle, pendingRejectedNewTasks } = await runReviewPhase({
                phase, log, command,
                cycle, validated, targetIssues, orchestratorMember,
                gitSync,
                replanIds, replannedThisCycle, perBeadFeedback, rejectedNewTasks,
                devRounds, streakOutcomes, readyTitleById,
                lastReviewVerdict, reviewedThisCycle, pendingRejectedNewTasks,
                dispatchReview, bdListScoped, goalMax, recordReopen,
                childIdAllocator, sprintMutexId,
                computeChildFloor, createChildBeadWithAllocatedId,
                trackRejectedNewTaskForResurfacing, clearResubmittedNewTask,
            }));

            await updateDashboard();

            // readyLeafBeads(), not raw bdListScoped('--ready --json'): a
            // childful --issue target that is still "ready" per bd's own
            // definition (e.g. before its children exist yet, or between
            // children closing and the next Route step routing it to verify)
            // must not read as "work still pending" here -- it is never a
            // dispatchable leaf, so it must not keep this loop from
            // organically completing (apra-fleet-66u.1/66u.2 rework).
            const stillOpen = await readyLeafBeads();
            lastStillOpenCount = stillOpen.length;  // Track for post-loop round-cap detection

            if (stillOpen.length === 0) {
                log('All beads processed this cycle -- cycle organically complete.');
                break;
            } else {
                log(`System found ${stillOpen.length} beads still open/ready. Looping back to develop.`);
            }
        }

        // Check if we exited due to round cap (devRounds === 3) with work still pending
        if (devRounds === 3 && lastStillOpenCount > 0) {
            log(`Develop/Review round cap (3) reached this cycle with ${lastStillOpenCount} bead(s) still open/reopened -- deferring to next cycle.`);
        }
        } // end Develop & Review loop (skipped when readyBeads.length === 0)

        // =======================
        // 4. Deploy & Integration
        // =======================
        //
        // Runbook probes: a single platform-agnostic probe helper, dispatched
        // via `command(..., { failSoft: true })`. A probe failure (transient
        // error, portability quirk on a given member, etc.) SKIPS the dependent
        // phase with a logged warning -- it must never throw and kill the
        // sprint.
        const hasDeploy = await probeFileExists('deploy.md', getMemberForRole('deployer'));
        const hasPlaybook = await probeFileExists('integ-test-playbook.md', getMemberForRole('integ-test-runner'));

        let deployedThisCycle = false;

        if (hasDeploy) {
            // The phase body lives in ./phases/deploy.mjs
            // (apra-fleet-3swo.6.5), which receives its state explicitly
            // instead of closing over runSprintCycle's locals. The
            // `probeFileExists('deploy.md')` probe above and the `else` branch
            // below stay here: the probe is what decides whether this phase
            // runs at all, and the flag it produces is read much later by
            // Cycle Evaluation. A failure is pushed onto `deployFailures` in
            // place, exactly as the closure did; `deployedThisCycle` is the one
            // value that is reassigned, so it comes back as a return value.
            ({ deployedThisCycle } = await runDeployPhase({
                phase, log, dispatchCtx,
                cycle, sprintSelfIdLine,
                getMemberForRole, ensureUnattendedAuto, ensureDeployPermissions,
                deployFailures, deployedThisCycle,
            }));
        } else {
            log('Skipping Deploy Phase (no deploy.md found, or the probe itself failed -- see prior log line)');
        }

        // apra-fleet-66u.2: declared here, OUTSIDE the `if (hasPlaybook &&
        // deployedThisCycle)` block below, so Cycle Evaluation's
        // verifyDispatchAttempts/verifyDispatchClosures tracking can see it
        // regardless of whether Integ Test actually ran this cycle -- an
        // in-block `let` is unreachable once that block's scope ends, which
        // is exactly what threw a ReferenceError here before this hoist.
        // Defaults to empty so a cycle where Integ Test never dispatched (no
        // playbook, or Deploy failed) correctly counts as "no verify
        // dispatch attempt", not a crash.
        let verifySetForIntegTest = [];
        if (hasPlaybook && deployedThisCycle) {
            // The phase body lives in ./phases/integ-test.mjs
            // (apra-fleet-3swo.6.8), which receives its state explicitly
            // instead of closing over runSprintCycle's locals. The two
            // probeFileExists() runbook probes above, the hoisted
            // `let verifySetForIntegTest = []` and both "Skipping Integration
            // Test Phase" else branches below all stay here: the probes decide
            // whether this phase runs at all, and the verify set they feed is
            // read by Cycle Evaluation whether or not it ran. integFailures,
            // verifyEverIds and verifyGapCounts are mutated in place exactly as
            // the closure did; the three genuinely reassigned values come back.
            ({ verifySetForIntegTest, integTestRunnerDispatchCount, integTestRunnerSpend } = await runIntegTestPhase({
                phase, log, command, dispatchCtx,
                cycle, targetIssues, orchestratorMember, sprintSelfIdLine,
                budget,
                integFailures, verifyEverIds, verifyGapCounts,
                verifySetForIntegTest, integTestRunnerDispatchCount, integTestRunnerSpend,
                getMemberForRole, ensureUnattendedAuto, ensureDeployPermissions,
                bdListScoped, fetchAllBeadsShared, parseBdJson, updateDashboard,
                VERIFY_GAP_LIMIT,
            }));
        } else if (hasPlaybook && !deployedThisCycle) {
            log('Skipping Integration Test Phase (deploy did not succeed this cycle, or no deploy.md was present to attempt)');
        } else {
            log('Skipping Integration Test Phase (no playbook found, or the probe itself failed -- see prior log line)');
        }

        // =======================
        // 5. Cycle Evaluation: goal-priority exit + stall-abort
        // =======================
        //
        // Real completion is "zero NOT_DONE_STATUSES beads in scope at or
        // above the goal priority AND the last reviewer verdict this cycle
        // was APPROVED" -- deliberately NOT `bd list --ready == []`, which
        // reads a permanently-blocked or orphaned in_progress bead as
        // success. See goalPriorityMax()/NOT_DONE_STATUSES above.
        //
        // D-pull the orchestrator's beads clone BEFORE the cycle-evaluation
        // counts so the completion/stall math reads the current cross-member
        // beads state (every member's D-pushed closes) rather than the
        // orchestrator's stale local copy.
        // Thread the orchestrator member's REGISTERED shell into dolt-settle,
        // guarded on args.callTool the same way the pre-dispatch bracket is
        // (apra-fleet-7dir.24).
        const cycleEvalSettleShell = await resolveSettleShell({ args, member: orchestratorMember, log, sprintState });
        await gitSync.syncBeadsBefore(orchestratorMember, { fatal: true, settle: buildSettleCallback(orchestratorMember, { command, log, shell: cycleEvalSettleShell }) });
        // A decomposed parent (any bead that is itself someone's --parent,
        // including a childful --issue target) is excluded here the same way
        // readyLeafBeads() excludes it from dispatch: its own "done" status
        // comes from its children/verify-closure, never from being an
        // undispatchable leaf sitting open at goal priority forever. Whether
        // it must still close before the sprint may exit is owned entirely by
        // the separate stillOpenVerifyIds/verifyEverIds mechanism below, which
        // is scope- and structure-independent and does not have this blind
        // spot for the child-not-yet-verify-routed case in between.
        const [openAtGoalRaw, openAtGoalParentIds] = await Promise.all([
            bdListScoped(`--status=${NOT_DONE_STATUSES} --priority-max=${goalMax} --json`),
            decomposedParentIds(),
        ]);
        const openAtGoal = openAtGoalRaw.filter((b) => !openAtGoalParentIds.has(b.id));

        // Stall detection: track the closed-bead count for the WHOLE sprint
        // scope (not just goal-priority) so zero forward progress on ANY bead
        // is caught. `closedBeadsNow` is a genuinely fresh, correctly-scoped
        // `bd list --status=closed` read (bdListScoped always issues a real
        // command when a filter is passed) -- reused below instead of
        // fetchAllBeadsShared()'s snapshot, which is NOT refreshed by this
        // (or any other) bdListScoped call and can be stale by a full cycle
        // in a topology with no dolt sync remote (doltPullBefore/After are
        // both benign no-ops there, so nothing invalidates it): the integ
        // runner's own `bd close` happens inside an agent() dispatch, never
        // through the cache-invalidating command() wrapper.
        const closedBeadsNow = await bdListScoped('--status=closed --json');
        const closedIdsNow = new Set(closedBeadsNow.map((b) => b.id));
        const closedCount = closedBeadsNow.length;
        closedCountHistory.push(closedCount);

        // apra-fleet-66u.2: track whether THIS cycle's Integ Test dispatch (if
        // any verify-routed beads were handed to it) actually closed any of
        // them, on the same live, correctly-scoped state closedCount above
        // just read. Feeds the stall-abort message below: "the verifier may
        // be failing" is only warranted when it NEVER once closed anything it
        // was asked to verify, not merely when the sprint later stalls for an
        // unrelated reason.
        if (verifySetForIntegTest.length > 0) {
            verifyDispatchAttempts++;
            const closedThisDispatch = verifySetForIntegTest.some((id) => closedIdsNow.has(id));
            if (closedThisDispatch) verifyDispatchClosures++;
        }

        // apra-fleet-jfo: a bead classified into the verify set this cycle is
        // real progress too -- it was implementation-complete work correctly
        // excluded from Plan/Develop, now awaiting real integration-test
        // verification (which cannot happen until IntegTest actually runs).
        // Without this, a cycle that closes every leaf bead under several
        // parents -- but closes none of the parents themselves, since only
        // IntegTest may do that -- reads as zero progress and stalls the
        // sprint, exactly what happened live 2026-08-02 on apra-fleet-l7n and
        // apra-fleet-2sn. `verifyEverIds` is monotone (only ever grows), so a
        // bead cannot re-earn credit by oscillating in and out of
        // eligibility -- the high-water-mark oscillation-proofing survives.
        const progressScore = closedCount + verifyEverIds.size;
        // High-water-mark progress. A cycle only counts as progress when it sets
        // a NEW all-time high for this sprint -- returning to a previously-seen
        // value (even one different from the immediately prior cycle, e.g.
        // 5,4,5,4,...) is not progress.
        if (progressScore > highWaterClosedCount) {
            highWaterClosedCount = progressScore;
            staleCycles = 0;
        } else {
            staleCycles++;
        }

        if (staleCycles >= STALL_CYCLE_LIMIT) {
            const thrashIds = thrashingBeadIds();
            // apra-fleet-mjo: counts alone ("history: [9, 14, 14, 14]") do not
            // tell an operator WHAT is holding the sprint open, which is
            // precisely what they need to intervene. Name the blocking beads.
            const blockerIds = openAtGoal.map((b) => b.id);
            const blockerSuffix = blockerIds.length > 0
                ? ` Still open at/above goal priority ${goalMax}: [${blockerIds.join(', ')}].`
                : ' No beads remain open at/above goal priority -- the stall is in closing out the sprint, not in the work itself.';
            const thrashSuffix = thrashIds.length > 0
                ? ` Reopen-thrash detected on bead(s) [${thrashIds.join(', ')}] (reopened more than ${REOPEN_THRASH_LIMIT} times) -- ` +
                  `likely cause of the oscillation.`
                : '';
            // apra-fleet-66u.2: report only the STILL-open verify-routed
            // beads (verifyEverIds is monotone and never drops an id once
            // closed, so dumping it directly names beads that may have
            // closed cycles ago -- the exact wording that shipped in the
            // real 2026-08-02 incident, which named apra-fleet-33c/jfo/gd0 as
            // "never closed" when all three had closed back in Cycle 1). And
            // only claim "the verifier may be failing" when Integ Test
            // dispatches actually happened against a verify set and NEVER
            // once closed anything -- if it closed something at some point,
            // the stall has some other cause and the verifier-blame wording
            // is actively misleading.
            let verifySuffix = '';
            if (verifyEverIds.size > 0) {
                const stillOpenVerifyIdsForAbort = [...verifyEverIds].filter((id) => !closedIdsNow.has(id));
                if (stillOpenVerifyIdsForAbort.length > 0) {
                    verifySuffix = (verifyDispatchAttempts > 0 && verifyDispatchClosures === 0)
                        ? ` ${stillOpenVerifyIdsForAbort.length} bead(s) were routed to verify this sprint but never closed -- the ` +
                          `verifier may be failing rather than the sprint being genuinely out of work: ${stillOpenVerifyIdsForAbort.join(', ')}.`
                        : ` ${stillOpenVerifyIdsForAbort.length} verify-routed bead(s) remain unclosed: ${stillOpenVerifyIdsForAbort.join(', ')}.`;
                }
            }
            throw new StalledSprintError(
                `Sprint stalled: ${staleCycles} consecutive cycle(s) made no new high-water-mark progress ` +
                `(closed beads + verify-routed beads) in scope '${sprintFilter}'. Closed-count history: ` +
                `[${closedCountHistory.join(', ')}] (high-water mark on progress score: ${highWaterClosedCount}).` +
                blockerSuffix + thrashSuffix + verifySuffix +
                ` Aborting rather than burning the remaining cycles.`,
                { staleCycles, closedCountHistory, highWaterClosedCount, blockerIds, thrashIds, reopenCounts: Object.fromEntries(reopenCounts), verifyEverIds: [...verifyEverIds], cycle }
            );
        }

        // apra-fleet-jfo D5: if the ONLY open-at-goal beads remaining are
        // verify-routed and no playbook exists to verify them, no further
        // cycle can make progress by construction -- exit to Finalization
        // directly rather than let the stall net eventually convert
        // "finished but unverifiable" into an ABORT.
        if (!hasPlaybook && openAtGoal.length > 0 && openAtGoal.every((b) => verifyEverIds.has(b.id))) {
            log(`Cycle ${cycle}: all ${openAtGoal.length} remaining open-at-goal bead(s) are verify-routed (${openAtGoal.map((b) => b.id).join(', ')}) and no integ-test-playbook.md exists to verify them -- exiting cycle loop, cannot make further progress by construction.`);
            endGroup();
            break;
        }

        // The exit decision below must never rely on a verdict from an EARLIER
        // cycle. `lastReviewVerdict` is reset to null at the top of every cycle
        // and only set when a review genuinely ran THIS cycle
        // (`reviewedThisCycle`). If the goal-priority bead count already reads 0
        // but no review ran this cycle (e.g. the Develop/Review loop was skipped
        // because there were no ready beads), dispatch one fresh review of the
        // CURRENT state here, before ever deciding to exit -- rather than either
        // silently exiting on a stale verdict nothing this cycle backs, or
        // looping forever with no way to confirm completion.
        if (openAtGoal.length === 0 && !reviewedThisCycle) {
            // The phase body lives in ./phases/re-review.mjs
            // (apra-fleet-3swo.6.8), which receives its state explicitly
            // instead of closing over runSprintCycle's locals. The `if` above
            // stays here: it is built from Cycle Evaluation's own freshly-read
            // counts, and the stillOpenVerifyIds exit gate below belongs to
            // Cycle Evaluation, not to this phase. rejectedNewTasks is pushed
            // to in place exactly as the closure did; the three genuinely
            // reassigned values come back.
            ({ lastReviewVerdict, reviewedThisCycle, pendingRejectedNewTasks } = await runReReviewPhase({
                phase, log, command,
                cycle, validated, targetIssues, orchestratorMember,
                gitSync,
                rejectedNewTasks,
                lastReviewVerdict, reviewedThisCycle, pendingRejectedNewTasks,
                dispatchReview, bdListScoped, goalMax, recordReopen,
                childIdAllocator, sprintMutexId,
                computeChildFloor, createChildBeadWithAllocatedId,
                trackRejectedNewTaskForResurfacing, clearResubmittedNewTask,
            }));
        }

        // apra-fleet-jfo.2: verify-routed beads are decomposed parents, so
        // `openAtGoal` above (post-filtered via decomposedParentIds()) never
        // includes them no matter their status -- a cycle where Deploy fails
        // (skipping IntegTest entirely, so no verify-routed bead ever gets a
        // chance to close) can therefore still read `openAtGoal.length === 0`
        // and exit here with those beads never actually re-verified. Check
        // their live status independently before allowing the count-based
        // exit to fire. Guarded on `verifyEverIds.size > 0` so a sprint that
        // never routed any bead to verify (the common case) pays no extra
        // `bd list` dispatch here at all. Uses a fresh scoped closed-list
        // (apra-fleet-66u.2), not fetchAllBeadsShared()'s cache, which can be
        // stale here for the same reason noted at the closedBeadsNow read
        // above -- this check runs after the Re-Review block may have pushed
        // further mutations this cycle.
        let stillOpenVerifyIds = [];
        if (verifyEverIds.size > 0) {
            const closedIdsForExitCheck = new Set((await bdListScoped('--status=closed --json')).map((b) => b.id));
            stillOpenVerifyIds = [...verifyEverIds].filter((id) => !closedIdsForExitCheck.has(id));
        }

        if (openAtGoal.length === 0 && lastReviewVerdict === 'APPROVED' && stillOpenVerifyIds.length === 0) {
            log(`Goal priority ${validated.goal} (<=${goalMax}) satisfied: 0 open bead(s) in scope and last reviewer verdict was APPROVED. Exiting cycle loop.`);
            endGroup();
            break;
        }

        log(
            `Cycle ${cycle} evaluation: ${openAtGoal.length} bead(s) still open at/above goal priority ${goalMax}, ` +
            `last reviewer verdict: ${lastReviewVerdict ?? '(none this cycle)'}` +
            (stillOpenVerifyIds.length > 0
                ? `, ${stillOpenVerifyIds.length} verify-routed bead(s) still open and unverified ` +
                  `(${stillOpenVerifyIds.join(', ')}) -- not exiting on goal-priority count alone until these ` +
                  `close or a future cycle's IntegTest genuinely attempts them`
                : '') +
            `. Continuing.`
        );

        cycle++;
        endGroup();
    }

    // When the loop exits because `cycle` exceeded MAX_CYCLES (rather than via
    // an early `break`), `cycle` is MAX_CYCLES + 1 at this point; the labels
    // below must report the last cycle actually run.
    const finalCycleLabel = Math.min(cycle, MAX_CYCLES);

    // =======================
    // 6. Finalization: the evidence-based final verdict drives the return value
    // =======================
    group('Finalization');
    // The phase body lives in ./phases/final-review.mjs (apra-fleet-3swo.6.6),
    // which receives its state explicitly instead of closing over
    // runSprintCycle's locals. The group('Finalization') banner above stays
    // here: it wraps Finalization as a WHOLE -- this phase, Regression Test,
    // Harvest and Publish PR -- not this phase alone. rejectedNewTasks is
    // pushed to in place exactly as the closure did; the sprint verdict and the
    // two closing counts the analysis doc renders come back. The Regression
    // Test phase call site below is placed AFTER this line by
    // test/regression-phase-never-gates.test.mjs's ordering pin, not because
    // returning finalVerdictResult here enforces it -- phases/regression-test.mjs
    // never names finalVerdictResult, so a hoist above this line would not
    // throw (apra-fleet-3swo.38). This return documents the intended order for
    // a reader; the test pin plus the A/B mock sprint in
    // mock-sprint-regression-failure-never-gates.test.mjs are what actually
    // hold the line.
    const { finalVerdictResult, finalClosedCount, finalOpenAtGoalCount } = await runFinalReviewPhase({
        phase, log, command, dispatchCtx,
        args, validated, targetIssues, orchestratorMember, finalCycleLabel, sprintState,
        gitSync,
        deployFailures, integFailures, rejectedNewTasks, verifyEverIds,
        bdListScoped, decomposedParentIds, goalMax, NOT_DONE_STATUSES,
        kbPriming, kbWork, getMemberForRole,
        childIdAllocator, sprintMutexId, resolveSettleShell,
        computeChildFloor, createChildBeadWithAllocatedId, sanitizePrText,
    });

    // =======================
    // 6b. Regression Test (once per sprint, informational -- never a gate)
    // =======================
    //
    // Sits deliberately BETWEEN Final Review and Harvest.
    //
    // After Final Review, because `finalVerdictResult` is already computed by
    // the time this runs -- so a regression failure structurally CANNOT
    // perturb the sprint's verdict. No LLM-trusted "please ignore this"
    // instruction is needed; the ordering is the guarantee.
    //
    // Before Harvest, because the harvester writes
    // docs/sprint-analysis-<slug>.md and this phase's summary is folded into
    // that document (informational section, see buildAnalysisText).
    //
    // This is the sprint's standing confidence check: it proves EXISTING
    // functionality still works, which is why it runs once per sprint rather
    // than once per cycle, and why its failures are filed as STANDALONE,
    // PARENT-LESS `[regression][carry-over]` beads. `bdListScoped()` builds
    // the sprint's scope tree by walking `.parent` edges only, so a
    // parent-less bead is mechanically invisible to `openAtGoal` /
    // `finalOpenAtGoal` -- a regression failure therefore carries over to a
    // future sprint (the planner discovers them with `bd search
    // "[carry-over]"`) instead of retroactively blocking the sprint that
    // happened to find it.
    //
    // No deployedSha handoff: part 1 runs against branch HEAD directly and
    // part 2 provisions its own fresh sandbox install, so neither depends on
    // the per-cycle Deploy target.
    let regressionResult = null;
    const hasRegressionPlaybook = await probeFileExists('regression-test-playbook.md', getMemberForRole('regression-test-runner'));
    if (hasRegressionPlaybook) {
        // The phase body lives in ./phases/regression-test.mjs
        // (apra-fleet-3swo.6.6). The probeFileExists call that produces
        // hasRegressionPlaybook, the `let regressionResult = null` default and
        // the "Skipping Regression Test Phase" else below all stay here,
        // exactly as ./deploy.mjs's deploy.md probe and ./integ-test.mjs's
        // runbook probes did. finalVerdictResult is already computed above --
        // that ordering, not a flag or an LLM instruction, is what makes this
        // phase structurally unable to gate the sprint.
        ({ regressionResult } = await runRegressionTestPhase({
            phase, log, dispatchCtx,
            finalCycleLabel, sprintSelfIdLine,
            regressionResult,
            getMemberForRole, ensureUnattendedAuto, ensureDeployPermissions, updateDashboard,
        }));
    } else {
        log('Skipping Regression Test Phase (no regression-test-playbook.md found, or the probe itself failed -- see prior log line)');
    }

    // The phase body lives in ./phases/harvest.mjs (apra-fleet-3swo.6.9). It
    // returns nothing: the sprint-analysis document, the changelog/docs commits
    // and the issue deferrals are all written by the DISPATCHED harvester in
    // its own repo, and the 'harvester' policy row's pushCode/pushBeads bracket
    // publishes them -- so no later phase reads a value from it. It must
    // nonetheless run HERE, after Regression Test (whose summary it folds into
    // the analysis document) and before Publish PR (which pushes the branch the
    // harvester just committed to).
    await runHarvestPhase({
        phase, log, dispatchCtx,
        validated, targetIssues, finalCycleLabel, budget,
        closedCountHistory, highWaterClosedCount,
        deployFailures, integFailures, rejectedNewTasks,
        integTestRunnerSpend, integTestRunnerDispatchCount,
        finalVerdictResult, finalClosedCount, finalOpenAtGoalCount, regressionResult,
        computeBranchSlug, buildAnalysisText, buildCostAnalysis,
    });

    // =======================
    // 7. Publish: push the sprint branch and raise (but do NOT merge) a PR
    // =======================
    // Per the pm skill's R12 rule (never auto-merge), this only pushes and
    // opens the PR -- a human (or a later, explicitly-scoped issue) must
    // review and merge it.
    // The phase body lives in ./phases/publish-pr.mjs (apra-fleet-3swo.6.9).
    // It returns only `pushed` -- whether the sprint branch actually reached
    // the remote -- and BOTH return objects below are built here, because
    // runSprintCycle's return value is the function's own contract. A push
    // that never went through returns pushed:false having deliberately skipped
    // PR creation and target-issue closure (neither is meaningful for an
    // unpushed branch) while PRESERVING the sprint's own computed verdict; a
    // genuine PR-creation failure still throws a typed CommandError out of the
    // phase, before the endGroup() below, exactly as the inline version did.
    const { pushed } = await runPublishPrPhase({
        phase, log, command,
        args, validated, targetIssues, orchestratorMember, finalCycleLabel,
        gitSync, getMemberForRole,
        finalVerdictResult,
        sanitizePrText,
    });

    endGroup();

    // The final verdict -- not a blanket, unconditional 'success' -- drives the
    // return value, so a downstream caller (CLI, CI, a human reading the run)
    // can tell a genuinely-passing sprint from one that ran to completion but
    // left goal-priority work open, a deploy failing, or integration tests red.
    // `pushed` comes from the Publish PR phase above and is the ONLY thing it
    // contributes here: a failed branch push reports pushed:false, and the
    // verdict it is reported alongside is still the sprint's own computed one.
    return {
        status: finalVerdictResult.verdict === 'PASS' ? 'success' : 'failed',
        verdict: finalVerdictResult.verdict,
        notes: finalVerdictResult.notes,
        branch: validated.branch,
        baseBranch: validated.baseBranch,
        goal: validated.goal,
        maxCycles: validated.maxCycles,
        pushed,
    };
}

// ---------------------------------------------------------------------------
// Fatal-diagnostics guard
// ---------------------------------------------------------------------------
//
// main()'s try/catch around runSprintCycle() only ever sees errors that
// propagate up an AWAITED call chain: it can never see a promise that rejects
// with nothing awaiting it, or a synchronous throw that escapes every awaited
// frame. Without this guard such a failure ends the run with no usable signal.
// The guard makes it observable: an explicit [FATAL] line (cause + the last
// phase this run entered) through the run's own log(), plus a best-effort
// publishState('terminal', ...) so a watchdog, dashboard, or human sees a real
// lastError instead of state frozen mid-run with no explanation.
//
// It deliberately does not attempt to recover or continue -- by the time either
// process-level event fires the process's control flow is in an unspecified
// state.
/**
 * @param {{ log?: (msg: string) => void, publishState?: (namespace: string, data: any) => void, phaseOf?: () => string|null }} deps
 * @returns {() => void} uninstall() -- removes both listeners.
 */
export function installFatalDiagnosticsGuard(deps = {}) {
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const publishState = typeof deps.publishState === 'function' ? deps.publishState : null;
    const phaseOf = typeof deps.phaseOf === 'function' ? deps.phaseOf : () => null;

    const handle = (kind) => (err) => {
        const message = (err && err.message) || String(err);
        const stack = (err && err.stack) || null;
        const phase = phaseOf();
        log(`[FATAL] ${kind} (last known phase: ${phase ?? 'unknown'}): ${message}${stack ? `\n${stack}` : ''}`);
        if (publishState) {
            try {
                publishState('terminal', {
                    verdict: 'ABORTED',
                    failed: true,
                    terminalReason: kind,
                    lastError: { message, stack, phase, kind, at: new Date().toISOString() },
                });
            } catch (publishErr) {
                // Diagnostics reporting itself must never crash harder than the
                // failure it is trying to record -- log and move on.
                log(`[FATAL] ${kind}: failed to persist terminal error state: ${(publishErr && publishErr.message) || publishErr}`);
            }
        }
    };

    const onUnhandledRejection = handle('unhandledRejection');
    const onUncaughtException = handle('uncaughtException');
    process.on('unhandledRejection', onUnhandledRejection);
    process.on('uncaughtException', onUncaughtException);

    return function uninstall() {
        process.off('unhandledRejection', onUnhandledRejection);
        process.off('uncaughtException', onUncaughtException);
    };
}

// ---------------------------------------------------------------------------
// Classify an unmergeable Dolt conflict as its own terminal state
// (BEADS_SYNC_CONFLICT), not the generic wrapper/UNKNOWN bucket -- and
// best-effort carry forward the raw conflict diagnostics an operator would
// otherwise have to re-derive by hand.
// ---------------------------------------------------------------------------

/**
 * Walks a thrown error's `.cause` chain (bounded, so a pathological circular
 * cause can never loop forever) looking for a DoltDivergedError -- either
 * the error itself, or wrapped one level down inside a PostDispatchSyncError
 * (withGitSync's post-dispatch D-push bracket wraps a diverged sync failure
 * this way; see PostDispatchSyncError's own doc comment in errors.mjs). A
 * plain `bd dolt pull` divergence (preflightBeadsHealthGate / doltPullBefore,
 * before any dispatch ever ran) throws DoltDivergedError directly, with no
 * wrapper -- also matched here.
 * @param {unknown} err
 * @returns {import('./errors.mjs').DoltDivergedError|null}
 */
export function findDoltDivergedCause(err) {
    let cur = err;
    for (let depth = 0; cur && depth < 5; depth += 1) {
        if (cur instanceof DoltDivergedError) return cur;
        cur = cur.cause;
    }
    return null;
}

/**
 * The terminal-state `terminalReason` main()'s typed-abort catch persists. A
 * genuinely unmergeable Dolt conflict -- surfaced either directly (a
 * pre-dispatch `bd dolt pull` divergence) or wrapped inside a
 * PostDispatchSyncError (a D-push divergence discovered AFTER a dispatch
 * already completed) -- is reported as the distinct 'BEADS_SYNC_CONFLICT', so
 * the supervisor/dashboard shows "beads sync conflict, needs operator
 * resolution" instead of collapsing it into the same generic bucket as every
 * other termination reason. Every other error keeps the
 * `err.code || err.name || 'UNKNOWN_ABORT'` behavior.
 * @param {unknown} err
 * @returns {string}
 */
export function resolveTerminalReason(err) {
    if (findDoltDivergedCause(err)) return 'BEADS_SYNC_CONFLICT';
    return (err && (err.code || err.name)) || 'UNKNOWN_ABORT';
}

/**
 * Best-effort diagnostics for a BEADS_SYNC_CONFLICT terminal state -- the raw
 * `bd dolt pull`/`bd dolt push` stderr
 * (DoltDivergedError.doltOutput) that proved the divergence, captured at the
 * moment `runDoltStep()` observed the failure (i.e. BEFORE any later `bd`
 * invocation's own safe-abort/cleanup could discard whatever state it was
 * describing) and carried on the error object ever since. This is pure
 * plumbing of already-captured data through to the terminal state -- no new
 * `bd`/SQL command is issued here -- so a human resolving the conflict later
 * starts with the actual rejection text in hand instead of having to
 * reproduce it by re-running `bd dolt pull`/`dolt merge --no-commit`
 * themselves. Returns `null` (never throws) when `err` carries no
 * DoltDivergedError cause.
 * @param {unknown} err
 * @returns {{ member: string|null, operation: string|null, doltOutput: string|null }|null}
 */
export function captureDoltConflictDump(err) {
    const diverged = findDoltDivergedCause(err);
    if (!diverged) return null;
    return {
        member: diverged.member ?? null,
        operation: diverged.operation ?? null,
        doltOutput: diverged.doltOutput ?? null,
    };
}

// ---------------------------------------------------------------------------
// Engine entry point + typed-abort routing
// ---------------------------------------------------------------------------
//
// `main()` is the WorkflowEngine entry point: it runs the sprint and routes a
// failure through TWO independent decisions (see isTerminalSprintFailure() vs
// isTypedAbortError() above for why they are not the same question):
//   - isTerminalSprintFailure(): write a terminal history record, so the
//     supervisor watchdog reports the run as FINISHED-with-a-reason rather
//     than CRASHED;
//   - isTypedAbortError(): additionally route through finalizeAbort() (push +
//     idempotent [ABORTED] PR iff the branch carries real work beyond base).
// Re-throwing (rather than swallowing) is deliberate: it keeps
// bin/cli.mjs's top-level catch -- console.error, exit code 1, and the
// dashboard grace window -- unchanged; this function only adds work that
// happens BEFORE the error reaches that catch.
//
// A non-terminal error (isTerminalSprintFailure() === false: CancelledError
// from a cooperative /stop, or an untyped Error/TypeError -- a real bug) is
// re-thrown immediately with no finalizeAbort()/history-record side effects.
export async function main(context) {
    const { command, log = () => {}, publishState, phase: rawPhase, args } = context;

    // Validate args and acquire a machine-local pidfile lock keyed on
    // (branch, members) BEFORE any dispatch -- a duplicate concurrent engine
    // start for the SAME sprint must fail fast with a named
    // SprintLockHeldError instead of silently running two engines against
    // the same shared git branch/beads DB. validateArgs() is pure, so
    // running it here ahead of runSprintCycle()'s own call changes nothing
    // for invalid args except failing one call frame higher.
    const validatedForLock = validateArgs(args);
    const sprintLock = acquireSprintLock({ branch: validatedForLock.branch, members: validatedForLock.members });

    // apra-fleet-5d5.1: the SAME reactive git/dolt credential self-heal
    // callback runSprintCycle wires into every withGitSync bracket (see its
    // own onAuthFailure precedence comment above) -- computed here too so
    // finalizeAbort()'s own git ops (fetch/rev-list/push, ~line 4562) get the
    // identical provision_vcs_auth self-heal-and-retry-once treatment instead
    // of silently swallowing a mid-abort auth failure with no self-heal.
    //   1. `context.onAuthFailure` -- an explicitly-injected callback (tests
    //      wire an in-process one to prove the self-heal fires without a live
    //      fleet server).
    //   2. `args.callTool` -- the real provision_vcs_auth self-heal via
    //      createVcsAuthSelfHealCallback.
    //   3. neither -- undefined: an 'auth'-classified failure falls straight
    //      through to finalizeAbort()'s existing throw-and-fall-back path.
    const abortOnAuthFailure = context.onAuthFailure ?? (
        (args && typeof args.callTool === 'function')
            ? createVcsAuthSelfHealCallback({ callTool: args.callTool, command, log, azdevopsPatSecretName: validatedForLock.azdevopsPatSecretName })
            : undefined
    );

    // Track the last phase this run entered by wrapping context.phase, so a
    // fatal diagnostic can name the phase instead of just "somewhere".
    let lastPhaseTitle = null;
    const phase = typeof rawPhase === 'function'
        ? (title) => { lastPhaseTitle = title; return rawPhase(title); }
        : rawPhase;
    const runContext = { ...context, phase };

    const uninstallFatalGuard = installFatalDiagnosticsGuard({
        log,
        publishState,
        phaseOf: () => lastPhaseTitle,
    });

    try {
        return await runSprintCycle(runContext);
    } catch (err) {
        if (!isTerminalSprintFailure(err)) {
            throw err;
        }

        // Args were already validated at entry (validatedForLock), so the
        // branch/baseBranch/member for the abort record are always
        // resolvable; only finalizeAbort() itself can still fail here.
        const branch = validatedForLock.branch;
        const baseBranch = validatedForLock.baseBranch;
        let abortResult = { prUrl: null, pushed: false, commitCount: 0 };
        // Only a typed sprint ABORT earns the branch push + [ABORTED] PR. The
        // discriminator is RECOVERABILITY, not whether there is work to show
        // (finalizeAbort already publishes nothing at zero commits beyond
        // base): a dispatch failure or a sync failure that outlived its retries
        // is fixed by re-running the sprint, which pushes any local work then,
        // whereas a stall / budget / reviewer-contract / unmergeable-divergence
        // abort will never self-resolve, so the [ABORTED] PR is the only
        // artifact a human gets. Both still get the terminal record below --
        // the watchdog needs a reason either way.
        if (isTypedAbortError(err)) {
            try {
                // apra-fleet: finalizeAbort() runs `git fetch`/`git push` against
                // this member's LOCAL checkout, which the orchestrator role no
                // longer has (it may be a shared/unreservable, git-less member --
                // see docs/design-orchestrator-worktree-model-v2.md section 4.5).
                // Resolve a git-capable DISPATCH member instead: the harvester's
                // member (the last code-writing role, so its clone pushed most
                // recently), falling back to the first doer, never
                // roleMap.orchestrator and never a bare validatedForLock.members[0]
                // pick (that silent pick is the original bug this closes).
                const roleMap = validatedForLock.roleMap;
                const harvesterMembers = (roleMap && Array.isArray(roleMap['harvester'])) ? roleMap['harvester'] : [];
                const doerMembers = (roleMap && Array.isArray(roleMap[ROLE_DOER])) ? roleMap[ROLE_DOER] : [];
                const member = harvesterMembers[0]
                    ?? doerMembers[0]
                    ?? validatedForLock.members.find((m) => !roleMap || !roleMap[ROLE_ORCHESTRATOR] || !roleMap[ROLE_ORCHESTRATOR].includes(m));
                if (!member) {
                    log('[Terminal History] finalizeAbort() skipped: no harvester/doer/dispatch member could be resolved to push the aborted branch.');
                    throw new Error('no git-capable member resolved for finalizeAbort');
                }
                abortResult = await finalizeAbort({
                    error: err,
                    branch,
                    baseBranch,
                    member,
                    command,
                    log,
                    onAuthFailure: abortOnAuthFailure,
                    callTool: (args && typeof args.callTool === 'function') ? args.callTool : undefined,
                });
            } catch (finalizeErr) {
                log(
                    `[Terminal History] finalizeAbort() failed for this abort ` +
                    `(${finalizeErr.message}); writing the terminal history record with no PR lookup.`
                );
            }
        }

        // Always write a terminal history record, even for a zero-commit
        // abort (only the PR itself is conditional on there being real work
        // to publish).
        if (typeof publishState === 'function') {
            // An unmergeable Dolt conflict is reported as its own distinct
            // BEADS_SYNC_CONFLICT terminal state (not the generic
            // wrapper/UNKNOWN bucket), with the raw conflict diagnostics already
            // captured on the error carried alongside it so an operator
            // resolving it starts with the actual rejection text in hand -- see
            // resolveTerminalReason()/captureDoltConflictDump() above.
            const conflictDump = captureDoltConflictDump(err);
            publishState('terminal', {
                verdict: 'ABORTED',
                terminalReason: resolveTerminalReason(err),
                message: (err && err.message) || null,
                branch,
                baseBranch,
                prUrl: abortResult.prUrl,
                pushed: abortResult.pushed,
                commitCount: abortResult.commitCount,
                ...(conflictDump ? { conflictDump } : {}),
            });
        }

        throw err;
    } finally {
        uninstallFatalGuard();
        // Always release the sprint lock, on every exit path (success, typed
        // abort, or an untyped re-thrown error) -- a lock never released here
        // would falsely block every future launch of this exact sprint
        // (branch+members) until acquireSprintLock()'s own dead-pid reclaim
        // kicks in on a LATER attempt.
        sprintLock.release();
    }
}
