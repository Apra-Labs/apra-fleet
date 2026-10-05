# Sprint Analysis: feat/kb-bible-admission

Scope issue id(s): apra-fleet-b4g.112.
Base branch: feat/kb-redesign.
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

PASS -- Net diff feat/kb-redesign..feat/kb-bible-admission (3 commits, 25 files) reviewed against apra-fleet-b4g.112 and .112.1 (with subtasks .1.1-.1.3).

What changed: src/tools/kb-bible-commit.ts imports filterProjectBibleCandidates from src/services/knowledge/bible-basis-filter.ts and passes it the requested CONFIRMED entries plus project.getSourceFileBases(). This is the same call kb_export makes (src/tools/kb-export.ts:437-438), so there is one predicate with no copy and no hash comparison of its own. A CONFIRMED id that fails the predicate is skipped with reason basis_mismatch and a logWarn; unknown or non-CONFIRMED ids keep not_confirmed_or_unknown. An existing bible entry for a skipped id stays unchanged (entry-level merge). The engine (fleet-sprint/kb.mjs commitRepo) logs each skip with its reason and drops it from the queue; this is tested in kb-bible-commit-round.test.mjs. These were all updated in the same change: memory-contract/v1 (response-schemas enum, spec, INVENTORY, generate-contract, binding, request/response schemas, recorded basis-mismatch fixture plus roundtrip step), the tool-registry description, and the apra-fleet-client typedef and api-reference. ASCII-only, no CRLF, working tree clean, no stray files.

Tests (this Windows host):
- Build passes.
- client, workflow, apra-fleet-se (4130) and apra-pm (489) suites: 0 failures.
- The vitest suite was killed by the 15-minute wall clock. A rerun with a 45-minute budget gave 6160 passed, 5 failed, none attributable to this diff:
  - run-all-tests-suite-enumeration (3): caused by my own APRA_TEST_SUITES_JSON override.
  - 2cc-win-bd-invocation-integ (1): 120s bd/Dolt sandbox timeout in an untouched area.
  - kb-bible-commit.test.ts concurrent-rebase retry (1): over the 5s default timeout. It fails the same way on base (9.8s on a base worktree vs 8.1s on HEAD); with --testTimeout=60000 both bible-commit files pass 15/15.
- kb-bible-commit-admission.test.ts passed 4/4, including scenario 3 (kb_bible_commit merges exactly the id set kb_export admits on one mixed fixture).
- register-member-id and member-fleet-wiring each failed once under full-suite load and passed when run alone.

Not checkable here: the parent bead's live toy-sprint criterion. The in-sprint proxy is admission scenario 1 (real handler, real git, unchanged file is merged and committed), which passes. This does not block.

Minor: the roundtrip basis-mismatch step only checks the response schema, not that skipped carries basis_mismatch. The case comments next to the bumped fixture counts (30->34, 69->73) were not updated.

Tool use: kb_query, kb_session_prime and code_impact failed with E-SELF-NOT-A-REPO (the fleet server's working folder is C:\Windows\system32). I fell back to reading the diff and grep for callers (tool-registry, member-tool-allowlist, kb.mjs via the client).

KB: promoted c872c6d4 (verified in code and tests). No discards.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: Ran the Install smoke part against branch HEAD 58c31cfa99c5df02d473e2858efb45ef9f048ef4. It passed: the fresh install into the throwaway HOME succeeded, the fleet server booted and was verified bound to scratch port 18700, and Teardown (lock release, server stop, sandbox deletion) ran cleanly. The In-sprint smoke part was NOT RUN: moved to CI. The playbook requires this, because the toy sprint needs an LLM credential that an agent cannot provision here. Per the playbook it is reported as passed: false, so overall passed is false. No bead was filed for it. The leftover sandbox-deploy sweep for this sprint's id reported nothing to tear down. No failures were found and no carry-over beads were filed. This result is informational and does not gate the sprint's verdict. I did not run the kb_session_prime step: the kb_* tools were deferred and not loaded, and I did not retry. No regression gotchas were found.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'fleet-win1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'fleet-win1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 3: doer on member 'fleet-win1' [Streak [apra-fleet-b4g.112.1.1, apra-fleet-b4g.112.1.2, apra-fleet-b4g.112.1.3]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 4: reviewer on member 'fleet-win1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 5: deployer on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 6: integ-test-runner on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 7: reviewer on member 'fleet-win1' [Final Review] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 8: regression-test-runner on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.

Per-member totals:
- member 'fleet-win1': 5 dispatch(es), kb_* calls: 0, code_* calls: 0.
- member 'fleet-win3': 3 dispatch(es), kb_* calls: 0, code_* calls: 0.

## Cost

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $5.0087.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0274 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 8 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```
