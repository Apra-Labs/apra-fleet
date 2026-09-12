import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'node:fs';
import os from 'node:os';
import { checkPath, checkModules, findCallSites, extractBalancedCall } from '../fleet-sprint/dispatch-safety-guard.mjs';
import { GUARDED_MODULES, guardedModulePaths, guardedModuleBasenames } from '../fleet-sprint/guarded-modules.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// apra-fleet-eft.3.1 (Plan Part 1.6) -- Dispatch-safety guard test.
//
// Invariant under test: EVERY `command(` / `agent(` call site in
// packages/apra-fleet-se/fleet-sprint/runner.js must supply an explicit
// `member_name` (or `member_id`) in its options object. The workflow engine
// throws if neither is supplied, with no local-execution/"ambient member"
// fallback -- this test locks that invariant in at the source level so a
// future edit cannot silently introduce a call site that omits it (which
// would only surface at runtime, on a real fleet dispatch, in whatever
// heterogeneous-member topology happens to be running that day).
//
// This is a real (bracket-aware) call-site parse, not a naive line grep:
// each `command(`/`agent(` token is paired with its matching closing paren
// (skipping over string/template-literal contents so parens embedded in a
// shell command string, e.g. `${beadIds.join(' ')}`, can never be
// mis-attributed as call-site punctuation), and the resulting call-site
// text is checked for `member_name`/`member_id`. Full-line comments (a line
// whose trimmed text starts with `//` or `*`, i.e. JSDoc/line-comment
// bodies) are skipped so comments that merely MENTION `command()`/`agent()`
// prose-style (there are many in runner.js) are never counted as call
// sites.
//
// Baseline (verified against current HEAD by manual review of every site
// this parser finds, packages/apra-fleet-se/fleet-sprint/runner.js as of
// apra-fleet-eft.3.1): 20 command() call sites and 9 agent() call sites,
// all 29 compliant. (The parent feature's description cites an earlier
// "12 command() / 9 agent()" audit figure; the file has grown call sites
// since that audit was written, e.g. finalizeAbort()'s two command() sites
// and bdListScoped()'s two command() sites. This test asserts the CURRENT,
// re-verified count so it passes on current HEAD, per its own acceptance
// criteria -- an out-of-date fixed number would defeat the test's purpose
// of catching real drift.) If this test's baseline counts need to change,
// that is a deliberate, reviewable signal: either a call site was added
// (bump the count, after confirming member_name/member_id is present) or
// one was silently dropped (an actual regression -- do NOT just bump the
// count without checking why).
//
// apra-fleet-eft.3.3: the checker itself (findCallSites/checkPath) now lives
// in ../fleet-sprint/dispatch-safety-guard.mjs, exported and parameterizable
// by file path, so it can be pointed at a fixture that deliberately violates
// the invariant -- proving the guard actually fails on a non-compliant call
// site rather than vacuously passing -- WITHOUT mutating runner.js to
// manufacture that failure case. See the fixture-driven tests below, which
// exercise test/fixtures/dispatch-safety/{non-compliant,member-id-only}.mjs.
// =============================================================================

