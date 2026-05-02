# PR #221 Review — `bug_fix/file-transfer-windows`

**Reviewer:** Claude (independent review)
**Date:** 2026-05-01
**Verdict:** CONDITIONAL APPROVE — core fix is correct; merge requires removing sprint artifacts and CLAUDE.md changes first

---

## Summary

This PR fixes a P0 bug where `send_files` / `receive_files` fail with "No such file" when transferring files between a Linux fleet host and a Windows member. Root cause: `path.posix.resolve()` treats Windows drive-letter paths (e.g. `C:/Users/...`) as relative, prepending the local CWD. The fix adds `resolveRemotePath()` to `src/utils/platform.ts` and replaces both call sites in `src/services/sftp.ts`.

The fix itself is clean, correct, and well-tested. However, the branch contains significant sprint scaffolding that must be stripped before merge.

---

## Independent Review Findings

### R1 — Code correctness: PASS

`resolveRemotePath()` correctly detects Windows drive-letter paths via `/^[A-Za-z]:/` and avoids `path.posix.resolve()` for them. The logic mirrors the existing `isContainedInWorkFolder()` pattern in the same file, maintaining internal consistency. Both `uploadViaSFTP` and `downloadViaSFTP` call sites are updated.

**Severity:** n/a (no issue)

### R2 — `resolveRemotePath` does not collapse `..` segments

Unlike `isContainedInWorkFolder()` (which manually collapses `..` and `.` via a stack), `resolveRemotePath()` performs simple string concatenation for Windows paths. A subPath like `../../etc/passwd` would produce `C:/Users/Kashyap/repos/../../etc/passwd` without normalization.

This is **acceptable** because `isContainedInWorkFolder()` is called upstream in `send-files.ts:49` and `receive-files.ts:49` before any SFTP operation, and that function *does* collapse traversal segments. The containment check guards against path escape. No action needed, but noting for awareness.

**Severity:** Info

### R3 — Test quality: GOOD

- `tests/sftp-path-resolution.test.ts`: 7 tests documenting the underlying `path.posix.resolve` bug — good as a bisect oracle.
- `tests/file-transfer-matrix.test.ts`: 20 tests covering `resolveRemotePath` unit tests + Linux→Linux and Linux→Windows SFTP integration tests with all 5 repro cases from issue #220. Windows driver combos are correctly marked as `describe.todo`.
- All 1107 tests pass, build clean.

**Severity:** n/a (no issue)

### R4 — `tests/README.md` is useful but optional

The new `tests/README.md` documents the cross-OS matrix and the #220 incident. This is reasonable documentation for a non-obvious testing requirement. Acceptable to merge.

**Severity:** Info

### R5 — Scope is appropriate

The fix touches only 2 production files (`sftp.ts`, `platform.ts`) with a net +17 lines of production code. The change is narrowly scoped to the bug.

**Severity:** n/a (no issue)

---

## Owner-Requested Findings (F1–F5)

### F1 — `skills/fleet/SKILL.md` references a test matrix

**Finding:** The added paragraph at line 136 says: *"The test matrix in `tests/file-transfer-matrix.test.ts` enumerates every (driver OS, target member type) combination and is authoritative."*

This is problematic. `SKILL.md` is user-facing documentation served to LLMs via the fleet skill. End users and deployed fleet members don't run the test suite and have no access to `tests/file-transfer-matrix.test.ts`. Referencing an internal test file here creates confusion.

**Recommendation:** Remove the test matrix reference from `skills/fleet/SKILL.md`. The cross-OS fact ("must work bidirectionally for Linux/Windows transfers") is fine to keep as a one-liner, but drop the test file reference. The test matrix documentation belongs in `tests/README.md` (which already exists in this PR) and/or `CLAUDE.md` (for dev context).

**Severity:** Medium — must fix before merge

### F2 — Term "driver" is a new, inconsistent name

**Finding:** The term "driver" appears 20+ times across files added/modified in this branch: `CLAUDE.md`, `skills/fleet/SKILL.md`, `tests/README.md`, `tests/file-transfer-matrix.test.ts`, `issue-body.md`, `requirements.md`, and `PLAN.md`.

The existing codebase (`src/`) never uses "driver." The fleet's established terminology is:
- **"local"** — the machine running apra-fleet (the MCP server host)
- **"member"** — a registered machine (local or remote)
- **"agentType"** — `'local' | 'remote'` in code

"Driver" is an ad-hoc synonym for "local machine" / "fleet host" introduced in this branch's issue body and propagated into docs and tests. It conflicts with the established vocabulary.

**Recommendation:** Replace "driver" with "fleet host" or "local machine" in all files that will be merged to main. For files being removed (issue-body.md, PLAN.md, etc.), no action needed since they won't merge. The key files to fix: `tests/file-transfer-matrix.test.ts`, `tests/README.md`, and `skills/fleet/SKILL.md` (if the SKILL.md text is retained per F1).

**Severity:** Medium — terminology consistency matters for a multi-agent codebase

### F3 — `/pm cleanup` was not run — sprint artifacts present

**Finding:** The following sprint-only files are in the diff and must not merge to main:

| File | Reason |
|------|--------|
| `PLAN.md` | Sprint execution plan — replaced the previous `PLAN.md` content entirely |
| `progress.json` | Sprint task tracker — replaced previous content |
| `requirements.md` | Sprint requirements doc — heavily modified from previous content |
| `feedback.md` | Sprint review feedback (will be replaced by this file) |

These are `/pm` sprint artifacts. The author should run `/pm cleanup` or manually `git checkout origin/main -- PLAN.md progress.json requirements.md` before merge.

**Severity:** High — these files will overwrite unrelated content on main

### F4 — `issue-body.md` must not merge to main

**Finding:** `issue-body.md` is a new file containing the GitHub issue #220 body text. It was used to create the issue and has no purpose in the repository. It is not referenced by any code or documentation.

**Recommendation:** Remove `issue-body.md` from the branch before merge (`git rm issue-body.md`).

**Severity:** Medium — file hygiene

### F5 — `CLAUDE.md` changes must not merge to main

**Finding:** The diff replaces the entire `CLAUDE.md` with sprint-specific agent execution context: plan execution model, verify checkpoint instructions, branch hygiene rules, secrets handling, and a File Transfer Tools section. The original `CLAUDE.md` (dev commands, conventions, branch naming) is completely overwritten.

The File Transfer Tools section (lines 43–57 in the new version) contains genuinely useful developer guidance about `resolveRemotePath` and the path-style trap. However, it is embedded in a file that is otherwise entirely sprint scaffolding.

**Recommendation:** `git checkout origin/main -- CLAUDE.md` to restore the original, then selectively add back the File Transfer Tools section (lines 43–57) as an appendix to the original CLAUDE.md if desired. The sprint execution context must not merge.

**Severity:** High — overwrites shared project configuration

---

## Pre-Merge Checklist

- [ ] Remove `issue-body.md` (F4)
- [ ] Restore `CLAUDE.md` from main; optionally re-add File Transfer Tools section (F5)
- [ ] Restore `PLAN.md`, `progress.json`, `requirements.md` from main (F3)
- [ ] Remove or reword test matrix reference in `skills/fleet/SKILL.md` (F1)
- [ ] Replace "driver" with "fleet host" or "local machine" in mergeable files (F2)
- [ ] Verify build + tests pass after cleanup
