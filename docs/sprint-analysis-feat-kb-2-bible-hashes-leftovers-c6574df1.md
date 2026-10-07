# Sprint Analysis: feat/kb-2-bible-hashes-leftovers

Scope issue id(s): apra-fleet-b4g.139.
Base branch: feat/kb-redesign.
Cycles run: 3.

## Progress

Closed-bead count history (per cycle evaluation): [17, 34, 39].
High-water-mark closed count this sprint: 47.
Final closed count: 39.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Final review, epic apra-fleet-b4g.139. The local feat/kb-redesign ref was stale, so I reviewed the real sprint range: origin/feat/kb-redesign...feat/kb-2-bible-hashes-leftovers (35 commits, 133 files).

Verified in the diff:
- Bible format v3. Both bible writers emit per-entry source_file_hashes using the stored basis, and refuse duplicate ids. kb_import keeps the carried basis verbatim; v1/v2 entries import with no basis (kb-export.ts toCanonicalEntry, bible-import.ts carriedBasisOf).
- Admission now hashes each cited file at HEAD (git cat-file HEAD:<path>), not the work tree. A folder that is not a git work tree fails with E-BIBLE-BASIS-NOT-GIT (file-hash.ts computeHeadFileHashBatch). no_source_files is now its own skip reason, and the engine keeps basis_mismatch ids queued for a bounded number of rounds.
- kb_bible_commit removes entries the maintainer KB holds as superseded or invalidated, and lists each removal in the response and the commit message. kb_export stays additive.
- All SqliteProvider hashing goes through hashAnchored.
- The member tool list is now explicit: kb_setup and kb_export are never served to members; kb_promote and kb_resolve_contradiction need the engine kb_maintainer grant.
- Tool-only ?member= sessions no longer touch the session registry.
- Code index: no answer from a partial or changing index; a lookup that resolves to a different symbol is flagged. usage.jsonl rows from member sessions carry member and session ids.
- The client package, memory-contract taxonomy, spec and fixtures, and docs were updated in the same change. All files are ASCII; no stray files.

Tests: build OK. npm test EXIT 0 (vitest 6392 passed, apra-fleet-client 103, workflow 348, fleet-se 4166, apra-pm 489, 0 failures).

Still open, legitimately: apra-fleet-b4g.16 and apra-fleet-8zyg (both P2). Their code is in place, but their acceptance needs the real-remote acceptance run (apra-fleet-b4g.25), which is outside this sprint. The 8zyg rg check returns 0 matches.

Observations:
1. The bible on this branch is still v2 with no hashes (281 entries). The maintainer that wrote it runs an installed server (v0.4.4_25443d) older than this code. Existing entries never get a basis backfilled.
2. Member sessions can still mint or remove CONFIRMED without the maintainer grant: through kb_import with an explicit path, through kb_reconcile_prefilter, and through kb_invalidate followed by kb_bible_commit.
3. The engine skips kb_bible_commit in rounds with no new confirmations, so removals wait for a promotion round.
4. npm test leaves backslash-named fleet-wintask files in the repo root on macOS. This predates the sprint; I removed the files my run created.