const RUNNER_PATH = path.join(__dirname, '../fleet-sprint/runner.js');
// The dispatchRole engine: since apra-fleet-3swo.5.7 the ONLY module in the
// dispatch-ladder set that makes an agent() call at all.
const DISPATCH_ROLE_PATH = path.join(__dirname, '../fleet-sprint/dispatch-role.mjs');
// Branch-split convention (established when the three auto-sprint
// stabilization fixes -- auto-sprint-9's branch-adopt fix, auto-sprint-3's
// bdListScoped rewrite, and the failSoft-discrimination follow-up -- were
// moved to feat/fleet-reorg and this branch was rebased on top of it):
// feat/fleet-reorg carries only those stabilization fixes and has NO
// eft-feature-specific runner.js additions, so ITS copy of this test asserts
// 18 command() sites. THIS branch (auto-sprint/eft-service) additionally
// carries eft-feature work (e.g. finalizeAbort()'s two dispatch sites,
// supervisor-skeleton additions) on top of that same base. Do not resolve a
// future count mismatch between the two branches by just copying one
// branch's number into the other -- confirm which commits actually
// introduced the delta first.
//
// Bumped 21 -> 22 (2026-07-18): commit 6d348f1a (apra-fleet-eft.8.1,
// syncMemberBefore/syncMemberAfter G-pull/G-push helpers) added exactly one
// new real command() call site (the injected `command(cmd, { member_name:
// member, ... })` inside runGitStep()), verified compliant. That commit's
// two `throw new Error("... requires an injected command() in opts")`
// lines are NOT call sites -- they were a false-positive in this test's own
// parser (the literal text "command()" inside a plain string), fixed here
// via isInsideSameLineString().
// Bumped 22 -> 25 (2026-07-18, apra-fleet-eft.9.1 + eft.8.x sync helpers):
// three new real command() call sites, each verified to carry an explicit
// member_name (3.2): (1) runDoltStep()'s injected `command(cmd, { member_name:
// member, silent: true, failSoft: true, label })` -- the single site every
// D-pull/D-push bracket funnels through; (2) verifyDoerStreakClosed()'s
// post-D-pull `command(label, { member_name: orchestratorMember, silent:
// true })` verification read; and (3) the syncMemberAfter clean-state restore
// `command('git rebase --abort', { member_name: member, ... })` /
// `command('git status --porcelain', { member_name: member, ... })` pair
// (these two land on adjacent lines but the parser counts them as the two
// distinct call sites they are). The `throw new Error("... requires an
// injected command() in opts")` lines added alongside the dolt helpers are,
// as before, string-literal false positives excluded by
// isInsideSameLineString(), not call sites.
// Bumped 25 -> 26 (2026-07-19): finalizeAbort() gained a `git fetch origin
// ${baseBranch}` command() site (member_name: member) so its subsequent
// `git rev-list --count origin/${baseBranch}..${branch}` diffs against a
// remote-tracking ref instead of assuming `baseBranch` is a resolvable
// LOCAL ref on the abort-path member -- a real abort hit exit 128 ("unknown
// revision") when the member never had that base branch checked out
// locally under that exact name, verified compliant.
// 26 -> 28: Ensure Sprint Branch gained a dirty-tree recovery path
// (stabilization log Issue 11) -- one `git stash push -u` site and one
// post-stash checkout retry site, both with explicit member_name. The
// happy path issues neither.
// 28 -> 29 (apra-fleet-eft.9.7): per-bead work-claiming inside the D-pull/
// D-push brackets gained one new `command(claimLabel, { member_name:
// orchestratorMember, silent: true })` call site (the `bd update <id>
// --claim` issued per bead before a doer streak dispatch), verified
// compliant.
// 29 -> 28 (apra-fleet-eft.8.12, git conflict ladder Tier 2): the Tier 1
// scripted detect-and-abort helper (detectAndAbortRebaseConflict, with its
// `git rebase --abort` and post-abort `git status --porcelain` command()
// pair) moved out of runner.js entirely into ./conflict-ladder.mjs (-2 real
// sites from THIS file's count -- conflict-ladder.mjs is outside
// RUNNER_PATH's scan scope, not a regression); runner.js gained exactly one
// new real command() site in its place, the Tier 2 post-resolution
// clean-state check `command('git status --porcelain', { member_name:
// member, silent: true, failSoft: true, label })` inside syncMemberAfter
// (+1), net -1. Verified compliant (explicit member_name).
// 28 -> 29 (apra-fleet-eft.30.2, neutralized-sandbox D-push defense-in-depth):
// isMemberSyncRemoteConfigured gained one new `command('bd config get
// sync.remote --json', { member_name: member, silent: true, failSoft: true
// })` call site, used by doltPushAfter to consult a member's bd-level
// sync.remote setting before treating a non-diverged push failure as fatal.
// Verified compliant (explicit member_name).
// 29 -> 30 (apra-fleet-eft.55.2, part-2 SHA freshness): getDeployedSha
// gained one new `command('git rev-parse HEAD', { member_name:
// orchestratorMember, silent: true, label: ..., failSoft: true })` call
// site, used to resolve this cycle's deploy-verified SHA right after a
// successful deploy, for the Integ Test dispatch/validation below. Verified
// compliant (explicit member_name).
// 30 -> 31 (apra-fleet-eft.58.1, pre-flight beads-health gate): on a
// detected divergence, preflightBeadsHealthGate() issues one new best-effort
// `command('pwd', { member_name: member, silent: true, failSoft: true,
// label: ... })` call site to resolve the workspace path for its one-line
// cause message. Only ever dispatched on the (rare) divergence path.
// Verified compliant (explicit member_name).
// 31 -> 32 (apra-fleet-eft.56.1, newTask notes-fallback): a residual
// validateNewTask() rejection must never simply vanish (see eft.56) --
// appendRejectedFindingToParentNotes() gained one new
// `command('bd note ${parentId} --file "${noteFile}"', { member_name:
// member, silent: true, label: ... })` call site that persists the raw
// finding verbatim to the parent bead's notes. Only ever dispatched on a
// residual (non-fatal) rejection. Verified compliant (explicit
// member_name). createChildBeadWithAllocatedId()'s existing `bd create`
// call site is unchanged in COUNT (its `-d "${description}"` interpolation
// became `--body-file "${descriptionFile}"`, same single call site).
// 32 -> 34 (apra-fleet-eft.64.1): the Publish PR step gained two new
// command() call sites -- `git remote get-url origin` (resolving/
// classifying the sprint's git remote via isHostedGithubRemote() before
// deciding whether to attempt `gh pr create`) and `bd close ${id}` (closing
// the target issue directly on the non-hosted-remote path); both pass
// member_name: orchestratorMember, verified compliant.
// 34 -> 36 (apra-fleet-eft.72.1): plan-cap exhaustion confined to specific
// beads now defers those beads instead of aborting the whole run -- two new
// command() call sites, `bd update ${id} --status=deferred` and
// `bd note ${id} --file "${noteFile}"` (attaching the plan-reviewer's
// finding), both inside the Plan phase's new deferral loop. This is a plain
// orchestrator-side bd mutation, not a new agent() dispatch -- EXPECTED_AGENT_COUNT
// below is unchanged. Both new sites pass member_name: orchestratorMember,
// verified compliant.
// 36 -> 37 (apra-fleet-eft.73.1): the host-agnostic body transport centralizes
// member-side body staging in stageCommandBodyMemberSide(), which adds exactly
// ONE new command() call site -- the `node -e "..." "<base64>"` dispatch that
// writes the body to a member-LOCAL temp file (member_name: member/
// orchestratorMember, verified compliant). The three call sites that used to
// write the body on the orchestrator host (createChildBeadWithAllocatedId's
// `bd create --body-file`, appendRejectedFindingToParentNotes' `bd note
// --file`, and the plan-cap deferral `bd note --file`) each keep their SAME
// single bd command() site -- only the file's provenance moved host -> member
// -- so the net change is +1, not +3.
// 37 -> 38 (apra-fleet-9te.4.1): Ensure Sprint Branch gained a new
// `git rev-parse --verify --quiet refs/heads/<branch>` probe, dispatched only
// when the origin fetch reports the remote ref is missing, to detect a
// pre-existing local-only branch before deciding whether to reuse it as-is
// or reset it to base -- member_name: member confirmed present.
// 39 -> 41 (apra-fleet-co4): Ensure Sprint Branch gained two new
// `git merge-base --is-ancestor` probes (one per direction), dispatched only
// when the origin fetch succeeds AND a local branch of that name already
// exists, to detect whether the local branch has committed-but-unpushed work
// ahead of origin before ever resetting it -- fixes a confirmed live
// data-loss incident where a successful fetch was wrongly treated as always
// safe to reset over. Both new sites pass member_name: member, confirmed
// present.
// 41 -> 40 (integ/regression split): getDeployedSha()'s `command('git
// rev-parse HEAD', { member_name: orchestratorMember, ... })` site was
// REMOVED. It existed only to prove the Integ Test phase's part-2 (smoke
// test) evidence was fresh; the smoke test moved to the once-per-sprint
// Regression Test phase, which provisions its own sandbox and has no
// deployed SHA to attest against, so the probe had no remaining consumer.
// The new Regression Test phase adds NO new command() site -- it reuses the
// existing probeFileExists() helper.
// 41 -> 42 (apra-fleet-xuo.4): the Plan phase gained a new
// `bd list --parent <parentId> --json` command() call site, dispatched once
// per target issue after a planner round when pendingRejectedNewTasks is
// non-empty, to reconcile the pending resurface list against beads actually
// created under the parent since the rejection (title-independent, matched
// on description) -- member_name: orchestratorMember confirmed present.
// 42 -> 43 (apra-fleet-xuo.7.1): createChildBeadWithAllocatedId() gained a
// `bd update <childId> --parent <parentId>` command() call site, dispatched
// only on the explicit-allocated-id path immediately after the `bd create`
// -- bd rejects `--id` and `--parent` on the same create ("cannot specify
// both --id and --parent flags"), so the parent edge is now recorded by this
// separate update. It passes member_name: member (the same member the create
// itself is dispatched to), confirmed present.
// Merge note (integ/regression split branch + fleet-sprint-stabilization
// branch, both forked from the same 41-baseline): applying BOTH sides'
// independent deltas -- the integ/regression split's -1 (getDeployedSha
// removed) and fleet-sprint-stabilization's +2 (the two xuo.4/xuo.7.1 sites
// above) -- nets to 41 - 1 + 2 = 42. Verified against the merged runner.js
// by running this test after resolving the merge (see the actual/expected
// mismatch it reports if this arithmetic is ever wrong).
// 43 -> 45 (apra-fleet-jfo, 64dc595): the verify-route/phase-routing slice
// added two command() sites (`bd show <bugId> --json` and its follow-up),
// both member_name: orchestratorMember -- the constant was bumped without a
// note at the time; recorded here for the audit trail.
// apra-fleet-5d5.1: finalizeAbort()'s three direct `command()` call sites for
// `git fetch origin`, `git rev-list --count`, and `git push -u origin` were
// replaced with `runGitStep({ command, member, cmd, label, log,
// maxTransientRetries, onAuthFailure })` calls (each still passing `member:
// member`, i.e. `member_name` once inside runGitStep's own single
// `command(cmd, { member_name: member, ... })` site, which already existed
// and is unchanged/still counted) so a git-auth failure here gets the same
// provision_vcs_auth self-heal-and-retry-once as the main withGitSync
// dispatch bracket. Net -3 direct call sites in finalizeAbort, not a
// member_name regression -- runGitStep is itself already compliant.
// apra-fleet-6bu was going to add +1 (a failSoft `git remote get-url origin`
// probe for a server-side `create_pull_request` path) but that whole path
// was reverted (apra-fleet-tfx.5/tfx.6) before landing here, so it nets 0.
// Merge of fix/dispatch-stall-reliability-v2 (5d5.1/6a7) with
// fix/vcs-pr-architecture-v2 (tfx revert): value re-verified by running this
// test against the merged runner.js rather than derived by arithmetic, per
// this test's own acceptance criteria (see comment above).
// 41 -> 40 (apra-fleet-eft.89.2): updateDashboard()'s project-wide backlog
// fetch (`bd list --status=${BACKLOG_STATUSES} --json`) was removed -- the
// per-sprint fleet-sprint viewer now shows sprint progress only, backlog
// exploration is the supervisor UX's job. Net -1 command() call site.
// 40 -> 40 (apra-fleet-tfx.8 / tfx.8.1): the Publish PR and finalizeAbort
// call sites were re-wired off `gh pr create` onto VCSModule's REST
// create-pull-request dispatch. This REMOVED the two `gh pr create`
// command() sites (one per PR-raising path) and ADDED exactly two command()
// sites, both now consolidated in the shared raiseVcsPrForMember() helper:
// (1) readMemberVcsCredentialToken()'s read of the just-provisioned
// git-credential-helper script, and (2) the VCSModule-built `curl ... /pulls`
// dispatch itself. -2 + 2 nets ZERO, so the count stays 40 -- verified by
// running this test (and checkPath against dc1aa80~1) rather than by
// arithmetic. NOTE: the tfx.8 issue text cited 44; that was a stale
// projection that never materialized on this branch -- 40 is the actual,
// measured value and the one asserted here.
// 40 -> 37 (apra-fleet-417.2.1, the single dolt-sync module): the three dolt
// command() call sites MOVED out of runner.js into ./dolt-sync.mjs, which is
// now the only permitted `bd dolt` command surface -- (1) runDoltStep()'s
// single spawn, (2) isMemberSyncRemoteConfigured()'s `bd config get
// sync.remote --json` gate, and (3) preflightBeadsHealthGate()'s best-effort
// `pwd` diagnostic. NOT a member_name regression and NOT a silently-dropped
// dispatch: same precedent as the eft.8.12 conflict-ladder.mjs extraction
// above, except that this time the moved sites are NOT left unguarded --
// dolt-sync.mjs is asserted by its own test below, so the invariant still
// covers every one of them.
// 37 -> 38 (integration-branch merge): Final Review's reopenIds persist
// block gained one new command() call site (`bd update <id> --status=open
// --append-notes ...`), verified compliant with member_name (member_name:
// orchestratorMember).
// 38 -> 39 (apra-fleet-647.1.4.1): finalizeAbort() gained ONE new command()
// call site -- resolving 'git remote get-url origin' via VCSModule.capabilities()
// before attempting the [ABORTED] PR, the same gate the Publish PR step
// already had. It carries member_name (see finalizeAbort()'s new
// originUrlRes call), so the invariant this file checks is unaffected.
// The two bumps above are independent (different commits, different
// history) and both land in this rebase, so the deltas combine:
// 40 - 3 + 1 + 1 = 39.
// 39 -> 36 (apra-fleet-3swo.3.1, the vcs-auth.mjs extraction): the three
// VCS-auth command() call sites MOVED out of runner.js into ./vcs-auth.mjs --
// (1) provisionVcsAuthForMember()'s `git remote get-url origin` read used to
// derive the repos scope, (2) readMemberVcsCredentialToken()'s read of the
// just-provisioned git-credential-helper script, and (3) raiseVcsPrForMember()'s
// VCSModule-built create-pull-request dispatch. Move-only: no call site was
// added, removed or rewritten. Same precedent as the 417.2.1 dolt-sync.mjs
// extraction above, and likewise NOT left unguarded -- vcs-auth.mjs is asserted
// by its own test below, so all three remain covered by this invariant.
// 36 -> 34 (apra-fleet-3swo.3.6, the abort.mjs extraction): the typed
// sprint-abort predicate, the abort-path PR publish helper and the newTask
// validation/persistence helpers moved out of runner.js into ./abort.mjs,
// taking finalizeAbort()'s `git remote get-url origin` PR-capability probe and
// appendRejectedFindingToParentNotes()'s `bd note <id> --file ...` call with
// them -- the same two sites the 647.1.4.1/eft.3.1 history above already
// accounted for inside runner.js. Move-only: no call site was added, removed
// or rewritten. Same precedent as the vcs-auth.mjs extraction above, and
// likewise NOT left unguarded -- abort.mjs is asserted by its own test below.
// 34 -> 32 (apra-fleet-3swo.4.6): the shared full-DB beads snapshot and the
// scope-discovery BFS moved out of runner.js into ./beads-scope.mjs, taking
// bdListScoped()'s TWO command() call sites with them -- fetchAllBeadsShared()'s
// `bd list --all --limit 0 --json` and bdListScoped()'s filtered
// `bd list <flags> --limit 0`. Move-only: no call site was added, removed or
// rewritten (both still pass `member_name: getOrchestratorMember()`, the
// injected getter that resolves to the same orchestratorMember they used
// before). NOT left unguarded -- beads-scope.mjs is registered in
// GUARDED_MODULES, so the aggregate checkModules(guardedModulePaths()) test
// below scans both sites. Same precedent as the vcs-auth.mjs/abort.mjs
// extractions above.
// 32 -> 29 (apra-fleet-3swo.4.7): the reviewer-verdict bead transitions moved
// out of runner.js into ./beads-transitions.mjs, taking the THREE
// `bd update <id> --status=open` reopen call sites with them -- the per-round
// reviewer's, Final Review's (the --append-notes variant) and Re-Review's.
// All three now share ONE applyGuardedReopens() site, which dispatches with
// `member_name: member` (the orchestrator member each call site passes in),
// verified compliant. Not a member_name regression and not left unguarded --
// beads-transitions.mjs is registered in GUARDED_MODULES, so the aggregate
// checkModules(guardedModulePaths()) test below scans that shared site. Note
// 3 call sites collapsed to 1 in the new module, so this is -3 here and only
// +1 there; the arithmetic is deliberate, not a dropped site.
// 29 -> 18 (apra-fleet-3swo.6.2): the first two phase() boundaries were sliced
// out of runSprintCycle into ./phases/ensure-sprint-branch.mjs (EIGHT command()
// call sites -- the base fetch, the sprint-branch fetch, the local-branch
// probe, the two merge-base tip comparisons, the checkout, the orphaned-WIP
// stash and the post-stash checkout retry) and ./phases/plan.mjs (THREE -- the
// per-parent `bd list --parent` reconciliation listing and the plan-cap
// deferral's `bd update --status=deferred` plus `bd note --file`). 8 + 3 = 11,
// which is exactly 29 - 18; no site was added, removed or collapsed in the
// move. Not left unguarded: BOTH modules are registered in GUARDED_MODULES
// (as the list's first NESTED entries), so the aggregate
// checkModules(guardedModulePaths()) test below scans all eleven, and each
// module also gets its own explicit baseline count below -- same precedent as
// the vcs-auth.mjs/abort.mjs/beads-transitions.mjs extractions above.
// 18 -> 17 (apra-fleet-3swo.6.5): the Review and Deploy phase() boundaries were
// sliced out of runSprintCycle. Deploy took NO command() site (its only
// repo-side effect is the deployer dispatch's own bracket) and Review took
// exactly ONE -- the `bd show <assignedBeadIds> --json` acceptance-criteria
// read -- so this is -1, which is exactly 18 - 17; no site was added, removed
// or collapsed in the move. Review's reopen/newTask writes were already NOT
// counted here: they go through applyGuardedReopens (beads-transitions.mjs) and
// createChildBeadWithAllocatedId/computeChildFloor, whose command() sites live
// in the modules that own them. Not left unguarded: both new modules are
// registered in GUARDED_MODULES, so the aggregate
// checkModules(guardedModulePaths()) test below scans them, and each gets its
// own explicit baseline count below.
// 17 -> 15 (apra-fleet-3swo.6.8): the Integ Test and Re-Review phase()
// boundaries were sliced out of runSprintCycle. Re-Review took NO command()
// site (its reopen/newTask writes go through applyGuardedReopens
// (beads-transitions.mjs) and createChildBeadWithAllocatedId/
// computeChildFloor, whose command() sites live in the modules that own them,
// exactly as phases/review.mjs's already did) and Integ Test took exactly TWO
// -- the verify-fail bounce cap's `bd show <bugId> --json` parent lookup and
// its `bd update <parentId> --status=deferred --append-notes` deferral -- so
// this is -2, which is exactly 17 - 15; no site was added, removed or
// collapsed in the move. Not left unguarded: both new modules are registered
// in GUARDED_MODULES, so the aggregate checkModules(guardedModulePaths()) test
// below scans them, and each gets its own explicit baseline count below.
const EXPECTED_COMMAND_COUNT = 15;
// Bumped 9 -> 10 (2026-07-18): the doer max_turns-exhaustion resume path
// (dispatchDoerResume) adds one new agent() call site -- a resume-and-continue
// dispatch on the SAME session with an escalated max_turns, verified compliant
// with member_name.
// 10 -> 11: dispatchReview() gained a reviewer resume-and-continue agent()
// site (stabilization log Issue 9, mirrors the doer's dispatchDoerResume);
// member_name confirmed present via shared reviewerDispatchOpts.
// 11 -> 12 (stabilization log iteration 5): Final Review gained a
// resume-and-continue agent() site (dispatchFinalReviewResume), same
// shape as the doer/reviewer resume paths; member_name literal confirmed.
// 12 -> 13: Streak Assignment gained a bounded semantic-repair re-ask
// site (one corrective re-dispatch when the candidate is schema-valid but
// semantically rejected, e.g. run 8's suffix-stripped bead ids);
// member_name literal confirmed.
// 18 -> 20 (apra-fleet-eft.68.1): the in-cycle SCOPED replan (route replanIds
// to a scoped planner + plan-review pass WITHIN the develop loop, rather than
// deferring to the next cycle) added exactly two new agent() call sites in the
// develop loop -- (1) the scoped planner dispatch (member_name:
// getMemberForRole('planner')) and (2) the scoped plan-review dispatch
// (member_name: getMemberForRole('plan-reviewer')), both literal member_name
// present, verified compliant.
// 20 -> 22 (integ/regression split): the new once-per-sprint Regression Test
// phase (Finalization, between Final Review and Harvest) adds two agent()
// call sites -- the dispatch itself and its max_turns-exhaustion
// resume-and-continue, both `member_name:
// getMemberForRole('regression-test-runner')`, verified compliant.
// 22 -> 20 (apra-fleet-3swo.5.3): the planner ladder -- its interactive
// dispatch and its max_turns-exhaustion resume -- moved out of runner.js onto
// the dispatchRole engine (fleet-sprint/dispatch-role.mjs), which is itself a
// GUARDED_MODULES entry and is scanned by this guard's own checkModules()
// baseline. Two agent() call sites left runner.js; none were added.
// 20 -> 18 (same bead): the plan-reviewer ladder -- its dispatch and its
// max_turns-exhaustion resume -- followed the planner onto the engine.
// 18 -> 17 (same bead): the scoped-replan planner (a single dispatch, no
// resume of its own) followed them.
// 17 -> 16 (same bead): the scoped-replan plan-reviewer (also a single
// dispatch) followed them.
// 16 -> 14 (same bead): the Streak Assignment grouping call and its bounded
// semantic-repair re-ask followed them, completing the planning-side
// migration. Every remaining runner.js agent() site is execution-side.
// 14 -> 12 (apra-fleet-3swo.5.7): the harvester ladder -- its dispatch and its
// max_turns-exhaustion resume -- moved onto the dispatchRole engine, starting
// the execution-side half of the migration. Two agent() call sites left
// runner.js; none were added.
// 12 -> 10 (same bead): the deployer ladder -- its dispatch and its
// max_turns-exhaustion resume -- followed the harvester onto the engine.
// 10 -> 8 (same bead): the regression-test-runner ladder -- its dispatch and
// its max_turns-exhaustion resume -- followed the deployer onto the engine.
// 8 -> 6 (same bead): the integ-test-runner ladder -- its dispatch and its
// max_turns-exhaustion resume, which is also its ONE infra-recovery resume --
// followed the regression runner onto the engine.
// 6 -> 4 (same bead): the final-review ladder -- its dispatch and its
// max_turns-exhaustion resume -- followed the integ runner onto the engine.
// 4 -> 2 (same bead): the per-round reviewer ladder -- its dispatch and its
// max_turns-exhaustion resume -- followed the final review onto the engine.
// 2 -> 0 (same bead): the doer ladder -- its streak dispatch and its
// max_turns-exhaustion resume -- was the last inline execution ladder. Every
// agent() dispatch in the scanned module set is now the dispatchRole engine's
// single call site, so this runner.js-only census proves nothing and the
// EXPECTED counts here are zero by construction.
const EXPECTED_AGENT_COUNT = 0;

