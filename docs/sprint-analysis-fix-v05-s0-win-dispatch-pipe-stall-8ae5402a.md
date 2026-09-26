# Sprint Analysis: fix/v05-s0-win-dispatch-pipe-stall

Scope issue id(s): apra-fleet-qe83.
Base branch: main.
Cycles run: 3.

## Progress

Closed-bead count history (per cycle evaluation): [18, 20, 22].
High-water-mark closed count this sprint: 23.
Final closed count: 22.
Final open-at-goal-priority count: 1.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
Integration test failures (1): C1: Verified apra-fleet-qe83.3 and verify-set bead apra-fleet-qe83.3.5 against the deployed build at HEAD 9f894fa92ee55a645dd501027bb309e0dfdc5686 on fix/v05-s0-win-dispatch-pipe-stall. Windows-local run of tests/run-all-tests-timeout.test.ts passed 4/3-skipped with no regression, but direct CI evidence at this HEAD (ubuntu-latest job that reported before fail-fast cancellation) shows the timer-fires-first POSIX ordering case still fails with exit code 0 -- the real defect qe83.3.5 was meant to close is not actually fixed despite both its child tasks being closed. Filed gap bug apra-fleet-qe83.3.5.3 under qe83.3.5 itself and left it open; left dependent feature qe83.3 open too since its acceptance criteria require all-OS passing. Also observed and filed an out-of-scope macos-latest process-leak failure (apra-fleet-qe83.8.1) under the closed task that claimed that exact coverage. Sandbox for this sprintId was located and torn down cleanly at the end. (bugs filed: apra-fleet-qe83.3.5.3)

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- Reviewed the net sprint diff origin/main..60c072e7 (26 files; local main was stale, so main..branch would have pulled in 6 unrelated merged PRs). Quality of the in-scope work is good, but the epic's acceptance criteria are not met.

WHY FAIL
1. Epic requires npm test green on Windows AND Linux. There is NO CI run at HEAD 60c072e7. Newest run 35772126542 is at ece43e1f, and its ubuntu-latest job FAILED: tests/execute-command-long-running-windows.test.ts 2 failed -- 'local path: output written immediately before process exit survives the exit-drain window' (line 300, expect(repro.isPidAlive(pid)).toBe(false) got true) and 'POSIX: killPidTree reaps a live descendant...' (20000ms inactivity timeout via src/services/strategy.ts:154). Commit 60c072e7 claims to fix both (bounded waitForPidGone/waitForGroupGone in scripts/repro/win-orphan-pipe.mjs; POSIX case no longer routed through execCommand) but has zero CI evidence.
2. P1 chain still open: qe83.3 -> qe83.3.5 -> qe83.3.5.3 -> qe83.3.5.3.2 (IN_PROGRESS, lease expired). Verify-routed bead qe83.3.5 was never confirmed against a deployed build.

VERIFIED GOOD (evidence, not claims)
- qe83.3.5.3.1's fix (cb377044) IS proven: ubuntu job 106896160147 at ece43e1f shows tests/run-all-tests-timeout.test.ts 7 tests PASSED, incl. the timer-fires-first survivor case. The deferredExitPending guard (run-all-tests.mjs:128,347) and signal-time group capture (lines 168-192) are sound; the deferred timer is ref-ed so it cannot be skipped.
- qe83.1/.5/.6: exit-drain read-side fix is correct and consistently ordered (finalize before destroy) in src/services/strategy.ts:245-300 and src/services/ssh.ts:295-360, with the unref rationale documented at both sites.
- qe83.2: read-log-tail.ts now scans backwards for a dated entry and stall-detector.ts:472-530 replaces the old bare continue with an mtime-anchored threshold evaluation.
- qe83.3/qe83.4 se-runner half: packages/apra-fleet-se/scripts/run-tests.mjs now runs node --test via async spawn with the same wall-clock bound, tree-kill and force-exit grace, traps SIGTERM to reap its own detached group, and clears activeChildPid on exit so a late signal cannot kill a recycled pid; it still exports APRA_FLEET_TEST_CONCURRENCY (line 173), so CONFIRMED entry a6400b26's sibling claim is unaffected.
- qe83.9: fail-fast:false is present in ci.yml, but it landed AFTER the only run cited as evidence, so no post-change run has shown all three legs reporting.
- Local Windows check at HEAD: build OK; vitest 4807 passed/43 skipped/0 failed; apra-fleet-se pass=3970 fail=0. Given the POSIX-only skipIf blocks this is necessary, not sufficient.

