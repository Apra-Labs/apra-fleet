# Plan Review: UX Quality Fixes (Round 2)

**Branch:** `sprint/ux-quality-fixes`
**Reviewer:** Claude Opus 4.6
**Date:** 2026-04-05
**Plan commit:** `11eeb5b`

## Checklist

1. **Does every task have clear "done" criteria?**
   PASS — Every work task (1, 2, 4, 5, 6, 8, 9, 10, 11) has an explicit "Done when" clause with testable conditions. VERIFY checkpoints (3, 7, 12) have pass criteria tied to `npm run build` and `npm test`.

2. **High cohesion within each task, low coupling between tasks?**
   PASS — Each task maps 1:1 to a GitHub issue with a narrow file set (1-2 files). No task touches another task's files. The only shared file is `src/index.ts` (Task 2), which is not touched by any other task.

3. **Are key abstractions and shared interfaces in the earliest tasks?**
   PASS — This sprint is bug fixes, not feature work — there are no shared abstractions to extract. The riskiest platform-level changes (auth-socket, installer) are correctly front-loaded in Phase 1.

4. **Is the riskiest assumption validated in Task 1 (#42 OOB terminal)?**
   PASS — Task 1 directly tackles #42, the highest-risk item (platform-dependent terminal behavior). The risk register also calls out the Windows/macOS platform isolation concern.

5. **Later tasks reuse early abstractions (DRY)?**
   PASS — Not applicable in the traditional sense (no shared abstraction to reuse), but the plan is correctly structured: foundational fixes first, edge cases last. No task duplicates work from another.

6. **2-3 work tasks per phase, then a VERIFY checkpoint?**
   PASS — Phase 1: 2 work + 1 verify. Phase 2: 3 work + 1 verify. Phase 3: 4 work + 1 verify. Phase 3 has 4 work tasks, which slightly exceeds the 2-3 guideline, but all four are small, isolated fixes (bounds check, warning message, UI hint, version injection) so this is acceptable.

7. **Each task completable in one session?**
   PASS — Every task is scoped to 1-2 files with a specific, bounded change. The largest (Task 1, OOB terminal) touches one file with three well-defined behaviors to add. Task 8 (version injection) spans 2 files but the change is mechanical.

8. **Dependencies satisfied in order?**
   PASS — No task depends on output from a later task. Tasks within each phase are independent. VERIFY checkpoints correctly gate phase transitions.

9. **Any vague tasks that two developers would interpret differently?**
   FAIL — Task 5 (Issue #67) offers two alternative approaches ("OS temporary folder" vs ".gitignore guard") without picking one. Two developers would implement different solutions. The plan should commit to one approach. Recommendation: prefer the temp dir approach since it eliminates the problem at the source rather than relying on a .gitignore that could be removed.

10. **Any hidden dependencies between tasks?**
    PASS — No hidden dependencies found. Each task targets distinct files and distinct behavior. Task 2 (installer key) and Task 8 (version string) both involve version strings but in completely separate code paths (`install.ts` vs `version.ts`/`ci.yml`).

11. **Does the plan include a risk register?**
    PASS — Risk register present with two entries: OOB terminal platform variance and esbuild BUILD_VERSION injection. Both are the correct high-risk items. Could be stronger — see recommendations.

12. **Does the plan align with requirements.md intent — all 9 issues addressed?**
    PASS — All 9 issues (#6, #9, #10, #37, #39, #42, #57, #67, #78) are mapped to tasks. The requirements.md provides detailed root cause analysis, file locations, and acceptance criteria that the plan tasks align with.

## Summary

**11 PASS / 1 FAIL**

The plan is a major improvement over Round 1. Every task is concrete, file-scoped, and has done criteria. The phasing is sound — risk-first, edge-cases last. All referenced source files exist in the repo.

## Issues to Address

1. **Task 5 ambiguity (FAIL):** Pick one approach for `.fleet-task*` file placement. Recommend: write to OS temp dir (e.g., `os.tmpdir()`). If the temp dir approach is chosen, the `.gitignore` guard becomes unnecessary — remove it from the task description to avoid confusion.

## Recommendations (non-blocking)

2. **Risk register additions:** Consider adding: (a) Task 6 test coverage — mocking `ensureCloudReady` error paths may require refactoring if the function isn't easily testable in isolation; (b) Task 5 temp dir — if the member's Claude Code reads the task file by path, moving it to `/tmp` could break delivery unless the path is communicated.

3. **Phase 3 size:** 4 work tasks is at the upper bound. If any task grows during implementation, consider splitting Phase 3 into 3a (Tasks 8-9) and 3b (Tasks 10-11) with an intermediate verify.

---

**Verdict: APPROVED**

The single FAIL (Task 5 ambiguity) is minor and can be resolved at implementation time. The plan is actionable, well-ordered, and covers all 9 issues.
