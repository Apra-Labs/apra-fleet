# Sprint Analysis: feat/v05-m1-launch-path

Scope issue id(s): apra-fleet-i9ag.15, apra-fleet-i9ag.16, apra-fleet-i9ag.18.
Base branch: v0.5_dashboard.
Cycles run: 5.

## Progress

Closed-bead count history (per cycle evaluation): [11, 14, 17, 22, 33].
High-water-mark closed count this sprint: 37.
Final closed count: 33.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

2 newTask(s) rejected before reaching bd create: C5: title fails safe-character allowlist /^[A-Za-z0-9 .,:;!?()'_/+[\]-]+$/ (or is empty): "Launch form's post-launch reset still depends on #backlog and leaves row checkboxes checked" | C5: title fails safe-character allowlist /^[A-Za-z0-9 .,:;!?()'_/+[\]-]+$/ (or is empty): "Consolidate duplicated launch-form test suites (~590 lines of near-verbatim overlap)"

## Final verdict

PASS -- Verified against the real base (local v0.5_dashboard is stale at 8688e007; reviewed origin/v0.5_dashboard..HEAD = 36 commits, 50 files, +5921/-126). Build OK; full bounded suite green end-to-end: SUMMARY contract:check=ok vitest=ok apra-fleet-client=ok apra-fleet-workflow=ok apra-fleet-se=ok apra-pm=ok (vitest 5960 pass/0 fail, fleet-se 4793 pass/0 fail); worktree clean; no stray/temp files.

i9ag.15 (binary spawns cli.mjs with execPath): FIXED at the root. New node-runner.mjs resolves a real Node via FLEET_SE_NODE -> execPath (gated on node:sea isSea()) -> PATH node >= 22.16, numeric version compare, win32 shell-probe quoting; spawner.mjs resolves lazily inside spawnSprint() BEFORE port/logfile/ledger side effects, caches success only, and api.mjs maps SprintRunnerResolutionError to 503 with the operator fix line (class check, not string match). Tests cover every tier, the SEA path, stale-version rejection, spaced paths, and the 503 through the real route layer.

i9ag.16 (invisible launch failures): FIXED. history-view.mjs synthesizes launch-failed rows from LAUNCH_FAILED events only when a history collaborator is injected, correctly gated on producedIds (not byId) so an unparseable terminal file still surfaces and an out-of-window file is not duplicated; dashboard.mjs renders a distinct launchFailedBadge + escaped reason + raw-log link (route exists at /sprints/:id/log), embedded in the live-refresh script with a generic guard that every toString-embedded helper is itself embedded; launch form watches the new run for 30s with generation-guarded polling that never invents a failure.

i9ag.18 (stale selection hint): FIXED. Listener moved to document level, all mutations funnel through setSelected/clearSelection, missing hint element logs loudly, wording corrected to 'above'.

Cross-cutting rules honored: apra-fleet-client JSDoc, memory-contract schemas/INVENTORY and the new live response-conformance lane all land with the kb_setup/kb_stats changes; contract:check now runs inside npm test.

Secondary findings filed as newTasks (none block this epic): (1) win32 .cmd/shim gap - the resolver probes with shell:true but spawner.mjs spawns without a shell, so a shim that passes the probe fails at spawn; (2) kb-server's loopback bind is a silent breaking change for existing team-shared installs (docs/--help updated, but no release note or startup warning); (3) the post-launch reset still uses a '#backlog'-scoped selector and leaves checkboxes checked; (4) ~590 lines of duplicated launch-form tests; (5) strict-mode ensureReachable() does a network round trip per getLinked/relatedClaims/promote.

Process note: apra-fleet-i9ag.15 itself is still OPEN at P1 with all 18 children closed, so the dispatch evidence line '0 beads still open at or above goal priority' is inaccurate - the scope bead needs closing. Also flagging scope drift: .15.11-.15.18 are KB/memory-contract work parented under a P1 launch-path spawner bug; the work is sound and tested but belongs under its own root.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: apra-fleet-p8gg.
Summary: Ran the full regression pass against repo root /Users/akhil/git/apra-fleet-deploy at branch HEAD 6e5985288b8b46d0723d2de080157052c3b6d8ca (feat/v05-m1-launch-path). Part 1 (real-bd functional suite, via scripts/run-integ-suites.mjs): discovered a stale cached status file from a different branch/commit (feat/v05-m1-status-health @ b2a65082) left over in this checkout, discarded it with --fresh, and ran a clean fresh pass -- 298/298 files completed, 13 failed (elapsedWall=8037s / ~134min). All 13 failures matched known, already-open [regression][carry-over]/[integ] beads except one: supervisor-lifecycle.test.mjs's real-serve health-wait timeout, which recurred under full-suite CPU contention despite its prior fixes being closed/verified -- filed as new standalone bead apra-fleet-p8gg. Updated 8 other existing beads (zekq, pjew, vwa2, 0aer, k83x, b1gw, ryk, 3dk4) and the long-pole budget bucket (eft.17, 45/298 files over the 300s single-file budget) with today's recurrence confirmation instead of filing duplicates. Part 2 (sandbox smoke test): Setup completed fully and cleanly (install, server start + port verify, toy-repo clone, git identity seed, sandbox-local git mirror + beads seed + isolation guard, supervisor boot with identity-checked readiness). Test scenario step 3a (credential provisioning) was denied by the Claude Code auto-mode classifier ('[Secret-Store Writes]') -- this is a well-established, repeatedly-reproduced known block (apra-fleet-j48h, updated today, no workaround attempted per this repo's CLAUDE.md permission-block policy), so steps 1-2 and 3b-6 never ran this cycle. Teardown then hit two more known, already-tracked issues that were manually recovered per their documented precedent: the supervisor-stop step false-reported 'still alive' due to a known identity-check race (apra-fleet-5mu3; manually confirmed the process/port were actually already dead) and scripts/reap-sandbox-dolt.mjs hard-failed with a macOS-incompatible 'ps -eo etimes=' call (apra-fleet-jz2m; manually confirmed no stray dolt sql-server process before removing the sandbox). The sandbox and its lock file are confirmed removed. This result is entirely informational: it does not gate this sprint's PASS/FAIL verdict, and the one newly-filed bug (apra-fleet-p8gg) plus every updated bead are standalone/parent-less and carry over to a future sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
