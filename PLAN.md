# PLAN — Onboarding & User Engagement

**Branch:** `feat/onboarding-ux`
**Base:** `main`
**Created:** 2026-04-08

---

## Architecture Overview

### Key Design Decisions

1. **Central response wrapper in `index.ts`** — Replace 21 inline wrappers with a single `wrapTool(handler)` function that checks onboarding state and prepends contextual text when appropriate. This is the riskiest change (touches every tool registration) but enables all onboarding features without modifying individual tool handlers.

2. **Onboarding state file** — `~/.apra-fleet/data/onboarding.json` tracks milestones (banner shown, first member registered, first prompt executed, etc.). Respects `APRA_FLEET_DATA_DIR`. Loaded once at server start, written on state transitions.

3. **Text constants module** — `src/onboarding/text.ts` holds all user-facing strings (banner, guide, nudges, welcome-back). Logic never constructs display text directly.

4. **Onboarding service** — `src/services/onboarding.ts` manages state persistence and milestone progression. Pure logic, no MCP awareness.

### File Layout

```
src/
  onboarding/
    text.ts          # All user-facing text constants
  services/
    onboarding.ts    # State management (load/save/check/advance)
  index.ts           # Modified: wrapTool() wrapper, welcome-back on startup
```

---

## Phase 1 — Foundations

### Task 1.1: Onboarding state service
**Tier:** standard
**Files:** `src/services/onboarding.ts`, `src/types.ts`
**What:**
- Define `OnboardingState` interface in types.ts:
  ```typescript
  interface OnboardingState {
    bannerShown: boolean;
    firstMemberRegistered: boolean;
    firstPromptExecuted: boolean;
    multiMemberNudgeShown: boolean;
    reviewCycleNudgeShown: boolean;
    welcomeBackShownThisSession: boolean; // in-memory only, not persisted
  }
  ```
- Implement `loadOnboardingState()`, `saveOnboardingState()`, `advanceMilestone(key)`, `shouldShow(key)` in onboarding.ts
- State file at `path.join(FLEET_DIR, 'onboarding.json')` with 0o600 permissions
- Missing file = fresh install (all false) — creates file on first write
- `welcomeBackShownThisSession` is runtime-only (reset each server start)

**Done:** Unit test creates temp state file, advances milestones, verifies persistence across load/save cycles. Missing file returns default state.

**Blockers:** None — pure file I/O, follows registry.ts patterns.

### Task 1.2: Text constants module
**Tier:** cheap
**Files:** `src/onboarding/text.ts`
**What:**
- Export named constants: `BANNER`, `GETTING_STARTED_GUIDE`, `WELCOME_BACK(memberCount, onlineCount, lastActive)`, and nudge functions:
  - `NUDGE_AFTER_FIRST_REGISTER(memberType)` — suggest SSH key setup (remote) or first prompt (local)
  - `NUDGE_AFTER_FIRST_PROMPT()` — introduce fleet_status
  - `NUDGE_AFTER_MULTI_MEMBER()` — introduce PM skill
  - `NUDGE_REVIEW_CYCLE_COMPLETE()` — celebrate milestone
- Banner is the exact ASCII art from requirements.md
- Each nudge is 1-3 lines, box-drawing bordered, sparse emoji
- Guide uses indentation and section headers for scannability

**Done:** Text module exports all constants. Import compiles. Manual review confirms formatting looks correct in monospace.

**Blockers:** None.

### VERIFY 1
- [ ] `npm run build` succeeds with new files
- [ ] `npm test` — all existing tests still pass
- [ ] New unit test for onboarding state service passes

---

## Phase 2 — Core Integration (Riskiest Change)

### Task 2.1: Central `wrapTool()` in index.ts
**Tier:** standard
**Files:** `src/index.ts`
**What:**
- Add a `wrapTool` function that takes a tool handler `(input) => Promise<string>` and returns the MCP response shape:
  ```typescript
  function wrapTool(handler: (input: any) => Promise<string>) {
    return async (input: any) => {
      const result = await handler(input);
      const preamble = getOnboardingPreamble(toolContext);
      const text = preamble ? preamble + '\n\n---\n\n' + result : result;
      return { content: [{ type: 'text', text }] };
    };
  }
  ```
