# apra-fleet #210 — Code Review

**Reviewer:** fleet-rev
**Date:** 2026-05-02 20:40:00-04:00
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.

---

## Phase 1 Code Review: Audit all exit paths (T1 + T2)

### T1: Exit path comment block

**PASS.** Comment block at `src/tools/execute-prompt.ts:93-102` documents all seven exit paths (a–g) including early returns before `inFlightAgents.add`. Coverage is thorough — every path through `executePrompt` is accounted for.

**NOTE — stale content in comment block.** Lines 101–102 describe the *pre-fix* state ("Currently broken… Must move"). After T2 moved `writeStatusline()` to finally, the comment should reflect the current (fixed) state. Additionally, hardcoded line numbers are stale due to the insertion of the comment block itself. Non-blocking.

**Doer:** fixed in commit 1a9925b — rewrote comment block in present-tense fixed form; removed "Currently broken" and "Must move" lines; removed all hardcoded line numbers.

### T2: Move writeStatusline() to finally block

**PASS.** The structural change is correct:

1. **writeStatusline() removed from success path** — confirmed in diff, no longer present between token usage update and output construction.
2. **writeStatusline() added to finally block** (`src/tools/execute-prompt.ts:255`) — runs unconditionally on all exit paths. Positioned after `scope.ok/fail/abort` and before `inFlightAgents.delete` and `deletePromptFile`.
3. **Catch block offline distinction** (`src/tools/execute-prompt.ts:241-245`) — catch now only marks offline for genuine connection failures via regex `/ssh|network|timeout|econnrefused|ehostunreach/i`. Cancellations and other errors fall through to finally's unconditional `writeStatusline()`.

**NOTE — "timeout" in offline regex may be over-broad.** The regex matches bare `timeout` which could match non-connection timeout errors. Low-risk in practice since `execCommand` timeout errors produce non-zero exit codes rather than thrown exceptions. Non-blocking.

**Doer:** fixed in commit e6b423a — replaced `/timeout/i` with `connection timed out` phrase match; pattern is now `/ssh|network|econnrefused|ehostunreach|connection timed out/i`.

**NOTE — writeStatusline() is a re-render, not a state clear.** Pre-existing behavior on main — `writeStatusline()` with no args re-renders from persisted state, which may still contain 'busy'. Not a regression. Recommend follow-up to explicitly set idle. Non-blocking.

**Doer:** fixed in commit cc6b782 — added `_epOffline` flag tracked in catch block; finally now calls `writeStatusline(new Map([[agent.id, _epOffline ? 'offline' : 'idle']]))` so the persisted state is always explicitly updated. Removed the writeStatusline call from catch; finally is the single write site. T5 test assertions updated to check for Map call with 'idle' or 'offline' instead of no-arg call.

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

## Phase 3 Code Review: Test coverage for busy-state cleanup (T5 + T6)

### T5: Unit tests for busy-state clear on all exit paths

**PASS.** Four tests added in `tests/execute-prompt.test.ts` under `describe('busy-state clear on all exit paths (T5)')`:

1. **Success (exit=0)** — `mockExecCommand` returns code 0 with valid JSON. Asserts `inFlightAgents.has(memberId)` is false and `writeStatusline()` was called with no args.
2. **Failure (exit=1)** — `mockExecCommand` returns code 1 with stderr. Same assertions — busy state clears even on non-zero exit.
3. **Thrown exception** — `mockExecCommand` rejects with `Error('ssh connection lost')`. Verifies the catch→finally chain clears busy state.
4. **AbortSignal cancellation** — Uses `AbortController` and deferred promise pattern. The main exec hangs, abort fires, then the promise resolves with code 1. Uses `vi.advanceTimersByTimeAsync(0)` to flush microtasks. Asserts busy state is cleared after abort path.

**Test setup is correct.** `writeStatusline` is mocked at module level (`vi.mock('../src/services/statusline.js')`). `inFlightAgents` is imported directly from `execute-prompt.js` and cleaned up in `afterEach`. `vi.useFakeTimers()` is scoped to this describe block only — no interference with other test suites.

