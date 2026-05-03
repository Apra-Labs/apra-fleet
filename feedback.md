# apra-fleet #210 — Code Review

**Reviewer:** fleet-rev
**Date:** 2026-05-02 22:20:00-04:00
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.

---

## Phase 1 Code Review: Audit all exit paths (T1 + T2)

### T1: Exit path comment block

**PASS.** Comment block at `src/tools/execute-prompt.ts:93-102` documents all seven exit paths (a–g) including early returns before `inFlightAgents.add`. Coverage is thorough — every path through `executePrompt` is accounted for.

**NOTE — stale content in comment block.** Lines 101–102 describe the *pre-fix* state ("Currently broken… Must move"). After T2 moved `writeStatusline()` to finally, the comment should reflect the current (fixed) state. Additionally, hardcoded line numbers are stale due to the insertion of the comment block itself. Non-blocking.

### T2: Move writeStatusline() to finally block

**PASS.** The structural change is correct:

1. **writeStatusline() removed from success path** — confirmed in diff, no longer present between token usage update and output construction.
2. **writeStatusline() added to finally block** (`src/tools/execute-prompt.ts:255`) — runs unconditionally on all exit paths. Positioned after `scope.ok/fail/abort` and before `inFlightAgents.delete` and `deletePromptFile`.
3. **Catch block offline distinction** (`src/tools/execute-prompt.ts:241-245`) — catch now only marks offline for genuine connection failures via regex `/ssh|network|timeout|econnrefused|ehostunreach/i`. Cancellations and other errors fall through to finally's unconditional `writeStatusline()`.

**NOTE — "timeout" in offline regex may be over-broad.** The regex matches bare `timeout` which could match non-connection timeout errors. Low-risk in practice since `execCommand` timeout errors produce non-zero exit codes rather than thrown exceptions. Non-blocking.

**NOTE — writeStatusline() is a re-render, not a state clear.** Pre-existing behavior on main — `writeStatusline()` with no args re-renders from persisted state, which may still contain 'busy'. Not a regression. Recommend follow-up to explicitly set idle. Non-blocking.

---

## Phase 2 Code Review: PID capture race and stop_prompt hardening (T3 + T4)

### T3: Guard against PID-less cancellation leaving stale state

**PASS.** Changes to `src/tools/stop-prompt.ts` correctly implement the specification:

1. **Imports added** (lines 8–9): `inFlightAgents` from `./execute-prompt.js` and `writeStatusline` from `../services/statusline.js`. Import paths are correct — note the Phase 1 plan review incorrectly referenced `src/utils/statusline.ts` but implementation correctly uses `src/services/statusline.js`.
2. **Export of `inFlightAgents`** (`src/tools/execute-prompt.ts:91`): Changed from `const` to `export const`. Clean — no runtime behavior change.
3. **Unconditional busy-state clear** (`src/tools/stop-prompt.ts:40-41`): `inFlightAgents.delete(agent.id)` followed by `writeStatusline()` runs after all other logic, ensuring the pid=none case is handled.

**Done criteria met:** When `stop_prompt` is called with pid=none, `inFlightAgents.delete` removes the stale entry and `writeStatusline()` re-renders. A subsequent `execute_prompt` will pass the `inFlightAgents.has()` guard at line 120.

### T4: Defend against re-dispatch race after stop_prompt

**PASS.** The poll guard at `src/tools/stop-prompt.ts:29-36` correctly implements the specification:

1. **Condition gating** (`pid !== undefined`): Poll only fires when a PID was actually killed — in the pid=none path, there's no running `execCommand` promise whose finally block needs to drain, so polling is unnecessary. The unconditional delete at line 40 handles that case directly.
2. **Poll mechanics**: 50ms intervals, 2000ms deadline. Exactly matches PLAN.md specification.
3. **Correctness**: After `tryKillPid` sends the signal, the `execCommand` promise in `executePrompt` resolves (process exited), the finally block runs `inFlightAgents.delete(agent.id)`, and the poll exits. The subsequent unconditional delete at line 40 is then a no-op (safe — `Set.delete` on a non-existent element returns false).
4. **Timeout safety**: If the 2s deadline expires (finally block never ran — pathological case), the unconditional delete at line 40 still clears the agent. This means `stop_prompt` *always* guarantees busy state is cleared on return, regardless of poll outcome.

**Done criteria met:** After `stop_prompt` returns, `inFlightAgents.has(agent.id)` is guaranteed false. An immediately subsequent `execute_prompt` will not hit the "already running" guard.

**NOTE — double-delete on happy path is intentional redundancy.** When pid is defined and the poll succeeds (finally already cleared `inFlightAgents`), the unconditional delete at line 40 is a no-op. This is correct defensive code — it handles the timeout case where finally hasn't run yet without adding a conditional branch.

**NOTE — poll occurs before logLine.** The `logLine` call (line 43) is positioned after the poll and unconditional clear. This means the log entry reflects the final state. Correct ordering.

### Build & Tests

**PASS.** `npm run build` succeeds (clean tsc). `npm test` passes: 61 test files, 1064 passed, 6 skipped, no failures.

### Regression Check

Phase 2 changes touch only `src/tools/stop-prompt.ts` (new imports + poll logic + unconditional clear) and `src/tools/execute-prompt.ts` (export keyword on `inFlightAgents`). No behavioral change to execute-prompt.ts beyond the export visibility. No regressions in Phase 1 changes — the finally block structure, catch block offline distinction, and comment block are untouched. All 61 test suites still pass.

### Requirements Alignment

Requirements.md specifies:
- "Busy state clears as soon as execute_prompt exits" → Phase 1 ensures this via finally block.
- "The concurrent dispatch guard fires incorrectly, blocking legitimate dispatches" → Phase 2 ensures `stop_prompt` clears `inFlightAgents` unconditionally, so the next `execute_prompt` dispatch is never blocked by stale state.
- "Workaround is manual stop_prompt or server restart" → Now unnecessary: `stop_prompt` is a reliable fix (not just a workaround) that guarantees clean state.

Both phases align with the stated requirements and solve the described problem.

---

## Summary

Phases 1 and 2 (T1–T4) are **APPROVED**. The implementation correctly:

- Moves `writeStatusline()` to the finally block for unconditional cleanup on all exit paths (T1/T2)
- Exports `inFlightAgents` and uses it in `stop_prompt` to unconditionally clear busy state (T3)
- Adds a poll guard to prevent re-dispatch races after PID kill (T4)

Build and tests pass clean. No regressions. Code matches PLAN.md specifications and solves requirements.md's stated problem.

**Non-blocking notes carried forward from Phase 1** (unchanged, at doer's discretion):

1. Comment block lines 101–102 describe pre-fix state — update to reflect current state; remove hardcoded line numbers.
2. Timeout regex `/timeout/i` could be tightened to avoid matching non-connection timeouts.
3. `writeStatusline()` re-renders persisted state rather than explicitly clearing to idle — recommend follow-up issue.