- Replace all 21 inline wrappers with `wrapTool(handler)` calls
- `getOnboardingPreamble()` returns null when no onboarding text is needed (majority of calls)
- On first tool call ever: return banner + getting started guide
- On first non-first-run server start: return welcome-back message (once per lifecycle)
- Import onboarding service at server startup alongside other imports

**Done:** All 21 tools use `wrapTool()`. Existing integration tests pass unchanged. A tool call with fresh onboarding state returns banner prepended to normal response. A tool call with completed onboarding returns only the normal response.

**Blockers:** This is the riskiest task — must verify that prepending text doesn't break:
- JSON-returning tools (fleet_status, member_detail with format=json) — consumers may parse the full text as JSON
- Tools that return error strings — prepending banner to an error would be confusing

**Mitigation:** Only prepend to successful responses. For JSON-format tools, skip prepending (detect by checking if result starts with `{` or `[`). Add a test specifically for this edge case.

### Task 2.2: First-run banner + getting started guide
**Tier:** cheap
**Files:** `src/services/onboarding.ts` (add `getFirstRunPreamble()`)
**What:**
- `getFirstRunPreamble()`: if `!state.bannerShown`, return `BANNER + '\n' + GETTING_STARTED_GUIDE` and mark `bannerShown = true`
- Called by `wrapTool` on every invocation until banner is shown
- After showing, state is persisted immediately so server crash doesn't re-show

**Done:** First tool call returns banner + guide prepended. Second call does not. State file shows `bannerShown: true`.

**Blockers:** None.

### VERIFY 2
- [ ] `npm run build` succeeds
- [ ] ALL existing tests pass (critical — wrapTool refactor touches every tool)
- [ ] New test: fresh state → first call includes banner → second call does not
- [ ] New test: JSON-returning tool does not get banner prepended
- [ ] Manual smoke test: run server, call `fleet_status`, confirm banner appears once

---

## Phase 3 — Contextual Nudges

### Task 3.1: Post-registration and post-prompt nudges
**Tier:** standard
**Files:** `src/services/onboarding.ts`, `src/index.ts`
**What:**
- Extend `wrapTool` to accept tool name parameter so nudge logic knows which tool just ran
- After `register_member` succeeds (result starts with `✅`):
  - If `!state.firstMemberRegistered`: append `NUDGE_AFTER_FIRST_REGISTER(memberType)`, set flag
  - If first member already registered and registry now has 2+ members and `!state.multiMemberNudgeShown`: append `NUDGE_AFTER_MULTI_MEMBER()`, set flag
- After `execute_prompt` succeeds (result starts with `📋`):
  - If `!state.firstPromptExecuted`: append `NUDGE_AFTER_FIRST_PROMPT()`, set flag
- Nudges are APPENDED (not prepended) to tool responses — they're contextual follow-ups
- Each nudge shown at most once (state flag prevents repeat)

**Done:** Test simulates tool sequence: register → nudge appears → register again → no nudge. Prompt → nudge appears → prompt again → no nudge. Multi-member nudge appears on second registration.

**Blockers:** Need to detect member type (local vs remote) from register_member response to customize the nudge. Parse from the response text (`Type: remote` or `Type: local`).

### Task 3.2: Review cycle celebration + welcome-back message
**Tier:** cheap
**Files:** `src/services/onboarding.ts`, `src/index.ts`
**What:**
- Review cycle detection: after `execute_prompt`, if response contains review-related keywords (e.g., "review", "approved", "LGTM") and `!state.reviewCycleNudgeShown`: append `NUDGE_REVIEW_CYCLE_COMPLETE()`, set flag
- Welcome-back: at server startup in `startServer()`, load onboarding state. If `bannerShown === true` (not first run), set a flag `pendingWelcomeBack = true`. On first tool call, prepend `WELCOME_BACK(memberCount, onlineCount, lastActive)` using data from registry. Clear flag.
- Welcome-back requires reading the registry to get member count — use `getAllAgents()` from registry service

**Done:** Test: server start with existing state → first call gets welcome-back → second call does not. Review nudge appears once when prompt response contains review keywords.

**Blockers:** Review detection is heuristic — could false-positive. Keep it simple: only trigger if the execute_prompt tool name matches AND response text contains "approved" or "review complete" (case-insensitive).

