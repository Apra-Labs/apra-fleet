# Sprint Analysis: fix/v05-s0-win-dispatch-pipe-stall

Scope issue id(s): apra-fleet-qe83.
Base branch: main.
Cycles run: 3.

## Progress

Closed-bead count history (per cycle evaluation): [6, 10, 15].
High-water-mark closed count this sprint: 16.
Final closed count: 15.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- Windows-side evidence is real and green, verified first-hand at HEAD 78e0eaac (not taken from bead notes): npm run build exit 0; npx vitest run -> 324 files / 4691 passed, 8 files + 41 tests skipped, 0 failed; npm test --workspace=@apralabs/apra-fleet-se -> SUMMARY pass=3912 fail=0; apra-fleet-client -> 36 passed. Working tree clean apart from an untracked .beads.gate.lock. The diff genuinely implements what closed: read-side completion-on-exit in src/services/strategy.ts + src/services/ssh.ts behind src/services/exit-drain.ts (Windows-gated; getAgentOS returns the lowercase RemoteOS union 'windows', so completesOnProcessExit is live in production, not inert); backwards timestamp scan in read-log-tail.ts; the mtime-corroborated staleness branch plus stall_log_read / stall_no_signal / stall_tail_truncated log lines in stall-detector.ts; wall-clock bound, two-phase POSIX kill cascade, forced-exit backstop and the trailing 'failed || terminating' exit in scripts/run-all-tests.mjs and the se runner. qe83.1.3, qe83.2.3, qe83.3.3 and linked bugs apra-fleet-am7w / apra-fleet-0cil are all closed, so the epic's proof-task clause is satisfied. scripts/repro/win-orphan-pipe.mjs is load-bearing (await import-ed by the reproduction test), not scaffold. vitest.config.ts pool:'forks' is honestly self-documented as a no-op, not a fix.

ONE cause for FAIL, and it is the epic's own acceptance criterion 'npm test green on Windows AND Linux': there is no POSIX evidence at any HEAD containing the fix. The only CI run on this branch is 35695489913 at 3b5d7136 (pre-fix, conclusion failure). HEAD 78e0eaac is pushed to origin with no run at all. The three describe.skipIf(isWindows) blocks in tests/run-all-tests-timeout.test.ts -- including the two that cover the exit-code defect this sprint's last two commits claim to fix -- have therefore never executed anywhere. qe83.3.5 and qe83.3 remain correctly open; no closed bead needs reopening, since qe83.3.5.1's fix and qe83.3.5.2's test both demonstrably landed and the missing CI evidence is qe83.3.5's own obligation. UNBLOCK ACTION: a human supervisor must trigger workflow_dispatch of 'CI - Build & Test' on fix/v05-s0-win-dispatch-pipe-stall (the fleet-minted App token gets 403 on gh workflow run), then confirm every POSIX-only block passes on ubuntu-latest and macos-latest.

KB correction: entry dba06a76 ('currentChild is always null at the trailing process.exit in run-all-tests.mjs') is half-stale. Its literal claim still holds after the rewrite, but its stated conclusion -- 'so that line can never race the terminating-signal handler's kill cascade' -- is exactly the qe83.3.5 defect. The race was real; it simply did not run through currentChild. Left INFERRED; nothing promoted this round.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Ran the full regression pass against branch HEAD. Part 1 (real-bd suite via scripts/run-integ-suites.mjs) completed all 269 files with 9 recorded failures (golden-transcript.test.mjs, phase0-seams-facade.test.mjs, phase1-leaf-facade-completeness.test.mjs, phase3-dispatch-engine-completeness.test.mjs [4229s], vcs-auth-extraction-facade.test.mjs, mock-sprint-beads-health-gate-empty-remote.test.mjs, mock-sprint-beads-identity.test.mjs, mock-sprint-parent-child-blocks-cycle-repair.test.mjs, mock-sprint-regression-failure-never-gates.test.mjs), full wall time 6837s against the ~7min documented target, plus check-integ-suite-budget.mjs flagged 35/269 files over the 300s single-file budget. The test:slow lane also ran (1 pass, 1 fail: mock-sprint-planner-dispatch-stalled-session.test.mjs, bd-replay recording drift). Every one of these failures deduped against an already-open carry-over/integ bead, so no new bead was created -- each was updated in place with this run's occurrence detail: apra-fleet-zekq (golden-transcript root cause and its 4 cascade files), apra-fleet-vwa2, apra-fleet-y0zz, apra-fleet-0aer, apra-fleet-ae2i (the four mock-sprint-specific failures), apra-fleet-5jlr (test:slow drift), apra-fleet-eft.17 (wall-time budget), and apra-fleet-jl71 (a stale integ-suite-status.json that required --fresh before Part 1 could start -- no recorded failure was erased by that recovery). Part 2's Setup completed cleanly end to end (install, both port guards, server verified bound to port 18700, toy-repo clone plus sandbox-local git/Dolt mirrors, check-sandbox-sync-remote.mjs exit 0, identity-checked supervisor boot), but Test scenario step 3a (credential provisioning) was denied at runtime by the Claude Code auto-mode classifier under '[Credential Exploration]' -- both the playbook's verbatim command and a narrower env-var-only probe were refused, categorically, distinct from and in addition to the static .claude permissions.allow entries already confirmed present. Per CLAUDE.md this was surfaced, not routed around, and matches the already-open apra-fleet-j48h bead (updated, not reopened as new -- compose_permissions cannot fix this since it writes permissions.allow, not the classifier layer, so an operator-side classifier exemption or an out-of-band run of that step is what's actually needed). Scenario steps 1/2/3b/4/5 never executed as a result. Teardown ran regardless (supervisor stopped cleanly at 94s uptime, well under the 300s dolt-orphan-sweep tick; lock released; server stopped; dolt reap found nothing; sandbox directory deleted and verified gone), and the sprintId's leftover sandbox-deploy sweep reported nothing to tear down. This entire result is informational: it does not gate the current sprint's verdict, and every recorded failure/block carries over to a future sprint via its existing parent-less bead.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
