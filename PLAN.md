# PLAN — Onboarding & User Engagement

**Branch:** `feat/onboarding-ux`
**Base:** `main`
**Created:** 2026-04-08

---

## Architecture Overview

### Key Design Decisions

1. **Central response wrapper in `index.ts`** — Replace 21 inline wrappers with a single `wrapTool(handler)` function that checks onboarding state and prepends contextual text when appropriate. This is the riskiest change (touches every tool registration) but enables all onboarding features without modifying individual tool handlers.

2. **Onboarding state file** — `~/.apra-fleet/data/onboarding.json` tracks milestones (banner shown, first member registered, first prompt executed, etc.). Respects `APRA_FLEET_DATA_DIR`. **Loaded once at server start into an in-memory singleton**, all reads check the in-memory copy (serialized through the JS event loop — no concurrent-read races), written to disk on state transitions. "First meaningful interaction" in the requirements = first MCP tool call (MCP tools are the only user-facing interaction surface).

3. **Text constants module** — `src/onboarding/text.ts` holds all user-facing strings (banner, guide, nudges, welcome-back). Logic never constructs display text directly.

4. **Onboarding service** — `src/services/onboarding.ts` manages state persistence and milestone progression. Pure logic, no MCP awareness. Runtime-only flags (e.g., `welcomeBackShownThisSession`) are kept as module-level variables, **not** in the persisted `OnboardingState` interface.

5. **Nudge placement** — Banner and welcome-back are **prepended** to the first tool response. Contextual nudges are **appended** after tool results — this deviates from the requirements wording ("prepended, not replacing") but is the correct UX: nudges are follow-up suggestions that should appear after the user sees the tool result. The requirement's intent is "don't replace the tool response," which appending also satisfies.

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
- Define `OnboardingState` interface in types.ts (persisted fields only):
  ```typescript
  interface OnboardingState {
    bannerShown: boolean;
    firstMemberRegistered: boolean;
    firstPromptExecuted: boolean;
    multiMemberNudgeShown: boolean;
  }
  ```
- Implement `loadOnboardingState()`, `saveOnboardingState()`, `advanceMilestone(key)`, `shouldShow(key)` in onboarding.ts
- State is **loaded once at server start into an in-memory singleton** — all subsequent reads use the in-memory copy (no concurrent-read races via JS event loop serialization). Writes persist to disk immediately via atomic write (temp + rename).
- State file at `path.join(FLEET_DIR, 'onboarding.json')` with 0o600 permissions
- Missing file = fresh install (all false) — creates file on first write
- Runtime-only flag `welcomeBackShownThisSession` is a **module-level variable** in onboarding.ts, not part of the persisted interface

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
- Add a `wrapTool` function that takes a **tool name** and handler, and returns the MCP response shape:
  ```typescript
  function wrapTool(toolName: string, handler: (input: any) => Promise<string>) {
    return async (input: any) => {
      const result = await handler(input);
      const preamble = getOnboardingPreamble();       // stub: returns null
      const suffix = getOnboardingNudge(toolName, input, result); // stub: returns null
      let text = result;
      if (preamble && !isJsonResponse(result)) text = preamble + '\n\n---\n\n' + text;
      if (suffix) text = text + '\n\n---\n\n' + suffix;
      return { content: [{ type: 'text', text }] };
    };
  }
  ```
- Replace all 21 inline wrappers with `wrapTool('tool_name', handler)` calls
- **This task creates `getOnboardingPreamble()` and `getOnboardingNudge()` as stubs returning `null`** — no onboarding logic yet. Task 2.2 fills in preamble, Task 3.1 fills in nudges. This makes 2.1 independently testable.
- `isJsonResponse(result)`: returns true if result starts with `{` or `[` — skips prepend for JSON tools. Explicitly handles: `fleet_status` (json format), `member_detail`, `list_members` (json format), and `monitor_task` (always returns JSON via `JSON.stringify`).
- `wrapTool` receives `input` and passes it to nudge logic — this enables nudges to read tool input fields (e.g., `member_type`) without parsing response strings.
- Import onboarding service at server startup alongside other imports; call `loadOnboardingState()` once.

**Done:** All 21 tools use `wrapTool()`. Existing integration tests pass unchanged. Stubs return null so all responses are unchanged. `isJsonResponse` test covers `{`, `[`, and non-JSON inputs.

