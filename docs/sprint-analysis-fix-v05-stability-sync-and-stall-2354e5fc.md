# Sprint Analysis: fix/v05-stability-sync-and-stall

Scope issue id(s): apra-fleet-rp7a, apra-fleet-2wdc, apra-fleet-ta3.
Base branch: main.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [12, 18].
High-water-mark closed count this sprint: 21.
Final closed count: 18.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed the net diff main..fix/v05-stability-sync-and-stall (64 files, +4306/-156); sprint-scope subset is fa0888f9..HEAD (38 files). Gates on my machine: npm run build exit 0; npm test exit 0 (3981 node:test assertions, fail=0, vitest green). Tree clean apart from untracked .beads.gate.lock (tooling artifact, not in the diff, not gitignored).

rp7a: partitionDeferredBeads (beads-scope.mjs) is shared by the cycle-eval count and final-review's closing count, so the two cannot drift; only 'deferred' changes meaning (blocked/in_progress still count open). Deferred ids are named, not dropped, on every terminal path (exit line, StalledSprintError message + typed deferredIds, final-verdict prompt, analysis doc, golden transcript updated). blockerIds no longer names deferred beads. Root-closed short-circuit (runner.js ~2997) reads the existing closedIdsNow set, is placed after Re-Review so the stale-APPROVED regression still holds, and is guarded on targetIssues.length>0. Covered by 3 new mock-sprint scenarios; the deferredgoalpriority scenario's inverted expectation is a documented supersede of unw2.18(a), not a weakened test.

2wdc: mapAccessLevel grants workflows:write for push/push+pr/admin/full; mintGitToken 422 becomes an operator referral with no silent permission downgrade. New per-rule permissionScope axis (vcs-providers/index.mjs contract + validation, github.mjs rules) is matched ahead of KIND_PRECEDENCE so git's generic 'failed to push some refs' DIVERGED trailer cannot win; runGitStep returns immediately with no self-heal and no retry, and the diverged/transient/azdevops self-heal paths are explicitly regression-guarded. member_detail gains gitAccess and the apra-fleet-client typedef + docs were updated in the same change (repo convention honored), with a parity test pinning the engine's hand-copied level table against mapAccessLevel.

ta3: isMissingRemoteRefError factored out and shared by syncMemberBefore/syncMemberAfter; missing-ref rebase is skipped and the push retried to create the branch; a diverged retry raises the typed GitDivergedError. 4 targeted tests, incl. the genuine-conflict Tier1/Tier2 regression guard.

Secondary findings (filed as newTasks / one reopen, none blocking the epic):
1. develop.mjs's 2wdc.4 dispatch-outcome path has zero test references (permissionScopeBlockedBeads, the carry-over exclusion, the 'PUBLISH BLOCKED' log, publishBlocked). The (2wdc.5) test only exercises the isPermissionScopePostDispatchSyncFailure predicate, so 2wdc.5 criterion 3 is not actually met -> reopened.
2. publishBlocked is written on streakOutcomes but read by nothing (no dashboard, report, stall detector or final-verdict evidence), so a permission-blocked sprint still ends as a generic SPRINT_STALLED with the referral only in the log.
3. 2wdc.8's 'live push' leg was substituted by a local bare-repo push; the real github.com verification remains an open operator referral.
4. PAT-mode members are deliberately excluded from the workflows preflight (documented), so they still learn only from the rejection.
5. Hygiene: the branch also carries 4 unrelated pre-sprint PR merges (#502/#503, #499/#504, #508, #509 - claude.ts, agent-transform, azure-devops, supervisor dashboard) that will ride in this PR.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Stopped at Step 0 permissions check before running anything: regression-test-playbook.md's ## Permissions section requires Bash(curl:*) (to drive the sandbox supervisor's HTTP API on port 18701 in Setup/Test scenario/Teardown) and Bash(kill:*) (for the supervisor boot identity-check and stop/kill retries in Setup/Reset/Teardown), and neither prefix is covered by any entry in the merged union of .claude/settings.json and .claude/settings.local.json -- the only curl grants present are narrowly scoped to a different port/path (localhost:8787/api/sprints and /api/reservations), and there is no kill entry at all. Neither Part 1 (real-bd suite) nor Part 2 (smoke test) was run, and the sandbox was never brought up so there is nothing to tear down. This result is informational and does not gate the current sprint's verdict; please run compose_permissions to add Bash(curl:*) and Bash(kill:*) to .claude/settings.local.json so the regression pass can proceed on a future run.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
