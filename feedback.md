# API Cleanup & Skill Doc Sweep — Phase 1 Re-Review

**Reviewer:** fleet-rev  
**Date:** 2026-04-06 21:42:00-04:00  
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.

---

## Prior Review Context

The initial Phase 1 code review (commit a5d32e0) found one blocking issue: Task 1.2's fresh-permissions test was vacuously passing due to (1) `existsSpy` breaking `findProfilesDir` before `loadLedger` was reached, and (2) `expect(async fn).not.toThrow()` not catching async rejections. Tasks 1.1 and 1.3 were approved. The doer addressed both bugs in commit 9d44f02.

---

## Task 1.2 Fix Verification — PASS

Commit 9d44f02 makes two targeted changes to `tests/compose-permissions.test.ts:349-369`:

1. **`existsSpy` now returns `true` for paths containing `'profiles'`** (line 352). This lets `findProfilesDir` resolve to a valid directory, so execution reaches `loadLedger` and actually exercises the `??` guard from Task 1.1. Profile JSON files (e.g., `base-dev.json`) don't contain `'profiles'` in their path, so `loadProfile` returns `null` — which is correct for this test (it only needs to prove no crash, not validate permission content).

2. **Assertion changed to `await expect(composePermissions({...})).resolves.toBeDefined()`** (lines 363-369). This correctly awaits the promise and fails if the promise rejects. The vacuous-pass pattern is eliminated.

The test now genuinely exercises the fix path: `findProfilesDir` succeeds → `loadLedger` reads `'{}'` → `raw.stacks ?? []` and `raw.granted ?? []` return empty arrays → `compose()` iterates safely → no crash → promise resolves with a defined string.

---

## Full Test Suite — PASS

- `npx vitest run` — 41 test files, 628 passed, 4 skipped. No regressions.

---

## Phase 1 Final Status

| Task | Verdict | Notes |
|------|---------|-------|
| 1.1 — loadLedger guard | PASS | Clean null-coalescing fix (unchanged from prior review) |
| 1.2 — Fresh permissions test | PASS | Fix verified — mock and assertion both corrected |
| 1.3 — provision_llm_auth rename | PASS | MCP registration updated (unchanged from prior review) |
| V1 — npm test | PASS | 628/628 passed, 4 skipped |

**Non-blocking (carried forward to Phase 5):** User-facing strings in `src/` still reference `provision_auth` (prompt-errors.ts, register-member.ts, provision-auth.ts, lifecycle.ts). Phase 5 Task 5.4's grep should surface these.

Phase 1 is complete. Ready for Phase 2.
