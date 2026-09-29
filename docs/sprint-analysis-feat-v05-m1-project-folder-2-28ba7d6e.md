# Sprint Analysis: feat/v05-m1-project-folder-2

Scope issue id(s): apra-fleet-i9ag.17.
Base branch: v0.5_dashboard.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [31].
High-water-mark closed count this sprint: 34.
Final closed count: 31.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Scope: the local v0.5_dashboard ref is stale (cecd3e07), so v0.5_dashboard..branch also contains PRs #525-#553 that are already merged. I reviewed the real net diff, origin/v0.5_dashboard (546286ca)..branch: 9 commits, 23 files. They close the three partial-acceptance findings on the epic, plus .10 and .11.

(a) Home-folder bd global-state .beads (.12): beads-identity.mjs adds isProjectBeadsDir(), which requires .beads/metadata.json. discoverBeadsDir() and project-route.mjs's hasBeadsDbAt() both use it, so the walk-up and the Projects page can no longer disagree. Backlog degrades to 200 {noProject:true} through hasProject() and isNoBeadsDirectoryError() in backlog.mjs and api.mjs. Any other bd failure still returns 500, and a test covers that. New test: supervisor-global-state-beads.test.mjs.

(b) Restart (.13): src/cli/restart.ts runs stop and start in strict mode. Stop re-queries the service and throws if it is still running; start refuses the 'already running' no-op. index.ts catches the error and exits 1. The help text now mentions the supervisor. Three new runRestart tests are in tests/supervisor-service.test.ts.

(c) Missing git/bd (.14): probeBeadsIdentity treats a spawn ENOENT differently from a non-zero exit. It sets a non-enumerable probeCauses, and the error names the PATH cause instead of 'git remote add origin'. Restart guidance follows an explicit --managed-service flag. The registered unit now passes that flag, supervisor.ts forwards argv unchanged, and serve.mjs parses it. install re-registers unconditionally, so upgraded installs pick up the flag.

(.10) launchGuard refuses a launch with 409 when the launch cwd is unusable. The spawner waits one tick for the child's async 'error' event and throws SPRINT_SPAWN_FAILED with the cause, which the API maps to 500. A real-spawn test with a nonexistent cwd covers this. I traced the failure path: node emits spawn errors via nextTick, which fires before the setImmediate fallback.

(.11) The route guard test now matches import/call sites instead of comment text.

Hygiene: every file ties to a bead; nothing stray.

Tests (npm run build and npm test, Windows): build OK; contract, apra-fleet-client, apra-fleet-workflow, apra-fleet-se (4189 pass / 0 fail) and apra-pm all OK. Vitest: 6004 pass, 1 fail. The failure is tests/sea-http-verify.test.ts on a stale local dist/apra-fleet-installer-win-x64.exe (built Sep 26; the error says to run build:binary). It is it.skipIf(!binaryExists), so it is skipped on CI; this is the local-environment issue already in the KB, not a regression.

KB promotions: 1399df2b (SEA stale-binary local failure) and 076d83e4 (supervisor registration args pinned in three test files).

Minor follow-up filed: the metadata.json predicate may skip a bd worktree .beads that holds only a redirect file.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Informational only: this result does not gate the sprint, and every failure below carries over to a future sprint. Part 1 (real-bd suite at HEAD f83aa1f1) finished with 306/306 files run and 11 failed. A stale status file from 2026-09-27 blocked the run, so I backed it up to ~/temp/regr-backup and started a fresh pass. The failing files were f34-concurrent-launch-engagement-integration, golden-transcript, mock-sprint-beads-health-gate-empty-remote, mock-sprint-beads-identity, mock-sprint-parent-child-blocks-cycle-repair, mock-sprint-regression-failure-never-gates, phase0-seams-facade, phase1-leaf-facade-completeness, phase3-dispatch-engine-completeness, supervisor-guard-e2e and vcs-auth-extraction-facade. Four of those (phase0, phase1, phase3, vcs-auth) fail because golden-transcript fails inside them. The slow lane (npm run test:slow) also failed: dispatch-watchdog-timer-ref passed, and mock-sprint-planner-dispatch-stalled-session failed at setup with bd-replay recording drift. Part 2 was NOT completed. Setup succeeded, but the auto-mode permission classifier denied the scenario script (Credential Exploration), so the smoke test itself never ran. I did not work around the block. It is a permission-layer denial rather than a broken product path, and the operator has to decide how to clear it. The sprint was never launched. I ran Teardown afterwards: the supervisor and fleet server stopped, the sandbox was removed and the lock released, and the sandbox-deploy sweep found nothing to tear down. Every failure already had an open [regression][carry-over] bead, so I filed no new ones and appended this run's evidence to the existing beads: zekq (golden-transcript and its cascade, plus a new EBUSY / leaked nested sandbox in phase3), g541, pjew, vwa2, 0aer, k83x, x0mr, 3dk4, ye8j (slow lane) and j48h (Part 2 blocked). Because Part 2 never ran, there is no smoke evidence.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
