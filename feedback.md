# API Cleanup & Skill Doc Sweep — Phase 2 Code Review

**Reviewer:** fleet-rev  
**Date:** 2026-04-06 21:52:00-04:00  
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review.

---

## Prior Review Context

Phase 1 was APPROVED in commit 2174d0e after a re-review cycle that fixed a vacuously-passing fresh-permissions test. Phase 1 tasks (1.1 loadLedger guard, 1.2 fresh-permissions test, 1.3 provision_llm_auth rename) are all clean.

---

## Task 2.1 — Rename claude → llm_cli in member_detail output — PASS

Commit bf6ded1 changes `result.claude = cli` → `result.llm_cli = cli` at `src/tools/member-detail.ts:149`. The backwards-compat comment is removed as specified. Grep confirms zero remaining `result.claude` references in `src/` and `tests/`. The compact format (line 253) reads `cli.version` and `cli.auth` directly from the local variable, so it was never affected by the key name.

---

## Task 2.2 — Strip provider prefix from version string — FAIL (test gap)

The regex at `src/tools/member-detail.ts:111` is correct:

```ts
const vMatch = String(cli.version).match(/(\d+\.\d+\.\d+.*)$/);
if (vMatch) cli.version = vMatch[1];
```

It correctly:
- Strips `"Claude Code 2.1.92"` → `"2.1.92"`
- Preserves pre-release suffixes: `"Claude Code 2.1.92-beta.1"` → `"2.1.92-beta.1"`
- Passes through bare versions like `"2.1.92"` unchanged
- Passes through `"unknown"` unchanged (no match → no mutation)

**However**, no test exercises this logic. All three test cases in `tests/agent-detail.test.ts` mock the `--version` command to return `'1.0.42'` — a bare version with no provider prefix. The regex is never tested with a prefixed string like `"Claude Code 1.0.42"`. This means:

1. If the regex is accidentally broken in a future commit, no test will catch it.
2. The Task 2.2 done criteria says "version strings have no prefix" but there is no assertion proving the stripping actually works.

**Required fix:** Add at least one test case where the mock returns a prefixed version string (e.g. `"Claude Code 1.0.42"`) and assert that `result.llm_cli.version` equals `"1.0.42"`. This can be a single new `it()` block in the existing `memberDetail auth detection` describe, or a new describe.

---

## Task 2.3 — Update member_detail test for llm_cli rename — PASS

Three occurrences of `result.claude.auth` updated to `result.llm_cli.auth` in `tests/agent-detail.test.ts` (lines 92, 109, 126-127). All assertions pass. No stale references remain.

---

## Full Test Suite — PASS

`npx vitest run` — 41 test files, 628 passed, 4 skipped. No regressions from Phase 1.

---

## Phase 1 Regression Check — PASS

- loadLedger guard (Task 1.1): unchanged since approval
- Fresh-permissions test (Task 1.2): unchanged since approval, still passes
- provision_llm_auth rename (Task 1.3): unchanged since approval

---

## Summary

| Task | Verdict | Notes |
|------|---------|-------|
| 2.1 — Rename claude → llm_cli | PASS | Clean rename, no stale refs |
| 2.2 — Strip version prefix | FAIL | Regex is correct but untested — no mock returns a prefixed string |
| 2.3 — Update tests for rename | PASS | 3 assertion references updated |
| V2 — npm test | PASS | 628/628 passed, 4 skipped |

**Blocking:** Task 2.2 needs a test that exercises the version-stripping regex with a provider-prefixed input string. Without it, the new behavior is unverified and regressions will go undetected.

**Non-blocking (carried forward):** Phase 1 note about user-facing strings in `src/` still referencing `provision_auth` remains — expected to be addressed in Phase 5 Task 5.4.
