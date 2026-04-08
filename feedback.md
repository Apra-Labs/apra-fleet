# Onboarding & User Engagement — Plan Review

**Reviewer:** reviewerAF
**Date:** 2026-04-08
**Verdict:** APPROVED

> Review cycle 2. Cycle 1 verdict: CHANGES NEEDED (6 must-fix, 4 recommended). This cycle re-evaluates the revised plan.

---

## Must-Fix Resolution Check

### MF-1: Task 2.1/2.2 dependency ordering — RESOLVED
Task 2.1 now explicitly creates `getOnboardingPreamble()` and `getOnboardingNudge()` as stubs returning `null`. Task 2.2 fills in preamble, Task 3.1 fills in nudges. Each task is independently testable and the VERIFY 2 checklist includes "stubs return null (no behavior change)."

### MF-2: Task 3.1 member type detection via response parsing — RESOLVED
`wrapTool` now passes `toolName` and `input` to `getOnboardingNudge(toolName, input, result)`. Task 3.1 reads `input.member_type` directly. No response string parsing. The blockers section confirms `input.member_type` is always present in the register_member schema (verified — it's a required enum field with default `"remote"`).

### MF-3: Review cycle heuristic — RESOLVED
Dropped entirely from initial scope. `reviewCycleNudgeShown` removed from `OnboardingState`. Plan documents the rationale: the requirement implies PM skill integration, not keyword heuristics. R5 in the risk register updated to "DEFERRED." This is the right call.

### MF-4: `welcomeBackShownThisSession` mixed into persisted interface — RESOLVED
Now a module-level variable in `onboarding.ts`. `OnboardingState` contains only: `bannerShown`, `firstMemberRegistered`, `firstPromptExecuted`, `multiMemberNudgeShown`. Clean separation.

### MF-5: R7 concurrent first-call race — RESOLVED
R7 added to risk register. Architecture Overview explicitly states "loaded once at server start into an in-memory singleton" with JS event loop serialization. Task 1.1 notes enforce this pattern.

### MF-6: `lastActive` computation unspecified — RESOLVED
Task 3.2 specifies: `lastActive = max(agent.lastActivity for all agents in registry)`, formatted as relative time, falls back to `"unknown"`. VERIFY 3 includes "welcome-back with member count + lastActive."

## Should-Fix Resolution Check

### SF-1: `monitor_task` always returns JSON — RESOLVED
Task 2.1 now explicitly lists `monitor_task` as always-JSON and the `isJsonResponse()` function explicitly covers it. R1 in the risk register updated to name all four JSON-returning tools.

### SF-2: Verify install CLI doesn't reset data directory — RESOLVED
Task 4.1 now includes: "Verify `install` CLI (`src/cli/install.ts`) does not overwrite or reset the data directory — read the install flow and confirm it only writes hooks, scripts, and MCP config, not data files."

### SF-3: Prepend-vs-append deviation acknowledged — RESOLVED
Architecture Decision #5 explicitly documents the deviation and justifies it: "the requirement's intent is 'don't replace the tool response,' which appending also satisfies."

### SF-4: "First meaningful interaction" = "first tool call" equivalence — RESOLVED
Architecture Overview, Decision #2 now states: "'First meaningful interaction' in the requirements = first MCP tool call (MCP tools are the only user-facing interaction surface)."

---

## 12-Criteria Re-Evaluation

1. **Clear 'done' criteria** — PASS. Unchanged from cycle 1; all tasks have testable done conditions.
2. **High cohesion / low coupling** — PASS. Unchanged. The removal of `reviewCycleNudgeShown` from the interface actually improves cohesion.
3. **Shared abstractions early** — PASS. `OnboardingState` and service API in Task 1.1, text in 1.2, stubs in 2.1.
4. **Riskiest assumption early** — PASS. wrapTool refactor is Phase 2 with stub-based isolation.
5. **Later tasks reuse early abstractions** — PASS. Tasks 3.1, 3.2, 4.1 all build on the Phase 1 + 2 foundation.
6. **2-3 tasks + VERIFY per phase** — PASS. 4 phases, 2 tasks each, all with VERIFY checkpoints.
7. **Each task one-session** — PASS. No task exceeds 3 files.
8. **Dependencies in order** — PASS. The stub approach in 2.1 cleanly resolves the prior cycle's finding.
9. **No ambiguous tasks** — PASS. Member type from input, lastActive specified, review cycle deferred.
10. **No hidden dependencies** — PASS. JSON tools enumerated, runtime state separated, install CLI verified.
11. **Risk register** — PASS. R1-R7 covers all identified risks. R5 honestly marked as deferred.
12. **Alignment with requirements** — PASS. All deviations acknowledged and justified. Review cycle deferral is documented and reasonable.

---

## New Issues Introduced by Revisions

None identified. The revisions are clean — they address the findings without introducing new complexity or changing the phase structure.

---

## Summary

All 6 must-fix and 4 should-fix items from cycle 1 are adequately resolved. The plan passes all 12 quality criteria. The review cycle celebration deferral is well-justified. The plan is ready for implementation.
