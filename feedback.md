# API Cleanup & Skill Doc Sweep — Plan Review

**Reviewer:** fleet-rev  
**Date:** 2026-04-06 22:15:00+00:00  
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.

---

## Prior Review Context

This is the fourth review of this plan. The first two reviews (commits fdbcf0c, 18f8309) flagged a requirements-checklist gap. The doer resolved this by expanding requirements.md (Option B). The third review (commit 8dd42ea) found three blocking issues: missing risk register, missing tilde test task, and an unresolved #88 template discrepancy. The doer addressed all three in commit 892a2c6:

- **Risk register:** Added R1–R4 to PLAN.md covering breaking changes, token race (correctly assessed as non-issue in single-threaded Node.js), tilde edge cases, and the template discrepancy. All four risks are well-characterized with impact and mitigation.
- **Tilde test task:** Added Task 3.4 with four test cases (`~/path`, bare `~`, absolute passthrough, relative passthrough). Phase 3 summary updated to reflect 3.1–3.4.
- **#88 template discrepancy:** Requirements.md updated to replace the template-fix sub-item with the guard-based `loadLedger` approach. Task 1.1 done criteria explicitly state no template file is created. Risk R4 documents the resolution. This is the right call — guarding in `loadLedger` is strictly more robust than shipping a template.

---

## Plan Review Checklist

### 1. Done Criteria — PASS

Every task has an explicit **Done:** line with a verifiable condition. Task 1.1 now includes the guard-based approach clarification. Task 3.4 specifies all four tilde test cases must pass. No task leaves the definition of "done" ambiguous.

### 2. Cohesion and Coupling — PASS

Each phase groups tightly related changes: Phase 1 = crash fix + low-risk rename, Phase 2 = member_detail output, Phase 3 = execute_command params + tilde, Phase 4 = token lifecycle, Phase 5 = docs. The only cross-phase dependency (Phase 5 references names from Phases 1-4) is correctly ordered.

### 3. Key Abstractions in Earliest Tasks — PASS

`resolveTilde` (Task 3.2) is introduced before it's used in both `execute-command.ts` and `execute-prompt.ts`. `tokenUsage` type (Task 4.1) is introduced before Tasks 4.2-4.4 consume it.

### 4. Riskiest Assumption in Task 1 — PASS

The crash fix (#88) is front-loaded as Task 1.1 — the only runtime crash. The `loadLedger` guard validates the assumption that the fix is a simple null-coalescing guard (confirmed against line 80-86 of `compose-permissions.ts`).

### 5. Later Tasks Reuse Early Abstractions — PASS

`resolveTilde` is shared across `execute-command.ts` and `execute-prompt.ts`. `tokenUsage` flows through Tasks 4.2 → 4.3 → 4.4. Phase 5 doc updates reference the renames from Phases 1-3.

### 6. Phase Size — PASS (with note)

Phases 1-3 and 5 have 3-4 tasks each. Phase 4 has 5 tasks, slightly exceeding the 2-3 guideline, but tasks 4.3-4.5 are cheap and mechanical (add field to output, delete files). The 5-task phase is acceptable because the tasks form a tight dependency chain. Phase 3 grew from 3 to 4 tasks with the addition of Task 3.4 (tilde tests), which is the right place for it.

### 7. Each Task Completable in One Session — PASS

All tasks marked cheap except 4.1-4.2 (standard). Even the standard tasks are well-scoped: 4.1 adds a single type field, 4.2 is ~10 lines of accumulation logic.

### 8. Dependencies Satisfied in Order — PASS

Task 4.1 (type) before 4.2 (use). Task 4.2 (accumulate) before 4.3-4.4 (surface). Task 4.5 (remove old tool) after replacement is in place. Task 3.2 (helper) before 3.4 (test it). Phase 5 (docs) after all code changes. `updateAgent` (referenced in Task 4.2) verified to exist at `src/services/registry.ts:111`.

### 9. Vague Tasks — PASS

Every task specifies exact files, line numbers, and code snippets. Line references verified against the codebase and are accurate. Task 3.4 specifies all four test cases explicitly.

### 10. Hidden Dependencies — PASS

No hidden dependencies. Task 5.1 references names from Phases 1 and 4 (`provision_llm_auth`, `update_task_tokens` removal) — correctly ordered after those phases.

### 11. Risk Register — PASS

Risk register added with four well-characterized risks (R1-R4). R2 (token race) correctly identifies that single-threaded Node.js event loop makes this a non-issue. R3 (tilde edge cases) correctly scopes `~user/foo` out — not a fleet use case. R4 (template discrepancy) is resolved with both a requirements update and code-level documentation.

### 12. Alignment with requirements.md — PASS

All six issues are addressed:
- **#89:** Already fixed (noted in plan header, commits e28f294, f02a4a0)
- **#88:** Guard-based fix in Task 1.1 + test in Task 1.2; requirements updated to match
- **#87:** Rename + version strip in Tasks 2.1-2.2 + test update in Task 2.3
- **#85:** Param rename in Task 3.1 + tilde fix in Task 3.2 + test updates in Tasks 3.3-3.4
- **#84:** Rename in Task 1.3
- **#83:** Auto-accumulation in Tasks 4.1-4.4 + tool removal in Task 4.5

Acceptance criteria coverage: CWD fix (#89 already done), compose_permissions test (Task 1.2), tilde resolution tests (Task 3.4), all existing tests pass (VERIFY checkpoints after each phase), skill docs updated (Phase 5).

---

## Summary

All 12 checklist items pass. The three blocking issues from the prior review have been resolved cleanly: risk register is complete and well-reasoned, tilde test task fills the acceptance criteria gap, and the #88 template discrepancy is resolved at both the requirements and plan level. The plan is ready for implementation.
