# Plan Review — Token Usage Improvements (Revision 3)

**Reviewer:** Claude Opus 4.6
**Date:** 2026-04-03
**Branch:** improve/token-usage
**Plan:** PLAN.md
**Requirements:** requirements.md

---

## Checklist

### 1. Does every task have clear "done" criteria?
**PASS** — All 16 tasks have "Done when" sections with testable conditions. Task 16 uses grep-based verification.

### 2. High cohesion within each task, low coupling between tasks?
**PASS** — Task 16 touches the same files as Task 13 (`SKILL.md`, `doer-reviewer.md`) but edits disjoint sections (opus references vs resume rules). Manageable overlap.

### 3. Are key abstractions and shared interfaces in the earliest tasks?
**PASS** — Same structure as revision 2. Task 1 validates provider settings, Task 7 defines `ParsedResponse.usage`, Task 10 defines progress.json schema — all before consumers.

### 4. Is the riskiest assumption validated in Task 1?
**PASS** — Task 1 remains an investigation spike for CLI `defaultModel` support.

### 5. Later tasks reuse early abstractions (DRY)?
**PASS** — No change from revision 2.

### 6. 2-3 work tasks per phase, then a VERIFY checkpoint?
**PASS** — Phase 5 now has 4 tasks (13-16) + VERIFY, exceeding the 2-3 guideline. However, all are docs-only changes and Tasks 15-16 are trivially small. Acceptable.

### 7. Each task completable in one session?
**PASS** — Task 11 (MCP tool) is the largest but has a clear spec. Task 16 is a small docs addition.

### 8. Dependencies satisfied in order?
**FAIL** — Task 12 tells the PM to call `node scripts/update-tokens.js --task-id <id> --role <role> --input <N> --output <M>` (line 108), but Task 11 now creates an MCP tool `update_task_tokens` — not a Node.js script. The PM should call the MCP tool directly, not invoke a script via `execute_command`. VERIFY Phase 4 (lines 114-117) also tests a script that no longer exists in the plan.

### 9. Any vague tasks that two developers would interpret differently?
**FAIL** — Task 12's instructions contradict Task 11. Task 12 says "call `execute_command` on the doer member: `node scripts/update-tokens.js ...`" but Task 11 creates an MCP tool the PM calls directly. A developer implementing Task 12 as written would produce docs that reference a non-existent script.

### 10. Any hidden dependencies between tasks?
**PASS** — No new hidden dependencies beyond the stale references (covered in checks 8 and 9).

### 11. Does the plan include a risk register?
**FAIL** — Risk register has two stale references to `scripts/update-tokens.js` (rows 3 and 5). Row 3 says "scripts/update-tokens.js initializes missing fields" — should reference the MCP tool. Row 5's mitigation says "use a committed script (scripts/update-tokens.js)" — should say "use a dedicated MCP tool (update_task_tokens)".

### 12. Does the plan align with requirements.md intent?
**PASS** — Task 16 (resume=true rule) is a valuable addition for token savings that aligns with the overarching goal. The MCP tool approach (Task 11) is architecturally better than the member-side script for req 3b. Core coverage unchanged.

---

## Findings

| # | Finding | Severity | Location | Suggested Fix |
|---|---------|----------|----------|---------------|
| 1 | Task 12 references deleted `scripts/update-tokens.js` instead of new `update_task_tokens` MCP tool | High | PLAN.md lines 107-109 | Rewrite Task 12 step 2: PM calls `update_task_tokens` MCP tool with `member_id`, `progress_json`, `task_id`, `role`, `input_tokens`, `output_tokens` — no `execute_command` needed |
| 2 | VERIFY Phase 4 tests a non-existent script | High | PLAN.md lines 114-117 | Rewrite verification to test the MCP tool: call `update_task_tokens` with sample params and confirm accumulation |
| 3 | Risk register row 3 references `scripts/update-tokens.js` | Low | PLAN.md line 167 | Update to reference `update_task_tokens` MCP tool |
| 4 | Risk register row 5 references `scripts/update-tokens.js` | Low | PLAN.md line 169 | Update to reference `update_task_tokens` MCP tool |

All four findings stem from the same root cause: Task 11's implementation was updated but downstream references were not.

---

**CHANGES NEEDED**
