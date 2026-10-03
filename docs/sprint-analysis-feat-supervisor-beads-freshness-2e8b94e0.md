# Sprint Analysis: feat/supervisor-beads-freshness

Scope issue id(s): apra-fleet-417.11.
Base branch: main.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [6, 9].
High-water-mark closed count this sprint: 12.
Final closed count: 9.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Scope: apra-fleet-417.11 (3 features, 6 tasks, all closed). Local main is 48 commits behind origin/main, so main..branch also pulls in 39 commits that were already merged. I reviewed the net diff origin/main..feat/supervisor-beads-freshness instead: 9 commits, 9 files, +1607/-12, all under packages/apra-fleet-se.

Acceptance criteria, checked against the code:
- Cached view (src/supervisor/beads-view.mjs): it reuses the engine's doltPullBefore remote-tip fingerprint and runs it on the backlog member, whose work folder is repoRoot. bd list runs with cwd=repoRoot. When the tip is unchanged it does no pull and no re-list, but still calls setScopeFreshness. Only one refresh runs at a time. A lock or busy error skips the round (maxTransientRetries 0). If a pull succeeds but the list after it fails, a re-list stays owed (listPending), so the cache cannot report stale rows as fresh. The command adapter fails closed when execute_command returns no exit code. Tested: unchanged tip, changed tip, lock skip, 5 concurrent refreshes cause 1 pull, timeout_s forwarding.
- Launch guard (serve.mjs createLaunchScopeGuard / composeBeforeLaunch): freshForLaunch always re-lists inside the same call. Busy skips are retried within one deadline. A BeadsViewUnavailableError maps to 503 with the reason. Tests use a poisoned cache in both directions and cover pull error, list error, degraded member, timeout on a fake clock and busy exhaustion. They also check that a 503 never reserves or spawns.
- Dashboard and backlog (createBeadsBackedViews): both read snapshot() only and kick refreshIfStale(15s) without blocking. GET /state carries beadsFreshness, and the page renders 'Beads as of', a visible error notice and a separate busy note. A test proves 10 /state polls cause no extra bd list calls.
- The supervisor performs no bead mutations, so it needs no invalidate-on-mutation hook (grep-verified).
- The diff is ASCII only, no bead ids appear in runtime strings, and every file is justified by the sprint tasks.

Tests: the build passed. All 70 cases in the new and changed test files pass. 3 vitest and 3 node:test failures are local to this machine and outside the diff: (1) the ASCII gate trips on uncommitted local AGENTS.md/CLAUDE.md edits; (2) phase0/phase1 facade tests hit Windows symlink EPERM; (3) sprint-state slices runner.js by '\n}\n' on a CRLF checkout; (4) a check-sandbox-sync-remote case timed out (20s). This branch touches none of those files.

One follow-up is filed as a new task: the dashboard can lag behind beads that sprint children change in the shared clone without pushing. The launch path is not affected because it always re-lists.

KB: promoted 59499fc5 (reproduced: node:test cancels a test that waits only on an unref'd timer) and 483f8ab3 (confirmed in fleet-members.mjs and api.mjs).

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: apra-fleet-wk8e, apra-fleet-hb3a.
Summary: Informational regression pass at HEAD 411725e9; it does not gate the sprint's verdict. Part 1 (real-bd suite): a leftover integ-suite-status.json from before the last three HEAD commits was stale, so I used --fresh. The run covered 288 of 288 files and 10 failed: golden-transcript, mock-sprint-beads-health-gate-empty-remote, mock-sprint-beads-identity, mock-sprint-parent-child-blocks-cycle-repair, mock-sprint-regression-failure-never-gates, mock-sprint-sprint-state-client-hoist, phase0-seams-facade, phase1-leaf-facade-completeness, phase3-dispatch-engine-completeness and vcs-auth-extraction-facade. The run was interrupted once at 125 of 288 files, because the tool call that started it was killed and took the detached run with it. I resumed it with --start, which keeps the recorded results, so the first 125 files ran under the earlier session's load. The slow lane (npm run test:slow) exited 1: mock-sprint-planner-dispatch-stalled-session failed at setup with bd-replay recording drift, and dispatch-watchdog-timer-ref passed. Every Part 1 failure maps to an already-open carry-over bead (zekq, x0mr, zl0u, vwa2, 0aer, o4vi, 9cok, 44il), so I appended this run's evidence to those instead of filing duplicates. Part 2 (smoke test): Setup, credential provisioning, member registration and the canary check all passed. The playbook's first POST /api/sprints returned HTTP 503. The supervisor had booted with an empty registry, list_members returned non-JSON, and the backlog member stayed degraded until its 30s retry. That is a recurrence of closed apra-fleet-ky2l.7, filed as apra-fleet-wk8e (P2). A retry launched the sprint (HTTP 201), but it was still running at the 280s supervisor-uptime bound, with Develop R1 failing all streaks and the member missing a VCS provider. I filed that as apra-fleet-hb3a (P1). Step 5 assertions (canary closed, branch commit, --version output) were not verified. My poll script also hit an 'Argument list too long' error on the large sprint-state JSON, so terminal detection never worked in my wrapper; the sprint was still running at 04:12:03Z regardless, but I did not get a clean run to a terminal state. The supervisor's shutdown left the sprint child (port 8082) alive, holding the sandbox's toy-backlog directory open. Teardown's rm -rf failed with 'Device or resource busy' until I cleared the port with scripts/kill-port.mjs, then removed the sandbox. The sandbox is gone, ports 18700/18701/8082/3001 are free, and the sandbox-deploy sweep found nothing to tear down. Both new beads are parent-less carry-overs.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
