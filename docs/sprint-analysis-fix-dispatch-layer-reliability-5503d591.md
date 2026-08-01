# Sprint Analysis: fix/dispatch-layer-reliability

Scope issue id(s): apra-fleet-iuc.
Base branch: chore/integration-binary-fixes-and-auth-selfheal.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [6].
High-water-mark closed count this sprint: 6.
Final closed count: 6.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- All 6 child beads of apra-fleet-iuc are closed and each acceptance criterion is substantively met. iuc.1: isMaxTurnsSignal (src/providers/claude.ts) detects all four inconsistent max_turns channels and isMaxTurnsResponse (src/providers/provider.ts) is the single classifier both execute-prompt.ts sites use; root cause documented on the bead; no new enum/contract values. iuc.2: src/services/stall/stall-poller.ts fetches OS mtime independently and stall-detector.ts cross-checks it as a strict superset (stall only when content AND mtime agree frozen; fresher mtime prevents false-kill), threshold configurable via STALL_THRESHOLD_MS and documented in docs/stall-detector-resilience.md section 7. iuc.4: findDeadLockPid (src/tools/execute-prompt.ts) self-heals stale busy-locks via local/remote/interactive pid liveness probes, conservative on no-pid; all branches tested. iuc.6: src/providers/agy.ts captures conversation_id as sessionId plus reply text, fixture-based. iuc.3/iuc.5 pin the contracts deterministically with no real CLI/credentials. Build (tsc) green; working tree clean. Full suite: 2864 passed, 4 failed. The 4 failures (tests/eft-41-symlinked-entry.test.ts, tests/workflow.test.ts) are a pre-existing undici/Node 'webidl.util.markAsUncloneable is not a function' incompatibility -- verified identical on the base branch via worktree, unrelated to this sprint's files, not a regression. HARD CONSTRAINT honored: no MCP tool schema/response-contract/reason-enum changes. Footprint: only docs/stall-detector-resilience.md sits outside the declared list, justified by iuc.2's 'documented' criterion. Minor non-blocking nit: 4 newly-added lines introduce non-ASCII em-dashes (comments in src/services/stall/stall-detector.ts and a describe label/comment in tests/stall-detector.test.ts) against the repo ASCII-only convention, though consistent with pre-existing em-dashes in those same files.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: apra-fleet-0v0.
Summary: Ran both parts of the regression pass at branch HEAD. Part 1 (real-bd suite via scripts/run-integ-suites.mjs, npm run test:integration --workspace=@apralabs/apra-fleet-se) completed all 142 files with 30 failures (elapsedWall=279s, cumFileTime=1742s, all files within the 300s single-file budget); the slow lane (npm run test:slow) passed 2/2. Part 2 (fresh sandbox smoke test) got through Setup, member registration, credential provisioning/verification, and canary confirmation (gh-toy-4ef open), but the fleet-sprint workflow dispatch itself crashed on startup before any sprint activity, leaving the canary open with no commit. Both parts trace to the same root cause: Node v20.20.2 is incompatible with the installed undici 8.7.0 ('TypeError: webidl.util.markAsUncloneable is not a function' in undici's CacheStorage), which crashes ~28 real-bd test files, causes 2 more to fail via supervisor-subprocess-boot timeouts, and also crashes the sandbox's own installed CLI when the smoke test tried to run the toy sprint. Filed one standalone, parent-less carry-over bug (apra-fleet-0v0, P0) covering both parts (no duplicate found via bd search). Teardown ran and the sandbox was fully removed. This result is informational only -- it does not gate the current sprint's verdict, and apra-fleet-0v0 carries over to a future sprint to fix.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
