# Issue #98 Plan Review (Second Review) — Glob Patterns and Directories in send_files / receive_files

**Reviewer:** fleet-rev
**Date:** 2026-05-01
**Verdict:** APPROVED

---

## Previous-Review Fix Verification

All 5 items from the first review (commit 890b686) are resolved:

| # | Issue | Resolution | Status |
|---|-------|-----------|--------|
| 1 | Missing local strategy task (blocking) | Task 3 added — updates `LocalStrategy.transferFiles()` and `receiveFiles()` in `strategy.ts` to accept `{absolute, relative}[]`, create intermediate directories, and expand paths for local members | Fixed |
| 2 | Post-expansion security gap (blocking) | Task 5 now validates all expanded `relative` paths after expansion: `path.posix.normalize(relative)` must not start with `..` or `/` | Fixed |
| 3 | `minimatch` dependency (minor) | Removed entirely — Task 5 specifies inline single-level matcher (`*`/`?` only), no new npm deps | Fixed |
| 4 | Task tier monotonicity (minor) | Task 7 (formerly Task 6) promoted to `standard` — sequence is now cheap → standard(x8), monotonically non-decreasing | Fixed |
| 5 | Symlink traversal risk (minor) | Added to risk register row 1: "Symlink on remote member points outside work_folder — high — Task 5 validates all expanded relative paths" | Fixed |

---

## 13-Point Checklist

### 1. Does the plan address everything in requirements.md?
**PASS.** All expansion rules (explicit file, glob, directory) covered for both `send_files` and `receive_files`. Local strategy (`strategy.ts`) now has a dedicated task (Task 3). All files in scope from requirements.md are addressed. No new npm dependencies — uses `node:fs/promises` glob and inline matcher.

### 2. Are phases clearly separated with VERIFY checkpoints?
**PASS.** Four phases, each ending with a VERIFY block listing build, test, and manual checks.

### 3. Are tiers monotonically non-decreasing across the plan?
**PASS.** Task 1: cheap. Tasks 2–9: all standard. Monotonically non-decreasing.

### 4. Does each task have a concrete "Done when" criterion?
**PASS.** Every task has specific, verifiable criteria including build gates and test expectations.

### 5. Are blockers correctly stated?
**PASS.** Dependency chains are accurate:
- Task 1: none (foundation)
- Task 2: Task 1
- Task 3: Tasks 1, 2
- Task 4: Tasks 1, 2, 3
- Task 5: none (independent remote-side work)
- Task 6: Task 5
- Task 7: Task 6
- Task 8: Task 1
- Task 9: Tasks 2, 5

Phase 1 and Phase 3 can proceed in parallel up to their respective VERIFY gates.

### 6. Is the base branch correct?
**PASS.** Base branch: `main`. Implementation branch: `feat/glob-dir-transfer`. Both follow conventions.

### 7. Are file paths accurate and do referenced files exist?
**PASS.** All existing files verified present:
- `src/tools/send-files.ts` ✓
- `src/tools/receive-files.ts` ✓
- `src/services/sftp.ts` ✓
- `src/services/file-transfer.ts` ✓
- `src/services/strategy.ts` ✓

New files (`src/utils/expand-paths.ts`, `tests/expand-paths.test.ts`, `tests/sftp.test.ts`) correctly marked as new.

### 8. Is scope complete — local member strategy, schema descriptions, collision check all covered?
**PASS.**
- **Local member strategy:** Task 3 updates both `transferFiles()` and `receiveFiles()` in `strategy.ts`. ✓
- **Schema descriptions:** Tasks 4 and 7. ✓
- **Collision check:** Task 4 updates collision check to use `entry.relative`. ✓

### 9. Are risks identified and mitigated?
**PASS.** Six risks with appropriate mitigations, including symlink traversal (high severity) with path validation in Task 5.

### 10. Is the regression test realistic and sufficient?
**PASS.** Task 8 covers five local expansion cases. Task 9 covers remote expansion, path traversal rejection, nested upload, and backward-compat flat upload. VERIFY blocks include manual end-to-end checks.

### 11. Are there implementation details missing that would block a developer?
**PASS.** Previous ambiguity around `minimatch` is resolved — inline matcher is the only option. `file-transfer.ts` type threading is called out in Tasks 2 and 6. The `node:fs/promises` glob availability concern is addressed in the risk register with a fallback strategy.

### 12. Are commit/branch conventions followed?
**PASS.** Branch `feat/glob-dir-transfer` follows `feat/<topic>` convention. Each task = one commit. VERIFY = checkpoint.

### 13. Any security concerns (path traversal via relative paths)?
**PASS.** Task 5 validates all expanded `relative` paths after expansion — `path.posix.normalize(relative)` must not start with `..` or `/`. This catches symlink escape attempts before any download occurs. The risk register documents this as a high-severity item with the mitigation in place.

---

## Summary

All blocking and minor items from the first review are resolved. The plan is complete, well-structured, and ready for implementation. No further changes needed.
