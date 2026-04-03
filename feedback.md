# Plan Review — Token Usage Improvements

**Reviewer:** Claude Opus 4.6
**Date:** 2026-04-03
**Branch:** improve/token-usage
**Plan:** PLAN.md
**Requirements:** requirements.md

---

## Checklist

### 1. Does every task have clear "done" criteria?
**PASS** — All 13 tasks have "Done when" sections with specific, testable conditions (grep results, test assertions, file content checks).

### 2. High cohesion within each task, low coupling between tasks?
**PASS** — Each task is focused on 1-3 related files. Phase boundaries align with component boundaries (MCP tool, installer, provider parsers, skill docs).

### 3. Are key abstractions and shared interfaces in the earliest tasks?
**PASS** — `usage` field on `ParsedResponse` (Task 6, Phase 3) is defined before any consumption in Tasks 7-8 and Phase 4.

### 4. Is the riskiest assumption validated in Task 1?
**FAIL** — The riskiest assumption is whether CLIs honor a `defaultModel` setting in their config (Task 4's own blocker note: "Need to verify that each CLI honours a defaultModel setting; if not, fall back to injecting --model everywhere"). This isn't validated until Phase 2, Task 4. If it fails, the fallback changes the approach for the entire phase. A quick verification spike (check CLI docs or test one provider) should be in Task 1 or at the start of Phase 2 before writing install code.

### 5. Later tasks reuse early abstractions (DRY)?
**PASS** — Phase 4 (progress.json token accumulation) consumes token data surfaced by Phase 3's `ParsedResponse.usage`. Phase 5's tier language builds on Phase 1's standard-tier default.

### 6. 2-3 work tasks per phase, then a VERIFY checkpoint?
**PASS** — Phase 1: 3+V, Phase 2: 2+V, Phase 3: 3+V, Phase 4: 2+V, Phase 5: 3+V. All within bounds.

### 7. Each task completable in one session?
**PASS** — All tasks touch 1-3 files with focused changes. Largest tasks (6, 10) are clearly scoped.

### 8. Dependencies satisfied in order?
**PASS** — Task 6 (ParsedResponse.usage) precedes Task 7 (Claude extraction) and Task 8 (surface in execute_prompt). Task 9 (progress.json schema) precedes Task 10 (PM workflow). Phase 1 default model precedes Phase 2 installer default.

### 9. Any vague tasks that two developers would interpret differently?
**FAIL** — Two tasks are underspecified:
- **Task 10** ("Document token update workflow in PM skill"): Says "add a step instructing the PM to read token counts and use execute_command to update progress.json" but doesn't specify: what JSON path to update, what the execute_command invocation looks like, how the PM parses the "Tokens: input=N output=M" line from Task 8's output, or the accumulation formula. Two developers would write very different instructions.
- **Task 12** ("Update planning prompt with model tier assignment step"): Says "planner can decide which phase needs what type of model" but doesn't specify how the tier assignment flows from planner output into progress.json for the PM to read during dispatch. The planner writes PLAN.md, the PM reads progress.json — the bridge is missing.

### 10. Any hidden dependencies between tasks?
**FAIL** — Task 12 (planner assigns model tiers per task) produces output that must be consumed by the PM during dispatch, but no task adds a `tier` field to progress.json (Task 9 only adds `tokens`) or updates the PM dispatch loop to read the tier when choosing `--model`. Requirement 4b depends on this bridge existing.

### 11. Does the plan include a risk register?
**FAIL** — Risk register exists with 4 valid risks, but is missing:
- **LLM instruction reliability:** Tasks 10 and 12 depend on the PM (an LLM) consistently following natural-language instructions to parse token lines and accumulate counts. LLMs can skip steps, misparse, or hallucinate values. Mitigation: structured output format, validation in VERIFY 4.
- **apra-focus reference gap:** Requirements.md explicitly says "refer to apra-focus main codebase for correct ways to know token usage." No task references apra-focus for token extraction patterns. If the approach differs from apra-focus, token counts may be wrong or inconsistent.

### 12. Does the plan align with requirements.md intent?
**FAIL** — Most requirements are well-covered, but requirement 4b is partially addressed:
- Requirement 4b: "initial progress.json should always be available at the PM to refer which dispatching prompts for doers and reviewers (reviewers always use premium models)"
- Task 12 adds tier assignment to the planner prompt, but no task ensures these tiers are written into progress.json or that the PM reads them during dispatch. The plan covers token *tracking* in progress.json but not model-tier *dispatch guidance* in progress.json.
- Additionally, the requirement states "reviewers always use premium models" — Task 12 allows the planner to assign tiers including to reviewers, but doesn't enforce the reviewer=premium constraint.

---

## Summary of Required Changes

| # | Finding | Severity | Suggested Fix |
|---|---------|----------|---------------|
| 1 | defaultModel CLI support not validated early | Medium | Add a verification step at the start of Phase 2 (or end of Phase 1) to confirm CLI support before writing install code |
| 2 | Task 10 underspecified | High | Add concrete details: JSON path, execute_command format, token line parsing regex, accumulation formula |
| 3 | Task 12 → progress.json bridge missing | High | Add a task (or extend Task 9) to include a `tier` field per task in progress.json, and update PM dispatch to read it |
| 4 | Reviewer=premium not enforced | Medium | Task 12 should specify that reviewers always use premium tier regardless of planner assignment |
| 5 | Risk register incomplete | Low | Add LLM instruction reliability risk and apra-focus reference gap |

---

**CHANGES NEEDED**
