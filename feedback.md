# API Cleanup & Skill Doc Sweep — Phase 4 Re-Review

**Reviewer:** fleet-rev  
**Date:** 2026-04-06 22:45:00-04:00  
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.

---

## Prior Review Context

Phase 4 initial review (commit fc22dbd) found one blocking issue: no test coverage for the new `updateAgent` token accumulation path in `execute_prompt`. The doer addressed this in commit `aa177e2`.

---

## Fix Verification — Token Accumulation Tests — PASS

Commit `aa177e2` adds three test changes to `tests/execute-prompt.test.ts`:

1. **"accumulates tokenUsage on agent when usage is present in response"** (line 270-281) — Creates an agent with no prior `tokenUsage`, sends a response with `{ input_tokens: 50, output_tokens: 75 }`, asserts `getAgent(id).tokenUsage` equals `{ input: 50, output: 75 }`. Verifies the fresh-accumulation path.

2. **"accumulates tokenUsage on top of existing values when agent already has tokenUsage"** (line 283-294) — Creates an agent pre-seeded with `tokenUsage: { input: 30, output: 20 }`, sends a response with `{ input_tokens: 10, output_tokens: 5 }`, asserts `getAgent(id).tokenUsage` equals `{ input: 40, output: 25 }`. Verifies the additive accumulation path.

3. **"does not append token line when usage is absent"** (line 267) — Extended to also assert `getAgent(id).tokenUsage` is `undefined`. Verifies the no-op path when `parsed.usage` is absent.

All three tests directly verify the `updateAgent` call's effect by reading back from the registry via `getAgent` — this is the correct approach (testing the observable side effect rather than mocking internals).

The import of `getAgent` from `../src/services/registry.js` at line 3 is the only non-test change. Clean.

---

## Build & Full Test Suite — PASS

- `npx tsc --noEmit` — clean, no type errors
- `npx vitest run` — 40 test files, 628 passed, 4 skipped. No failures.

Test count: 626 → 628 (+2 new tests; the third change extended an existing test rather than adding a new one). Correct.

---

## Phase 1+2+3 Regression Check — PASS

No source files outside `tests/execute-prompt.test.ts` were modified. All prior phase tests continue to pass.

---

## Summary

| Task | Verdict | Notes |
|------|---------|-------|
| 4.1 — Add tokenUsage to Agent type | PASS | Unchanged since initial review |
| 4.2 — Auto-accumulate in execute_prompt | PASS | Code + tests now both verified |
| 4.3 — Surface in member_detail | PASS | Unchanged since initial review |
| 4.4 — Surface in fleet_status | PASS | Unchanged since initial review |
| 4.5 — Remove update_task_tokens | PASS | Unchanged since initial review |
| V4 — npm test | PASS | 628 passed, 4 skipped (40 files) |
| Phase 1+2+3 regression | PASS | No regressions |

**Non-blocking (carried forward to Phase 5):** `member_detail` shows token string even when both values are 0; `fleet_status` suppresses zeros. Minor inconsistency.

**Non-blocking (carried from Phase 3):** User-facing strings in `src/` still reference `provision_auth` — Phase 5 Task 5.4 scope.

Phase 4 is complete. Ready for Phase 5.
