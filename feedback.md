# Onboarding & User Engagement — Plan Review

**Reviewer:** reviewerAF
**Date:** 2026-04-08
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review.

---

## 1. Clear 'Done' Criteria — PASS

Every task has an explicit "Done" section with testable conditions. Task 1.1 specifies "unit test creates temp state file, advances milestones, verifies persistence." Task 2.1 specifies "all 21 tools use wrapTool()" and names specific edge case tests. Task 4.1 specifies corrupt JSON and upgrade-detection test scenarios. These are concrete enough that two developers would produce comparable verification.

## 2. Cohesion & Coupling — PASS

Task boundaries are well-drawn. State service (1.1) is pure file I/O with no MCP awareness. Text constants (1.2) are pure data with no logic. The wrapTool integration (2.1) is the only task that touches index.ts broadly. Nudge logic (3.1, 3.2) extends the service without re-opening the wrapTool structure. Coupling between tasks is limited to the `OnboardingState` interface and the `onboarding.ts` service API — both established in Phase 1.

## 3. Shared Abstractions in Earliest Tasks — PASS

`OnboardingState` interface and the core service API (`loadOnboardingState`, `saveOnboardingState`, `advanceMilestone`, `shouldShow`) are all in Task 1.1. Text constants are in 1.2. Every later task imports from these two modules. Good layering.

## 4. Riskiest Assumption Validated Early — PASS

The plan explicitly calls out Task 2.1 (wrapTool refactor) as the riskiest change and schedules it in Phase 2 with a dedicated VERIFY checkpoint that includes "ALL existing tests pass" and JSON edge-case tests. This is correct — if wrapTool breaks tool responses, everything downstream is invalid. Phase 2 is early enough to catch this before nudge logic is built on top.

## 5. Later Tasks Reuse Early Abstractions (DRY) — PASS

Tasks 3.1, 3.2, and 4.1 all work through the `advanceMilestone`/`shouldShow` API from Task 1.1 and import text from Task 1.2. No duplication of state management or text construction. The wrapTool from 2.1 is the single integration point for all preamble/append logic.

## 6. 2-3 Work Tasks Per Phase + VERIFY — PASS

Phase 1: 2 tasks + VERIFY. Phase 2: 2 tasks + VERIFY. Phase 3: 2 tasks + VERIFY. Phase 4: 2 tasks + VERIFY. This is exactly the right cadence.

## 7. Each Task Completable in One Session — PASS

All tasks are scoped to 1-3 files. The largest (Task 2.1) touches one file (index.ts) with a mechanical refactor (21 inline wrappers → wrapTool calls). No task requires cross-cutting changes or extensive research. Task tiers (standard vs cheap) are reasonable.

## 8. Dependencies Satisfied in Order — FAIL

**Issue:** Task 2.2 ("First-run banner + getting started guide") adds `getFirstRunPreamble()` to `src/services/onboarding.ts`, but the plan says Task 2.1 calls `getOnboardingPreamble()`. There's an implicit dependency — 2.1's `wrapTool` references a function that doesn't exist until 2.2 implements it. The plan should clarify: either 2.1 includes a stub/no-op for `getOnboardingPreamble()` that 2.2 fills in, or 2.2 should be reordered before 2.1 (less likely to work since 2.1 is the integration point).

**Fix:** Add a note to Task 2.1 that it creates `getOnboardingPreamble()` as a stub returning `null` (no onboarding text), and Task 2.2 fills in the banner logic. This makes both tasks independently testable.

## 9. Vague Tasks / Ambiguity — FAIL

**Issue 1 — Task 3.1 member type detection:** The plan says to "parse from the response text (`Type: remote` or `Type: local`)" to determine member type for the nudge. This is brittle string parsing of another tool's output format. If the register_member response format changes, the nudge breaks silently. Two developers could implement this differently (regex vs indexOf vs split).

**Fix:** Instead of parsing the response string, pass the tool input (which contains `member_type`) into the nudge logic. The wrapTool wrapper has access to the input — thread it through.

**Issue 2 — Task 3.2 review cycle detection:** The plan says to detect review-related keywords in execute_prompt responses. The "Done" criteria say `"approved" or "review complete"` but the What section says `"review", "approved", "LGTM"`. These don't match. Also, this heuristic will false-positive on any prompt that happens to contain these words (e.g., "review the PR" as an instruction, not a result).

**Fix:** Tighten the keyword list to only `"approved"` and `"LGTM"` (results, not instructions). Document the exact list in both the What and Done sections. Alternatively, consider dropping the review cycle nudge entirely — it's low value and high false-positive risk, and the requirements say "After first review cycle complete" which implies integration with the PM skill's review tracking, not keyword-sniffing on raw prompt output.

