# Sprint Analysis: fix/v05-planner-dedup-and-query

Scope issue id(s): apra-fleet-2mi, apra-fleet-auto-sprint-10.
Base branch: v0.5_dashboard.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [5].
High-water-mark closed count this sprint: 6.
Final closed count: 5.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- FAIL: one of the two scope ids was never worked. The sprint was given apra-fleet-auto-sprint-10, but that id does not exist in beads. The real bead is auto-sprint-10 (P1 bug, OPEN: planner and plan-reviewer query bd list --parent themselves and miss the full-depth scope the orchestrator sees). Its children apra-fleet-ckvs and apra-fleet-ptb4 (both P1) are also OPEN. The diff does not touch phases/plan.mjs, phases/replan.mjs, plan-reviewer.md, _shared/GRAPH-SEMANTICS.md or beads-scope.mjs. The claim of '0 open at goal priority' only counted the 5 apra-fleet-2mi beads, because the bad id was dropped without any error. Half of the requested goal is undelivered.

The apra-fleet-2mi work itself is sound, and nothing needs reopening:
- 2mi.1: validateDedupCheck and validateNewTaskWithDedup (fleet-sprint/abort.mjs) are wired into review.mjs, re-review.mjs and final-review.mjs. A missing or malformed dedupCheck goes through the existing per-item rejection and resurfacing path. 'overlap' checks candidateIds[0] with bd show --json and appends via the staged bd note --file, with no bd create. A closed or missing candidate is rejected. dedupCheck is declared loosely ({}) in the canonical schema and both contracts.mjs fallbacks, so one bad item cannot fail the whole verdict (test/newtask-dedup-check.test.mjs).
- 2mi.4: dedupChecks is required in integ-test-runner-output.json, FALLBACK_integReport, the auto-sprint.js INTEG_RUN_SCHEMA and the synthesized fallback. flagUnverifiedBugDedup sends a WARN and adds a [dedup-unverified] note for a missing entry, a blank query or an 'overlap' verdict, and never fails the sprint.
- 2mi.2: 'ENTIRE backlog' appears in exactly planner.md, reviewer.md and integ-test-runner.md plus CLAUDE.md, AGENTS.md and AGY.md. Rerunning sync-agent-docs.mjs gives no diff. plan-reviewer.md and harvester.md are untouched.
- 2mi.3: test/dedup-evidence-phase-integration.test.mjs drives the real review and integ-test phases and checks all 4 outcomes separately.

Tests:
- packages/apra-fleet-se npm test: 5822 pass, 3 fail, plus 300 pass in the second suite. All 3 failures are in test/i9ag19-7-exec-bd-configured.test.mjs. They come from this host having /usr/bin/node, which the CONTROL tests assume is absent. That is already tracked as apra-fleet-tbup.4, and the diff does not touch exec-bd.
- apra-pm npm test: 489 pass, 0 fail, including auto-sprint-schemas-drift.
- CI was not judged (out of scope).

Minor: the comment in test/dispatch-safety-guard.test.mjs still says 'exactly the two' commands, but the count is now 5.

KB:
- Promoted 1b9672fe after reproducing it with ajv.
- Promoted 5dd9a04c after checking the drift test and how the test runners are chained.

Tool use:
- kb: used (kb_query).
- code: unavailable. The fleet MCP server failed to connect, so I used diff and grep instead.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: Install smoke passed. A fresh install from this checkout ran into the throwaway HOME, the server booted and server.json confirmed it was bound to scratch port 18700, and Teardown released the lock, stopped the server and deleted the sandbox. The leftover sandbox-deploy sweep for this sprintId exited 0 with 'nothing to tear down'. In-sprint smoke is NOT RUN: moved to CI, as the playbook specifies. It needs an LLM credential for the toy member, which an agent cannot provision here. Overall passed is false only because of that unrun part. No bead was filed for it, and no other failures occurred. This result is informational and does not gate the sprint; any filed bugs would carry over to a future sprint as parent-less beads.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB bible

WARNING: bible not published -- these KB confirmations are not in a pushed bible commit on the sprint branch as of this analysis (the harvest round retries once more after it is written):
- github.com/apra-labs/apra-fleet: 2 unpublished confirmation(s).
Bible commits were sealed: final review verdict FAIL.

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'fleet-lin1' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 3: doer on member 'fleet-lin1' [Streak [apra-fleet-2mi.1, apra-fleet-2mi.4, apra-fleet-2mi.2, apra-fleet-2mi.3]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 4: reviewer on member 'fleet-lin1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 5: doer on member 'fleet-lin1' [Streak [apra-fleet-2mi.1]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 6: reviewer on member 'fleet-lin1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 7: deployer on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 8: integ-test-runner on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 9: reviewer on member 'fleet-lin1' [Final Review] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 10: regression-test-runner on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.

Per-member totals:
- member 'fleet-lin1': 7 dispatch(es), kb_* calls: 7, code_* calls: 2.
- member 'fleet-lin1-deploy': 3 dispatch(es), kb_* calls: 0, code_* calls: 0.

## Cost

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $5.8837.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0330 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 10 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```
