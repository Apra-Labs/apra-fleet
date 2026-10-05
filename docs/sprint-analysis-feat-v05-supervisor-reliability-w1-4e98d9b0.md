# Sprint Analysis: feat/v05-supervisor-reliability-w1

Scope issue id(s): apra-fleet-tbup, apra-fleet-xv53, apra-fleet-oiuf.
Base branch: v0.5_dashboard.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [8, 12].
High-water-mark closed count this sprint: 16.
Final closed count: 12.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed the net diff v0.5_dashboard..feat/v05-supervisor-reliability-w1 (9cf735e6) against each bead's criteria.

tbup (AC3): fleet-sprint/git-topology.mjs adds commandResultStdout(). It prefers structuredContent.stdout, falls back to the text minus the 'Exit code: N' line, turns CRLF into LF, and throws with the exit code on a non-zero exit or isError. bin/cli.mjs runCommand now uses it for all three probes, and checkMemberTopology is unchanged. test/tbup-synced-topology-two-member.test.mjs covers synced pass, legacy refusal, a non-zero exit that names the member, and a raw-envelope control that fails. AC1-2 were already pinned by supervisor-api-sync-argv.test.mjs. A live two-machine launch is left to integ/regression, as the plan says.

xv53 (A6): watchdog.mjs readTerminal() prefers extensions.terminal.terminalReason over the top-level value the viewer overwrites. It is used by formatFinishedDetail and defaultRecordFinished. The new terminal-reasons.mjs class table keeps RELAUNCH_GATE_REASONS exactly {BEADS_SYNC_CONFLICT}, and history.mjs derives from it. The k7b8 integration fixture now seeds the real engine+viewer shape and asserts the top-level value is NOT the reason. mvp-a6-relaunch-gate passes.

oiuf (A9 holder): dolt-mutex.mjs persists the holder to <dataDir>/mutex.json on grant, renew, release and reclaim. Writes go through a serialized tmp+rename chain and a write failure is logged, never thrown. start() restores the holder and drops it with a log line if the lease expired or the pid is dead; corrupt JSON or an unknown version gives a warning and no holder. stop() leaves the file and waits for queued writes. Other changes: a 503 supervisor-stopping response with retryable:true, renew answers 409 not-holder, and acquire is idempotent only for the live holder's token on the same sprintId. Every criterion in oiuf.1.1-1.3 has a test (supervisor-dolt-mutex 34 pass, mvp-a9 3 pass). Existing mutex tests were only changed to use temp dataDirs, not in their assertions. Epic oiuf is still OPEN but all its children are closed, so it can be closed.

Tests: the build passes. npm test exited 1. The failures are contracts-schema-dist-staleness-guard (local dist/ needs dist-pm), i9ag19-7-exec-bd-configured CONTROL x2 (node still found under an emptied PATH on this host), and vitest config load (packages/apra-fleet-shell-ui is missing @vitejs/plugin-react). This branch changes none of those files or their imports. All 13 suites touched by the sprint passed.

Hygiene: the .fleet/kb-canonical.json churn comes from the workflow's KB bible commits. No stray files.

KB: promoted e1e30a69 (checked against the diff and coordination.mjs).
ToolUse: kb used (kb_query); code used (code_impact; the index was one commit behind HEAD and createDoltMutex was not found, so I traced callers with grep: only bin/serve.mjs:758 and tests).

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: Ran the regression playbook at branch HEAD (e0dc338d). Permissions were covered by the merged settings. The leftover sandbox-deploy sweep for this sprint id reported nothing to tear down. Install smoke passed and its Teardown completed cleanly. In-sprint smoke is NOT RUN: moved to CI. The playbook requires reporting it as passed: false, so overall passed is false. No bead was filed for it, as the playbook directs, and no other failures were found, so no carry-over beads were filed. This result is informational and does not gate the sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'fleet-lin1' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 3: doer on member 'fleet-lin1' [Streak [apra-fleet-oiuf.1.1, apra-fleet-oiuf.1.2, apra-fleet-oiuf.1.3]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 4: doer on member 'fleet-lin1' [Streak [apra-fleet-tbup.1, apra-fleet-tbup.2]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 5: doer on member 'fleet-lin1' [Streak [apra-fleet-xv53.1.1, apra-fleet-xv53.1.2, apra-fleet-xv53.1.3]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 6: reviewer on member 'fleet-lin1' -- kb_* calls: 1, code_* calls: 2.
- Dispatch 7: doer on member 'fleet-lin1' [Streak [apra-fleet-oiuf.1.2, apra-fleet-oiuf.1.3]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 8: doer on member 'fleet-lin1' [Streak [apra-fleet-oiuf.1.2, apra-fleet-oiuf.1.3]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 9: deployer on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 10: integ-test-runner on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 11: planner on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 12: plan-reviewer on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 13: doer on member 'fleet-lin1' [Streak [apra-fleet-oiuf.1.2, apra-fleet-oiuf.1.3]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 14: reviewer on member 'fleet-lin1' -- kb_* calls: 2, code_* calls: 2.
- Dispatch 15: deployer on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 16: integ-test-runner on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 17: reviewer on member 'fleet-lin1' [Final Review] -- kb_* calls: 1, code_* calls: 2.
- Dispatch 18: regression-test-runner on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.

Per-member totals:
- member 'fleet-lin1': 13 dispatch(es), kb_* calls: 10, code_* calls: 9.
- member 'fleet-lin1-deploy': 5 dispatch(es), kb_* calls: 0, code_* calls: 0.

## Cost

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $8.5571.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0618 across 2 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 18 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```