// findCallSites/extractBalancedCall/skipStringLiteral/isInsideSameLineString
// and the path-parameterized checkPath() checker now live in
// ../fleet-sprint/dispatch-safety-guard.mjs (apra-fleet-eft.3.3), imported
// above, so they can be reused against fixture files below without
// duplicating the parser here.

test('every command()/agent() call site in runner.js passes member_name or member_id', () => {
    const { sites, violations } = checkPath(RUNNER_PATH);

    const commandSites = sites.filter((s) => s.fnName === 'command');
    const agentSites = sites.filter((s) => s.fnName === 'agent');

    // Baseline counts asserted explicitly: a future edit that silently
    // DROPS a call site (e.g. a refactor that inlines a dispatch behind a
    // helper this parser can no longer see) changes these counts even
    // though every remaining site is individually compliant, and must be
    // caught rather than passing silently.
    assert.strictEqual(
        commandSites.length,
        EXPECTED_COMMAND_COUNT,
        `Expected ${EXPECTED_COMMAND_COUNT} command() call site(s) in runner.js, found ${commandSites.length}. ` +
        `If a call site was intentionally added or removed, update EXPECTED_COMMAND_COUNT after confirming ` +
        `every site still passes member_name/member_id.`
    );
    assert.strictEqual(
        agentSites.length,
        EXPECTED_AGENT_COUNT,
        `Expected ${EXPECTED_AGENT_COUNT} agent() call site(s) in runner.js, found ${agentSites.length}. ` +
        `If a call site was intentionally added or removed, update EXPECTED_AGENT_COUNT after confirming ` +
        `every site still passes member_name/member_id.`
    );

    assert.deepStrictEqual(
        violations,
        [],
        `Found ${violations.length} dispatch-safety violation(s):\n${violations.join('\n')}`
    );
});

