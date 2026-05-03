# apra-fleet #210 — Code Review

**Reviewer:** fleet-rev
**Date:** 2026-05-02 20:05:00+05:30
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.

---

## Phase 1 Code Review: Audit all exit paths (T1 + T2)

### T1: Exit path comment block

**PASS.** Comment block at `src/tools/execute-prompt.ts:93-102` documents all seven exit paths (a–g) including early returns before `inFlightAgents.add`. Coverage is thorough — every path through `executePrompt` is accounted for.

**NOTE — stale content in comment block.** Lines 101–102 read:
```
// Currently broken: writeStatusline() clear only in success path (line 219), not in catch or finally.
// Must move writeStatusline() to finally block so ALL paths clear statusline to idle.
```
This describes the *pre-fix* state. After T2 moved `writeStatusline()` to finally, the comment should reflect the *current* state (e.g., "Fixed: writeStatusline() now in finally block, clears statusline on all exit paths"). As written, a future reader will think the bug is still present.

Additionally, line references in the comment (lines 219, 202, 232, 180, 184, 190, 195, 101, 106, 110) are stale — the 11-line comment block itself shifted all subsequent line numbers. Consider removing specific line numbers in favor of descriptive labels (e.g., "success return", "non-zero exit return", "catch block").

### T2: Move writeStatusline() to finally block

**PASS.** The structural change is correct:

1. **writeStatusline() removed from success path** (was between token usage update and output construction) — confirmed in diff, line no longer present.
2. **writeStatusline() added to finally block** (`src/tools/execute-prompt.ts:255`) — runs unconditionally on all exit paths. Positioned after `scope.ok/fail/abort` and before `inFlightAgents.delete` and `deletePromptFile`.
3. **Catch block offline distinction** (`src/tools/execute-prompt.ts:241-245`) — catch now only marks offline for genuine connection failures via regex `/ssh|network|timeout|econnrefused|ehostunreach/i`. Cancellations and other errors fall through to finally's unconditional `writeStatusline()`.

**NOTE — "timeout" in offline regex may be over-broad.** The regex matches bare `timeout` which could match Node.js `TimeoutError` messages from AbortSignal-based timeouts (cancellations). The risk register specifies "TimeoutError → idle," but the regex would classify it as a connection error → offline. In practice this is low-risk because `execCommand` timeout errors are caught differently (they produce non-zero exit codes, not thrown exceptions), but a tighter pattern like `/ssh|network|timed?\s*out|econnrefused|ehostunreach/i` or `/connection.*timeout/i` would be more precise. Non-blocking — the current regex covers the common SSH error messages correctly.

**NOTE — writeStatusline() is a re-render, not a state clear.** `writeStatusline()` with no args loads persisted state from `statusline-state.json` and re-renders without modification (`src/services/statusline.ts:59-86`). After `writeStatusline(new Map([[agent.id, 'busy']]))` sets busy in state, a subsequent `writeStatusline()` re-renders with the persisted 'busy' value — it does not reset to 'idle'. This is a pre-existing behavior on main (the success path on main also calls `writeStatusline()` the same way), so it is not a regression introduced by this PR. However, it means the statusline display may lag until `fleet_status` (check-status.ts) does a full connectivity sweep and overwrites all states. Consider filing a follow-up to have the finally block call `writeStatusline(new Map([[agent.id, 'idle']]))` explicitly — with appropriate logic to preserve the offline marker from catch. Not blocking for Phase 1 since it matches main's existing behavior.

**Catch-then-finally interaction is correct.** When catch sets `writeStatusline(new Map([[agent.id, 'offline']]))`, the offline state is persisted to the state file. The subsequent `writeStatusline()` in finally re-renders from persisted state, so the offline marker survives. No overwrite issue.

### Build & Tests

**PASS.** `npm run build` succeeds (clean tsc). `npm test` passes: 1064 passed, 6 skipped, 61 test files, no failures.

### Regression Check

No changes to `src/services/statusline.ts`. No changes to any other tool files. The diff is scoped entirely to `src/tools/execute-prompt.ts`. No regressions in previously stable code.

### Requirements Alignment

Requirements.md specifies: "Busy state clears as soon as execute_prompt exits — whether by normal completion, timeout, cancellation, or crash." The `inFlightAgents.delete` in finally (unchanged from main) ensures the concurrent dispatch guard clears on all paths. The `writeStatusline()` in finally ensures a re-render on all paths (with the pre-existing state caveat noted above). The catch block offline distinction matches the plan's intent to differentiate connection failures from cancellations.

---

## Summary

Phase 1 (T1 + T2) is **APPROVED**. The core structural fix — moving `writeStatusline()` to the finally block and adding connection-error gating in catch — is correct and matches the plan's specification. Build and tests pass clean. No regressions.

Three non-blocking notes for the doer to address at their discretion:

1. **Comment block staleness**: Lines 101–102 describe pre-fix state ("Currently broken… Must move"). Update to reflect current (fixed) state. Remove hardcoded line numbers.
2. **Timeout regex breadth**: `/timeout/i` in the offline-detection regex could match non-connection timeout errors. Consider tightening to `/timed?\s*out/i` or `/connection.*timeout/i`.
3. **writeStatusline() does not clear busy from persisted state**: Pre-existing issue on main. Recommend a follow-up to explicitly set idle in finally: `writeStatusline(new Map([[agent.id, 'idle']]))` with logic to preserve catch's offline override.
