# Sprint Analysis: fix/rel-044-critical

Scope issue id(s): apra-fleet-assv.
Base branch: main.
Cycles run: 7.

## Progress

Closed-bead count history (per cycle evaluation): [26, 37, 44, 44, 45, 45, 47].
High-water-mark closed count this sprint: 61.
Final closed count: 47.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Final review of fix/rel-044-critical. Local main is about 2 weeks behind origin/main, so I reviewed the real change: origin/main...branch, 38 commits, 133 files. I checked each of the 14 children against the diff. Deploy-failure gate: deploy.mjs latestDeployFailure and applyDeployFailureVerdictGate, runner.js satisfied-exit gating, final-review override. D-push and G-push landed checks: dolt-sync confirmPushLanded, member-sync checkGitPushLanded. execute_command now returns isError with exitCode -1 on timeout or transport failure, read by commandFailureOf in the client and in workflow command(). Also checked: reopen gate worked-on exemption and red-branch fix task; below-goal dispatch filter; beads setup and permission-config preflight; Claude permission_denials heal; OAuth-expired auth pattern; cache-token pricing end to end; SFTP inactivity timeout and refused-channel close; FLEET_PID for installer and VCS exec; TOFU warning log; bounded sprint id and log stem; boundChildEnv; Windows spawn-limit message; schema-migration publish on D-pull; launcherPathFor POSIX fix. Each child's acceptance criteria are met by specific lines in the diff. The client was updated in step with the tool changes. Added lines are ASCII-only. No stray files are in the diff.

Tests (run locally after build): vitest 402 files, 5679 passed; apra-fleet-client 89/89; apra-fleet-workflow 355/355; apra-fleet-se 4015 pass, 0 fail; apra-pm 489/489. The 156 leaked \tmp\fleet-wintask files and the C:\ dir in the repo root all predate fix 36b96ed5, and my run added none. CI is out of scope.

No blocking defects. Follow-ups filed as newTasks: (1) a failed deploy.md probe clears the deploy-failure gate; (2) any Claude permission_denials entry, even an incidental one, now fails the dispatch, and a second one ends the sprint; (3) FLEET_PID wrapping of VCS exec and the installer widens a shared per-member stored-PID slot; (4) boundChildEnv drops every non-protected var even when that cannot get the block under the cap; (5) token-unit budgets now count cache-read tokens 1:1. Minor: in supervisor/api.mjs the ApiError JSDoc now sits above MAX_SPRINT_ID_LENGTH.

