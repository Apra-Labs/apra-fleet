# Sprint Analysis: fix/contrib-sprint-engine-bugs

Scope issue id(s): apra-fleet-p6f4, apra-fleet-g4ro.
Base branch: feat/kb-redesign.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [26].
High-water-mark closed count this sprint: 34.
Final closed count: 26.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Net diff origin/feat/kb-redesign...HEAD reviewed (52 files). Each scope bead's criteria map to specific code:
- p6f4.1: orphan-reclaim.mjs plus runner.js reclaimInRunOrphanedClaims. Fresh bd show before the write, killIfAlive before re-lane, --if-status in_progress guarded write. Claims held by other sprints (structured reason) are never touched; per-bead cap is surfaced in the final notes.
- p6f4.3: review.mjs reviewScopeBeadIds unions the engine-verified closedIds and skips publishBlocked/postDispatchSyncFailed.
- p6f4.4: execute-prompt.ts returns and records sessionId on max_turns/auth/server/overloaded/nonzero_exit, empty_response and dispatch_failed. Client JSDoc updated. dispatch-role same-session resume uses the explicit id, never resume:true. It falls back to a fresh full-prompt session when there is no id or on session_not_found.
- p6f4.5: member-sync salvageBeforeReset pins commits and tracked WIP on a local fleet-salvage/ ref and fails closed. Real-git test included.
- p6f4.2: verify-block.mjs pre-sprint stop, mid-run exit and FAIL verdict gate.
- p6f4.6: Cost block removed from the harvester-committed analysis, kept in the PR body.
- p6f4.7: leading dashes stripped from newTask titles; original title kept in the description.
- g4ro: deploy.md has no $(...)/loops; logic moved to scripts/deploy-install.mjs, guarded by tests/deploy-md-commands.test.ts.

Tests (local): build OK. apra-fleet-se SUMMARY pass=5121 fail=0; client 119/0; workflow 363/0; apra-pm 489/0. Vitest: 7024 passed, 1 failed. The failure is tests/windows-hide-spawn-guard.test.ts and is environmental: the local node_modules has @modelcontextprotocol/sdk 1.27.1, the lockfile pins 1.32.1, and no package file is touched by this diff. It matches the sprint's own 7025/0 run.

Secondary finding (filed as a new task, not blocking): runner.js D5 and the new mid-run verify-block exit both key on integCanRunThisCycle. So when only verify-routed beads remain, a single transient deploy failure now ends the sprint FAIL with no deploy retry. Before, the next cycle redeployed. This bypasses the DEPLOY_RETRY_CYCLE_LIMIT budget. p6f4.2's criteria literally ask for this, so it is not a reopen.

Not checkable here: g4ro's second criterion (live POSIX deploy under headless CLI 2.1.296+). Epic p6f4 is still open with 7/7 children closed and is eligible for close.

ToolUse: kb used (kb_query). code unavailable: E-CODE-INDEX-NOT-READY (gitnexus index incomplete); fell back to the diff and grep. KB entry a1a279ec (CONFIRMED, flagged_for_review) matches review.mjs reviewScopeBeadIds as read; looks correct. No promotion candidates block was supplied.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: I ran the regression playbook against branch HEAD. The Install smoke part passed. A fresh install from this checkout into the throwaway sandbox HOME exited 0. The fleet server started on scratch port 18700, and the sandbox lock was marked with the server PID. `status` reported running, and `server.json` confirmed the server was bound to 18700 with no rebind. Teardown then released the lock, stopped the server and deleted the sandbox, and the sandbox directory is gone. Before Setup, the leftover sandbox-deploy sweep for sprint apra-fleet-p6f4-2-b6bc01-7ec5f940 exited 0 with 'nothing to tear down', so no isolated test instance from this sprint's deploy was still up. The In-sprint smoke part is NOT RUN: moved to CI. Per the playbook, I reported it as passed: false and returned overall passed: false, and I filed no bead for it. No failures occurred, so no carry-over beads were filed. This result is informational and does not gate the sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'fleet-win1' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'fleet-win1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 3: doer on member 'fleet-win1' [Streak [apra-fleet-p6f4.1.1, apra-fleet-p6f4.1.2, apra-fleet-p6f4.2.1, apra-fleet-p6f4.2.2]] -- kb_* calls: 4, code_* calls: 4.
- Dispatch 4: doer on member 'fleet-win1' [Streak [apra-fleet-p6f4.4.1, apra-fleet-p6f4.4.2]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 5: doer on member 'fleet-win1' [Streak [apra-fleet-g4ro.1, apra-fleet-g4ro.2]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 6: doer on member 'fleet-win1' [Streak [apra-fleet-p6f4.7.1, apra-fleet-p6f4.7.2]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 7: reviewer on member 'fleet-win1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 8: doer on member 'fleet-win1' [Streak [apra-fleet-p6f4.5.1, apra-fleet-p6f4.5.2]] -- kb_* calls: 1, code_* calls: 2.
- Dispatch 9: doer on member 'fleet-win1' [Streak [apra-fleet-g4ro.1]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 10: reviewer on member 'fleet-win1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 11: doer on member 'fleet-win1' [Streak [apra-fleet-p6f4.3.1, apra-fleet-p6f4.3.2, apra-fleet-p6f4.4.3, apra-fleet-p6f4.4.4, apra-fleet-p6f4.6.1, apra-fleet-p6f4.6.2]] -- kb_* calls: 2, code_* calls: 0.
- Dispatch 12: reviewer on member 'fleet-win1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 13: deployer on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 14: integ-test-runner on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 15: reviewer on member 'fleet-win1' [Final Review] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 16: regression-test-runner on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.

Per-member totals:
- member 'fleet-win1': 13 dispatch(es), kb_* calls: 13, code_* calls: 10.
- member 'fleet-win3': 3 dispatch(es), kb_* calls: 0, code_* calls: 0.

## Cost

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $112.2243.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.5174 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 18 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```
