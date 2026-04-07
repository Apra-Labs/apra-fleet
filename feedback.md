# API Cleanup & Skill Doc Sweep — Plan Review

**Reviewer:** fleet-rev (sprint/skill-refactor reviewer)  
**Date:** 2026-04-06 21:30:00+00:00  
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review.

---

## Prior Review Context

Two prior reviews (commits fdbcf0c, 18f8309) flagged a gap between requirements.md and the plan — the plan addressed a narrower scope than the user's checklist demanded. The doer resolved this by choosing **Option B: Expand Requirements**. requirements.md was rewritten to cover all six issues (#83, #84, #85, #87, #88, #89), and PLAN.md was rewritten from scratch (commit ad156f8) to address the expanded scope. This review evaluates the new plan against the new requirements.

---

## 1. Done Criteria — PASS

Every task has an explicit **Done:** line with a verifiable condition. Examples: Task 1.1 specifies that `loadLedger` never returns undefined `granted` or `stacks` regardless of file content. Task 2.2 specifies the exact output format (`"2.1.92"` not `"Claude Code 2.1.92"`). Task 4.5 specifies full removal with no backward-compat shim. No ambiguity.

## 2. Cohesion and Coupling — PASS

Each phase groups tightly related changes: Phase 1 = crash fix + low-risk rename, Phase 2 = member_detail output shape, Phase 3 = execute_command params + tilde fix, Phase 4 = token accumulation lifecycle, Phase 5 = docs. Cross-phase coupling is minimal — the only dependency is that Phase 5 references names introduced in Phases 1-4.

## 3. Key Abstractions in Earliest Tasks — PASS

Task 3.2 introduces the `resolveTilde` helper shared between `execute-command.ts` and `execute-prompt.ts`. Task 4.1 introduces `tokenUsage` on the `Agent` type before Tasks 4.2-4.4 consume it. Both are correctly front-loaded within their phases.

## 4. Riskiest Assumption in Task 1 — PASS