KB: promoted 7 entries I verified against the code (see kb_promotions). Left a1220246 (no-op push) INFERRED: it needs a live remote to verify. Tool use: kb used (kb_session_prime, kb_query). code used (code_impact), but the index was 38 commits behind HEAD and could not resolve the new symbols, so I fell back to reading the diff and grep.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: Ran the regression playbook at branch HEAD. Install smoke passed. The sandbox lock was acquired, a fresh install into the throwaway HOME exited 0, and the server started on scratch port 18700. status reported running, and server.json confirmed the server was bound to 18700. Teardown then released the lock, stopped the server and deleted the sandbox, all with exit 0. The leftover sandbox-deploy sweep for this sprint's id found nothing to tear down. In-sprint smoke is NOT RUN: moved to CI. The playbook defines it that way because the toy sprint needs an LLM credential that an agent cannot provision here. Overall passed is false because that part is reported as not passed. No bead was filed for it, and no other failures occurred, so bugsFiled is empty. This result is informational and does not gate the sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'fleet-lin1' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 3: doer on member 'fleet-lin1' [Streak [apra-fleet-b4g.91.1, apra-fleet-b4g.91.2]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 4: doer on member 'fleet-lin1' [Streak [apra-fleet-o9k8.1, apra-fleet-o9k8.2, apra-fleet-o9k8.3]] -- kb_* calls: 2, code_* calls: 2.
- Dispatch 5: doer on member 'fleet-lin1' [Streak [apra-fleet-7me1.1, apra-fleet-7me1.2]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 6: reviewer on member 'fleet-lin1' -- kb_* calls: 2, code_* calls: 2.
- Dispatch 7: doer on member 'fleet-lin1' [Streak [apra-fleet-b4g.86.1, apra-fleet-b4g.86.2, apra-fleet-b4g.90.3, apra-fleet-b4g.90.4]] -- kb_* calls: 2, code_* calls: 1.
- Dispatch 8: doer on member 'fleet-lin1' [Streak [apra-fleet-b4g.132.1, apra-fleet-b4g.132.2, apra-fleet-b4g.99.1, apra-fleet-b4g.99.2, apra-fleet-b4g.84.1, apra-fleet-b4g.84.2]] -- kb_* calls: 2, code_* calls: 0.
- Dispatch 9: reviewer on member 'fleet-lin1' -- kb_* calls: 1, code_* calls: 2.
- Dispatch 10: doer on member 'fleet-lin1' [Streak [apra-fleet-b4g.83.1, apra-fleet-b4g.83.2, apra-fleet-b4g.83.3]] -- kb_* calls: 5, code_* calls: 4.
- Dispatch 11: reviewer on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 12: deployer on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 13: integ-test-runner on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 14: planner on member 'fleet-lin1' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 15: plan-reviewer on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 16: doer on member 'fleet-lin1' [Streak [apra-fleet-assv.1.1, apra-fleet-assv.1.2, apra-fleet-assv.1.3]] -- kb_* calls: 3, code_* calls: 4.
- Dispatch 17: reviewer on member 'fleet-lin1' -- kb_* calls: 2, code_* calls: 2.
- Dispatch 18: doer on member 'fleet-lin1' [Streak [apra-fleet-assv.2.1, apra-fleet-assv.2.2, apra-fleet-assv.2.3]] -- kb_* calls: 2, code_* calls: 2.
- Dispatch 19: reviewer on member 'fleet-lin1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 20: doer on member 'fleet-lin1' [Streak [apra-fleet-assv.2.1]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 21: doer on member 'fleet-lin1' [Streak [apra-fleet-b4g.102.1, apra-fleet-b4g.102.2]] -- kb_* calls: 1, code_* calls: 2.
- Dispatch 22: reviewer on member 'fleet-lin1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 23: deployer on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 24: integ-test-runner on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 25: planner on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 26: plan-reviewer on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 27: doer on member 'fleet-lin1' [Streak [apra-fleet-b4g.83.2]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 28: doer on member 'fleet-lin1' [Streak [apra-fleet-b4g.90.1, apra-fleet-b4g.90.2]] -- kb_* calls: 1, code_* calls: 2.
- Dispatch 29: reviewer on member 'fleet-lin1' -- kb_* calls: 2, code_* calls: 2.
- Dispatch 30: doer on member 'fleet-lin1' [Streak [apra-fleet-b4g.135.1, apra-fleet-b4g.135.2]] -- kb_* calls: 2, code_* calls: 3.
- Dispatch 31: reviewer on member 'fleet-lin1' -- kb_* calls: 1, code_* calls: 2.
- Dispatch 32: deployer on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 33: integ-test-runner on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 34: planner on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 35: plan-reviewer on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 36: deployer on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 37: integ-test-runner on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 38: reviewer on member 'fleet-lin1' -- kb_* calls: 1, code_* calls: 2.
- Dispatch 39: planner on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 40: plan-reviewer on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 41: doer on member 'fleet-lin1' [Streak [apra-fleet-assv.3]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 42: reviewer on member 'fleet-lin1' -- kb_* calls: 2, code_* calls: 1.
- Dispatch 43: deployer on member 'fleet-lin1-deploy' -- kb_* calls: 1, code_* calls: 0.
- Dispatch 44: integ-test-runner on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 45: planner on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 46: plan-reviewer on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 47: deployer on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 48: integ-test-runner on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 49: reviewer on member 'fleet-lin1' -- kb_* calls: 2, code_* calls: 2.
- Dispatch 50: planner on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 51: plan-reviewer on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 52: planner on member 'fleet-lin1' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 53: plan-reviewer on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 54: deployer on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 55: integ-test-runner on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 56: reviewer on member 'fleet-lin1' -- kb_* calls: 2, code_* calls: 1.
- Dispatch 57: reviewer on member 'fleet-lin1' [Final Review] -- kb_* calls: 2, code_* calls: 3.
- Dispatch 58: regression-test-runner on member 'fleet-lin1-deploy' -- kb_* calls: 1, code_* calls: 0.

Per-member totals:
- member 'fleet-lin1': 43 dispatch(es), kb_* calls: 50, code_* calls: 44.
- member 'fleet-lin1-deploy': 15 dispatch(es), kb_* calls: 2, code_* calls: 0.

## Cost

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $60.2206.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.2812 across 7 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 58 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```
