# Sprint Analysis: u1_kb_demote_v2

Scope issue id(s): my-beads-db-xqp.
Base branch: u1_kb_redesign_base.
Cycles run: 4.

## Progress

Closed-bead count history (per cycle evaluation): [26, 27, 29, 35].
High-water-mark closed count this sprint: 39.
Final closed count: 35.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- PASS. Reviewed the net diff (55 commits, 105 files) against the 13 closed P1/P2 children of my-beads-db-xqp, not bead counts alone. The only open child (xqp.13) is P3, below the goal bar.

Gates: working tree clean; npm run build exit 0; npm test exit 0 -- vitest 457 files passed/9 skipped, apra-fleet-se pass=4857 fail=0, apra-pm 489/489.

Implementation confirmed present, not merely claimed:
- xqp.1: SqliteProvider.demote enforces all six refusals BEFORE any write in the specified order (unknown/ownerTag -> superseded -> user-directive -> not-CONFIRMED -> reason floor -> evidence), writes one UPDATE leaving promoted_at/source untouched, and snapshots demoted_basis_hashes from DISK (demoteBasisHashes) rather than copying the capture-time column -- the exact PR #650 defect. Both new columns use guarded ALTERs. tests/knowledge/kb-demote.test.ts covers 30 cases incl. the absolute-evidence-path case, against a real SqliteProvider(':memory:'), no mocks.
- xqp.2/3: tombstones are explicit {id, demoted_at}; absence never demotes -- applyBibleDemotion runs only for explicitly tombstoned ids, never creates a row, and requires promotion time strictly older than the tombstone. kb_export honours tombstones and clears one only on a later re-promotion; the member bible view excludes tombstoned entries on BOTH the local and remote transports.
- xqp.4: demotionCandidates reads own_scope CONFIRMED rows wide, then filters, then caps; demotions are gated against their OWN offered set (offeredDemotions), never the promotion set; final review passes scope:'sprint' explicitly.
- Roster guard tests updated (17->18 kb_*, 26->27, 52->54); client wrapper carries kbDemote + demoted_ids per the CLAUDE.md rule; the two touched kb_import fixtures changed only by adding "demoted":0 -- no UUID churn. No temp/scratch files; no sprint-analysis files touched.

