# Sprint Analysis: fix/runner-error-classification

Scope issue id(s): apra-fleet-9ta.
Base branch: chore/integration-binary-fixes-and-auth-selfheal.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [7].
High-water-mark closed count this sprint: 7.
Final closed count: 7.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Scope: apra-fleet-9ta (epic) + children .1-.7 on fix/runner-error-classification vs origin/chore/integration-binary-fixes-and-auth-selfheal (8 commits; runner.js, errors.mjs, 7 new test files, 12 new mock fixtures, harness + golden-transcript updates).

GATES -- git status clean; `npm run build` (root, build:contract + tsc) exit 0; `npm run test:unit` (apra-fleet-se mock suite) 1374 tests, 0 fail, 3 skipped (SUMMARY pass=1615 fail=0); targeted re-run of the 7 new files + golden-transcript: 74/74 pass; root `npm test` (vitest) 2818 passed / 36 skipped, 0 fail. No lint script configured.

PER-BEAD:
.1 isTypedAbortError narrowed from `instanceof WorkflowError` to an explicit class list (Stalled/PlanRejected/ReviewerContractViolation/BudgetExceeded + divergences + pre-sprint prefix), CancelledError still excluded; every caller audited and main() split into isTerminalSprintFailure (terminal record) vs isTypedAbortError (finalizeAbort push/[ABORTED] PR) -- runner.js ~4200-4290, ~8570-8600. Enumerated truth table in typed-abort-classification.test.mjs.
.2 AGENT_RAN_DISPATCH_REASONS = {max_turns_exhausted, watchdog_timeout}; AgentOutputError explicitly excluded; the blanket isTypedAbortError disjunct replaced by BudgetExceededError only. Pinned e2e by mock-sprint-watchdog-timeout-sync-teardown.test.mjs (asserts no teardown-skip line, D-push actually ran per attempt, and the planner-created bead survives in post-run state).
.3 Final Review heal path short-circuits via handledByAuthSelfHeal; heal-retry throws are degraded through the same FAIL ladder. final-review-auth-self-heal.test.mjs asserts exactly 2 attempts, healed verdict preserved, no generic-ladder log, and the heal-retry-throws -> FAIL case.
.4 dispatchFailed:true on both synthesized plan-reviewer fallbacks + one in-round retry + new PlanReviewDispatchFailedError branched at the wholePlanContested check. plan-reviewer-dispatch-failure.test.mjs pins 6 dispatches / infra error on all-rounds transport failure AND the genuine-rejection control still yielding SprintPlanRejectedError (3 dispatches).
.5 replanIds added to isReviewerContractViolation and to buildReviewerPrompt (as a subset-of-reopenIds contract matching the pre-existing consumption gate), plus a visible `replanIds: DROPPED` log. reviewer-contract-replan-ids.test.mjs covers predicate true/false/APPROVED, prompt content, and the dropped-id e2e; the 'scoped-replan reachable end to end' criterion is genuinely covered by pre-existing mock-sprint-replan-short-circuit.test.mjs scenario 1 (verified: reopenIds=[X]+replanIds=[X] -> scoped planner + same-cycle re-dispatch). Golden transcript delta is exactly the 2 reworded reviewer-prompt lines.
.6 Publish push now failSoft + bounded retry over POST_DISPATCH_SYNC_RETRY_DELAYS_MS ([0,5000,15000], mock-instant backoff honored); persistent failure logs [Publish Push Failed], skips gh pr create/target-issue closure, and returns the computed verdict with pushed:false. mock-sprint-publish-push-failure.test.mjs asserts exactly 3 attempts, PASS preserved, no ABORTED terminal record, no gh pr create -- plus a success-path control (1 push, PR raised, pushed:true).
.7 error-classification-routing-table.test.mjs is genuinely table-driven (17 rows x both predicates, incl. wrapped-divergence and null/undefined) with 4 e2e harness routing assertions (abort record / rethrow-no-record / teardown-skip / teardown-run) -- exceeds the >=3 required.

Epic criterion '647.1 becomes ready when .1/.2 close': verified -- apra-fleet-647.1's only DEPENDS-ON edges are 9ta.1 and 9ta.2, both closed.

