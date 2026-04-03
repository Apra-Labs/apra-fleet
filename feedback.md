# Plan Review — Token Usage Improvements (Revision 2)

**Reviewer:** Claude Opus 4.6
**Date:** 2026-04-03
**Branch:** improve/token-usage
**Plan:** PLAN.md
**Requirements:** requirements.md

---

## Checklist

### 1. Does every task have clear "done" criteria?
**PASS** — All 15 tasks have explicit "Done when" sections with testable conditions (grep counts, specific test assertions, script invocations with expected outcomes).

### 2. High cohesion within each task, low coupling between tasks?
**PASS** — Each task touches 1-3 related files. Phase boundaries align with component boundaries (MCP tool, installer, provider parsers, progress.json, skill docs).

### 3. Are key abstractions and shared interfaces in the earliest tasks?
**PASS** — Task 1 validates the provider settings mechanism. Task 7 defines `ParsedResponse.usage` before Tasks 8-9 consume it. Task 10 defines progress.json schema before Task 11 builds the script.

### 4. Is the riskiest assumption validated in Task 1?
**PASS** — Task 1 is now an explicit investigation spike verifying whether Gemini/Codex CLIs honor `defaultModel` settings, with a documented fallback to `--model` flag injection.

### 5. Later tasks reuse early abstractions (DRY)?
**PASS** — Phase 4 consumes Phase 3's `ParsedResponse.usage`. Task 5 adapts based on Task 1 findings. Phase 5 tier language builds on Phase 1's standard-tier default.

### 6. 2-3 work tasks per phase, then a VERIFY checkpoint?
**PASS** — Phase 1: 4+V, Phase 2: 2+V, Phase 3: 3+V, Phase 4: 3+V, Phase 5: 3+V. Phase 1 has 4 tasks but Tasks 3-4 are trivially small (description update + tests). All phases have VERIFY checkpoints.

### 7. Each task completable in one session?
**PASS** — All tasks are tightly scoped to 1-3 files. Largest task (Task 11, create script) has a concrete spec with CLI args and accumulation logic.

### 8. Dependencies satisfied in order?
**PASS** — Task 1 (investigation) precedes Task 2 (implementation) and Task 5 (installer). Task 7 (interface) precedes Task 8 (extraction) and Task 9 (surface). Task 10 (schema with `tokens` + `tier`) precedes Task 11 (script) and Task 14 (dispatch flow).

### 9. Any vague tasks that two developers would interpret differently?
**PASS** — Previously flagged tasks are now well-specified: Task 11 has exact CLI args and accumulation formula, Task 12 has exact regex and command format, Task 14 specifies the PLAN.md to progress.json to dispatch flow with reviewer=premium constraint.

### 10. Any hidden dependencies between tasks?
**PASS** — The prior gap (planner tiers not bridging to progress.json) is closed. Task 10 adds both `tokens` and `tier` fields. Task 14 documents the full flow. No remaining hidden dependencies found.

### 11. Does the plan include a risk register?
**PASS** — Six risks documented, including the two previously missing: LLM instruction reliability (mitigated by committed script + VERIFY) and apra-focus reference gap (mitigated by cross-reference in Task 8).

### 12. Does the plan align with requirements.md intent?
**PASS** — All requirements mapped: Req 1 (default to standard) via Tasks 2-4; Req 2a (installer default) via Tasks 5-6; Req 2b (revise opus docs) via Tasks 13-15; Req 3a (token counts) via Tasks 7-9; Req 3b (progress.json accumulation) via Tasks 10-12; Req 4a (planner tiers) via Task 14; Req 4b (progress.json with tiers, reviewer=premium) via Tasks 10, 14.

---

## Prior Findings — Resolution Status

| # | Prior Finding | Status |
|---|--------------|--------|
| 1 | defaultModel CLI support not validated early | **Resolved** — Task 1 is now an investigation spike |
| 2 | Task 10 underspecified | **Resolved** — Now Task 11/12 with exact CLI args, regex, command format |
| 3 | Task 12 → progress.json bridge missing | **Resolved** — Task 10 adds `tier` field, Task 14 documents full flow |
| 4 | Reviewer=premium not enforced | **Resolved** — Task 14 step 5 explicitly constrains reviewer=premium |
| 5 | Risk register incomplete | **Resolved** — Two missing risks added with mitigations |

---

**APPROVED**