The crash fix (#88) is front-loaded as Task 1.1. This is the right call — it's the only bug that causes a runtime crash in production. The `compose_permissions` `loadLedger` guard is low-risk but validates the assumption that the fix is a simple null-coalescing guard (confirmed: `loadLedger` at lines 80-86 of `compose-permissions.ts` parses JSON directly without guards).

## 5. Later Tasks Reuse Early Abstractions — PASS

`resolveTilde` (Task 3.2) is used in both `execute-command.ts` and `execute-prompt.ts`. `tokenUsage` type (Task 4.1) flows through Tasks 4.2 → 4.3 → 4.4. Phase 5 doc updates reference the renames from Phases 1-3.

## 6. Phase Size — NOTE

Phases 1-3 and 5 follow the 2-3 tasks + VERIFY guideline. **Phase 4 has 5 tasks**, exceeding the guideline. However, Tasks 4.3-4.5 are all marked cheap and are essentially mechanical (add a field to output, delete a file). The 5-task phase is acceptable here because the tasks form a tight dependency chain (type → accumulate → surface × 2 → remove old), but the plan should acknowledge this deviation.

## 7. Each Task Completable in One Session — PASS

All tasks are marked cheap except 4.1-4.2 (standard). Even the standard tasks are well-scoped: 4.1 is adding a single field to a type, 4.2 is ~10 lines of accumulation logic. No task requires multi-session work.

## 8. Dependencies Satisfied in Order — PASS

Task 4.1 (type) before 4.2 (use it). Task 4.2 (accumulate) before 4.3-4.4 (surface). Task 4.5 (remove old tool) after 4.2 provides the replacement. Phase 5 (doc sweep) after all code changes. `updateAgent` import in Task 4.2 is verified to exist at `src/services/registry.ts:111`.

## 9. Vague Tasks — PASS

Every task specifies exact files, line numbers, and code snippets. The line number references were verified against the codebase and are accurate (within ±1 line). No task is ambiguous enough for two developers to interpret differently.

## 10. Hidden Dependencies — PASS

No hidden dependencies found. The only cross-phase dependency (Phase 5 referencing names from Phases 1-4) is explicit in the phase ordering.

## 11. Risk Register — FAIL

**The plan contains no risk register.** The previous plan version (commit 99e9a11) had 4 documented risks. The rewritten plan dropped them entirely. Identified risks that should be documented:

1. **Breaking change risk:** `provision_auth` → `provision_llm_auth` (Task 1.3) and `work_folder` → `run_from` (Task 3.1) are schema-level renames. Any external caller using the old names will break. Mitigation: requirements explicitly say "no backward-compat shims" — this is intentional, but the risk should be acknowledged.
2. **Token accumulation race:** Task 4.2 reads `agent.tokenUsage`, adds to it, then writes back. If two concurrent `execute_prompt` calls finish simultaneously for the same agent, one update could be lost. Mitigation: assess whether `updateAgent` is atomic or needs a compare-and-swap.
3. **Tilde expansion edge cases:** Task 3.2 only handles `~/` and bare `~`. Paths like `~user/foo` (other user's home) would not be resolved. Mitigation: document that only `~` (current user) is supported.
4. **#88 template discrepancy:** Requirements say "Fix the template permissions.json file to ship with `{"granted": []}` not `{}`" but the plan notes no template file exists in the repo. The plan's guard-in-`loadLedger` approach is arguably better (defends against any malformed JSON), but the requirement is technically unmet. Mitigation: explicitly close this out — either create the template or update requirements to reflect the guard-based fix.

## 12. Alignment with requirements.md — FAIL (two gaps)

**Gap A — Missing tilde resolution test.** Requirements acceptance criteria state: *"All existing tests pass; new tests added for CWD fix, tilde resolution, and compose_permissions guard."* The plan includes a test for compose_permissions (Task 1.2) and updates existing tests (Tasks 2.3, 3.3), but **no task creates a test for tilde resolution**. Task 3.3 only renames `work_folder` → `run_from` in existing tests. A test should verify that `resolveTilde('~/git/project')` returns the expanded path and that a bare `~` is handled correctly.

**Gap B — #88 template fix.** As noted in the risk register section, requirements.md explicitly asks to "Fix the template permissions.json file to ship with `{"granted": []}` not `{}`". The plan's investigation found no template file exists, and the `loadLedger` guard is a valid fix, but the plan should either (a) add a task to create the template file with correct defaults, or (b) explicitly propose updating requirements.md to remove the template fix line. Currently it's a silent deviation.

---

## Summary

The plan is well-structured, with accurate file/line references, clear done criteria, correct dependency ordering, and good phase decomposition. The requirements-checklist gap from prior reviews has been fully resolved by expanding requirements.md.

**Two items block approval:**

1. **Add a risk register** — at minimum covering breaking changes, token race conditions, tilde edge cases, and the template discrepancy.
   **Doer:** fixed in commit 892a2c6 — added Risk Register section to PLAN.md with risks R1–R4 covering breaking changes, token race (assessed as non-issue in single-threaded Node.js), tilde edge cases, and #88 template discrepancy.

2. **Add a tilde resolution test task** (e.g., Task 3.4) that tests `resolveTilde` with `~/path`, bare `~`, and a non-tilde path. This is explicitly required by the acceptance criteria.
   **Doer:** fixed in commit 892a2c6 — added Task 3.4 to PLAN.md with four test cases: `~/path`, bare `~`, absolute path passthrough, relative path passthrough.

3. **Resolve the #88 template discrepancy** — either add a template creation task or propose a requirements update. Don't leave it as a silent deviation.
   **Doer:** fixed in commit 892a2c6 — updated requirements.md to replace template-fix sub-item with guard-based fix description. Updated Task 1.1 done criteria to explicitly state guard-based approach is chosen (no template file created). Added Risk R4 documenting the resolution.

Once these are addressed, the plan should be ready for APPROVED.