// apra-fleet-417.2.1: runner.js is no longer the only file that dispatches
// commands -- the dolt brackets moved into ./dolt-sync.mjs, which is now the
// single permitted `bd dolt` command surface. Guard it with the SAME
// invariant, so the three sites that moved there cannot silently lose their
// explicit member_name, and so a future dolt command added to that module is
// caught by this suite rather than at runtime on a real fleet dispatch.
const DOLT_SYNC_PATH = path.join(__dirname, '../fleet-sprint/dolt-sync.mjs');
// runDoltStep()'s single `bd dolt` spawn, isMemberSyncRemoteConfigured()'s
// `bd config get sync.remote --json` gate, and preflightBeadsHealthGate()'s
// best-effort `pwd` diagnostic -- exactly the three that left runner.js.
// 3 -> 4 (apra-fleet-akuv, remote-tip fingerprint): readRemoteDoltTip() gained
// one new `git ls-remote <url> refs/dolt/data` call site (member_name:
// member, confirmed present) used to skip a provably no-op D-pull/D-push.
const EXPECTED_DOLT_SYNC_COMMAND_COUNT = 4;

test('every command() call site in dolt-sync.mjs passes member_name or member_id', () => {
    const { sites, violations } = checkPath(DOLT_SYNC_PATH);

    const commandSites = sites.filter((s) => s.fnName === 'command');
    assert.strictEqual(
        commandSites.length,
        EXPECTED_DOLT_SYNC_COMMAND_COUNT,
        `Expected ${EXPECTED_DOLT_SYNC_COMMAND_COUNT} command() call site(s) in dolt-sync.mjs, found ${commandSites.length}. ` +
        `If a call site was intentionally added or removed, update EXPECTED_DOLT_SYNC_COMMAND_COUNT after confirming ` +
        `every site still passes member_name/member_id.`
    );
    assert.strictEqual(
        sites.filter((s) => s.fnName === 'agent').length,
        0,
        'dolt-sync.mjs must never dispatch an agent() -- it is a command-only sync module.'
    );
    assert.deepStrictEqual(
        violations,
        [],
        `Found ${violations.length} dispatch-safety violation(s):\n${violations.join('\n')}`
    );
});

