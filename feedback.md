# Onboarding & User Engagement — Phase 1 Code Review

**Reviewer:** reviewerAF
**Date:** 2026-04-08
**Scope:** Tasks 1.1 (Onboarding state service) and 1.2 (Text constants module)
**Verdict:** APPROVED

---

## Criteria Evaluation

### 1. Code matches plan specifications — PASS
- `OnboardingState` interface in `src/types.ts:61-66` matches plan exactly (4 boolean fields).
- `src/services/onboarding.ts` implements all required functions: `loadOnboardingState()`, `saveOnboardingState()`, `advanceMilestone()`, `shouldShow()`, `getOnboardingState()`, `resetSessionFlags()`, `markWelcomeBackShown()`, `_resetForTest()`.
- `src/onboarding/text.ts` exports all required constants: `BANNER`, `GETTING_STARTED_GUIDE`, `WELCOME_BACK()`, `NUDGE_AFTER_FIRST_REGISTER()`, `NUDGE_AFTER_FIRST_PROMPT()`, `NUDGE_AFTER_MULTI_MEMBER()`.

### 2. OnboardingState contains only persisted fields — PASS
Interface has exactly: `bannerShown`, `firstMemberRegistered`, `firstPromptExecuted`, `multiMemberNudgeShown`. No runtime flags.

### 3. welcomeBackShownThisSession is module-level — PASS
Declared at `onboarding.ts:22` as `export let welcomeBackShownThisSession = false`. Mutated through `markWelcomeBackShown()` and `resetSessionFlags()`. Clean separation from persisted state.

### 4. Atomic writes (temp + rename) — PASS
`saveOnboardingState()` at `onboarding.ts:65-74`: writes to `.tmp`, calls `enforceOwnerOnly`, then `renameSync`. Follows the plan's atomic write requirement. (Note: actually more robust than `registry.ts` which writes directly — good.)

### 5. Upgrade detection — PASS
`loadOnboardingState(existingMemberCount)` at `onboarding.ts:38-45`: if no onboarding file and `existingMemberCount > 0`, sets `bannerShown = true`. Correctly prevents banner for existing users upgrading.

### 6. Corruption recovery — PASS
`onboarding.ts:53-57`: catch block on `JSON.parse` returns `DEFAULT_STATE` and logs warning to stderr. Does not throw. Forward-compatibility also handled: partial JSON merged with defaults at line 52.

### 7. Text constants complete and monospace-formatted — PASS (with recommendations)
All constants present. Box-drawing borders used throughout. Banner matches requirements.md ASCII art exactly. See REC-1 and REC-2 below for minor formatting notes.

### 8. Token cost estimate — PASS
Comment block at `text.ts:6-33`. Estimates: ~370 one-time, ~20 recurring/server-start, ~80 total nudges. Methodology stated (~4 chars/token). Reasonable and well-documented.

### 9. Test coverage — PASS
- `onboarding.test.ts`: 16 tests covering load (missing file, upgrade path, persisted state, corrupted JSON, forward-compat), save (atomic write, no leftover tmp), advance (single, idempotent, independent), shouldShow, and session flags.
- `onboarding-text.test.ts`: 14 tests covering banner content, guide content, welcome-back (plural, singular, zero-member fallback), nudge variants (remote/local), prompt nudge, multi-member nudge.
- Edge cases well covered. See REC-3 for a minor gap.

### 10. Security — PASS
- State file written with `mode: 0o600` (`onboarding.ts:70`).
- Fleet directory created with `mode: 0o700` (`onboarding.ts:25`).
- `enforceOwnerOnly()` called on both temp and final file.
- No path traversal risk — path is derived from `FLEET_DIR` constant, not user input.
- `FLEET_DIR` respects `APRA_FLEET_DATA_DIR` env var (via `src/paths.ts:4`).

---

## Recommended Improvements (non-blocking)

### REC-1: WELCOME_BACK box-drawing width mismatch
The box borders in `WELCOME_BACK()` don't align in monospace rendering. The zero-member case has top/content/bottom widths of 49/51/50 characters respectively. The non-zero case uses a fixed-width bottom border but dynamic content, so alignment varies with input length. Consider either padding the content to a fixed width or dropping the box-drawing for `WELCOME_BACK` in favor of a simple one-liner (it's only ~20 tokens anyway).

### REC-2: Double enforceOwnerOnly on atomic write
`saveOnboardingState()` calls `enforceOwnerOnly` on both the `.tmp` file (line 71) and the final file after rename (line 73). Since `renameSync` preserves permissions, the second call is redundant. Not harmful, just unnecessary.

### REC-3: No test for file permissions
No test verifies the `0o600` permission on the written onboarding.json file. Consider adding a `stat` check in the save test (low priority — `enforceOwnerOnly` is tested elsewhere).

---

## Summary

Phase 1 implementation is clean and well-structured. The onboarding state service correctly implements the in-memory singleton pattern with atomic persistence, corruption recovery, and upgrade detection. Text constants are complete with appropriate formatting and token cost documentation. Test coverage is thorough with good edge case handling. All 10 review criteria pass. The three recommendations are minor and non-blocking.
