import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkPath } from '../fleet-sprint/dispatch-safety-guard.mjs';

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
const EXPECTED_COMMAND_COUNT = 40;
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
const EXPECTED_AGENT_COUNT = 22;

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
