# Sprint Analysis: feat/workflow-pause-resume

Scope issue id(s): apra-fleet-p2to.
Base branch: main.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [10, 13].
High-water-mark closed count this sprint: 17.
Final closed count: 13.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

1 newTask(s) rejected before reaching bd create: C2: title fails safe-character allowlist /^[A-Za-z0-9 .,:;!?()'_/\[\]-]+$/ (or is empty): "Add test coverage for the #393 Windows stall-poller PowerShell fix (and re-check fetchMtimeMs null path)"

## Final verdict

PASS -- Reviewed net diff main..feat/workflow-pause-resume against all 4 p2to children (13 beads in scope). All acceptance criteria are reflected in concrete code and pass their tests.

ENGINE (p2to.1, packages/apra-fleet-workflow/src/workflow/index.mjs): requestPause/requestResume/setPauseGuard added as siblings of requestStop; _pauseGate() awaited at the top of agent()/command() before _enterActivity(), so in-flight can drain to zero; 'paused' is emitted only from _maybeEngagePause() (guaranteed zero-in-flight); guard fails closed on throw; requestStop() rejects all _pauseWaiters with CancelledError (traced: a paused run unwinds instead of hanging). Failure paths verified sound.

VIEWER (p2to.2, viewer/index.mjs): POST /pause + /resume forward to the engine only; state.pause is driven exclusively by engine 'pause:requested'/'paused'/'resumed' events; button state machine + 'paused since' badge derive from state, not the click. Correct.

SUPERVISOR (p2to.3): proxy.mjs adds /pause + /resume live-proxy routes (never the kill+force-release path Stop uses); watchdog.mjs adds PAUSED as a 6th live/non-terminal status via probeChildPauseStatus() -- probe failure resolves null and is never conflated with 'paused' (traced); dashboard.mjs adds Pause/Resume row buttons + base-drift indicator via computeBaseDrift() (uses execFile with an arg array -- no shell injection; null 'unknown' rendered distinctly from 0).

FLEET-SPRINT (p2to.4, runner.js + errors.mjs + cli.mjs): clean-state pause guard via openSyncBracketCount (withGitSync body + standalone DoltSync brackets via withOpenSyncBracket, all try/finally balanced); reservation releaseForPause()/reReserveForResume() with owner-checked re-acquire and partial-rollback on failure, throwing MemberReservationResumeError naming unavailable members; resyncReacquiredMember() unconditional git fetch + decideEnsureBranchAction probe + bd dolt pull; commandResultToSoftGit() correctly derives ok from real exit code (verified the merge-base --is-ancestor concern). Wired to workflow.on('paused'/'resumed') in cli.mjs.

Build: clean. Tests: root 3081 pass/0 fail, SE 138 pass, workflow 24 pass. Tree clean. No p2to bead needs reopening.

SECONDARY FINDINGS (see newTasks): (1) commit 4ca0ff01 stall-poller #393 fix is bundled on this branch but is outside p2to scope and ships with NO new test coverage for the changed Windows PowerShell one-liners; fetchMtimeMs also dropped its `if ($i)` null guard. (2) Resume re-reserve/resync is a documented best-effort async task racing the first post-resume dispatch (engine emits 'resumed' synchronously), relying on execute_prompt's dispatch-time reservedBy check as the real guard. (3) Minor: the member-arg guard is now duplicated in both command() and _commandDispatch().

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: apra-fleet-47u1.
Summary: Ran a full regression pass at branch HEAD. Part 1 (real-bd suite): npm run test:integration --workspace=@apralabs/apra-fleet-se completed 180/180 files with 1 failure (f34-concurrent-launch-engagement-integration.test.mjs, matching existing carry-over apra-fleet-mmxx, note added); the slow lane (npm run test:slow) ran 2/2 files with 1 pass and 1 failure (mock-sprint-planner-dispatch-stalled-session.test.mjs, a bd-replay recording-drift/watchdog-timeout failure reproduced in a verified clean environment this time, matching existing carry-over apra-fleet-x1c, note added); a stale leftover integ-suite-status.json also required --fresh recovery before Part 1 could start, matching existing carry-over apra-fleet-m1n, note added. Part 2 (smoke test): Setup (install, server start, toy-repo clone/seed, sandbox-isolation checks) and Test scenario steps 1-3b (member registration, canary confirmation, credential provisioning/verification) all succeeded, but step 4's actual toy sprint launch failed immediately with a DoltSyncError ('bd: not found', exit 127) before any Planner dispatch -- traced to the local-member clean-env PATH-reconstruction mechanism (src/os/linux.ts getCleanEnv()/CLI_PATH) not resolving bd/claude when they are installed via nvm rather than a standard system path; filed as a new standalone carry-over bug apra-fleet-47u1 (P0). The canary gh-toy-4ef remained open and no sprint branch was created as a direct consequence. Teardown (stop server, delete sandbox) ran and was verified clean regardless of outcome. This result is purely informational: it does not gate the current sprint's PASS/FAIL verdict, and every filed/updated bug is a pre-existing, parent-less carry-over for a future sprint to pick up.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
