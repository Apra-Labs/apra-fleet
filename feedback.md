# Stall Detector Redesign (#241) — Code Review

**Reviewer:** fleet-rev
**Date:** 2026-05-05 19:05:00-04:00
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review. Prior version (ec6758f) identified two blocking issues in Phase 5. No commits have been made since that review — findings remain unaddressed.

---

## Phase 1 Review

Previously APPROVED (V1). No regressions detected. Path encoding, Gemini `/chats/` directory, and `[inv]` token prepend all intact.

---

## Phase 2 Review

Previously APPROVED (V2). No regressions. `findLogFile` with mtime filter unchanged by later phases.

---

## Phase 3 Review

Previously APPROVED (V3). No regressions. `pollLogFile` and timestamp extraction unchanged.

---

## Phase 4 Review

Previously APPROVED (V4). No regressions. AbortSignal injection into `execCommand` unchanged.

---

## Phase 5 Review

### Build & Tests

- `npm run build`: PASS — clean compile, no errors.
- `npm test`: PASS — 1166 passed, 6 skipped, 0 failures.

### Task 11: Fix `toLocalISOString` — FAIL (unchanged since V5 review)

**File:** `src/services/stall/time-utils.ts`

The implementation negates `getTimezoneOffset()` at line 3 (`const offsetMin = -offset`) then applies the sign formula and subtraction formula from requirements.md that expect the *non-negated* value. This produces:

- **Wrong local time:** shifts hours in the opposite direction (adds instead of subtracts)
- **Wrong offset sign:** shows `+` where it should show `-` (and vice versa)

**Verified on this machine (EDT, UTC-4, getTimezoneOffset()=240):**
```
Input:    2026-05-05T10:00:00Z
Got:      2026-05-05T14:00:00.000+04:00  (wrong)
Expected: 2026-05-05T06:00:00.000-04:00  (correct)
```

**Fix:** Remove the negation on line 3. Use `getTimezoneOffset()` directly, matching requirements.md:
```typescript
const offsetMin = new Date(ms).getTimezoneOffset();
const sign = offsetMin <= 0 ? '+' : '-';
const local = new Date(ms - offsetMin * 60000);
```

### Task 12: Unit tests for `toLocalISOString` — FAIL (unchanged since V5 review)

**File:** `tests/time-utils.test.ts`

All 7 tests are format-only (regex matches) or range-only (hour between 0-23). None assert that the displayed hour equals the actual local hour. The tests pass with the broken implementation — they do not catch the bug.

**Done criteria** (PLAN.md): "assert hour component matches local time, not UTC"

**Required addition:** At least one test that compares the output hour to `new Date(ms).getHours()`:
```typescript
it('should produce the correct local hour', () => {
  const ms = Date.now();
  const result = toLocalISOString(ms);
  const expectedHour = new Date(ms).getHours();
  const match = result.match(/T(\d{2}):/);
  expect(parseInt(match![1])).toBe(expectedHour);
});
```

---

## Regression Check

No regressions in Phases 1-4. The bug in `toLocalISOString` is the same bug that existed before Phase 5 — the "fix" introduced a negation that produces an equivalently wrong result (inverted instead of the original append-without-adjust). Net: the function remains broken for non-UTC timezones.

---

## Summary

**Phase 1: APPROVED** — T1-T4 done, all criteria met.
**Phase 2: APPROVED** — T5-T6 done, all criteria met.
**Phase 3: APPROVED** — T7-T8 done, all criteria met.
**Phase 4: APPROVED** — T9-T10 done, all criteria met.
**Phase 5: CHANGES NEEDED** — T11 and T12 both fail their done criteria. No changes since last review.

**Blocking issues (must fix before approval):**

1. **T11:** Remove the `offsetMin = -offset` negation in `time-utils.ts`. Use `getTimezoneOffset()` directly as specified in requirements.md.

2. **T12:** Add at least one test that asserts the output hour equals `new Date(ms).getHours()`. Format-only tests are insufficient.

**Build:** PASS (clean compile)
**Tests:** 1166 passed, 6 skipped — time-utils tests pass but do not validate correctness.

**Notes carried forward (non-blocking):**
1. (Phase 1) Cosmetic inconsistency: `basename()` vs `.split().pop()` in log-path-resolver.
2. (Phase 1) No Windows unit test for inv token in `buildAgentPromptCommand`.
3. (Phase 2) BSD `find` on macOS doesn't support `-newermt` — remote macOS agents will need a fallback. Acknowledged in risk register; deferred.
4. (Phase 3) `readLogTail` module is now unused by the stall detector — potential dead code for post-sprint cleanup.
5. (Phase 4) `tryKillPid` calls within retry branches not guarded by abort signal — minor; `tryKillPid` is normally fast.