### VERIFY 3
- [ ] `npm run build` succeeds
- [ ] All tests pass
- [ ] Nudge sequence test: register → nudge → register 2nd → multi-member nudge → prompt → prompt nudge
- [ ] Welcome-back test: existing user → server start → first call shows welcome-back
- [ ] Review nudge test: prompt with "approved" → celebration → next prompt → no celebration

---

## Phase 4 — Hardening & Polish

### Task 4.1: Edge cases and defensive behavior
**Tier:** cheap
**Files:** `src/services/onboarding.ts`, tests
**What:**
- Corrupted onboarding.json → treat as fresh install (log warning, don't crash)
- Concurrent writes → use atomic write (write to temp + rename, same as registry.ts pattern)
- Upgrade path: existing install has no onboarding.json → bannerShown defaults to false. BUT if registry already has members, this is an upgrade not a fresh install. Detect: if registry has agents but no onboarding.json, create state with `bannerShown: true` (skip banner for existing users). This satisfies acceptance criteria: "Re-install / upgrade preserves onboarding state"
- SEA binary mode: no embedded assets needed — all text is in code, state file uses FLEET_DIR

**Done:** Test: corrupt JSON file → default state returned. Test: registry has members but no onboarding.json → bannerShown pre-set to true. Atomic write test.

**Blockers:** None.

### Task 4.2: Final test coverage and cleanup
**Tier:** cheap
**Files:** `tests/onboarding.test.ts`, `tests/onboarding-text.test.ts`
**What:**
- Comprehensive test file for onboarding service: all milestone transitions, persistence, corruption recovery, upgrade detection
- Text constants test: verify BANNER contains the exact ASCII art, nudge functions return strings, WELCOME_BACK formats correctly
- Integration test: wrapTool with onboarding produces correct output sequence
- Verify all existing tests still pass

**Done:** `npm test` passes with full coverage of new code. No regressions.

**Blockers:** None.

### VERIFY 4 (Final)
- [ ] `npm run build` succeeds
- [ ] `npm test` — ALL tests pass (existing + new)
- [ ] Acceptance criteria checklist:
  - [ ] First call after fresh install shows ASCII banner + guide
  - [ ] Banner never appears again
  - [ ] Contextual nudges appear after correct triggers, each at most once
  - [ ] Welcome-back appears once per server lifecycle (not first run)
  - [ ] State persists across server restarts
  - [ ] Upgrade preserves state (no re-trigger for existing users)
  - [ ] Works in dev mode and SEA binary mode

---

## Risk Register

| # | Risk | Impact | Likelihood | Mitigation |
|---|------|--------|------------|------------|
| R1 | wrapTool refactor breaks JSON-returning tools | High | Medium | Skip prepend when response starts with `{` or `[`; test explicitly |
| R2 | Prepending to error responses confuses the AI agent | Medium | Medium | Only prepend/append to successful responses (detect ✅/📋 prefixes) |
| R3 | Onboarding state file corruption | Low | Low | Treat corrupt file as default state; atomic writes |
| R4 | Existing users see banner after upgrade | Medium | Medium | Detect existing registry → pre-set bannerShown=true |
| R5 | Review cycle heuristic false-positives | Low | Medium | Conservative keyword matching; only on execute_prompt responses |
| R6 | Welcome-back registry read fails (empty/corrupt) | Low | Low | Graceful fallback: show generic "Fleet ready." message |

---

## Task Summary

| Task | Phase | Tier | Files | Description |
|------|-------|------|-------|-------------|
| 1.1 | 1 | standard | services/onboarding.ts, types.ts | Onboarding state service |
| 1.2 | 1 | cheap | onboarding/text.ts | Text constants module |
| 2.1 | 2 | standard | index.ts | Central wrapTool() refactor |
| 2.2 | 2 | cheap | services/onboarding.ts | First-run banner + guide logic |
| 3.1 | 3 | standard | services/onboarding.ts, index.ts | Post-registration & post-prompt nudges |
| 3.2 | 3 | cheap | services/onboarding.ts, index.ts | Review celebration + welcome-back |
| 4.1 | 4 | cheap | services/onboarding.ts | Edge cases & upgrade detection |
| 4.2 | 4 | cheap | tests/ | Final test coverage |
