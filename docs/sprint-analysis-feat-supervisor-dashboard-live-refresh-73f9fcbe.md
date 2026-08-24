# Sprint Analysis: feat/supervisor-dashboard-live-refresh

Scope issue id(s): apra-fleet-siqi.
Base branch: main.
Cycles run: 3.

## Progress

Closed-bead count history (per cycle evaluation): [7, 13, 19].
High-water-mark closed count this sprint: 24.
Final closed count: 19.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- apra-fleet-siqi epic (supervisor dashboard live-refresh) is fully implemented and matches acceptance criteria. dashboard.mjs adds GET /state (line 1249) and GET /events SSE (line 1273, text/event-stream), with the client wired to EventSource('/events') -> debounced schedulePoll('/state') plus a setInterval heartbeat fallback (lines 796-803) -- deliberately reusing the apra-fleet-workflow viewer architecture the epic required rather than inventing a second one. Tab-activation refresh (refreshIfStale, per-tab, no full-page reload) is covered by supervisor-tab-activation-refresh.test.mjs; Sprint Stack progress bar live-update off /state is covered by the siqi.4.2 test. The c4s P0 perf fix is confirmed: scope expansion is now in-memory via expandScopeInMemory() (dashboard.mjs:1121) off the single bulk listAllBeads() fetch -- no per-node bd subprocess (verified by supervisor-dashboard-backlog-no-live-spawn.test.mjs). vk0a counter-labeling is present ('total in scope, unfiltered' vs the progress bar's 'Required M/N'). Build passes; focused epic tests 67/67 pass; full se suite 2063 pass. computeBaseDrift() uses execFile with array args (no shell), so the git rev-list invocation is injection-safe. The 2 reported test failures (contracts-schema-dist-staleness-guard.test.mjs) are NOT branch defects: they flag a stale, gitignored LOCAL dist/agents/schemas artifact; the test is a documented no-op skip in CI, and `npm run dist-pm` makes both pass -- exactly the local-only staleness the guard is designed to catch. Working tree has one untracked local backup dir (.beads.bak-preclone-20260822/) that is not part of the branch. Scope note: local main sits at the merge-base, so main..branch (32 commits) also carries prior-merged, non-siqi work (pause/resume apra-fleet-p2to, base-drift indicator, integ/regression-runner schema updates, gemini removal); those were not individually vetted against this epic and are assumed covered by their own reviews.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: apra-fleet-jl71, apra-fleet-g541, apra-fleet-w49i, apra-fleet-d6fq.
Summary: Ran regression-test-playbook.md Part 1 (real-bd suite via run-integ-suites.mjs, 201 files unmocked at branch HEAD, plus the npm run test:slow lane) and Part 2 (sandbox smoke test). Part 1: 4 file failures out of 201 (f34-concurrent-launch-engagement-integration.test.mjs, mock-sprint-kb-remote-scope.test.mjs, mock-sprint-member-vcs-provider-threading.test.mjs, mock-sprint-publish-push-failure.test.mjs), plus the slow lane's mock-sprint-planner-dispatch-stalled-session.test.mjs failing on a known bd-replay recording-drift bug; also reconfirmed the suite's long-standing single-file 300s-budget violation (47/201 files) and a stale run-integ-suites.mjs status file requiring --fresh to recover. Part 2: Setup (install, server start, toy-repo clone, git identity, sandbox beads seed, isolation guard) completed cleanly, but the Test scenario was blocked at steps 2/3a by the Claude Code auto-mode classifier denying bd/credential-related commands -- a known, previously-filed, recurring issue reproduced identically again today; no workaround was attempted per repo policy, and Teardown ran and confirmed full sandbox removal. Filed 4 new standalone parent-less [regression][carry-over] beads for genuinely new Part-1 failures and added fresh corroborating evidence notes to 4 pre-existing matching beads instead of duplicating them. This result is purely informational: it does not gate the current sprint's PASS/FAIL verdict, and every filed/updated bug carries over as pre-existing breakage for a future sprint to pick up.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