Findings (filed as newTasks; neither blocks this epic's criteria):
1. runner.js createCurrentFileHashes interpolates KB-supplied file paths into a shell command string via JSON.stringify, which does NOT escape $ or backticks. I reproduced real command execution through /bin/sh. Its own comment claims no path is ever interpolated into a shell string.
2. kb_export never clears a tombstone for an id already present in entries, so a hand-merged bible holding both stays self-contradictory forever.

CI was never triggered, polled or judged.

Tool use: kb = used (kb_session_prime + kb_query). code = unavailable -- code_impact/code_context failed with E-CODE-INDEX-NOT-READY for this repo (automatic rebuilds paused after a failed analyze); fell back to reading the diff plus grep, and did not build an index.

KB: promoted 2, discarded 1. Left b6331894 at INFERRED -- its claim is true but duplicates already-CONFIRMED entry 36b36170.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: Ran regression-test-playbook.md at repo HEAD (6cd7eff8e2503e115bebd5f98ff263264a2e7952) as defined, both parts it lists: Install smoke (fresh `install` into the throwaway sandbox $HOME/temp/.apra-fleet-tests, server started and confirmed bound to scratch port 18700 via server.json, then Teardown released the lock, stopped the server, and deleted the sandbox) passed cleanly, every step exiting 0. In-sprint smoke is explicitly NOT RUN per the playbook (moved to CI, requires an LLM credential an agent cannot provision; no bead filed for this, per the playbook's own instruction), which per the playbook's own rule forces overall passed=false even though no actual defect was found. The leftover sandbox-deploy sweep for this sprint's reservation id found nothing to tear down (normal case). No regression failures were observed in the parts that did run, so no [regression][carry-over] beads were filed this run. This result is informational only and does not gate the current sprint's verdict.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB bible

WARNING: bible not published -- these KB confirmations are not in a pushed bible commit on the sprint branch as of this analysis (the harvest round retries once more after it is written):
- github.com/ushah-blub0x/apra-fleet: 2 unpublished confirmation(s).

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'repo4-deploy-ubuntu' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'repo4-deploy-ubuntu' -- kb_* calls: 1, code_* calls: 0.
- Dispatch 3: doer on member 'repo4-deploy-ubuntu' [Streak [my-beads-db-xqp.3.1, my-beads-db-xqp.3.2, my-beads-db-xqp.3.3]] -- kb_* calls: 3, code_* calls: 1.
- Dispatch 4: doer on member 'repo4-deploy-ubuntu' [Streak [my-beads-db-xqp.4.3, my-beads-db-xqp.4.4]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 5: reviewer on member 'repo4-deploy-ubuntu' -- kb_* calls: 3, code_* calls: 1.
- Dispatch 6: member 'repo4-deploy-ubuntu' [Streak Assignment] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 7: doer on member 'repo4-deploy-ubuntu' [Streak [my-beads-db-xqp.5.1, my-beads-db-xqp.5.2, my-beads-db-xqp.5.3, my-beads-db-xqp.5.4, my-beads-db-xqp.5.5, my-beads-db-xqp.5.6, my-beads-db-xqp.5.7]] -- kb_* calls: 3, code_* calls: 1.
- Dispatch 8: doer on member 'repo4-deploy-ubuntu' [Streak [my-beads-db-xqp.9]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 9: doer on member 'repo4-deploy-ubuntu' [Streak [my-beads-db-xqp.3.1, my-beads-db-xqp.3.2]] -- kb_* calls: 3, code_* calls: 1.
- Dispatch 10: doer on member 'repo4-deploy-ubuntu' [Streak [my-beads-db-xqp.4.4]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 11: reviewer on member 'repo4-deploy-ubuntu' -- kb_* calls: 2, code_* calls: 1.
- Dispatch 12: member 'repo4-deploy-ubuntu' [Streak Assignment] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 13: doer on member 'repo4-deploy-ubuntu' [Streak [my-beads-db-xqp.4.4]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 14: doer on member 'repo4-deploy-ubuntu' [Streak [my-beads-db-xqp.10]] -- kb_* calls: 2, code_* calls: 1.
- Dispatch 15: doer on member 'repo4-deploy-ubuntu' [Streak [my-beads-db-xqp.10]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 16: doer on member 'repo4-deploy-ubuntu' [Streak [my-beads-db-xqp.11]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 17: reviewer on member 'repo4-deploy-ubuntu' -- kb_* calls: 2, code_* calls: 1.
- Dispatch 18: deployer on member 'repo4-deploy-ubuntu' -- kb_* calls: 1, code_* calls: 0.
- Dispatch 19: integ-test-runner on member 'repo4-deploy-ubuntu' -- kb_* calls: 1, code_* calls: 0.
- Dispatch 20: planner on member 'repo4-deploy-ubuntu' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 21: plan-reviewer on member 'repo4-deploy-ubuntu' -- kb_* calls: 1, code_* calls: 0.
- Dispatch 22: doer on member 'repo4-deploy-ubuntu' [Streak [my-beads-db-xqp.4.2, my-beads-db-xqp.4.4]] -- kb_* calls: 2, code_* calls: 2.
- Dispatch 23: doer on member 'repo4-deploy-ubuntu' [Streak [my-beads-db-xqp.10]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 24: reviewer on member 'repo4-deploy-ubuntu' -- kb_* calls: 2, code_* calls: 2.
- Dispatch 25: planner on member 'repo4-deploy-ubuntu' [Scoped Replan Plan (interactive)] -- kb_* calls: 2, code_* calls: 0.
- Dispatch 26: plan-reviewer on member 'repo4-deploy-ubuntu' [Scoped Replan Review] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 27: member 'repo4-deploy-ubuntu' [Streak Assignment] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 28: doer on member 'repo4-deploy-ubuntu' [Streak [my-beads-db-xqp.12]] -- kb_* calls: 2, code_* calls: 1.
- Dispatch 29: reviewer on member 'repo4-deploy-ubuntu' -- kb_* calls: 2, code_* calls: 1.
- Dispatch 30: deployer on member 'repo4-deploy-ubuntu' -- kb_* calls: 1, code_* calls: 0.
- Dispatch 31: integ-test-runner on member 'repo4-deploy-ubuntu' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 32: planner on member 'repo4-deploy-ubuntu' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 33: plan-reviewer on member 'repo4-deploy-ubuntu' -- kb_* calls: 1, code_* calls: 0.
- Dispatch 34: doer on member 'repo4-deploy-ubuntu' [Streak [my-beads-db-xqp.12]] -- kb_* calls: 2, code_* calls: 1.
- Dispatch 35: reviewer on member 'repo4-deploy-ubuntu' -- kb_* calls: 2, code_* calls: 2.
- Dispatch 36: member 'repo4-deploy-ubuntu' [Streak Assignment] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 37: doer on member 'repo4-deploy-ubuntu' [Streak [my-beads-db-xqp.4.4]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 38: doer on member 'repo4-deploy-ubuntu' [Streak [my-beads-db-xqp.4.2]] -- kb_* calls: 2, code_* calls: 1.
- Dispatch 39: doer on member 'repo4-deploy-ubuntu' [Streak [my-beads-db-xqp.13]] -- kb_* calls: 2, code_* calls: 2.
- Dispatch 40: doer on member 'repo4-deploy-ubuntu' [Streak [my-beads-db-xqp.13]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 41: reviewer on member 'repo4-deploy-ubuntu' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 42: doer on member 'repo4-deploy-ubuntu' [Streak [my-beads-db-xqp.4.2, my-beads-db-xqp.4.4]] -- kb_* calls: 2, code_* calls: 0.
- Dispatch 43: reviewer on member 'repo4-deploy-ubuntu' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 44: deployer on member 'repo4-deploy-ubuntu' -- kb_* calls: 1, code_* calls: 0.
- Dispatch 45: integ-test-runner on member 'repo4-deploy-ubuntu' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 46: planner on member 'repo4-deploy-ubuntu' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 47: plan-reviewer on member 'repo4-deploy-ubuntu' -- kb_* calls: 1, code_* calls: 0.
- Dispatch 48: doer on member 'repo4-deploy-ubuntu' [Streak [my-beads-db-xqp.14, my-beads-db-xqp.4.4]] -- kb_* calls: 3, code_* calls: 2.
- Dispatch 49: reviewer on member 'repo4-deploy-ubuntu' -- kb_* calls: 3, code_* calls: 1.
- Dispatch 50: doer on member 'repo4-deploy-ubuntu' [Streak [my-beads-db-xqp.4.5, my-beads-db-xqp.4.6, my-beads-db-xqp.4.7]] -- kb_* calls: 2, code_* calls: 0.
- Dispatch 51: reviewer on member 'repo4-deploy-ubuntu' -- kb_* calls: 2, code_* calls: 1.
- Dispatch 52: deployer on member 'repo4-deploy-ubuntu' -- kb_* calls: 1, code_* calls: 0.
- Dispatch 53: integ-test-runner on member 'repo4-deploy-ubuntu' -- kb_* calls: 1, code_* calls: 0.
- Dispatch 54: reviewer on member 'repo4-deploy-ubuntu' [Final Review] -- kb_* calls: 2, code_* calls: 2.
- Dispatch 55: regression-test-runner on member 'repo4-deploy-ubuntu' -- kb_* calls: 1, code_* calls: 0.

Per-member totals:
- member 'repo4-deploy-ubuntu': 55 dispatch(es), kb_* calls: 75, code_* calls: 29.

## Cost

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $72.9178.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.5062 across 4 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 50 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```