KB: promoted 5 entries and discarded none. Tool use: kb used, code used (the code_impact index was 3 commits behind HEAD, so I backed it up with the diff).

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: Ran the regression playbook. The leftover sandbox-deploy sweep for this sprint's id exited 0 with 'nothing to tear down'. Install smoke passed: a fresh install to the throwaway HOME succeeded, and the server started on scratch port 18700. server.json confirmed that port and `status` reported running. Teardown then released the lock, stopped the server and removed the sandbox. In-sprint smoke was NOT RUN: moved to CI, as the playbook directs, so overall passed is false. No bead was filed for it. No failures were found, so no carry-over beads were filed. This result is informational and does not gate the sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'fleet-mac1' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'fleet-mac1' -- kb_* calls: 1, code_* calls: 0.
- Dispatch 3: planner on member 'fleet-mac1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 4: plan-reviewer on member 'fleet-mac1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 5: doer on member 'fleet-mac1' [Streak [apra-fleet-b4g.113.1, apra-fleet-b4g.113.2, apra-fleet-b4g.113.3, apra-fleet-b4g.113.4]] -- kb_* calls: 5, code_* calls: 1.
- Dispatch 6: doer on member 'fleet-mac1' [Streak [apra-fleet-b4g.111.1, apra-fleet-b4g.111.2]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 7: doer on member 'fleet-mac1' [Streak [apra-fleet-b4g.89.1, apra-fleet-b4g.89.2, apra-fleet-b4g.137.1, apra-fleet-b4g.137.2]] -- kb_* calls: 2, code_* calls: 0.
- Dispatch 8: reviewer on member 'fleet-mac1' -- kb_* calls: 1, code_* calls: 2.
- Dispatch 9: doer on member 'fleet-mac1' [Streak [apra-fleet-b4g.139.1.1, apra-fleet-b4g.139.1.2]] -- kb_* calls: 1, code_* calls: 3.
- Dispatch 10: doer on member 'fleet-mac1' [Streak [apra-fleet-b4g.113.5]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 11: reviewer on member 'fleet-mac1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 12: doer on member 'fleet-mac1' [Streak [apra-fleet-b4g.139.1.1]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 13: reviewer on member 'fleet-mac1' -- kb_* calls: 0, code_* calls: 2.
- Dispatch 14: deployer on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 15: integ-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 16: planner on member 'fleet-mac1' -- kb_* calls: 1, code_* calls: 0.
- Dispatch 17: plan-reviewer on member 'fleet-mac1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 18: planner on member 'fleet-mac1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 19: plan-reviewer on member 'fleet-mac1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 20: doer on member 'fleet-mac1' [Streak [apra-fleet-b4g.139.1.1, apra-fleet-b4g.139.2.1, apra-fleet-b4g.139.2.2]] -- kb_* calls: 3, code_* calls: 2.
- Dispatch 21: doer on member 'fleet-mac1' [Streak [apra-fleet-b4g.118.3]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 22: reviewer on member 'fleet-mac1' -- kb_* calls: 2, code_* calls: 2.
- Dispatch 23: doer on member 'fleet-mac1' [Streak [apra-fleet-b4g.118.1, apra-fleet-b4g.118.2, apra-fleet-b4g.112.3, apra-fleet-b4g.118.4]] -- kb_* calls: 3, code_* calls: 1.
- Dispatch 24: reviewer on member 'fleet-mac1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 25: member 'fleet-mac1' [Streak Assignment] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 26: doer on member 'fleet-mac1' [Streak [apra-fleet-b4g.110]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 27: doer on member 'fleet-mac1' [Streak [apra-fleet-b4g.139.3]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 28: doer on member 'fleet-mac1' [Streak [apra-fleet-b4g.89.3]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 29: doer on member 'fleet-mac1' [Streak [apra-fleet-b4g.53.5, apra-fleet-b4g.53.6, apra-fleet-b4g.53.7, apra-fleet-b4g.53.8]] -- kb_* calls: 0, code_* calls: 3.
- Dispatch 30: reviewer on member 'fleet-mac1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 31: deployer on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 32: integ-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 33: planner on member 'fleet-mac1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 34: plan-reviewer on member 'fleet-mac1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 35: doer on member 'fleet-mac1' [Streak [apra-fleet-b4g.118.1, apra-fleet-b4g.114.1, apra-fleet-b4g.114.2]] -- kb_* calls: 3, code_* calls: 4.
- Dispatch 36: reviewer on member 'fleet-mac1' -- kb_* calls: 2, code_* calls: 1.
- Dispatch 37: deployer on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 38: integ-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 39: reviewer on member 'fleet-mac1' [Final Review] -- kb_* calls: 2, code_* calls: 1.
- Dispatch 40: regression-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.

Per-member totals:
- member 'fleet-mac1': 33 dispatch(es), kb_* calls: 37, code_* calls: 28.
- member 'fleet-mac1-deploy': 7 dispatch(es), kb_* calls: 0, code_* calls: 0.

## Cost

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $64.9030.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.1784 across 3 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 40 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```
