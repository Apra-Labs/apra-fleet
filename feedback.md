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

---
---

# Onboarding & User Engagement — Phase 2 Code Review

**Reviewer:** reviewerAF
**Date:** 2026-04-08
**Scope:** Tasks 2.1 (Central wrapTool() in index.ts) and 2.2 (First-run banner + getting started guide)
**Verdict:** APPROVED

---

## Criteria Evaluation

### 1. wrapTool correctly replaces all 21 inline wrappers without changing behavior — PASS

- **21 `server.tool()` calls** confirmed in `src/index.ts`, each now using `wrapTool()` instead of inline `async (input) => ({ content: [...] })` wrappers.
- **Zero inline wrappers remain** — grep for `async (input) => ({ content:` returns 0 matches.
- **wrapTool definition** (`index.ts:87-97`): takes `toolName` + `handler`, calls handler, applies preamble/suffix logic, returns `{ content: [{ type: 'text' as const, text }] }` — structurally identical to the old inline pattern.
- **No-input tools** (`shutdown_server`, `version`): Original used `async () =>`, new uses `wrapTool('tool_name', () => handler())` — handler ignores the `input` parameter passed by wrapTool. Behaviorally equivalent.
- **Stubs return null** → `preamble` and `suffix` are null → no string concatenation occurs → response text is unchanged. This means stubs make the refactor a pure no-op for existing behavior. Correct.

### 2. Stubs properly returning null = no-op — PASS

- `getOnboardingPreamble()` at `index.ts:78-80`: delegates to `getFirstRunPreamble()`. Returns `null` when banner already shown (which is the steady-state for non-first-run). For first-run, returns banner text — which is the Phase 2.2 feature, not a stub regression.
- `getOnboardingNudge()` at `index.ts:83-85`: hardcoded `return null` with comment "Stub — filled in Task 3.1". Correct no-op.

### 3. isJsonResponse correctly identifies JSON tools and skips prepend — PASS

- `isJsonResponse()` at `onboarding.ts:121-123`: `result.startsWith('{') || result.startsWith('[')`.
- Verified all 4 JSON-returning tools (`fleet_status`, `list_members`, `member_detail`, `monitor_task`) return `JSON.stringify()` directly — no leading whitespace. The `startsWith` check is sufficient.
- Non-JSON tools (e.g., `register_member` returns `✅ ...`, `execute_prompt` returns `📋 ...`) will never match. Correct.
- **3 tests** cover `{`, `[`, and non-JSON inputs including empty string.

### 4. First-run banner logic correct — shows once, persists immediately, never again — PASS

- `getFirstRunPreamble()` at `onboarding.ts:131-136`: checks `state.bannerShown`, calls `advanceMilestone('bannerShown')` before returning banner text.
- `advanceMilestone()` sets the in-memory flag AND calls `saveOnboardingState()` to disk. Crash between `advanceMilestone()` and the function return cannot re-show banner — state is already persisted. Correct.
- **4 tests** cover: fresh install shows banner, second call returns null, persists across restart (simulated with `_resetForTest()` + `loadOnboardingState()`), upgrade path skips banner.
- Edge case: `isJsonResponse` check in wrapTool prevents banner from being prepended to JSON responses even on first call. The banner is "consumed" (state persisted) but not displayed. This means if the very first tool call returns JSON, the user never sees the banner. **This is an acceptable trade-off** — better to skip the banner than corrupt a JSON response. However, see REC-4 below.

### 5. wrapTool passes toolName + input to nudge logic (prep for Phase 3) — PASS

- `wrapTool` signature: `wrapTool(toolName: string, handler: (input: any) => Promise<string>)`.
- Inside: `getOnboardingNudge(toolName, input, result)` — all three parameters forwarded. Phase 3 can read `toolName` to match trigger tools and `input.member_type` for nudge content without any further refactoring.

### 6. No regressions — all existing tests pass — PASS

- `npx tsc --noEmit` produces only the pre-existing `smol-toml` error in `src/cli/install.ts`. No new type errors.
- progress.json reports 638 tests passed (up from 631 in Phase 1), 1 pre-existing failure (`platform.test.ts` PATH env), 1 pre-existing suite failure (`install-multi-provider.test.ts` smol-toml). **No regressions from Phase 2 changes.**