// apra-fleet-3swo.3.1: the VCS/LLM auth region moved out of runner.js into
// ./vcs-auth.mjs, taking three command() call sites with it. Guard that module
// with the SAME invariant -- same reasoning as dolt-sync.mjs above: the moved
// sites cannot silently lose their explicit member_name, and a future
// credential/PR dispatch added there is caught by this suite rather than at
// runtime on a real fleet dispatch.
const VCS_AUTH_PATH = path.join(__dirname, '../fleet-sprint/vcs-auth.mjs');
// provisionVcsAuthForMember()'s `git remote get-url origin` read,
// readMemberVcsCredentialToken()'s git-credential-helper read, and
// raiseVcsPrForMember()'s VCSModule create-pull-request dispatch -- exactly the
// three that left runner.js.
const EXPECTED_VCS_AUTH_COMMAND_COUNT = 3;

test('every command() call site in vcs-auth.mjs passes member_name or member_id', () => {
    const { sites, violations } = checkPath(VCS_AUTH_PATH);

    const commandSites = sites.filter((s) => s.fnName === 'command');
    assert.strictEqual(
        commandSites.length,
        EXPECTED_VCS_AUTH_COMMAND_COUNT,
        `Expected ${EXPECTED_VCS_AUTH_COMMAND_COUNT} command() call site(s) in vcs-auth.mjs, found ${commandSites.length}. ` +
        `If a call site was intentionally added or removed, update EXPECTED_VCS_AUTH_COMMAND_COUNT after confirming ` +
        `every site still passes member_name/member_id.`
    );
    assert.strictEqual(
        sites.filter((s) => s.fnName === 'agent').length,
        0,
        'vcs-auth.mjs must never dispatch an agent() -- it is a credential/PR command surface only.'
    );
    assert.deepStrictEqual(
        violations,
        [],
        `Found ${violations.length} dispatch-safety violation(s):\n${violations.join('\n')}`
    );
});

// apra-fleet-3swo.3.6: the typed sprint-abort predicate, the abort-path PR
// publish helper and the newTask validation/persistence helpers moved out of
// runner.js into ./abort.mjs, taking two command() call sites with them.
// Guard that module with the SAME invariant -- same reasoning as vcs-auth.mjs
// above: the moved sites cannot silently lose their explicit member_name, and
// a future command()/agent() dispatch added there is caught by this suite
// rather than at runtime on a real fleet dispatch.
const ABORT_PATH = path.join(__dirname, '../fleet-sprint/abort.mjs');
// finalizeAbort()'s `git remote get-url origin` PR-capability probe and
// appendRejectedFindingToParentNotes()'s `bd note <id> --file ...` call --
// exactly the two that left runner.js.
const EXPECTED_ABORT_COMMAND_COUNT = 2;

test('every command() call site in abort.mjs passes member_name or member_id', () => {
    const { sites, violations } = checkPath(ABORT_PATH);

    const commandSites = sites.filter((s) => s.fnName === 'command');
    assert.strictEqual(
        commandSites.length,
        EXPECTED_ABORT_COMMAND_COUNT,
        `Expected ${EXPECTED_ABORT_COMMAND_COUNT} command() call site(s) in abort.mjs, found ${commandSites.length}. ` +
        `If a call site was intentionally added or removed, update EXPECTED_ABORT_COMMAND_COUNT after confirming ` +
        `every site still passes member_name/member_id.`
    );
    assert.strictEqual(
        sites.filter((s) => s.fnName === 'agent').length,
        0,
        'abort.mjs must never dispatch an agent() -- it is an abort-handling/newTask command surface only.'
    );
    assert.deepStrictEqual(
        violations,
        [],
        `Found ${violations.length} dispatch-safety violation(s):\n${violations.join('\n')}`
    );
});

// =============================================================================
// apra-fleet-3swo.6.2: the first two runSprintCycle phase() boundaries moved
// into ./phases/, taking eleven command() call sites with them (see
// EXPECTED_COMMAND_COUNT's own note above for the 29 -> 18 arithmetic). Same
// reasoning as the vcs-auth.mjs/abort.mjs baselines above: the aggregate
// checkModules() scan already proves every site is member_name-bearing, but
// only a per-module COUNT catches a later refactor that silently DROPS a site
// (e.g. inlines a dispatch behind a helper this parser cannot see) while every
// surviving site stays individually compliant.
//
// These are the first NESTED guarded modules, so the paths below join through
// a 'phases' segment. That matters only for locating the file -- the guard
// reports both under their bare basenames.
// =============================================================================
const ENSURE_SPRINT_BRANCH_PATH = path.join(__dirname, '../fleet-sprint/phases/ensure-sprint-branch.mjs');
// The base fetch, the sprint-branch fetch, the local-branch probe, the two
// `git merge-base --is-ancestor` tip comparisons, the checkout, the
// orphaned-WIP stash and the post-stash checkout retry -- the eight that left
// runner.js -- plus two diagnostic-only tip-SHA probes (apra-fleet-3swo
// fleet-mac regression investigation) that run only on the rare 'diverged'
// abort path, so a human reading the abort message can name the two tips
// instead of taking the verdict on faith.
const EXPECTED_ENSURE_SPRINT_BRANCH_COMMAND_COUNT = 10;

const PLAN_PHASE_PATH = path.join(__dirname, '../fleet-sprint/phases/plan.mjs');
// The `bd list --parent <id> --json` reconciliation listing, and the plan-cap
// deferral's `bd update <id> --status=deferred` and `bd note <id> --file` --
// exactly the three that left runner.js.
const EXPECTED_PLAN_PHASE_COMMAND_COUNT = 3;

