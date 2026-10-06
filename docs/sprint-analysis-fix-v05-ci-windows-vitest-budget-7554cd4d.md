# Sprint Analysis: fix/v05-ci-windows-vitest-budget

Scope issue id(s): apra-fleet-3604, apra-fleet-i9ag.22.2.2.
Base branch: v0.5_dashboard.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [6].
High-water-mark closed count this sprint: 8.
Final closed count: 6.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Net diff v0.5_dashboard..fix/v05-ci-windows-vitest-budget reviewed: scripts/run-all-tests.mjs, scripts/sandbox-deploy.mjs, vitest.config.ts (comment), 3 test files, and .fleet/kb-canonical.json (KB bible commit).

apra-fleet-3604 (amended criteria):
(a) MET. buildDefaultSuites() swaps the single vitest suite for vitest-shard-i-of-N suites (npm exec -- vitest run --shard=i/N). N defaults to 3. APRA_TEST_VITEST_SHARDS overrides it, is strictly validated and throws a message naming the variable. N=1 reproduces the legacy argv. Each shard goes through runBounded with its own budget, and a failed shard does not skip later suites.
(b) MET. SUMMARY shows name=status(elapsed/budget). A WARNING line names any suite above 70% of its budget and is repeated just above SUMMARY.
(c) The close notes on apra-fleet-3604.1 just say 'Closed', with no per-shard file counts or timings. I checked it myself instead: local npm test, macOS, exit 0. shard1 171 files/146s, shard2 170/219s, shard3 170/247s, 511 in total = unsharded vitest list count (511). tests/run-all-tests-vitest-shards.test.ts also checks disjointness and completeness through vitest's BaseSequencer.shard(). The evidence exists, so I am not reopening. The Windows CI median is out of scope (informational only, per the amendment).
Tests cover enumeration, the override, an invalid value (real subprocess), APRA_TEST_SUITES_JSON bypass, failure isolation and headroom (fake timers). The suite-enumeration test now stubs env so a caller's settings cannot leak in.

apra-fleet-i9ag.22.2.2: MET. teardown() step 1 now uses probeJson. A non-2xx answer pushes 'failed: HTTP 401 (bearer token rejected); graceful /api/shutdown skipped' into problems. stopOwned also adds describeProbeFailure to its not-ours message. The 'const h =await' nit is gone. Two new tests use a fake supervisor: 401 is named, no POST /api/shutdown, recorded pid still killed; 200 still shuts down gracefully.

Secondary finding (not blocking, filed as a new task): a 401 now makes teardown throw even after stopOwned has killed the recorded supervisor pid. The sandbox root and values file are kept, and inside up()'s port-conflict retry loop this sets tornDown=false, so the bind retry is abandoned. This matches the bead's literal ask, but the severity is worth revisiting.

Suite: npm run build OK; npm test exit 0, every suite ok and none above 70% of its budget (max apra-fleet-se 258s/900s). No lint script is configured. The changed files are ASCII-only. The untracked fleet-wintask-* files in the repo root are stale artifacts from a test already fixed on base (#647), not from this branch.

Tools: kb_query used (CONFIRMED entry ab555137 on getJson swallowing 401 matches this fix). code_impact used on teardown (index 194 commits behind; callers up()/CLI confirmed by reading the code).

KB: promoted 5ac0acf9 after verifying it against the code and the 401 test.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: I ran Install smoke and it passed: a fresh install into ~/temp/.apra-fleet-tests, the fleet server booted and bound to scratch port 18700, then stopped, with the sandbox deleted. Teardown ran and exited 0. The sprint-deploy sweep (sandbox-deploy.mjs teardown with the dispatch sprintId) reported nothing to tear down. In-sprint smoke is NOT RUN: moved to CI. The playbook requires it to be reported as passed:false, so overall passed is false. No bead was filed for it, and no bead was filed for anything else. This result is informational and does not gate the sprint. A leftover directory, ~/temp/.apra-fleet-tests-9te45, exists from some earlier run; it is not this run's sandbox and I did not touch it.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'fleet-mac1' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'fleet-mac1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 3: planner on member 'fleet-mac1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 4: plan-reviewer on member 'fleet-mac1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 5: doer on member 'fleet-mac1' [Streak [apra-fleet-3604.1, apra-fleet-3604.2]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 6: doer on member 'fleet-mac1' [Streak [apra-fleet-i9ag.22.2.2.1, apra-fleet-i9ag.22.2.2.2]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 7: reviewer on member 'fleet-mac1' -- kb_* calls: 2, code_* calls: 2.
- Dispatch 8: deployer on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 9: integ-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 10: reviewer on member 'fleet-mac1' [Final Review] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 11: regression-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.

Per-member totals:
- member 'fleet-mac1': 8 dispatch(es), kb_* calls: 7, code_* calls: 5.
- member 'fleet-mac1-deploy': 3 dispatch(es), kb_* calls: 0, code_* calls: 0.

## Cost

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $4.9894.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0297 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 11 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```