KB: promoted a1c77eb2 (verified against the stall-detector diff). Did NOT promote dba06a76 ('currentChild is always null at the trailing process.exit, so it can never race the kill cascade') -- the code contradicts it: qe83.3.5.3 was exactly that race and run-all-tests.mjs:347 now needs an explicit guard.

Hygiene: untracked .beads.gate.lock in the worktree; scripts/repro/win-orphan-pipe.mjs is required by the epic, not scaffold.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Ran the full regression pass against branch HEAD (60c072e7f18af15fac00308bf30a08a7b530e8c7) after confirming an on-disk integ-suite-status.json was stale (completed ~10.5h before this HEAD existed, against an older build) and clearing it with --fresh for a true HEAD measurement -- the fresh 269-file pass reproduced the exact same set of 9 failing files as the stale record, discharging the 'never use --fresh to erase a recorded failure' concern with evidence. Part 1 (real-bd suite): FAILED, 269/269 files completed in ~116 minutes (vs the ~6.5-8 min documented target), 9 failures -- golden-transcript.test.mjs and its cascade into phase0-seams-facade/phase1-leaf-facade-completeness/phase3-dispatch-engine-completeness/vcs-auth-extraction-facade (one root cause, tracked on apra-fleet-zekq), mock-sprint-beads-health-gate-empty-remote (apra-fleet-y0zz), mock-sprint-beads-identity (apra-fleet-vwa2), mock-sprint-parent-child-blocks-cycle-repair (apra-fleet-0aer), and mock-sprint-regression-failure-never-gates (apra-fleet-ae2i) -- all pre-existing, all matched to already-open [regression][carry-over] beads and updated with this run's evidence rather than duplicated; separately, check-integ-suite-budget.mjs found 36/269 files over the 300s single-file budget, matching the already-tracked systemic long-pole issue apra-fleet-eft.17 ([integ]-tagged), which was updated. The slow lane (Part 1b, npm run test:slow) also failed with the known bd-replay recording-drift signature in mock-sprint-planner-dispatch-stalled-session, matching apra-fleet-5jlr, updated. Part 2 (smoke test): Setup completed fully at branch HEAD (install, port guards, toy-repo clone, sandbox-local git mirror wiring, beads seed via sandbox-seed-beads.mjs, check-sandbox-sync-remote.mjs isolation guard OK, supervisor boot identity-checked) but Test scenario step 3a (seeding the sandbox's persistent secret store from the runner's ambient Claude credential) was denied by the Claude Code auto-mode permission classifier under a '[Credential Exploration]' reason -- this is a dynamic runtime classifier block, NOT a static permissions.allow gap (the required Bash prefixes were already verified present and sufficient before starting), so it cannot be fixed via compose_permissions; per this repo's CLAUDE.md ('surface, don't route around'), no workaround was attempted. This matches the long-recurring apra-fleet-j48h (open since 2026-08-19, reproduced on nearly every prior run), which was updated with this occurrence rather than duplicated. Steps 1/2/3b/4/5 of the Test scenario never executed, so no smokeEvidence (versionStdout/canaryStatus/toyRepoHeadSha) could be collected this run -- the field is omitted rather than fabricated. Teardown ran and was confirmed complete (supervisor stopped, lock released, server stopped, dolt-sql-server reap found nothing, sandbox directory/lock/pid markers all confirmed absent). The sandbox-deploy sweep for this sprint's dispatched sprintId (apra-fleet-qe83-995dff37-ba3e-4da8-9d65-052984057970) returned 'nothing to tear down'. No new [regression][carry-over] beads were filed -- every failure found was pre-existing and already tracked, so bugsFiled is empty; existing beads were updated with fresh evidence instead. This result is entirely informational: it does not gate the current sprint's PASS/FAIL verdict, and every failure identified is pre-existing breakage carrying over to a future sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