test('every command() call site in phases/ensure-sprint-branch.mjs passes member_name or member_id', () => {
    const { sites, violations } = checkPath(ENSURE_SPRINT_BRANCH_PATH);

    const commandSites = sites.filter((s) => s.fnName === 'command');
    assert.strictEqual(
        commandSites.length,
        EXPECTED_ENSURE_SPRINT_BRANCH_COMMAND_COUNT,
        `Expected ${EXPECTED_ENSURE_SPRINT_BRANCH_COMMAND_COUNT} command() call site(s) in phases/ensure-sprint-branch.mjs, ` +
        `found ${commandSites.length}. If a call site was intentionally added or removed, update ` +
        `EXPECTED_ENSURE_SPRINT_BRANCH_COMMAND_COUNT after confirming every site still passes member_name/member_id.`
    );
    assert.strictEqual(
        sites.filter((s) => s.fnName === 'agent').length,
        0,
        'phases/ensure-sprint-branch.mjs must never dispatch an agent() -- it is a git setup phase, not a role dispatch.'
    );
    assert.deepStrictEqual(
        violations,
        [],
        `Found ${violations.length} dispatch-safety violation(s):\n${violations.join('\n')}`
    );
});

test('every command() call site in phases/plan.mjs passes member_name or member_id', () => {
    const { sites, violations } = checkPath(PLAN_PHASE_PATH);

    const commandSites = sites.filter((s) => s.fnName === 'command');
    assert.strictEqual(
        commandSites.length,
        EXPECTED_PLAN_PHASE_COMMAND_COUNT,
        `Expected ${EXPECTED_PLAN_PHASE_COMMAND_COUNT} command() call site(s) in phases/plan.mjs, found ${commandSites.length}. ` +
        `If a call site was intentionally added or removed, update EXPECTED_PLAN_PHASE_COMMAND_COUNT after confirming ` +
        `every site still passes member_name/member_id.`
    );
    // The planner and plan-reviewer ladders are dispatchRole rows
    // (apra-fleet-3swo.5.3), so the phase module dispatches no agent() of its
    // own -- the engine owns the single real call site.
    assert.strictEqual(
        sites.filter((s) => s.fnName === 'agent').length,
        0,
        'phases/plan.mjs must never dispatch an agent() directly -- both its ladders run through the dispatchRole engine.'
    );
    assert.deepStrictEqual(
        violations,
        [],
        `Found ${violations.length} dispatch-safety violation(s):\n${violations.join('\n')}`
    );
});

// =============================================================================
// apra-fleet-3swo.6.5: the Review and Deploy phase() boundaries. Same per-module
// baseline reasoning as the two above -- and the ZERO baselines here are not
// decorative: phases/deploy.mjs is where a future edit is most likely to reach
// for a raw command() (a runbook probe, a teardown) instead of routing through
// the seams it is handed, and a zero baseline is what turns that into a red
// test rather than a silently unguarded site.
// =============================================================================
const REVIEW_PHASE_PATH = path.join(__dirname, '../fleet-sprint/phases/review.mjs');
// The `bd show <assignedBeadIds> --json` acceptance-criteria read -- the one
// site that left runner.js with this phase.
const EXPECTED_REVIEW_PHASE_COMMAND_COUNT = 1;

const DEPLOY_PHASE_PATH = path.join(__dirname, '../fleet-sprint/phases/deploy.mjs');
// None: the deployer ladder is a dispatchRole row, whose read-side git-sync
// bracket is the phase's only repo-side effect.
const EXPECTED_DEPLOY_PHASE_COMMAND_COUNT = 0;

test('every command() call site in phases/review.mjs passes member_name or member_id', () => {
    const { sites, violations } = checkPath(REVIEW_PHASE_PATH);

    const commandSites = sites.filter((s) => s.fnName === 'command');
    assert.strictEqual(
        commandSites.length,
        EXPECTED_REVIEW_PHASE_COMMAND_COUNT,
        `Expected ${EXPECTED_REVIEW_PHASE_COMMAND_COUNT} command() call site(s) in phases/review.mjs, found ${commandSites.length}. ` +
        `If a call site was intentionally added or removed, update EXPECTED_REVIEW_PHASE_COMMAND_COUNT after confirming ` +
        `every site still passes member_name/member_id.`
    );
    // The reviewer ladder is a dispatchRole row reached through runner.js's
    // shared dispatchReview() helper (Re-Review and Final Review call it too),
    // so this phase module dispatches no agent() of its own.
    assert.strictEqual(
        sites.filter((s) => s.fnName === 'agent').length,
        0,
        'phases/review.mjs must never dispatch an agent() directly -- its ladder runs through the dispatchRole engine.'
    );
    assert.deepStrictEqual(
        violations,
        [],
        `Found ${violations.length} dispatch-safety violation(s):\n${violations.join('\n')}`
    );
});

test('every command() call site in phases/deploy.mjs passes member_name or member_id', () => {
    const { sites, violations } = checkPath(DEPLOY_PHASE_PATH);

    const commandSites = sites.filter((s) => s.fnName === 'command');
    assert.strictEqual(
        commandSites.length,
        EXPECTED_DEPLOY_PHASE_COMMAND_COUNT,
        `Expected ${EXPECTED_DEPLOY_PHASE_COMMAND_COUNT} command() call site(s) in phases/deploy.mjs, found ${commandSites.length}. ` +
        `If a call site was intentionally added or removed, update EXPECTED_DEPLOY_PHASE_COMMAND_COUNT after confirming ` +
        `every site still passes member_name/member_id.`
    );
    assert.strictEqual(
        sites.filter((s) => s.fnName === 'agent').length,
        0,
        'phases/deploy.mjs must never dispatch an agent() directly -- the deployer ladder runs through the dispatchRole engine.'
    );
    assert.deepStrictEqual(
        violations,
        [],
        `Found ${violations.length} dispatch-safety violation(s):\n${violations.join('\n')}`
    );
});

// =============================================================================
// apra-fleet-3swo.6.8: the Integ Test and Re-Review phase() boundaries. Same
// per-module baseline reasoning as the four above. The TWO on integ-test.mjs
// are the only raw bd commands either phase issues directly; re-review.mjs's
// ZERO is the load-bearing one, for the same reason phases/deploy.mjs's is --
// it is a phase whose every bead write is supposed to go through an injected
// helper that owns its own guarded command() site, so a future edit reaching
// for a raw command() here must turn this red rather than land on a site no
// per-module baseline is watching.
// =============================================================================
const INTEG_TEST_PHASE_PATH = path.join(__dirname, '../fleet-sprint/phases/integ-test.mjs');
// The verify-fail bounce cap's `bd show <bugId> --json` parent lookup and its
// `bd update <parentId> --status=deferred --append-notes` deferral -- exactly
// the two sites that left runner.js with this phase.
const EXPECTED_INTEG_TEST_PHASE_COMMAND_COUNT = 2;

const RE_REVIEW_PHASE_PATH = path.join(__dirname, '../fleet-sprint/phases/re-review.mjs');
// None: every bead write this phase makes goes through applyGuardedReopens or
// persistNewTaskBestEffort/computeChildFloor/createChildBeadWithAllocatedId,
// whose command() sites live in the modules that own them, and its only other
// repo-side effect is the shared gitSync bracket.
const EXPECTED_RE_REVIEW_PHASE_COMMAND_COUNT = 0;

test('every command() call site in phases/integ-test.mjs passes member_name or member_id', () => {
    const { sites, violations } = checkPath(INTEG_TEST_PHASE_PATH);

    const commandSites = sites.filter((s) => s.fnName === 'command');
    assert.strictEqual(
        commandSites.length,
        EXPECTED_INTEG_TEST_PHASE_COMMAND_COUNT,
        `Expected ${EXPECTED_INTEG_TEST_PHASE_COMMAND_COUNT} command() call site(s) in phases/integ-test.mjs, found ${commandSites.length}. ` +
        `If a call site was intentionally added or removed, update EXPECTED_INTEG_TEST_PHASE_COMMAND_COUNT after confirming ` +
        `every site still passes member_name/member_id.`
    );
    assert.strictEqual(
        sites.filter((s) => s.fnName === 'agent').length,
        0,
        'phases/integ-test.mjs must never dispatch an agent() directly -- the integ-test-runner ladder runs through the dispatchRole engine.'
    );
    assert.deepStrictEqual(
        violations,
        [],
        `Found ${violations.length} dispatch-safety violation(s):\n${violations.join('\n')}`
    );
});