**Assertion strategy is sound.** Each test checks two invariants: (1) `inFlightAgents.has(memberId) === false` — the concurrent dispatch guard is clear; (2) `writeStatusline` was called at least once with no arguments — the finally block's statusline re-render fired. The `some(c => c.length === 0)` pattern correctly distinguishes the no-arg finally call from any catch-block call that passes a Map argument.

### T6: Unit tests for stop_prompt busy-clear

**PASS.** Two tests added in `tests/stop-prompt.test.ts` under `describe('stop_prompt busy-clear (T6)')`:

1. **pid=none clears busy state** — Manually adds `memberId` to `inFlightAgents`, calls `stopPrompt`, asserts `inFlightAgents.has(memberId)` is false and `writeStatusline` was called. Also asserts the return string contains 'stopped'. This directly tests the T3 fix for the pid=none case.
2. **Re-dispatch after stop** — Simulates the end-to-end user scenario from issue #210: member is stuck busy (in `inFlightAgents` with no PID), user calls `stop_prompt`, then immediately dispatches `execute_prompt`. Asserts the result does *not* contain 'already running' and *does* contain the expected output. This is the integration-level test for the T3+T4 fix working together.

**Test isolation is correct.** `afterEach` cleans up both `inFlightAgents` and `clearStoredPid`. `mockExecCommand` is set up fresh for the re-dispatch test. The `writeStatusline` mock is shared with the T5 tests via the same module-level `vi.mock`.

### Build & Tests

**PASS.** `npm run build` succeeds (clean tsc). `npm test` passes: 61 test files, **1070 passed** (up from 1064 in Phase 2), 6 skipped, no failures. The delta of +6 tests matches exactly: 4 from T5 + 2 from T6.

### Regression Check

Phase 3 changes are test-only — no production code was modified. `tests/execute-prompt.test.ts` gained 4 tests, `tests/stop-prompt.test.ts` gained 2 tests. Both files add imports (`inFlightAgents`, `writeStatusline`) and module-level mocks that are scoped correctly. No existing test assertions were modified. All 61 test suites still pass.

### Test Coverage Assessment

The six new tests cover the critical behavioral guarantees from Phases 1 and 2:

| Exit path | Covered by |
|---|---|
| Normal success (exit=0) | T5 test 1 |
| Non-zero exit (exit=1) | T5 test 2 |
| Thrown exception (catch block) | T5 test 3 |
| AbortSignal cancellation | T5 test 4 |
| stop_prompt with pid=none | T6 test 1 |
| stop_prompt → re-dispatch (integration) | T6 test 2 |

**Not covered (acceptable):** Stale session retry (exit path e) and server overload retry (exit path f) — these are internal retry loops that eventually exit through one of the covered paths. The poll guard timeout case in `stop_prompt` (2s deadline expires) is hard to test deterministically and the unconditional delete provides the safety net.

---

## Cumulative Summary (All Phases)

Phases 1–3 (T1–T6) are **APPROVED**. The implementation correctly:

- Documents all seven exit paths from `executePrompt` (T1)
- Moves `writeStatusline()` to the finally block for unconditional cleanup (T2)
- Exports `inFlightAgents` and uses it in `stop_prompt` to unconditionally clear busy state (T3)
- Adds a poll guard to prevent re-dispatch races after PID kill (T4)
- Tests busy-state cleanup on all four primary exit paths: success, failure, exception, abort (T5)
- Tests `stop_prompt` busy-clear for pid=none and the stop→re-dispatch user scenario (T6)

Build and all 1070 tests pass clean. No regressions across any phase. Production changes are limited to `src/tools/execute-prompt.ts` and `src/tools/stop-prompt.ts`. Code matches PLAN.md specifications and solves requirements.md's stated problem.

**Non-blocking notes (unchanged, at doer's discretion):**

1. Comment block lines 101–102 describe pre-fix state — update to reflect current state; remove hardcoded line numbers.
2. Timeout regex `/timeout/i` could be tightened to avoid matching non-connection timeouts.
3. `writeStatusline()` re-renders persisted state rather than explicitly clearing to idle — recommend follow-up issue.
