# Sprint Analysis: fix/blocked-set-aside

Scope issue id(s): apra-fleet-1zfd.
Base branch: main.
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

PASS -- Final review of apra-fleet-1zfd (children .1-.4), net diff origin/main...fix/blocked-set-aside: 6 sprint commits. The local main is stale; the merge base is origin/main 8c38f937.

Acceptance criteria:
- Rule 1 (set aside a BLOCKED bead and its dependents): met. phases/develop.mjs recordDoerBlocked takes the blocked ids from the doer's new blockedIds field, or from the one bead still open, and never parses notes. beads-scope.mjs openBlocksDependents follows only 'blocks' edges and skips closed beads and parent-child edges. I checked that real `bd list --all --json` output includes those edges. Other beads in the same streak go back to the ready pool. Test: mock-sprint-doer-blocked-set-aside.
- Rule 2 (deploy set aside after a Permissions failure): met. phases/deploy.mjs records sprintState.deploySetAside only when the deployer returns failedStep 'permissions'. runner.js then skips the deployer in later cycles, and latestDeployFailure still reports the failure, so the deploy verdict gate keeps working. Deployer prompt and schemas are updated.
- Rule 3 (immediate stall): met. set-aside.mjs evaluateSetAsideStall is pure. runner.js throwIfSetAsideStall runs at the start of a round and at Cycle Evaluation, before the 2-cycle stall check. blockerIds and blockerReasons name every set-aside bead and 'deploy'. The 2-cycle stall path also names set-aside beads now.
- Rule 4 (report): met. A 'Set aside this run' section appears in the PR body (publish and abort paths) and the sprint analysis, and is left out when nothing was set aside.
- Tests: the design's scenarios pass (mock-sprint-blocked-stall-cycle1 a/c/d, set-aside-stall, deploy-permissions-set-aside). Existing tests that relied on BLOCKED being retried now use a bead left open without BLOCKED, which still covers the retry path; nothing was weakened.
- OS-neutral: the new code is pure JS with no shell, path or process assumptions.

Verification: `npm run build` exit 0. `npm test` at the repo root exit 0: vitest 513 test files passed, 10 skipped; apra-fleet-se about 5301 PASS, 0 FAIL, including contracts-schema-dist-staleness-guard after the build refreshed the local dist. The working tree is clean. Every changed file is part of this bead. The .fleet/kb-canonical.json commits are the workflow's own KB updates.

Secondary findings (filed as newTasks, not blocking):
1) If the deploy is set aside and every bead is closed, with no bead that can only close through Integration Test, the stall check correctly does not fire (nothing open is completion, not a stall). The deploy-blocked retry branch then still runs up to DEPLOY_RETRY_CYCLE_LIMIT more cycles and logs 'Re-attempting deploy next cycle', but the deploy is never dispatched again. Those cycles are wasted, may each dispatch a Re-Review, and the log line is wrong.
2) The abort path (finalizeAbort in abort.mjs) passing error.setAside into the PR body has no end-to-end test. The tests build the body with buildSprintPrBody directly.

Tools: KB was used (kb_query; the CONFIRMED entries on doctorBlockedIds, deploySetAside and throwIfSetAsideStall match the code). The code index was not usable: code_impact matched the wrong symbol at first and then could not find apra-fleet-se symbols, so I traced callers with grep.

KB: the one candidate (mock vs real mode for mutation checks) stays INFERRED. run-tests.mjs does confirm that mock mode replays recorded bd fixtures, but I did not run a mutation check to prove the claim about how a mutated engine fails.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: I ran the regression playbook at branch HEAD 6eb3b13. The Permissions check passed: every required prefix is covered by the union of settings.json and settings.local.json. Install smoke passed. Setup acquired the sandbox lock, installed into a throwaway HOME, started the server on port 18700 and verified it was bound there. Teardown then released the lock, stopped the server and removed the sandbox. I also ran the leftover sandbox-deploy sweep for sprint apra-fleet-1zfd-1-77bc19-5ca1e51b, and it reported nothing to tear down. In-sprint smoke is NOT RUN: moved to CI. The playbook requires reporting it as failed with that reason and returning overall passed:false, so overall passed is false for that reason alone. No beads were filed. This result is informational and does not gate the sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB bible

WARNING: bible not published -- these KB confirmations are not in a pushed bible commit on the sprint branch as of this analysis (the harvest round retries once more after it is written):
- github.com/apra-labs/apra-fleet: 1 unpublished confirmation(s).

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'fleet-lin1' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 3: planner on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 4: plan-reviewer on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 5: doer on member 'fleet-lin1' [Streak [apra-fleet-1zfd.1]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 6: doer on member 'fleet-lin1' [Streak [apra-fleet-1zfd.2]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 7: reviewer on member 'fleet-lin1' -- kb_* calls: 2, code_* calls: 7.
- Dispatch 8: doer on member 'fleet-lin1' [Streak [apra-fleet-1zfd.3, apra-fleet-1zfd.4]] -- kb_* calls: 2, code_* calls: 3.
- Dispatch 9: reviewer on member 'fleet-lin1' -- kb_* calls: 1, code_* calls: 2.
- Dispatch 10: deployer on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 11: integ-test-runner on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 12: reviewer on member 'fleet-lin1' [Final Review] -- kb_* calls: 1, code_* calls: 3.
- Dispatch 13: regression-test-runner on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.

Per-member totals:
- member 'fleet-lin1': 10 dispatch(es), kb_* calls: 10, code_* calls: 16.
- member 'fleet-lin1-deploy': 3 dispatch(es), kb_* calls: 0, code_* calls: 0.