NON-BLOCKING OBSERVATIONS (no rework needed):
1. Documented deviation from .1's literal criteria: GitDivergedError, bare DoltDivergedError, and a PostDispatchSyncError WRAPPING a divergence return true from isTypedAbortError. This is correct rather than a defect -- pre-change every WorkflowError already reached finalizeAbort, so excluding divergences would have regressed the BEADS_SYNC_CONFLICT terminal reporting path (resolveTerminalReason/captureDoltConflictDump). The routing table pins the intended criterion via the 'PostDispatchSyncError with NO divergence' row = false.
2. Stale justification in the new comment at runner.js ~4180: it argues divergences must be in isTypedAbortError or resolveTerminalReason()/captureDoltConflictDump() 'is dead code' -- under the new split that path is gated by isTerminalSprintFailure(), which admits all WorkflowErrors. Behavior is right; the rationale sentence is now inaccurate.
3. ASCII-only convention: the new test/final-review-auth-self-heal.test.mjs contains 2 non-ASCII chars (a comment reference to the skip marker and a mock '[OK] provisioned' string). It mirrors pre-existing non-ASCII markers already in runner.js (~2049/2188/2195, untouched by this branch); no non-ASCII was introduced into shipped source.
4. Predicate coverage overlaps between typed-abort-classification.test.mjs and error-classification-routing-table.test.mjs -- deliberate and required by .7's criteria (individual asserts vs the extensible table), documented in both headers.
5. runSprintCycle's new early return yields status:'success' with pushed:false; no production consumer found that infers 'branch is on the remote' from status alone (only engine.mjs/viewer read status).

File hygiene clean: all touched files are runner.js, errors.mjs, apra-fleet-se tests, and per-scenario bd replay fixtures. No temp files, tool config, or unrelated scripts. No secrets/injection concerns; the publish-push command shape is unchanged. packages/apra-fleet-client needs no update (no MCP tool schema/behavior changed).

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: apra-fleet-t91, apra-fleet-542, apra-fleet-mnd, apra-fleet-egc.
Summary: Ran the full regression pass per regression-test-playbook.md. Part 1 main lane (packages/apra-fleet-se real-bd suite, run via scripts/run-integ-suites.mjs) was an already-live run from another session that was adopted and polled to completion per INTEG-SUITE.md's exit-3 procedure, at branch HEAD 24e71524 (matching this install's v0.4.0_24e715): 148 files, 1 failure (mock-sprint-publish-push-failure.test.mjs, two 180s timeouts), which maps to pre-existing bead apra-fleet-w5j (not re-filed). check-integ-suite-budget.mjs also found 37 files over the 300s budget, up from 6 at the last filing, so pre-existing bead apra-fleet-p8o was updated in place with the new list (not newly created). Part 1 slow lane (npm run test:slow) was run fresh by this session: dispatch-watchdog-timer-ref.test.mjs passed, mock-sprint-planner-dispatch-stalled-session.test.mjs's second subtest failed on bd-replay recording drift -- filed as apra-fleet-t91. Part 2 (smoke test) Setup came up cleanly on a clean retry (server on port 18700, toy repo cloned and seeded, canary gh-toy-4ef confirmed open at toy-repo HEAD 2544a8407c474e53f7e19c664dcf4cefb4555e41) after an initial Setup attempt was destroyed mid-run -- strong evidence (an ENOENT-on-rename during git clone, then the entire sandbox directory and its running server vanishing seconds later with no Teardown issued by this session) points to a concurrent run of this same playbook colliding on the shared, non-exclusive, fixed sandbox path; filed as apra-fleet-egc (P1), with the initially-misdiagnosed apra-fleet-542 (start/status race) and apra-fleet-mnd (bd init Windows race) corrected in place to point to it as the likely common root cause. On the clean retry, Part 2 then halted at Test scenario step 3a: no ambient Claude credential was resolvable (claudeAiOauth.accessToken empty in ~/.claude/.credentials.json, CLAUDE_CODE_OAUTH_TOKEN unset) -- an unmet Setup prerequisite, not a product regression, so no bead was filed for it -- meaning steps 3b/4/5 never ran and the canary was never dispatched against or closed. Teardown was run and verified (server stopped, sandbox directory removed) regardless. This result is informational: it does not gate this sprint's PASS/FAIL verdict, and the four filed bugs (all standalone and parent-less) carry over to a future sprint to be picked up and fixed there.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
