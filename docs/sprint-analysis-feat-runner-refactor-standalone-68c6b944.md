# Sprint Analysis: feat/runner-refactor-standalone

Scope issue id(s): apra-fleet-3swo.
Base branch: main.
Cycles run: 5.

## Progress

Closed-bead count history (per cycle evaluation): [83, 88, 88, 89, 93].
High-water-mark closed count this sprint: 95.
Final closed count: 93.
Final open-at-goal-priority count: 6.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- REVIEWED: main..feat/runner-refactor-standalone, 123 commits, 202 files, +45200/-9596. Working tree clean; `npm run build` green (BUILD_EXIT=0).

TWO FAIL REASONS.

(1) THE FULL TEST GATE IS RED. `npm test` exited 1. The apra-fleet-se workspace half is fully green (3411 pass / 0 fail / 451 suites), but the root vitest half failed 1 of 4584: tests/sandbox-deploy.test.ts:202 -- 'live: up / env / teardown across separate invocations > brings a real isolated pair up, locates it from the sprintId alone, and tears it down'. Failure text: '[sandbox-deploy] FAILED (sandbox supervisor did not answer /api/health with pid 30997 on 57321 (EADDRINUSE, or crashed))'. I reproduced in isolation (`npx vitest run tests/sandbox-deploy.test.ts`): 12/12 PASS. So this is contention-dependent, and the mechanism is a real TOCTOU defect, not just noise: scripts/sandbox-deploy.mjs osAssignedPort() (line ~165) binds port 0, reads srv.address().port, CLOSES the socket, and only later hands the number to a separately spawned server. Under the 8-way-concurrent full suite another process can claim the port in that window -- the fleet server got 57320 and came up, the supervisor lost 57321. Every phase gate in this epic is stated as 'full suite green'; on a real full run it is not, and it is not deterministic either, which is worse.

(2) THE SPRINT SCOPE IS NOT CLOSED AT GOAL PRIORITY. Walking parent-child descendants of apra-fleet-3swo recursively (20 descendants), 7 beads at or above the P1/P2 goal priority are still open: apra-fleet-3swo itself (P2 epic), 3swo.6 (P2, Phase 4 feature), 3swo.6.13/.14/.15/.16/.17 (P2, the remaining beads-children / sprint-report / newtask-text / round-session / dispatch-failure / fatal-diagnostics extractions), and 3swo.6.4 (P2) -- which is Phase 4's OWN facade-completeness and move-only VERIFICATION gate. The 12 phase slices landed but the gate that proves they were move-only never ran. Phase 5 (3swo.7, P3) is below goal priority and its absence is correct/deferred.

WHAT I VERIFIED AS GOOD (the landed work is high quality; this is not a rubber-stamp FAIL of the diff itself):
- runner.js 11,678 -> 4,049 lines (238,173 bytes). All 12 phases exist under fleet-sprint/phases/. The dispatchRole engine is real: I executed test/helpers/planning-ladders.mjs and execution-ladders.mjs and both tables now carry ZERO mode:'inline' entries (22 planning-visible dispatches, 14 execution, all routed through the one engine anchor).
- Move-only discipline holds where I could check it: the six Phase 4 slice commits (3bde9c30, 0f4958c0, b7c3b446, 1f67cb32, 5e20f089, 3ab8150c) touch NO mock-sprint*.test.mjs and no runner.js importer -- only phases/*, runner.js, guarded-modules.mjs and the guard baselines. That is what a complete facade looks like.
- The golden-transcript change is explained and bounded, not drift: mock-sprint-happy-path.jsonl drops from 113 to 101 lines and `bd config get sync.remote --json` from 26 to 14 calls, which is exactly the separately-flagged sprint-state.mjs per-sprint hoist (c8501e13).
- install --force (src/cli/install.ts): I traced the failure path, not just the diff. apraFleetPids() snapshots BEFORE the stop, escalates to killApraFleet() only when `stillUp.every(pid => pidsBeforeStop.includes(pid))`, and a pid that appears only afterwards is reported as a supervisor relaunch with the exact stop command instead of being signalled forever. Correct.
- src/tools/vcs-credential-exec.ts: the token is consumed in-process, and redactToken runs on stdout, stderr AND the thrown-error message in the dispatch_failed catch -- the throw path is not the hole it usually is.
- fleet-sprint/vcs-auth.mjs provisionOutcome() now reads structuredContent.ok first and only falls back to /^\[FAIL\]/ prose, closing the retired-emoji false-success.
- guarded-modules-coverage.test.mjs isAccountedFor() now compares full relative paths, with explicit controls asserting phases/index.mjs cannot ride on vcs-providers/index.mjs.
- Hygiene: no scaffold or temp files; the 5 added files outside src/tests are all justifiable (docs, check-generic-boundary.mjs, sandbox-deploy.mjs). Scanning ADDED LINES ONLY, the diff introduces zero non-ASCII characters, honouring the repo ASCII rule (the pre-existing BOM in src/os/windows.ts is on main, not from this branch).

SCOPE NOTE: the branch also carries four merged PRs that are not on main (#461 execute-prompt fork, #470 sandbox deploy, #471 generic-boundary, #472 bd-replay self-heal). They are legitimate work but they are not this epic's, and the failing test came in with #470 -- worth knowing that merging this branch lands them too.

KB: promoted 2 entries I independently re-derived (7386a70c, 223d121a). Explicitly NOT promoted, because measurement contradicts them against this tree: 82189e8d claims runner.js floors at 5,323 lines (it is 4,049); 9a870426 claims 459,143 bytes (it is 238,173); 77194250 (basename collision) and 65e6e503 (retired emoji) both describe defects this sprint has since FIXED; 8b7650ec claims the root vitest suite takes 8-12 minutes (observed 311s). 38065918 I verified only halfway -- the zero-inline-entries half is true, the 'renaming an anchor does not fail the pin' half I did not falsify -- so it stays INFERRED.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Regression test runner failed to return a schema-valid report after repair attempts: [Workflow Error] LLM failed to return parseable JSON for structured output after 3 attempt(s) (2 repair(s) exhausted).
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