## 10. Hidden Dependencies — FAIL

**Issue 1 — `monitor_task` always returns JSON:** The plan's R1 mitigation says "skip prepend when response starts with `{` or `[`". But `monitor_task` (line 99 of monitor-task.ts) always returns `JSON.stringify(result, null, 2)` — it has no compact/text mode. The plan doesn't mention `monitor_task` specifically. The heuristic of checking `{`/`[` prefix will catch it, but this should be explicitly called out and tested since it's a tool that ALWAYS returns JSON, not just optionally.

**Issue 2 — `welcomeBackShownThisSession` in the interface but not persisted:** The plan says this is "in-memory only, not persisted" and listed in the `OnboardingState` interface in types.ts. This is a design smell — mixing persisted and runtime state in the same interface leads to bugs where someone accidentally persists it or where `loadOnboardingState()` returns it as `false` (from disk) even though the banner was already shown. 

**Fix:** Keep `welcomeBackShownThisSession` as a separate module-level variable in `onboarding.ts`, not part of the `OnboardingState` interface. The interface should only contain persistable fields.

**Issue 3 — `lastActive` for welcome-back message:** Task 3.2 references `WELCOME_BACK(memberCount, onlineCount, lastActive)` from the text constants. But where does `lastActive` come from? The registry stores `createdAt` and `lastActivity` per agent — but `lastActivity` is set by `touchAgent()` in some tool handlers, not all. The plan doesn't specify how to compute "last active" across the fleet. Two developers would implement this differently.

**Fix:** Specify in Task 3.2: `lastActive = max(agent.lastActivity for agent in registry)`, falling back to "unknown" if none have been touched.

## 11. Risk Register — PASS (with gaps)

The register covers the major risks (R1-R6). However, it's missing one:

**Missing R7 — Race condition on first tool call:** If the AI client sends two tool calls simultaneously (e.g., `fleet_status` and `list_members` in parallel), both could see `bannerShown: false`, both prepend the banner, and then both try to write `bannerShown: true`. Result: banner shown twice. This is plausible because MCP servers can handle concurrent requests.

**Fix:** Add R7 to the risk register. Mitigation: load onboarding state once at server startup into memory, use the in-memory copy for all checks, and write to disk on state changes. This serializes through the JS event loop naturally. The plan already hints at this ("loaded once at server start") in the Architecture Overview but doesn't call it out as a concurrency risk or ensure Task 1.1 implements it this way.

## 12. Alignment with Requirements — FAIL

**Issue 1 — Requirements say "first meaningful interaction after install."** The plan implements "first tool call." These are the same thing in practice (MCP tools are the only interaction), but the plan should explicitly state this equivalence to show the requirement was considered.

**Issue 2 — Requirements say onboarding text is "prepended, not replacing."** The plan correctly prepends for banner/welcome-back but APPENDS nudges (Task 3.1: "Nudges are APPENDED"). This is actually the right UX decision (contextual follow-ups should come after the result), and the requirement arguably means "don't replace the tool response" rather than strictly "prepend." But the plan should acknowledge this deviation and justify it.

**Issue 3 — Requirements say "re-install / upgrade preserves onboarding state."** Task 4.1 handles the case where `onboarding.json` is missing but registry has members. But what about the `install` CLI command (`src/cli/install.ts`)? Does it touch the data directory? The plan doesn't verify that the install flow doesn't overwrite or reset the data directory. This should be explicitly verified in Task 4.1.

---

## Summary

The plan is well-structured with good phase decomposition, clear abstractions, and the riskiest change (wrapTool) correctly prioritized. The risk register covers most scenarios. However, there are several issues that need resolution before implementation:

**Must fix (blocking):**
- Task 2.1/2.2 dependency ordering — clarify the stub/fill-in relationship for `getOnboardingPreamble()`
- Task 3.1 member type detection — use tool input instead of parsing response strings
- Task 3.2 review detection heuristic — tighten keyword list or reconsider the feature
- Separate `welcomeBackShownThisSession` from the persisted `OnboardingState` interface
- Add R7 (concurrent first-call race) to risk register with in-memory state mitigation
- Specify how `lastActive` is computed for welcome-back messages

**Should fix (non-blocking but recommended):**
- Task 3.1/3.2 — explicitly note that `monitor_task` always returns JSON
- Task 4.1 — verify the `install` CLI doesn't reset the data directory
- Acknowledge the prepend-vs-append deviation from requirements wording for nudges
- Confirm "first meaningful interaction" = "first tool call" equivalence