test('every command() call site in phases/re-review.mjs passes member_name or member_id', () => {
    const { sites, violations } = checkPath(RE_REVIEW_PHASE_PATH);

    const commandSites = sites.filter((s) => s.fnName === 'command');
    assert.strictEqual(
        commandSites.length,
        EXPECTED_RE_REVIEW_PHASE_COMMAND_COUNT,
        `Expected ${EXPECTED_RE_REVIEW_PHASE_COMMAND_COUNT} command() call site(s) in phases/re-review.mjs, found ${commandSites.length}. ` +
        `If a call site was intentionally added or removed, update EXPECTED_RE_REVIEW_PHASE_COMMAND_COUNT after confirming ` +
        `every site still passes member_name/member_id.`
    );
    assert.strictEqual(
        sites.filter((s) => s.fnName === 'agent').length,
        0,
        'phases/re-review.mjs must never dispatch an agent() directly -- its reviewer ladder runs through runner.js\'s shared dispatchReview() helper and the dispatchRole engine.'
    );
    assert.deepStrictEqual(
        violations,
        [],
        `Found ${violations.length} dispatch-safety violation(s):\n${violations.join('\n')}`
    );
});

// =============================================================================
// apra-fleet-3swo.6.6: the Final Review and Regression Test phase() boundaries.
// Same per-module baseline reasoning as the six above, and BOTH baselines here
// are the load-bearing zero kind.
//
// phases/final-review.mjs is the sprint's most consequential phase -- it reads
// the closing bead counts and applies the verdict's reopens and newTasks -- and
// every one of those touches bd through an injected seam (bdListScoped) or a
// helper that owns its own guarded command() site (applyGuardedReopens,
// computeChildFloor/createChildBeadWithAllocatedId). A future edit reaching for
// a raw `bd` command here is exactly what a zero baseline must turn red.
//
// phases/regression-test.mjs issues no command() at all by design: the
// carry-over beads it exists to produce are filed by the DISPATCHED runner
// inside its own repo, never by the orchestrator. A command() appearing here
// would mean the orchestrator had started filing them itself.
// =============================================================================
const FINAL_REVIEW_PHASE_PATH = path.join(__dirname, '../fleet-sprint/phases/final-review.mjs');
const EXPECTED_FINAL_REVIEW_PHASE_COMMAND_COUNT = 0;

const REGRESSION_TEST_PHASE_PATH = path.join(__dirname, '../fleet-sprint/phases/regression-test.mjs');
const EXPECTED_REGRESSION_TEST_PHASE_COMMAND_COUNT = 0;

test('every command() call site in phases/final-review.mjs passes member_name or member_id', () => {
    const { sites, violations } = checkPath(FINAL_REVIEW_PHASE_PATH);

    const commandSites = sites.filter((s) => s.fnName === 'command');
    assert.strictEqual(
        commandSites.length,
        EXPECTED_FINAL_REVIEW_PHASE_COMMAND_COUNT,
        `Expected ${EXPECTED_FINAL_REVIEW_PHASE_COMMAND_COUNT} command() call site(s) in phases/final-review.mjs, found ${commandSites.length}. ` +
        `If a call site was intentionally added or removed, update EXPECTED_FINAL_REVIEW_PHASE_COMMAND_COUNT after confirming ` +
        `every site still passes member_name/member_id.`
    );
    assert.strictEqual(
        sites.filter((s) => s.fnName === 'agent').length,
        0,
        'phases/final-review.mjs must never dispatch an agent() directly -- the final-review ladder runs through the dispatchRole engine.'
    );
    assert.deepStrictEqual(
        violations,
        [],
        `Found ${violations.length} dispatch-safety violation(s):\n${violations.join('\n')}`
    );
});

test('every command() call site in phases/regression-test.mjs passes member_name or member_id', () => {
    const { sites, violations } = checkPath(REGRESSION_TEST_PHASE_PATH);

    const commandSites = sites.filter((s) => s.fnName === 'command');
    assert.strictEqual(
        commandSites.length,
        EXPECTED_REGRESSION_TEST_PHASE_COMMAND_COUNT,
        `Expected ${EXPECTED_REGRESSION_TEST_PHASE_COMMAND_COUNT} command() call site(s) in phases/regression-test.mjs, found ${commandSites.length}. ` +
        `If a call site was intentionally added or removed, update EXPECTED_REGRESSION_TEST_PHASE_COMMAND_COUNT after confirming ` +
        `every site still passes member_name/member_id.`
    );
    assert.strictEqual(
        sites.filter((s) => s.fnName === 'agent').length,
        0,
        'phases/regression-test.mjs must never dispatch an agent() directly -- the regression-test-runner ladder runs through the dispatchRole engine.'
    );
    assert.deepStrictEqual(
        violations,
        [],
        `Found ${violations.length} dispatch-safety violation(s):\n${violations.join('\n')}`
    );
});

// =============================================================================
// apra-fleet-3swo.34 -- an apostrophe inside a comment must never let
// extractBalancedCall()'s depth walk run past the call's real closing paren.
//
// Concrete case this reproduces (verified against runner.js:5403-5404 before
// this fix): dispatchDoerResume's `agent(` call site has a comment reading
// "Restate the streak's scope: ..." immediately inside its call body. The
// apostrophe in "streak's" was read as opening a string, which hid the
// call's real closing paren and let the balanced range run away to
// end-of-file -- callText grew from ~1.8KB to 155,327 characters (about a
// third of runner.js), while every other agent() site stayed under 4.2KB.
// =============================================================================

test("extractBalancedCall/findCallSites stop at the real closing paren even when a comment inside the call contains an apostrophe", () => {
    const src = [
        "const x = agent(",
        "    // it's a comment with an apostrophe inside the call body",
        "    'do the thing',",
        "    { member_name: member }",
        ")",
        ";",
        "const y = 1;",
    ].join('\n');

    const sites = findCallSites(src);
    assert.strictEqual(sites.length, 1, `expected exactly one call site, got: ${JSON.stringify(sites)}`);
    assert.strictEqual(sites[0].fnName, 'agent');
    // The call site's text must end at its own closing paren, i.e. must NOT
    // include the statements that follow it (";", "const y = 1;").
    assert.ok(sites[0].callText.endsWith(')'), `callText should end at the closing paren, got: ${JSON.stringify(sites[0].callText)}`);
    assert.ok(!sites[0].callText.includes('const y'), `callText leaked past its closing paren into later source: ${JSON.stringify(sites[0].callText)}`);

    // extractBalancedCall() directly, called the same way findCallSites()
    // calls it, exhibits the same fix.
    const openParenIdx = src.indexOf('agent(') + 'agent'.length;
    const callText = extractBalancedCall(src, openParenIdx);
    assert.strictEqual(callText, sites[0].callText);
});