### 7. Security: no new injection vectors from the refactor — PASS

- `wrapTool` only concatenates strings — no `eval`, no template interpolation, no shell execution.
- `preamble` and `suffix` come from onboarding service functions that return hardcoded text constants or `null`. No user input flows into these strings.
- The `input` parameter is passed through to the original handler unchanged — same as before.
- `isJsonResponse` is a read-only check with no side effects.
- No new file I/O beyond what Phase 1 introduced (onboarding.json with 0o600 perms).

### 8. Phase 1 non-blocking items (REC-1, REC-2, REC-3) status — NOTED

- **REC-1** (WELCOME_BACK box-drawing width): Not addressed — acceptable, it's non-blocking and WELCOME_BACK is Phase 3.2 scope.
- **REC-2** (double enforceOwnerOnly): Not addressed — code at `onboarding.ts:72-74` still calls enforceOwnerOnly on both tmp and final file. Minor redundancy, non-blocking.
- **REC-3** (no permission test): Not addressed — low priority, non-blocking.
- All three are properly deferred. No regression from Phase 2 changes.

---

## Additional Observations

### Architecture quality
- `wrapTool` is defined inside `startServer()` as a closure, giving it access to the imported `getFirstRunPreamble` and `isJsonResponse`. Clean scoping — no globals needed.
- `getOnboardingPreamble()` is a thin indirection over `getFirstRunPreamble()`. This will become useful in Phase 3.2 when it also handles welcome-back logic. Good forward design without over-engineering.
- The `loadOnboardingState()` call at server startup (`index.ts:48`) has no arguments — `existingMemberCount` defaults to 0. This means on a fresh install, banner will show. On an upgrade where the registry has members but the user has never run this code before, the upgrade detection won't fire because the member count isn't passed. **However**, this is Phase 4.1 scope (edge cases & upgrade detection). The plan explicitly says Task 4.1 handles this. Not a bug for Phase 2.

### Code cleanliness
- Diff is minimal and mechanical — each tool registration is a one-line change from inline wrapper to `wrapTool()` call. Easy to audit.
- No unrelated changes mixed in.
- Comments are sparse and useful.

---

## Recommended Improvements (non-blocking)

### REC-4: First JSON tool call silently consumes the banner
If the user's very first tool call is a JSON-returning tool (e.g., `fleet_status`), `getFirstRunPreamble()` fires, marks `bannerShown = true`, but `isJsonResponse` prevents the banner from being prepended. The banner is lost forever. This is unlikely (users typically start with `register_member` or a text-returning tool) and the alternative (corrupting JSON output) is worse. But consider deferring the `advanceMilestone()` call until the banner is actually displayed — i.e., move the state mutation into wrapTool after the `isJsonResponse` check, rather than inside `getFirstRunPreamble()`. This way, the banner would be retried on the next non-JSON tool call. Low priority.

### REC-5: `loadOnboardingState()` at startup doesn't pass member count
As noted above, `loadOnboardingState()` is called with no arguments at `index.ts:48`. The upgrade detection (`existingMemberCount > 0 → skip banner`) only works if the member count is passed. This is Phase 4.1 scope per the plan, but worth flagging: when implementing 4.1, the startup call needs to be updated to `loadOnboardingState(registry.getAllAgents().length)` or equivalent.

---

## Summary

Phase 2 is a clean, well-executed refactor. The `wrapTool()` function correctly replaces all 21 inline wrappers with identical behavior (verified by zero inline wrappers remaining and all 638 tests passing). The stub pattern (`getOnboardingPreamble` delegating to `getFirstRunPreamble`, `getOnboardingNudge` returning null) makes the refactor independently verifiable — with stubs, it's a pure no-op. The first-run banner logic is correct: shows once, persists immediately, handles upgrade and crash scenarios. `isJsonResponse` correctly protects structured data responses. No security concerns. Phase 1 code integrates cleanly with Phase 2 changes.

Two new non-blocking recommendations (REC-4: banner consumed on JSON first-call, REC-5: missing member count at startup). Both are low-risk edge cases with clear paths to resolution in later phases.

**All 8 review criteria pass. APPROVED.**
