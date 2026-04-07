# API Cleanup & Skill Doc Sweep — Phase 5 Re-Review

**Reviewer:** fleet-rev  
**Date:** 2026-04-06 23:15:00-04:00  
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.

---

## Prior Review Context

Phase 5 initial review (commit 92b8be0) found 3 findings — 2 blocking and 1 non-blocking — all stale `provision_auth` references in test files that the Task 5.4 sweep missed. The doer addressed all 3 in commit `f1aae41`.

---

## Fix Verification — All 3 Findings Resolved — PASS

Commit `f1aae41` makes the following changes:

### Finding 1 (was BLOCKING) — `tests/integration.test.ts:210` — FIXED

`result.includes('provision_auth')` → `result.includes('provision_llm_auth')`. The auth-detection integration test will now correctly match the output of `authErrorAdvice()`, which returns `provision_llm_auth` since Phase 5. Silent regression eliminated.

### Finding 2 (was BLOCKING) — `tests/integration.test.ts:104` — FIXED

Skip message updated from `provision_auth` to `provision_llm_auth`. User-visible string now reflects the current tool name.

### Finding 3 (was NON-BLOCKING) — `tests/auth-socket.test.ts` — FIXED

All 6 occurrences of `'provision_auth'` updated to `'provision_llm_auth'`:
- Lines 372, 389, 400, 411: `collectOobApiKey` tool name argument
- Lines 404, 415: `.toContain('provision_llm_auth')` assertions

Tests now reflect production usage where `provisionAuth()` passes `'provision_llm_auth'` to `collectOobApiKey`.

### Additional changes in `f1aae41`

- `PLAN.md` Task 5.4: grep scope expanded from `skills/ src/` to `skills/ src/ tests/` with a note explaining why. Good — prevents repeat of this class of miss.
- `progress.json` Tasks 5.4 and V5: notes updated to reflect the expanded scope and fix count. Clean.
- `feedback.md`: Doer annotated all 3 findings with "✓ DONE" and updated verdict to "CHANGES NEEDED → RESOLVED". Follows the review protocol.

---

## Stale Reference Sweep — PASS

Final grep across all three directories confirms zero stale references:

- `skills/` — zero matches for `provision_auth|update_task_tokens|claude.version|claude.auth`
- `src/` — zero matches (excluding internal `provisionAuth` export name, which is correct)
- `tests/` — zero matches

---

## Build & Full Test Suite — PASS

- `npm test` — 40 test files, 628 passed, 4 skipped. No failures.

---

## Phase 1–4 Regression Check — PASS

No prior phase source files modified. All tests continue to pass.

---

## Summary

| Task | Verdict | Notes |
|------|---------|-------|
| 5.1 — Update fleet SKILL.md | PASS | Unchanged since initial review |
| 5.2 — Update fleet onboarding.md | PASS | Unchanged since initial review |
| 5.3 — Update PM skill docs | PASS | Unchanged since initial review |
| 5.4 — Final stale-reference grep | PASS | All 8 stale refs in tests/ fixed; grep scope expanded to include tests/ |
| V5 — npm test | PASS | 628 passed, 4 skipped |
| Phase 1–4 regression | PASS | No regressions |

**Carried forward (non-blocking):** `member_detail` shows token string even when both values are 0; `fleet_status` suppresses zeros. Minor display inconsistency — cosmetic, not blocking.

All 5 phases APPROVED. Sprint work is complete.
