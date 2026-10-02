# Sprint Analysis: fix/supervisor-sprint-summary

Scope issue id(s): apra-fleet-vre7.
Base branch: main.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [7, 10].
High-water-mark closed count this sprint: 13.
Final closed count: 10.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
Integration test failures (1): C1: No open feature beads were in scope this cycle. I verified the two verify-set beads, apra-fleet-vre7.1 and apra-fleet-vre7.2, against the sprint working tree at bac2af15. I ran the full `npm test` and did not use the sandbox instance. In that run, viewer-run-summary-e2e passed (covers GET /state?summary=1). supervisor-dashboard-pulled-summary also passed, with 13 PASS lines and no FAIL lines. The apra-fleet-se suites passed (40, 328 and 489 tests, 0 failures), and check-generic-boundary.mjs passed. The supervisor's dashboard.mjs no longer calls computeSprintProgress; the only match under src/supervisor is a comment in backlog.mjs. I closed both beads with evidence notes. `npm test` exited 1 because of one vitest failure (1 failed, 5391 passed). The failure is tests/auth-terminal-windows-quoting.test.ts, which this sprint did not touch and which has no owning bead. I treated it as unrelated to these two features and filed it as apra-fleet-vre7.3 (P2, under apra-fleet-vre7), so the 'npm test green' acceptance line is not literally met on this host. I closed both beads anyway on that judgment; the closure is reversible if you want a clean `npm test` run first. The sandbox for this sprint was torn down. (bugs filed: apra-fleet-vre7.3)

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed the net diff origin/main...fix/supervisor-sprint-summary (7 commits, 17 files). The local main ref is stale, so I diffed against origin/main.

Acceptance criteria for apra-fleet-vre7:
- Generic core: viewer/run-summary.mjs plus index.mjs. summarize() runs only from workflow.on('state'), through applyExtensionSummary, for the extension that matches the namespace. GET /state?summary=1 returns only state.summary and calls no hook. Plain /state is unchanged and the summary is added after the leanify pass. Tested in workflow viewer-run-summary.test.mjs and se viewer-run-summary-e2e.test.mjs ('10 summary requests ... summarize exactly once').
- Beads extension: summarize() computes progress, and computed_at comes from the runner's fetchedAt (runner.js updateDashboard). The live view bar renders the published summary and no longer recomputes in the browser.
- Supervisor: dashboard.mjs no longer imports or calls computeSprintProgress or goalPriorityMax. The only grep hit under src/supervisor is a comment in backlog.mjs. Each row pulls /state?summary=1 with a 2s overall timer and a 1MB cap. Pulls start before the bulk bd fetch, so rows run concurrently. The last-good cache is evicted when a sprint leaves the ledger.
- Degradation states: 404, non-JSON or missing summaryVersion shows 'status unavailable'. A summary with no beads entry shows 'no summary yet'. Unreachable shows the last good bar, 'as of' and an 'unreachable' marker, or 'status unavailable' if nothing was ever cached. A runId mismatch is rejected and never cached. All of these are tested against a real stub child in supervisor-dashboard-pulled-summary.test.mjs.
- runId check: production runId equals the sprintId. The spawner forwards --run-id and cli.mjs passes it to createDashboardViewer.
- Port resolution is now one shared child-port.mjs used by both the proxy and the dashboard.
- vre7.3: test-only fix that quotes argv0 for the verbatim CRT round-trip, plus a junction-based test for an exec path containing a space. It passes 3/3 here.

npm test on this host: build OK. Workflow 328/0, client 40/0, apra-pm 489/0, and the generic-boundary guard passes. All sprint-touched suites pass. The run exited 1 on three failures, none in files this branch touches; each is a host or environment problem:
(a) undici-node20-compat: node_modules has undici 7.29.0 but the lockfile pins 7.30.0. Stale install; the branch does not change package.json or the lockfile.
(b) contracts-schema-dist-staleness-guard: the gitignored dist/agents/schemas/planner-output.json is from Aug 20. Its source changed on main in 0c6a4ddb.
(c) phase0-seams-facade and phase1-leaf-facade-completeness: symlinkSync EPERM without symlink privilege. Already tracked as open apra-fleet-9lwv.

Non-blocking findings (filed as newTasks):
1. History view runs saved before this change have no summary key, so they now show 'Required: no summary yet' instead of their progress.
2. The SSE onmessage handler in index.mjs dispatches workflow:state:beads without workflow:summary:beads first. Until the coalesced poll runs, the panel shows the new tasks with the previous summary. This contradicts the ordering comment in viewer-extensions.mjs.

KB promotions: df4bbcbe (my own standalone junction repro on node 22.19) and ff9ae373 (checked against the code and the concurrency test).

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: apra-fleet-44il.
Summary: Informational regression pass at HEAD 89a37c32 (sprint apra-fleet-vre7). Part 1, the real-bd suite, finished all 279 files with 10 failing. Those were mock-sprint-beads-health-gate-empty-remote, mock-sprint-beads-identity, golden-transcript, mock-sprint-parent-child-blocks-cycle-repair, mock-sprint-regression-failure-never-gates, phase0-seams-facade, serve-wiring-integration, vcs-auth-extraction-facade, phase1-leaf-facade-completeness and phase3-dispatch-engine-completeness. Several failures are Windows-environment (symlink EPERM, spawnSync ETIMEDOUT). Wall time was about 116 min (elapsedWall=6988s). phase3-dispatch-engine-completeness alone ran 5720s and then failed, and the budget check flags 41 files over the 300s single-file budget. I started the pass with --fresh because the leftover 2026-09-29 status file referenced files that no longer exist; I saved a copy of it to ~/temp first. The first run was cut off when its background wrapper was killed, and --start resumed it. The slow lane (test:slow) exited 1: dispatch-watchdog-timer-ref passed, and mock-sprint-planner-dispatch-stalled-session failed with bd-replay recording drift (new bead apra-fleet-44il, a recurrence of the closed apra-fleet-ye8j). Part 2: Setup passed (install, server on 18700, supervisor boot, toy clone, sandbox beads seed). The scenario then stopped at step 3a because the auto-mode classifier denied the secret-store write (credential provisioning); I did not work around the block. I ran Teardown to completion (supervisor and server stopped, lock released, sandbox removed). The leftover sandbox-deploy sweep for this sprintId found nothing to tear down. Every Part 1 failure and the Part 2 block matched an existing open carry-over bead, so I appended notes to those rather than filing duplicates: apra-fleet-zekq, x0mr, o4vi, zl0u, vwa2, 0aer, ryk, j48h and f28t. The only new bead is apra-fleet-44il, filed parent-less. This result is informational and does not gate the sprint; the failures carry over to a future sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
