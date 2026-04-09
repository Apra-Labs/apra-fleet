# Onboarding Banner Visibility Fix — Code Review

**Commits reviewed:** `07e214e` and `a06e052`
**Scope:** wrapTool passive guard, isActiveTool, PASSIVE_TOOLS, resetSessionFlags, MCP content annotations, banner bypassing the JSON response check

---

## Verdict: APPROVED

---

## Test Results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | Pass (clean) |
| `npm test` | 50/50 onboarding tests pass; 1 unrelated failure in `platform.test.ts` (`cleanExec` env test) |
| `node tests/onboarding-smoke.mjs` | All 5 smoke tests pass |

---

## Review of Changes

### 1. Passive Tool Guard (`isActiveTool` + `PASSIVE_TOOLS`) — GOOD

**What it does:** Prevents `version` and `shutdown_server` from consuming the one-shot banner or welcome-back preamble.

**Why it's correct:** MCP clients (Claude Code, Cursor) often call `version` automatically at startup during capability negotiation. Without this guard, the banner would be "consumed" by a background tool call the user never sees. The `Set`-based lookup is O(1) and the two passive tools are well-chosen — both are diagnostic/lifecycle tools with no user-facing output.

**The guard is properly layered:** `isActiveTool` only controls whether onboarding preambles attach. Nudges already have their own tool-name filters (`register_member`, `execute_prompt`), so there's no double-gating concern.

### 2. Banner Bypasses JSON Check — GOOD

**What it does (a06e052):** The first-run banner now shows regardless of whether the tool response is JSON. The welcome-back message and nudges still respect the JSON check.

**Why it's correct:** If a user's very first tool call happens to be `fleet_status` (which returns JSON), the old code would silently consume the banner milestone without ever displaying it. The fix splits the logic:

```
banner = getFirstRunPreamble()           // always, if active tool
welcome-back = isJson ? null : ...       // respects JSON check
nudge = isJson ? null : ...              // respects JSON check
```

This is the right tradeoff: the banner is a one-time event that must not be silently lost, while welcome-back and nudges are recurring/contextual and can safely yield to JSON responses.

### 3. MCP Content Annotations — GOOD

**What it does:** Instead of string-concatenating banner + result + nudge into one text blob, wrapTool now returns separate `content` blocks with MCP `annotations`:

- Banner: `{ audience: ['user'], priority: 1 }`
- Result: no annotation (default)
- Nudge: `{ audience: ['user'], priority: 0.8 }`

**Why it's correct:** This follows the MCP spec for content annotations. Clients that support annotations can render the banner prominently to the user without feeding it to the model as context. Clients that don't support annotations degrade gracefully — they just see multiple text blocks. The priority ordering (banner > result > nudge) is sensible.

### 4. `resetSessionFlags()` at Startup — GOOD

**What it does:** Explicitly resets `welcomeBackShownThisSession` to `false` at server startup, right after `loadOnboardingState()`.

**Why it's correct:** The session flag is a module-level `let` variable. In normal operation it starts as `false`, but calling `resetSessionFlags()` explicitly makes the invariant visible and protects against edge cases (hot module reload, test runners that reuse the module). The function is clean and the call site is correct.

### 5. Test Coverage — GOOD

The test suite covers:
- `isActiveTool` returns false for `version` and `shutdown_server`, true for active tools
- Passive tool (`version`) does not consume the banner
- Banner is preserved after passive call and consumed on next active call
- Banner shows on JSON response from active tool (the key fix)
- Full first-session sequence: banner → register nudge → multi-member nudge → prompt nudge
- Welcome-back session flag lifecycle
- Smoke test replicates the exact `wrapTool` logic from `src/index.ts`

### 6. Minor Observations (Non-blocking)

**A. PASSIVE_TOOLS extensibility:** If new diagnostic tools are added (e.g., `health_check`), someone needs to remember to add them to `PASSIVE_TOOLS`. A comment above the Set already documents this, which is sufficient for now. An alternative would be a schema-level `passive: true` annotation on tool definitions, but that's over-engineering for 2 tools.

**B. Nudge suppression on JSON responses (a06e052):** The second commit also suppresses nudges for JSON responses (`const suffix = isJson ? null : getOnboardingNudge(...)`) which is correct — nudges after `fleet_status` JSON output would be confusing — but this change isn't called out in the commit message. Minor documentation gap only.

**C. Smoke test t3 comment mismatch:** The smoke test comment on test 3 says "Expected: preamble=null" but then accepts a welcome-back preamble as passing. The output is correct (welcome-back is shown once), but the comment is slightly misleading. Non-blocking.

---

## Summary

The two commits solve a real problem (banner silently consumed by passive or JSON-returning tools) with a clean, minimal fix. The layering is correct: passive guard → banner bypass → JSON check for welcome-back/nudges. MCP annotations are a nice forward-looking addition. Test coverage is thorough. Ship it.