test("no agent()/command() call site in runner.js has a callText far larger than the largest real dispatch (regression guard for the apostrophe-swallows-file bug)", () => {
    const { sites } = checkPath(RUNNER_PATH);
    const lengths = sites.map((s) => s.callText.length);
    const maxLen = Math.max(...lengths);
    const sorted = [...lengths].sort((a, b) => a - b);
    const secondMaxLen = sorted[sorted.length - 2];

    // Before the fix, dispatchDoerResume's call site was ~155KB (about 37x
    // the next-largest real site, ~4.2KB). An order-of-magnitude margin
    // catches a recurrence without pinning an exact byte count that would
    // need updating on every legitimate dispatch edit.
    assert.ok(
        maxLen <= secondMaxLen * 10,
        `a call site's callText (${maxLen} chars) is more than 10x the next-largest site's (${secondMaxLen} chars) -- ` +
        `likely the apostrophe-in-comment bug swallowing the rest of the file again. Sites: ${JSON.stringify(
            sites.map((s) => ({ line: s.line, fnName: s.fnName, len: s.callText.length })).filter((s) => s.len === maxLen)
        )}`
    );

    // The specific site this bug was found on (dispatchDoerResume's agent()
    // call) must end well before the file's end -- assert it stays in the same
    // size class as other dispatch call sites rather than spanning a meaningful
    // fraction of the whole file. Anchored on the resume prompt's own text
    // rather than on a line number: runner.js keeps shrinking as extraction
    // phases move ladders out of it (apra-fleet-3swo.5.3), and a line number
    // goes stale on every one of those without the site having moved at all.
    //
    // apra-fleet-3swo.5.7: re-anchored. The site this bug was found on was
    // dispatchDoerResume's agent() call, which the dispatchRole migration
    // deleted along with every other inline ladder -- runner.js makes no
    // agent() dispatch at all any more. The bug it guards against is a
    // property of the SCANNER, not of that one call site, so the anchor moves
    // to the engine's single dispatch (fleet-sprint/dispatch-role.mjs), which
    // is itself a GUARDED_MODULES entry and is now the only agent() call site
    // in the dispatch-ladder module set.
    const { sites: engineSites } = checkPath(DISPATCH_ROLE_PATH);
    const ENGINE_DISPATCH_ANCHOR = 'member_name: member,';
    const engineDispatchSite = engineSites.find((s) => s.fnName === 'agent' && s.callText.includes(ENGINE_DISPATCH_ANCHOR));
    assert.ok(
        engineDispatchSite,
        `expected the engine's agent() call site containing ${JSON.stringify(ENGINE_DISPATCH_ANCHOR)} in ` +
        'dispatch-role.mjs -- update this test if that dispatch moved/was renamed'
    );
    assert.ok(
        engineDispatchSite.callText.length < 10000,
        `the engine's agent() callText is ${engineDispatchSite.callText.length} chars -- expected a normal-sized ` +
        'dispatch call, not a runaway match'
    );
    // The runner-side half of the same guard: with every ladder migrated,
    // runner.js has no agent() call site left to run away. Asserted rather
    // than assumed, so a new inline dispatch re-enters this guard's scope.
    assert.strictEqual(
        sites.filter((s) => s.fnName === 'agent').length,
        EXPECTED_AGENT_COUNT,
        'runner.js dispatches only through the engine now; a new inline agent() call must be added to this count ' +
        'deliberately, not slipped in.'
    );
});

// =============================================================================
// apra-fleet-eft.3.3 -- prove the guard can actually FAIL, not just pass
// vacuously against a hand-verified-compliant runner.js. These tests point
// the same checkPath() checker at fixtures under test/fixtures/dispatch-
// safety/ instead of runner.js.
// =============================================================================

const NON_COMPLIANT_FIXTURE = path.join(__dirname, 'fixtures/dispatch-safety/non-compliant.mjs');
const MEMBER_ID_ONLY_FIXTURE = path.join(__dirname, 'fixtures/dispatch-safety/member-id-only.mjs');

test('checker reports a violation naming the fixture and its line for a member_name-less call site', () => {
    const { sites, violations } = checkPath(NON_COMPLIANT_FIXTURE);

    assert.strictEqual(sites.length, 1, 'expected exactly one call site in the fixture');
    assert.strictEqual(sites[0].fnName, 'command');

    assert.strictEqual(violations.length, 1, `expected exactly one violation, got: ${JSON.stringify(violations)}`);
    assert.match(violations[0], /^non-compliant\.mjs:13 \(command\(\)\) is missing member_name\/member_id$/);
});

test('checker accepts a call site carrying member_id only (not a violation)', () => {
    const { sites, violations } = checkPath(MEMBER_ID_ONLY_FIXTURE);

    assert.strictEqual(sites.length, 1, 'expected exactly one call site in the fixture');
    assert.deepStrictEqual(violations, [], `expected no violations, got: ${JSON.stringify(violations)}`);
});

// =============================================================================
// SHARED GUARDED-MODULE LIST (fleet-sprint/guarded-modules.mjs).
//
// checkPath() above is the single-file entry point, kept and unchanged. What
// follows exercises the aggregate entry point checkModules(), which reads the
// SHARED list -- the single place a newly extracted fleet-sprint module is
// registered. The point of these tests is that the list is load-bearing:
// registering a module there is what makes the guard scan it, so a guarded
// construct that moves out of runner.js into a newly extracted module cannot
// silently fall out of coverage.
// =============================================================================

test('the shared guarded-module list contains runner.js and resolves to real files', () => {
    assert.ok(GUARDED_MODULES.includes('runner.js'), `expected runner.js in the shared list, got: ${JSON.stringify(GUARDED_MODULES)}`);
    for (const p of guardedModulePaths()) {
        assert.ok(fs.existsSync(p), `registered guarded module does not exist on disk: ${p}`);
    }
});

test('checkModules() over the shared list reports zero dispatch-safety violations today', () => {
    const { violations, files } = checkModules();
    // Compared against basenames, not GUARDED_MODULES verbatim: `files` is
    // built from path.basename(p) for every scanned module, which only
    // equals a GUARDED_MODULES entry byte-for-byte while that entry has no
    // directory component (apra-fleet-3swo.14).
    assert.deepStrictEqual(files, guardedModuleBasenames(), 'the default scan set is exactly the shared list');
    assert.deepStrictEqual(violations, [], `Found ${violations.length} dispatch-safety violation(s):\n${violations.join('\n')}`);
});

test('adding a second path to the shared list makes the guard scan it and name it in the violation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guarded-modules-'));
    const fixture = path.join(dir, 'extracted-module.mjs');
    try {
        // A newly "extracted" module carrying one seeded violation: a
        // command() dispatch with no member_name/member_id.
        fs.writeFileSync(
            fixture,
            [
                "import { thing } from './thing.mjs';",
                '',
                'export async function run(command) {',
                "    await command('bd list --json', { timeout: 60 });",
                '}',
            ].join('\n'),
            'utf8'
        );

        const { violations, files } = checkModules(guardedModulePaths([fixture]));

        assert.deepStrictEqual(files, [...guardedModuleBasenames(), 'extracted-module.mjs']);
        assert.strictEqual(violations.length, 1, `expected exactly one violation, got: ${JSON.stringify(violations)}`);
        // Attributed to the FIXTURE's own filename, not to runner.js -- an
        // aggregate scan that mislabelled its findings would be useless.
        assert.match(violations[0], /^extracted-module\.mjs:4 \(command\(\)\) is missing member_name\/member_id$/);

        // Clearing the seeded violation clears the report.
        fs.writeFileSync(
            fixture,
            [
                "import { thing } from './thing.mjs';",
                '',
                'export async function run(command, member) {',
                "    await command('bd list --json', { member_name: member, timeout: 60 });",
                '}',
            ].join('\n'),
            'utf8'
        );
        assert.deepStrictEqual(checkModules(guardedModulePaths([fixture])).violations, []);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('checkModules() rejects a non-array argument rather than silently scanning nothing', () => {
    assert.throws(() => checkModules(RUNNER_PATH), /must be an array/);
});