**Blockers:** This is the riskiest task — must verify that the mechanical refactor doesn't change any existing behavior (stubs return null = no-op).

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
**Files:** `src/services/onboarding.ts`
**What:**
- Fill in the `getOnboardingNudge(toolName, input, result)` stub from Task 2.1
- `wrapTool` already passes `toolName` and `input` — nudge logic reads `input.member_type` directly from tool input (no response string parsing)
- After `register_member` succeeds (result starts with `✅`):
  - If `!state.firstMemberRegistered`: return `NUDGE_AFTER_FIRST_REGISTER(input.member_type)`, advance milestone
  - If first member already registered and registry now has 2+ members and `!state.multiMemberNudgeShown`: return `NUDGE_AFTER_MULTI_MEMBER()`, advance milestone
- After `execute_prompt` succeeds (result starts with `📋`):
  - If `!state.firstPromptExecuted`: return `NUDGE_AFTER_FIRST_PROMPT()`, advance milestone
- Nudges are APPENDED (not prepended) to tool responses — they're contextual follow-ups (see Architecture Decision #5)
- Each nudge shown at most once (state flag prevents repeat)

**Done:** Test simulates tool sequence: register(member_type="local") → nudge appears → register again → no nudge. Prompt → nudge appears → prompt again → no nudge. Multi-member nudge appears on second registration.

**Blockers:** None — `input.member_type` is always present in register_member schema.

### Task 3.2: Welcome-back message
**Tier:** cheap
**Files:** `src/services/onboarding.ts`
**What:**
- Welcome-back: at server startup in `startServer()`, load onboarding state into the in-memory singleton. If `bannerShown === true` (not first run), set the module-level flag `welcomeBackShownThisSession = false`. On first tool call, fill in `getOnboardingPreamble()` to prepend `WELCOME_BACK(memberCount, onlineCount, lastActive)` using data from registry, then set `welcomeBackShownThisSession = true`.
- `lastActive` computation: `max(agent.lastActivity for all agents in registry)`, formatted as relative time (e.g., "2h ago"). Falls back to `"unknown"` if no agents have a `lastActivity` timestamp.
- Welcome-back requires reading the registry — use `getAllAgents()` from registry service.
- **Review cycle celebration is deferred.** The requirements say "after first review cycle complete" which implies integration with the PM skill's review tracking (doer-reviewer pairs). Keyword-sniffing on raw prompt output has high false-positive risk ("review the PR" as instruction vs. result). This will be implemented when the PM skill exposes a review-complete event/callback. Removed `reviewCycleNudgeShown` from `OnboardingState`.

**Done:** Test: server start with existing state → first call gets welcome-back with correct member counts → second call does not. Welcome-back with zero agents shows "Fleet ready." fallback.

**Blockers:** None.

### VERIFY 3
- [ ] `npm run build` succeeds
- [ ] All tests pass
- [ ] Nudge sequence test: register(local) → nudge → register(remote) 2nd → multi-member nudge → prompt → prompt nudge
- [ ] Welcome-back test: existing user → server start → first call shows welcome-back with member count + lastActive
- [ ] Welcome-back with zero agents → "Fleet ready." fallback

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
- Verify `install` CLI (`src/cli/install.ts`) does not overwrite or reset the data directory — read the install flow and confirm it only writes hooks, scripts, and MCP config, not data files. Add a note in the code if needed to protect the data dir.

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
| R5 | Review cycle heuristic false-positives | Low | Medium | **Deferred** — review cycle nudge removed from initial scope; will integrate with PM skill's review-complete event instead of keyword heuristics |
| R6 | Welcome-back registry read fails (empty/corrupt) | Low | Low | Graceful fallback: show generic "Fleet ready." message |
| R7 | Race condition: parallel first tool calls both see bannerShown=false | Medium | Medium | Load state once at server start into in-memory singleton; all reads use in-memory copy (JS event loop serializes access); writes persist to disk immediately |

---

## Task Summary

| Task | Phase | Tier | Files | Description |
|------|-------|------|-------|-------------|
| 1.1 | 1 | standard | services/onboarding.ts, types.ts | Onboarding state service |
| 1.2 | 1 | cheap | onboarding/text.ts | Text constants module |
| 2.1 | 2 | standard | index.ts | Central wrapTool() refactor |
| 2.2 | 2 | cheap | services/onboarding.ts | First-run banner + guide logic |
| 3.1 | 3 | standard | services/onboarding.ts | Post-registration & post-prompt nudges |
| 3.2 | 3 | cheap | services/onboarding.ts | Welcome-back message |
| 4.1 | 4 | cheap | services/onboarding.ts | Edge cases & upgrade detection |
| 4.2 | 4 | cheap | tests/ | Final test coverage |
