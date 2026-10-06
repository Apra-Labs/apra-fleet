# Sprint Analysis: fix/v05-tasks-view-and-closeout

Scope issue id(s): apra-fleet-5rjh, apra-fleet-dii2, apra-fleet-5u79.
Base branch: v0.5_dashboard.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [8, 11].
High-water-mark closed count this sprint: 14.
Final closed count: 11.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- I reviewed the full diff from v0.5_dashboard to fix/v05-tasks-view-and-closeout (22 files). npm test in packages/apra-fleet-se exits 0, and all the new tests pass: owed-triage, owed-triage-pr-body, sprint-owed-triage-report, mock-sprint-integ-skip-stranded-rollups (3/3), beads-tree-refresh-state, and the supervisor-backlog/tab-activation additions.

apra-fleet-5rjh (beads tree keeps its state across refresh): met.
- Tasks view: viewer-extensions.mjs now renders bead descriptions open from a client-side expandedDescIds set (passed as renderBeadsHtml's 4th argument), so they stay open on a rebuild. Payload-driven rebuilds are skipped when nothing changed and happen at most once per 15000 ms (one delayed render picks up the latest data). Before, the tree rebuilt on every poll: every 400 ms while events flowed, and every 7 s when idle.
- A 'loading' flag stops two fetches for the same description.
- Backlog: backlog.mjs no longer clears collapsedBeadIds on refetch and tracks open descriptions. dashboard.mjs gives the Backlog tab its own 30000 ms refresh threshold (it shared the 3000 ms one).
- Both views have tests for staying open and staying collapsed.

apra-fleet-5u79 (owed triage report): met.
- owed-triage.mjs is a pure module that lists four things: follow-ups no lane will pick up, all-children-closed rollups still open, rejected findings, and beads closed as 'blocked:'.
- runner.js returns owedTriage plus a clean flag (PASS, nothing owed, and the bead read succeeded). A failed bead read is marked incomplete, so it can never count as clean.
- The PR body gets an Owed triage section and a 'PASS is NOT clean' heading.
- 'Closed during this sprint' is decided by comparing against the ids already closed at sprint start, not by clock time.

apra-fleet-dii2 (features stranded when Integration Test is skipped): met via option (b), listing rather than closing.
- When Integration Test is skipped, every all-children-closed feature is named, with the reason (no playbook, or deploy failed).
- A later cycle that does run Integration Test drops the old reason.
- Nothing gets closed automatically.

Things I checked:
- The new render-throttle variables can't be used before they are set: they are only read from event listeners added after they are declared.
- bdListScoped('') returns closed beads too (the snapshot uses bd list --all).
- The new code at sprint start reads from the cached snapshot, so it adds no new bd command.

Secondary findings, filed as new tasks:
1. pr-body.mjs does not limit the size of the owed-triage section. With 25 items I got a 6519-character body. The PR layer then cuts it to the first 3500 characters, which drops part of the triage list and the run-history marker that later runs read back.
2. The stale-reason test in mock-sprint-integ-skip-stranded-rollups.test.mjs only checks the reason inside if (entry), so it passes without checking anything if the feature is not listed.

KB: promoted 77fcfad4. The code index is 202 commits behind HEAD, so I used grep and reading the diff for structural checks.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: I ran the playbook's two parts. Install smoke passed. A fresh install into the throwaway HOME succeeded, and the server booted and was verified bound to scratch port 18700. Teardown then released the lock, stopped the server and deleted the sandbox. In-sprint smoke is NOT RUN: moved to CI, as the playbook specifies. It is reported as failed and no bead was filed for it, so the overall result is passed: false. The leftover sandbox-deploy sweep for this sprint's id found and removed a sandbox directory and its env file. The result is informational and does not gate the sprint. No carry-over beads were filed.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'fleet-mac1' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'fleet-mac1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 3: doer on member 'fleet-mac1' [Streak [apra-fleet-5rjh.1, apra-fleet-5rjh.2, apra-fleet-5rjh.3]] -- kb_* calls: 3, code_* calls: 2.
- Dispatch 4: reviewer on member 'fleet-mac1' -- kb_* calls: 2, code_* calls: 2.
- Dispatch 5: doer on member 'fleet-mac1' [Streak [apra-fleet-5u79.1, apra-fleet-5u79.2, apra-fleet-5u79.3]] -- kb_* calls: 3, code_* calls: 3.
- Dispatch 6: reviewer on member 'fleet-mac1' -- kb_* calls: 1, code_* calls: 2.
- Dispatch 7: doer on member 'fleet-mac1' [Streak [apra-fleet-dii2.1, apra-fleet-dii2.2]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 8: reviewer on member 'fleet-mac1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 9: deployer on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 10: integ-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 11: planner on member 'fleet-mac1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 12: plan-reviewer on member 'fleet-mac1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 13: doer on member 'fleet-mac1' [Streak [apra-fleet-dii2.1, apra-fleet-dii2.2]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 14: reviewer on member 'fleet-mac1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 15: doer on member 'fleet-mac1' [Streak [apra-fleet-dii2.1]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 16: reviewer on member 'fleet-mac1' -- kb_* calls: 1, code_* calls: 0.
- Dispatch 17: deployer on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 18: integ-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 19: reviewer on member 'fleet-mac1' [Final Review] -- kb_* calls: 2, code_* calls: 2.
- Dispatch 20: regression-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.

Per-member totals:
- member 'fleet-mac1': 15 dispatch(es), kb_* calls: 18, code_* calls: 14.
- member 'fleet-mac1-deploy': 5 dispatch(es), kb_* calls: 0, code_* calls: 0.

## Cost

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $19.8506.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0736 across 2 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 21 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```
