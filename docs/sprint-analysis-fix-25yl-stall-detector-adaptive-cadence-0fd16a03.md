# Sprint Analysis: fix/25yl-stall-detector-adaptive-cadence

Scope issue id(s): apra-fleet-25yl.
Base branch: main.
Cycles run: 6.

## Progress

Closed-bead count history (per cycle evaluation): [3, 10, 15, 19, 26, 28].
High-water-mark closed count this sprint: 31.
Final closed count: 28.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
Integration test failures (1): C5: Integ test runner failed to return a schema-valid report after repair attempts: [Workflow Error] LLM returned non-compliant JSON. Validation failed after 3 attempt(s) (2 repair(s) exhausted): Candidate 1: schema validation failed: data must be object (bugs filed: none)

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- SCOPE NOTE: local `main` is stale at 16cf4a2d; origin/main is at 6d934001 (PR #480). The literal `main..branch` range shows 33 files; the true net sprint diff against origin/main is 28 files. The 4 extras (timestamped-reporter.mjs/.test.mjs, nested-suite-spawn.mjs, phase1-leaf-facade-completeness.test.mjs) are inherited from #480, not sprint work. Review was done against origin/main..HEAD.

GATES (all green, run by me): npm run build exit 0; vitest 322 files passed / 8 skipped, exit 0; apra-fleet-se default lane 3619 pass / 0 fail, exit 0; apra-fleet-se `npm run test:slow` 2 pass / 0 fail, exit 0 (that lane is NOT in `npm test`, and it is where the +210-line mock-sprint-planner-dispatch-stalled-session.test.mjs work from 25yl.1.7/.9/.10 actually executes -- it passed in 450s). Working tree has only pre-existing untracked junk (t16.json, tt.json, .claude/skills/gitnexus-*/); nothing untracked is branch-introduced, and no temp/scaffold files are committed.

CRITERIA VERIFIED IN THE DIFF (not from bead counts):
- Part 1: StallEntry.thresholdMs added (stall-detector.ts:~135) and threaded at ALL FOUR execute-prompt.ts call sites -- ~866 (initial add), ~1100 (pre-spawn sid), ~1310 (minted sid), ~1695 (post-dispatch sid) -- all from one `stallThresholdMs = (input.timeout_s ?? 300)*1000`. Trust asymmetry fixed: computeEffectiveThresholdMs is now max(base, min(pending+GRACE, ceiling)), so the trusted baseline is never capped; describeClamp compares base >= cappedPending rather than effective vs raw.
- Part 2: exec timer decoupled per provider via the REQUIRED ProviderAdapter.execTimeoutSource(); claude/agy = total_ceiling, codex/copilot/none/opencode = inactivity_timeout, each with a rationale comment. Absent max_total_s falls back to EXEC_TIMER_NEVER_BINDS_MS = 86_400_000 (finite int32) -- I reproduced setTimeout(Infinity) firing in 4ms with TimeoutOverflowWarning, confirming why Infinity is wrong here.
- Part 3: adaptive cadence gate is max(tickIntervalMs, min(300_000, stallThresholdMs/5)), floor beating ceiling (25yl.4), with the malformed-STALL_THRESHOLD_MS NaN guard (25yl.6) and probesIssued/probesSkipped/entryProbeIntervals observability (25yl.3.3). A gated-off tick issues no probe and performs NO stall evaluation -- covered by an explicit test. Using the stable baseline rather than effectiveThresholdMs is necessary (pendingToolTimeoutMs is only known after the probe) and is documented in docs/features/stall-detector.md.
- Behaviour change a PR reader needs: DISPATCH_INACTIVITY_TIMEOUT_S = min(1800, dispatch_timeout_s) = 1800s by default, so every role's timeout_s drops 9000 -> 1800 while max_total_s stays 9000.
Test quality is strong: ~70 stall-detector cases plus two new execute-prompt suites cover failure/edge paths (NaN env, ceiling-exceeding tick interval, skipped-tick non-evaluation, retry remaining-budget).

C5 INTEG FAILURE -- disposition: not attributed to this diff. No sprint log exists for this run yet (every sprint-logs/*.json belongs to the 5co8/uof6 epic), so I could not check for a kill line; the attribution rests on the error class -- "LLM returned non-compliant JSON / data must be object" after 3 schema-repair attempts is a schema-validation failure, whereas a stall kill surfaces as a typed stalled/AgentDispatchError. The se lane corroborates this (mock-sprint-integ-infra-dispatch-failure.test.mjs passes the inactivity-timeout-is-INCONCLUSIVE case). The lost integ signal for that cycle is still real and is filed below.

KB: promoted 4d036fbb and 9cb7bfe2 (first-hand evidence). Held 2f7eeb19 at INFERRED -- it is a conjunction and I verified only the SLOW_LANE_SKIP-before-git clause. Held 4f086953, 7f6016b6 and c70e6470 at INFERRED deliberately: all three describe defects THIS branch fixed (6f663534, f8aca61f, 116bfc28), so they are false at HEAD and must not be minted CONFIRMED. Copilot's unresolved stall gap is already tracked by apra-fleet-rurm, so no duplicate filed.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Regression test runner dispatch failed: [Workflow Error] Agent dispatch failed (stalled): [FAIL] execute_prompt on "fleet-win-dev1" was aborted after a confirmed stall -- the remote turn made no progress for the stall threshold, its process was killed, and the in-flight dispatch was cancelled immediately rather than waiting out the client timeout.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
