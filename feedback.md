# Issue #98 Plan Review — Glob Patterns and Directories in send_files / receive_files

**Reviewer:** fleet-rev
**Date:** 2026-05-01
**Verdict:** CHANGES NEEDED

---

## 13-Point Checklist

### 1. Does the plan address everything in requirements.md?
**PARTIAL.** Glob expansion, directory walking, and backward compatibility are covered for both `send_files` and `receive_files`. However, requirements.md lists `src/services/strategy.ts` in "Files in scope" and the plan's own Notes (line 123–124) acknowledge that the local strategy must be updated — yet **no task exists for updating `LocalStrategy.transferFiles()` or `LocalStrategy.receiveFiles()`**. These methods (`strategy.ts:181–205` and `strategy.ts:207–227`) currently accept `string[]` and use `path.basename(localPath)` for destination paths. Without a dedicated task, local members will break or silently ignore directory structure.

### 2. Are phases clearly separated with VERIFY checkpoints?
**PASS.** Four phases, each ending with a VERIFY block listing build, test, and manual checks.

### 3. Are tiers monotonically non-decreasing across the plan?
**MINOR NIT.** Task 6 (Phase 3) is tier `cheap` after Tasks 4–5 are `standard`, and Tasks 7–8 (Phase 4) return to `standard`. Sequence: cheap → standard → standard → standard → standard → cheap → standard → standard. Not monotonically non-decreasing. Task 6 is genuinely trivial (schema text update), but either promote it to `standard` or document the exception.

### 4. Does each task have a concrete "Done when" criterion?
**PASS.** Every task has specific, verifiable criteria including build and test gates.

### 5. Are blockers correctly stated?
**PASS.** Task 4 correctly notes it can run in parallel with Task 2. All dependency chains are accurate.

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
**NO — local member strategy task is missing.**
- **Schema descriptions:** Covered in Tasks 3 and 6. ✓
- **Collision check:** Task 3 updates collision check to use `entry.relative` instead of `basename`. ✓
- **Local member strategy:** `LocalStrategy.transferFiles()` (`strategy.ts:181`) accepts `string[]` and computes `path.basename(localPath)` at line 195. `LocalStrategy.receiveFiles()` (`strategy.ts:207`) does the same at line 217. Both must be updated to accept `{absolute, relative}[]`, use `entry.relative` for the destination subpath, and call `fs.mkdirSync(path.dirname(destPath), { recursive: true })` to create intermediate directories. **Add a task** in Phase 2 (alongside Task 2) to update both local strategy methods.

### 9. Are risks identified and mitigated?
**PARTIAL.** Six risks identified with reasonable mitigations. Missing risk: **symlink traversal** during local or remote directory walks could escape work_folder boundaries. Add a risk entry and mitigation (skip symlinks during walk, or validate expanded paths against work_folder).

### 10. Is the regression test realistic and sufficient?
**PASS.** Task 7 covers all five local expansion cases. Task 8 covers remote expansion and upload with nested entries. VERIFY blocks include backward-compat manual checks. Sufficient for v1.

### 11. Are there implementation details missing that would block a developer?
**YES — two items:**
1. **`minimatch` dependency vs inline matcher:** Task 4 proposes `minimatch` then hedges with "implement a simple `*`/`?` matcher internally." Requirements.md says "Node 22 built-ins only — no new npm dependencies." The inline matcher is the correct choice per the requirements. State this explicitly and remove the `minimatch` option.
2. **`file-transfer.ts` type change:** Task 2 mentions updating `file-transfer.ts` but doesn't spell out that `uploadFiles()` and `downloadFiles()` signatures both change from `localPaths: string[]` to `entries: Array<{absolute: string; relative: string}>`. This is a thin wrapper (`file-transfer.ts:7–14`) but the type change should be called out explicitly.

### 12. Are commit/branch conventions followed?
**PASS.** Branch `feat/glob-dir-transfer` follows `feat/<topic>` convention. Each task = one commit. VERIFY = checkpoint.

### 13. Any security concerns (path traversal via relative paths)?
**YES — one gap.** In `receive-files.ts`, the path security check (lines 38–53) validates each user-supplied `remote_path` against `work_folder` **before** expansion. After `expandRemotePaths()` runs inside `downloadViaSFTP` (Task 5), the expanded paths bypass this validation. A symlink inside a remote directory could point outside `work_folder`, and the expanded file would be downloaded without any containment check.

**Fix:** After remote expansion in `downloadViaSFTP` (or within `expandRemotePaths`), validate each resolved `remoteFull` path against `work_folder` using the same `isContainedInWorkFolder` check. Alternatively, use `lstat` during the remote directory walk to skip symlinks entirely.

---

## Summary of Required Changes

| # | Severity | Action |
|---|----------|--------|
| 1 | **Blocking** | Add a task to update `LocalStrategy.transferFiles()` and `LocalStrategy.receiveFiles()` in `strategy.ts` to accept `{absolute, relative}[]` and create intermediate directories (checklist items 1, 8) |
| 2 | **Blocking** | Add post-expansion path security validation in `downloadViaSFTP` or `expandRemotePaths` to prevent symlink-based work_folder escape (checklist item 13) |
| 3 | **Minor** | Remove `minimatch` option — requirements mandate no new deps; use inline `*`/`?` matcher (checklist item 11) |
| 4 | **Minor** | Promote Task 6 tier from `cheap` to `standard` for monotonic tier ordering (checklist item 3) |
| 5 | **Minor** | Add symlink traversal risk to Risk Register (checklist item 9) |
