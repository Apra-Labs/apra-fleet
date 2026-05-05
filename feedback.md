# Stall Detector Redesign (#241) — Code Review

**Reviewer:** fleet-rev
**Date:** 2026-05-05 18:50:00-04:00
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review. Prior versions approved Phases 1-4. This is the final cumulative review covering all 5 phases, with Phase 5 newly completed.

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

### Task 11: Fix `toLocalISOString`

**Commits:** `776ee52`
**Files:** `src/services/stall/time-utils.ts` (new, 17 lines), `src/services/stall/stall-detector.ts` (import swap)

**Done criteria check:**
- `toLocalISOString` produces correct local time with correct offset: **FAIL**

**Critical bug — sign logic is inverted:**

The implementation introduces `offsetMin = -getTimezoneOffset()` (negating the raw value) but then uses the sign formula and subtraction formula that were designed for the *non-negated* value from requirements.md.

Requirements.md specifies:
```typescript
const offsetMin = d.getTimezoneOffset(); // positive = west (EDT = 240)
const sign = offsetMin <= 0 ? '+' : '-';
const local = new Date(ms - offsetMin * 60000);
```

Implementation has:
```typescript
const offset = new Date(ms).getTimezoneOffset(); // 240 for EDT
const offsetMin = -offset;                       // -240 for EDT
const sign = offsetMin <= 0 ? '+' : '-';         // '+' — WRONG (should be '-')
const localMs = ms - offsetMin * 60000;          // ms + 240*60000 — WRONG direction
```

**Verified by execution (EDT, UTC-4, getTimezoneOffset()=240):**
- Input: `2026-05-05T10:00:00Z`
- Implementation produces: `2026-05-05T14:00:00.000+04:00`
- Correct output: `2026-05-05T06:00:00.000-04:00`

The two errors (inverted sign + inverted time adjustment) cancel for ISO 8601 round-trip parsing (both represent the same UTC instant), but the **displayed local time is wrong** — which is the exact bug Phase 5 was supposed to fix. A user in EDT sees `14:00` instead of `06:00`.

**Fix:** Either use the requirements.md formula verbatim (no negation, direct use of `getTimezoneOffset()`), or fix both the sign condition and the subtraction to account for the negation:
- Sign: `offsetMin >= 0 ? '+' : '-'` (flip the condition)
- Time: `ms + offsetMin * 60000` (add instead of subtract)

**Verdict: FAIL**

### Task 12: Unit tests for `toLocalISOString`

**Commits:** `776ee52`
**Files:** `tests/time-utils.test.ts` (new, 91 lines, 7 tests)

**Done criteria check:**
- Tests for UTC+0, positive-offset, negative-offset timezones: FAIL — tests are format-only and range-only. No test asserts the hour matches the actual local time. All 7 tests would pass even if `toLocalISOString` returned UTC time with a random offset appended.
- Assert hour component matches local time, not UTC: FAIL — test "should adjust hours correctly" only checks `hour >= 0 && hour <= 23`, not that it equals the expected local hour.

**Test quality:**
The tests verify:
1. ISO 8601 format regex (6 of 7 tests)
2. Minutes/seconds preserved (1 test)
3. Hour is in valid range (1 test)

None verify correctness. A test that would catch the bug:
```typescript
it('should match the local hour from native Date methods', () => {
  const ms = Date.now();
  const result = toLocalISOString(ms);
  const localHour = new Date(ms).getHours(); // native local hour
  const match = result.match(/T(\d{2}):/);
  expect(parseInt(match![1])).toBe(localHour);
});
```

**Verdict: FAIL** — Tests do not verify the property they claim to test. Coverage is format-only, not semantic.

---

## Regression Check

No regressions in Phases 1-4. The only change to existing code is the import swap in `stall-detector.ts` (inline `toLocalISOString` → imported from `time-utils.ts`). The extracted function has the same bug as the one it replaces (both display wrong local time in non-UTC timezones), so behavior is unchanged from the prior broken state — no new regression, but the fix is not achieved.

---

## Summary

**Phase 1: APPROVED** — T1-T4 done, all criteria met.
**Phase 2: APPROVED** — T5-T6 done, all criteria met.
**Phase 3: APPROVED** — T7-T8 done, all criteria met.
**Phase 4: APPROVED** — T9-T10 done, all criteria met.
**Phase 5: CHANGES NEEDED** — T11 and T12 both fail their done criteria.

**Blocking issues (must fix):**

1. **T11:** `toLocalISOString` sign logic is inverted — produces wrong local time and wrong offset sign for any non-UTC timezone. Fix by using the requirements.md formula directly (use raw `getTimezoneOffset()` without negation).

2. **T12:** Tests must include at least one assertion that verifies the displayed hour equals the actual local hour (e.g., compare against `new Date(ms).getHours()`). Format-only tests do not satisfy the done criteria "assert hour component matches local time, not UTC."

**Build:** PASS (clean compile)
**Tests:** 1166 passed, 6 skipped — but the time-utils tests are insufficient (they pass with broken code).

**Notes carried forward (non-blocking):**
1. (Phase 1) Cosmetic inconsistency: `basename()` vs `.split().pop()` in log-path-resolver.
2. (Phase 1) No Windows unit test for inv token in `buildAgentPromptCommand`.
3. (Phase 2) BSD `find` on macOS doesn't support `-newermt` — remote macOS agents will need a fallback. Acknowledged in risk register; deferred.
4. (Phase 3) `readLogTail` module is now unused by the stall detector — potential dead code for post-sprint cleanup.
5. (Phase 4) `tryKillPid` calls within retry branches not guarded by abort signal — minor; `tryKillPid` is normally fast.
