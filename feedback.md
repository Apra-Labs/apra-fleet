# API Cleanup & Skill Doc Sweep — Phase 3 Code Review

**Reviewer:** fleet-rev  
**Date:** 2026-04-06 22:10:00-04:00  
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.

---

## Prior Review Context

Phase 2 was APPROVED in commit a778ac0 after a re-review cycle. Phase 1 was APPROVED in commit 2174d0e. Both phases remain clean — no regressions detected (Phase 1/2 source files are unchanged since approval).

Phase 3 work spans two commits:
- `32d82c8` — Tasks 3.1 + 3.2 (rename `work_folder`→`run_from`, add `resolveTilde`)
- `1ef1bd1` — Tasks 3.3 + 3.4 (test updates for rename, tilde resolution tests)

---

## Task 3.1 — Rename work_folder → run_from in execute_command schema — PASS

Commit `32d82c8` changes `src/tools/execute-command.ts`:
- Schema parameter renamed from `work_folder` to `run_from` (line 24)
- Description updated to: `"Override directory to run from. Defaults to member's registered work folder — rarely needed."` — clear that it's an override, not a required param
- Usage at line 45: `const folder = resolveTilde(input.run_from ?? agent.workFolder);`

Remaining `work_folder` references in `src/` are all member-property contexts (register-member, update-member, send-files, receive-files, strategy) — these correctly refer to the registered member folder, not the execute_command parameter. The plan explicitly says to keep these as-is.

---

## Task 3.2 — Server-side tilde expansion for workFolder — PASS

`resolveTilde` exported at `src/tools/execute-command.ts:13-18`:

```ts
export function resolveTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return p.replace('~', os.homedir());
  }
  return p;
}
```

Applied in two locations:
1. `src/tools/execute-command.ts:45` — resolves `run_from` or `agent.workFolder` before use as CWD
2. `src/tools/execute-prompt.ts:99` — `const resolvedWorkFolder = resolveTilde(agent.workFolder);` used for both `promptFilePath` construction (line 101-102) and `promptOpts.folder` (line 116)

The `import { resolveTilde } from './execute-command.js';` at `execute-prompt.ts:16` correctly reuses the same function — no duplication.

Implementation correctly handles only current-user `~` (bare `~` and `~/...`). The `~user/` syntax is intentionally unsupported per Risk R3 in the plan. The `String.replace('~', ...)` call only replaces the first occurrence, which is correct since `~` is guaranteed to be at position 0 by the guard.

---

## Task 3.3 — Update execute_command test for run_from rename — PASS

Commit `1ef1bd1` in `tests/execute-command.test.ts`:
- Test name: `'uses custom work_folder when provided'` → `'uses custom run_from when provided'` (line 51)
- Test input: `work_folder: '/tmp/other'` → `run_from: '/tmp/other'` (line 55)

Single occurrence, cleanly updated. Assertion unchanged — still checks that `mockExecCommand` received a string containing `/tmp/other`.

---

## Task 3.4 — Add tilde resolution tests — PASS

Commit `1ef1bd1` adds a `describe('resolveTilde')` block at `tests/execute-command.test.ts:113-129` with four test cases:

1. `'expands ~/path to homedir/path'` — asserts `resolveTilde('~/git/project') === os.homedir() + '/git/project'`
2. `'expands bare ~ to homedir'` — asserts `resolveTilde('~') === os.homedir()`
3. `'passes through absolute paths unchanged'` — asserts `/absolute/path` passthrough
4. `'passes through relative paths unchanged'` — asserts `relative/path` passthrough

All four cases match the plan specification exactly. The tests use `os.homedir()` dynamically rather than hardcoding a path, making them portable.

---

## Build & Full Test Suite — PASS

- `npx tsc --noEmit` — clean, no type errors
- `npx vitest run` — 41 test files, 633 passed, 4 skipped. No failures.

Test count: progress.json reports 634/3 skipped vs my run showing 633/4 skipped. Total is 637 in both cases — the difference is a platform-conditional skip. Not a concern.

---

## Phase 1+2 Regression Check — PASS

- `src/tools/compose-permissions.ts` — unchanged since Phase 1 approval
- `src/tools/member-detail.ts` — unchanged since Phase 2 approval
- `src/index.ts` (provision_llm_auth rename) — unchanged since Phase 1 approval
- All Phase 1+2 tests continue to pass

---

## Summary

| Task | Verdict | Notes |
|------|---------|-------|
| 3.1 — Rename work_folder → run_from | PASS | Schema, description, and usage all updated; other `work_folder` refs are member-property contexts |
| 3.2 — Server-side tilde expansion | PASS | `resolveTilde` correctly handles `~` and `~/...`; applied in both execute-command and execute-prompt |
| 3.3 — Update test for rename | PASS | Test name and input param updated |
| 3.4 — Add tilde resolution tests | PASS | 4 cases covering ~/path, bare ~, absolute, relative |
| V3 — npm test | PASS | 633 passed, 4 skipped (637 total) |
| Phase 1+2 regression | PASS | No changes to previously approved files |

**Non-blocking (carried forward to Phase 5):** User-facing strings in `src/` still reference `provision_auth` (prompt-errors.ts, register-member.ts, provision-auth.ts, lifecycle.ts). Phase 5 Task 5.4's grep should surface these.

Phase 3 is complete. Ready for Phase 4.
