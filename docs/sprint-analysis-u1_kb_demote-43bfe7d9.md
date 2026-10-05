# Sprint Analysis: u1_kb_demote

Scope issue id(s): my-beads-db-qy8.9, my-beads-db-qy8.10, my-beads-db-qy8.11, my-beads-db-qy8.12, my-beads-db-qy8.13, my-beads-db-qy8.14.
Base branch: u1_kb_demote_base.
Cycles run: 3.

## Progress

Closed-bead count history (per cycle evaluation): [2, 14, 16].
High-water-mark closed count this sprint: 20.
Final closed count: 16.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Verified the net diff u1_kb_demote_base..u1_kb_demote (126 files, +6737/-390), not just bead counts.

BUILD/TESTS (run by me, this review): npm run build exit 0; npm test exit 0 -- root vitest 392 files / 5577 tests pass, 0 fail; apra-fleet-se SUMMARY pass=4436 fail=0; apra-pm 489 pass / 0 fail. git status --porcelain empty before AND after the full run (this is itself qy8.9.4's acceptance). node scripts/check-bd-env-strip.mjs: 789 files, zero violations.

PER-BEAD EVIDENCE:
- qy8.9: bdChildEnv() added in tests/helpers/bd-child-env.ts and packages/apra-fleet-se/test/helpers/bd-replay.mjs; every real bd spawn routed through it (exec-bd.test.ts, smoke-test-flow-e2e-integ.test.ts, bd-init-templating, bd-replay-read-cache, child-floor, apra-pm/e2e). f34 is covered transitively via mock-sprint-harness runCmd -> execCmd. New static guard scripts/check-bd-env-strip.mjs + tests/check-bd-env-strip.test.ts (self-exclusion, two-place exception mechanism, per-exception anchorRe).
- qy8.10: spot-checked taxonomy.json groups[].codes[].source against the working tree -- :1683 validateFilePaths, :1571/:1669 reason floors, :1548/:1654 superseded, :1545/:1651/:1744 not-found all resolve exactly. Token-based rot guard (tests/memory-contract-contract-rot-guard.test.ts) reads the real registry, not the generator prose.
- qy8.11: grep for 23-tool/23 tools/16 kb_/15 of the 16 returns only the three transcripts + INVENTORY s6 (plus a pre-existing CHANGELOG release note). docs/knowledge-layer.md box re-verified column-aligned at 64 chars with 17 kb_* listed.
- qy8.12: sqlite-provider list() now bounds SQL at limit * DEMOTION_FILTER_OVERFETCH(5) instead of dropping LIMIT; demotionCandidates sends source_files + a constant limit. Both bounds pinned at KB sizes 1/50/200/2000.
- qy8.13: independently reproduced vetKbWork -- a colliding id is dropped from BOTH lists with the named refusal, non-colliding entries survive, a doer payload is refused wholesale, and kbDemotionBlock returns [] when every candidate was already offered for promotion. All three lockstep copies carry the identical string.
- qy8.14: no tracker bead id remains in INVENTORY.md; ids survive only in the three named point-in-time transcripts.

KB PROMOTIONS: none. All three INFERRED candidates cite SummarEYES Python files (libs/db_wrappers/logs_db_wrapper.py, config/SummarEYESConfig.py, jobs/TimeBlockJob.py) that do not exist in this repo, so nothing was verifiable here. Filed as a follow-up -- a cross-repo candidate block is a scoping concern in its own right.

FOLLOW-UPS filed as newTasks (none block this epic): the kb_promote sole-path claim left stale in docs/kb-trust-model.md; taxonomy.json non_error_outcomes/excluded_from_closed_set where-citations still ~300 lines stale and deliberately outside the new guard; a historical sprint-analysis transcript rewritten 23 -> 24 despite the guard classifying those as immutable.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: my-beads-db-rj7, my-beads-db-5n6.
Summary: Ran both parts of regression-test-playbook.md at repo HEAD. Part 1 (real-bd functional suite via scripts/run-integ-suites.mjs, resumed from a 3-file-pending state, plus the test:slow lane) completed with 7 real-bd-suite failures (golden-transcript non-determinism and 4 cascading nested-suite failures, mock-sprint-beads-identity prefix mismatch, mock-sprint-parent-child-blocks-cycle-repair fixture refused by real bd, and phase3-dispatch-engine-completeness exceeding the 300s single-file budget at 616s) plus 1 slow-lane failure (mock-sprint-planner-dispatch-stalled-session bd-recording drift) -- every one of these exactly reproduced an already-open parent-less [regression][carry-over] bead from a prior pass, so I updated each with a reconfirmation note rather than filing duplicates (suitePassed=false). Part 2 (sandbox smoke test) got through Setup only after working around a host-specific BEADS_DIR-leak gap in scripts/sandbox-seed-beads.mjs (not covered by the earlier BEADS_DIR fix, which scoped only to tests/ and packages/) -- filed as new standalone bead my-beads-db-rj7 (P1). The toy sprint itself was never launched: Test scenario step 3a (seeding the ambient Claude credential into the sandbox secret store) was consistently denied at runtime by this session's auto-mode permission classifier on any read/derivation of ~/.claude/.credentials.json, with no CLAUDE_CODE_OAUTH_TOKEN fallback available; per this repo's permission-block policy I stopped rather than routing around it, so smokePassed=false with no versionStdout/canaryStatus/toyRepoHeadSha evidence to report. Teardown ran to completion regardless (supervisor and fleet server stopped and verified down, sandbox removed, lock released); the supervisor's own uptime (381s) exceeded the documented 300s dolt-orphan-sweep mitigation window because of time spent troubleshooting the credential block before Teardown could run (step 4's own 280s self-stop never got a chance to fire, since no sprint was launched) -- filed as new standalone bead my-beads-db-5n6 (P3) per the playbook's explicit instruction, with full context that this reflects the blocked run's own timeline rather than a hung sprint. The leftover sandbox-deploy sweep for the given sprintId found nothing to tear down. This entire result is informational: it does not gate the current sprint's PASS/FAIL verdict, and every filed bug is a standalone, parent-less carry-over bead for a future sprint to pick up.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
