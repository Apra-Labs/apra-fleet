# Sprint Analysis: feat/v05-s9-member-env-reservation

Scope issue id(s): apra-fleet-ecjf.
Base branch: v0.5_dashboard.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [12, 18].
High-water-mark closed count this sprint: 23.
Final closed count: 18.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- SCOPE NOTE: the dispatched range v0.5_dashboard..branch shows 83 files because the LOCAL v0.5_dashboard ref is stale at cecd3e07; origin/v0.5_dashboard is cc105c14 and is already an ancestor of this branch. The sprint's true net diff is cc105c14..8280c951 = 29 files. The extra 54 files are PRs #524/#525, already landed on the integration branch. I reviewed cc105c14..8280c951.

FILE SCOPE: clean. Zero hits in every prohibited path (member-owner.ts, remove-member.ts, shell-ui, src/console, packages/apra-fleet-se/** beyond the one admitted file). The amendment's UNVERIFIED CAVEAT is discharged: git log --all on supervisor-lifecycle.test.mjs shows only this branch's commits after b009a4f1, no concurrent track. Five files sit outside the literal scope list but are each mechanical consequences of in-scope changes, not independent work: docs/mcp-tools.md (1 line mirroring the describe() edit), check-toy-doer-credentials.mjs (comment-only), test-helpers.ts (spawnDeadPid, shared helper the reaping tests need), toy-doer-envvar-real-cli-integ.test.ts (1 assertion following the double- to single-quote change), and member-owner-env-fields.test.ts case 7 (it pinned the ABSENCE of the feature this sprint ships, correctly inverted to still guard single-builder use).

BEAD-TO-CODE: ecjf.1 src/utils/env-prefix.ts (shell-selected via isPosixShell, auth wins collisions, build-time name revalidation); .2 execute-command.ts sync path + both task-wrapper generators + execute-prompt.ts main launch and all 4 retry sites; .3 reservation {runId,pid,at} with getReservation/reapIfDead and legacy string compat; .4 owner_ref refusal member_other_owner; .5 resolveSupervisorHealthBudgetMs via scaledTimeout with override kept verbatim; .6 injectable env param; .7 describeChildExitState never-spawned state; .8 trackSpawnError on the real serve spawn. All eight are traceable to specific lines.

DESIGN VERIFIED: the long_running wrappers carry member.env only and never auth, because run.sh/run.ps1 persist as files on the member; the sync path carries both because its prefix is transient. Env is written INSIDE the script, correct for the WMI-spawned Windows process that inherits nothing. Both forms use single quotes, fully literal in bash and PowerShell.

TESTS: npm test exit 0 (vitest 352 files passed / 8 skipped; apra-fleet-se 468 pass / 0 fail). The win32-only real-powershell case actually RAN here and passed. The client suite is NOT reached by root npm test, so I ran it separately: 75 pass / 0 fail. Tree clean.

NOT BLOCKING, filed as newTasks: (1) reapIfDead checks isPidAlive then calls updateAgent, which is a blind read-modify-write with no CAS, so a reserve landing in that window can have its live reservation cleared -- list_members now writes on a hot path where it never did before; (2) the empty-string concurrency bug is fixed only locally, not at its root in scaled-timeout.mjs; (3) the client suite gap; (4) pid recycling leaves a reservation permanently un-reapable (fails safe).

The apra-fleet MCP server failed to connect, so code_impact/code_graph were unavailable; structural checks were done by reading the diff and targeted greps.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Ran regression-test-playbook.md Part 1 (real-bd functional suite, fresh 279-file run, pass COMPLETE elapsedWall=7060s) and slow lane (npm run test:slow), plus Part 2 (sandbox smoke test). Part 1: 9 suite files failed plus 1 slow-lane failure; all 10 are confirmed recurrences of already-tracked carry-over bugs (recurrence notes added, no new beads needed, to apra-fleet-zekq, y0zz, vwa2, 0aer, ae2i, 5jlr, and [integ] budget-bucket eft.17). check-integ-suite-budget.mjs also flagged 35 files over the 300s per-file budget (tracked on eft.17). Part 2: Setup completed fully including a Windows-specific jwt-mint ESM-import failure (worked around locally, noted on apra-fleet-2a71 -- now confirmed to fail with BOTH POSIX and drive-letter path substitutions, a stronger claim than 2a71's original filing). Test scenario step 3a's credential-provisioning command was denied by the Claude Code auto-mode classifier ([Credential Leakage]), a known recurring block (apra-fleet-j48h); per CLAUDE.md no workaround was attempted, so steps 1/2/3b/4/5 (member registration, canary check, real Planner dispatch, closure assertions) never ran this cycle -- this is an environment/permission block, not a product defect found by the test. Teardown ran regardless: hit a known Teardown supervisor-stop race that false-reports 'still alive' right after a clean shutdown (apra-fleet-5mu3, verified via direct PID/port check and completed manually); sandbox directory, lock file, and both marker files are all confirmed removed, and no orphaned processes remain. Zero new bugs were filed this run -- every failure mapped to an existing open (or closed-but-recurring) [regression][carry-over] bead via bd search, and a recurrence comment was added to each per the playbook's dedupe rule. This entire result is informational: it does not gate the current sprint's PASS/FAIL verdict, and all listed failures carry over to a future sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
