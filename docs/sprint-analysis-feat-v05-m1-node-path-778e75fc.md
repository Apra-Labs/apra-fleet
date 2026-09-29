# Sprint Analysis: feat/v05-m1-node-path

Scope issue id(s): apra-fleet-i9ag.19.
Base branch: v0.5_dashboard.
Cycles run: 5.

## Progress

Closed-bead count history (per cycle evaluation): [2, 4, 8, 15, 22].
High-water-mark closed count this sprint: 22.
Final closed count: 22.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed the net diff. NOTE: the local v0.5_dashboard ref is stale (8688e007); the real base is origin/v0.5_dashboard (546286ca), giving 27 commits / 25 files / +5904 -137. All 25 files are scoped to the recorded-toolchain work -- no temp files, stray tool config, secrets, or unrelated scripts. No bead ids leak into runtime-printed strings (comments only).

Epic AC ("service-started supervisor launches a sprint with node from a version manager") is met and directly evidenced, not merely claimed:
- install: resolveFleetSeToolchainPaths() + seedSupervisorToolchain() record absolute node/bd paths into supervisor.config.json; unresolved node is a loud fatal install error, unresolved bd degrades (src/cli/fleet-se-prereqs.ts, src/cli/supervisor.ts, install.ts:2021).
- read path: project-config.mjs validates nodePath is a non-blank ABSOLUTE string; every malformed/missing case degrades to a distinguishable toolchainReason, never a throw.
- use path: node-runner.mjs CONFIGURED tier sits correctly between FLEET_SE_NODE and current-runtime and hard-fails loudly; exec-bd.mjs routes bd through the recorded path, degrading to PATH.
- startup: toolchain.mjs validateRecordedToolchain() never throws, gates ok on node only, exposes machine-readable nodeOk/bdOk, and bounds worst case to 30s by probing node and bd concurrently (Promise.all) instead of inventing a new budget.
- surfacing: health toolchain/toolchainWarning reuse the validator's OWN problems/fixLine (no hand-copied literal); dashboard header escapes all paths/versions.

Verification: build clean; full bounded runner (npm test) EXIT=0 -- root vitest 406 files passed / 6 skipped; fleet-se node --test 5015 cases passed, 0 failures, incl. 93 i9ag19 cases. Working tree clean. No lint script configured in this repo.

Test quality is genuinely strong, not box-ticking: i9ag19-14 spawns a real bin/serve.mjs child under a scrubbed EMPTY PATH, asserts node is not resolvable there, then asserts the sprint child ran the RECORDED node -- the actual repro of the reported 503, not a mock. node-runner cases are AC-mapped and pin tier precedence in both directions; the dashboard suite pins HTML escaping; the health suite pins that no pre-existing field changed.

No blocking defects; no bead should be reopened. Three P3 children remain open and are already tracked (19.16 shared-helper tests, 19.24 async-exec probe contract, 19.25 stale comment cross-ref) -- correctly below the P1/P2 goal bar, so no newTasks duplicate them.

Two secondary findings filed as newTasks (neither blocks this epic's AC).

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Ran the full regression pass against branch HEAD 62865fe5 (sprint apra-fleet-i9ag.19). Part 1 (real-bd suite, resumed a stale 298-file run's 9 pending files): 307/307 done, 13 failures, all pre-existing carry-over regressions matching existing beads (apra-fleet-zekq's golden-transcript-divergence cascade across golden-transcript/phase0-seams-facade/phase1-leaf-facade-completeness/phase3-dispatch-engine-completeness/vcs-auth-extraction-facade, apra-fleet-vwa2, apra-fleet-0aer, apra-fleet-p8gg, apra-fleet-3dk4, apra-fleet-ryk, and three recurrences of tests whose last tracking beads were closed: apra-fleet-pjew, apra-fleet-k83x, apra-fleet-b1gw); the slow lane (npm run test:slow) also failed its known bd-replay recording-drift case (apra-fleet-5jlr), and check-integ-suite-budget.mjs flagged 45 files over the 5-minute budget matching the longstanding perf bead apra-fleet-eft.17. Part 2 (smoke test): Setup completed fully (install, server+port verification, toy-repo clone, beads seeding, supervisor boot), but Test scenario step 3a's credential-provisioning command was denied by the Claude Code auto-mode classifier, a known recurring block (apra-fleet-j48h) -- no workaround was attempted per repo policy, so member registration, the canary check, and the toy sprint launch never ran. Teardown completed successfully despite two more known, already-documented flakes (a false 'still alive' race on the supervisor stop, apra-fleet-5mu3, and a macOS ps-etimes incompatibility in the dolt-sql-server reap step, apra-fleet-jz2m); the sandbox was fully and verifiably removed, and the sprint's own sandbox-deploy sweep found nothing to tear down. Every failure found matched an existing [regression][carry-over] or [integ] bead, so recurrence notes were added to those beads rather than filing duplicates -- no new bugs were filed this run. This result is purely informational: it does not gate the current sprint's verdict, and every finding here is pre-existing breakage carrying over to a future sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
