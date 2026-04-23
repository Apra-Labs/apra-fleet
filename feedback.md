# Cumulative Review — Sprint 1 (Phases 1 + 2 + 3)

**Reviewer:** Claude (sprint review agent)
**Date:** 2026-04-23
**Branch:** sprint/session-lifecycle-oob-fix
**Verdict:** APPROVED

## Phase 1 Recap (previously approved)

T1 (PID wrapper), T2 (killPid interface + PID store), T3 (buildAgentPromptCommand wraps all providers) — all correct and well-tested. See prior review commit `8e0d4b5` for full details.

## Phase 2 Recap (previously approved)

T4 (extractAndStorePid), T5 (tryKillPid + kill-before-retry in executePrompt) — all correct and well-tested. See prior review commit `bbbac96` for full details.

## Phase 3 Review

### T6: Rolling inactivity timer — PASS

**SSH (`src/services/ssh.ts:123-160`):**
- `execCommand` signature adds `maxTotalMs?: number` as 4th optional param — backward compatible
- `resetInactivityTimer()` clears and recreates the timeout on every call. Called on both `stream.on('data')` (line 181) and `stream.stderr.on('data')` (line 195). Correct — timer resets on every data event, not just the first chunk
- Hard ceiling timer created only when `maxTotalMs !== undefined` (line 155). Never reset. Correct
- `settle()` clears both timers (lines 137-138). No timer leaks
- Both timers use `.unref()` to avoid keeping the process alive

**Local (`src/services/strategy.ts:84-117`):**
- Mirrors SSH implementation. `resetInactivityTimer()` called on both `child.stdout.on('data')` (line 129) and `child.stderr.on('data')` (line 144). Correct
- Hard ceiling timer only created when `maxTotalMs !== undefined` (line 112), never reset. Correct
- Local strategy calls `child.kill()` before rejecting on timeout (lines 104, 114) — necessary for spawned processes. Correct
- Minor: Local inactivity timer does not call `.unref()` (line 103) while SSH does (line 149). Not a bug since local commands are awaited, but a minor inconsistency. Non-blocking

**Interface (`AgentStrategy`, line 30):** Updated to `maxTotalMs?: number` as 3rd param. `RemoteStrategy` passes it through to `sshExecCommand` (line 43). Correct.

**Tests (`tests/unit/inactivity-timer.test.ts`):**
- Activity keeps alive: command outputs every 100ms with 3000ms inactivity timeout — completes normally. PASS
- True inactivity kills: `sleep 10` with 300ms timeout — rejects with `/inactivity/`. PASS
- Hard ceiling kills: output every 50ms (would never trigger 5000ms inactivity), `maxTotalMs=400` kills — rejects with `/max total time/`. PASS
- All three required scenarios covered with real `LocalStrategy` (not mocks). Good integration confidence

### T7: max_total_ms schema + threading — PASS

**Schema (`src/tools/execute-prompt.ts:23-32`):**
- `timeout_ms` description updated: "Inactivity timeout in milliseconds — the command is killed after this many ms without any stdout/stderr output". Correct
- `max_total_ms` added as `z.number().optional()` with description: "Hard ceiling in milliseconds — the command is killed after this total elapsed time regardless of activity. If omitted, there is no total time limit." Correct

**Threading (`src/tools/execute-prompt.ts:136-165`):**
- Both values extracted: `timeoutMs = input.timeout_ms ?? 300000`, `maxTotalMs = input.max_total_ms`. Correct
- Initial call (line 149): `strategy.execCommand(claudeCmd, timeoutMs, maxTotalMs)` — both passed. GOOD
- Stale-session retry (line 156): `strategy.execCommand(retryCmd, timeoutMs, maxTotalMs)` — both passed. GOOD
- Server-error retry (line 165): `strategy.execCommand(retryCmd, timeoutMs, maxTotalMs)` — both passed. GOOD

**Backward compatibility:** When `max_total_ms` is not provided, `maxTotalMs` is `undefined`, which flows through to the `if (maxTotalMs !== undefined)` guard in both SSH and Local strategies, skipping hard-ceiling creation. Existing callers behave identically to before. Correct.

**No regression in `execute-command.ts`:** Only passes `timeout_ms` (lines 200, 223), does not expose `max_total_ms`. `executeCommandSchema` unchanged. Correct.

### Observation (non-blocking)

No test in `execute-prompt.test.ts` explicitly passes `max_total_ms` and asserts it reaches the mock's 3rd argument across all 3 `execCommand` calls. The threading is correct by code inspection but not test-covered. Consider adding a test for completeness in a future pass.

## Verification Checklist

| # | Check | Result |
|---|-------|--------|
| 1 | Inactivity timer resets on every data event (not just first chunk) | PASS |
| 2 | Hard ceiling (maxTotalMs) never resets regardless of activity | PASS |
| 3 | Both SSH and Local strategies updated with identical semantics | PASS |
| 4 | Tests cover: activity keeps alive, inactivity kills, hard ceiling kills | PASS |
| 5 | `timeout_ms` schema description updated to "inactivity timeout" | PASS |
| 6 | `max_total_ms` added as optional with no-limit default | PASS |
| 7 | Both values threaded through ALL 3 execCommand calls (initial + 2 retries) | PASS |
| 8 | Backward compat — callers without `max_total_ms` behave identically | PASS |
| 9 | No regression in execute_command or existing execute_prompt tests | PASS |
| 10 | `npm run build` clean | PASS |
| 11 | `npm test` — 907 passed, 6 skipped, 0 failures | PASS |

## End-to-End Coherence (Phases 1 + 2 + 3)

The full chain for issues #147 and #160 is now complete:

1. **T1** wraps the LLM command in a PID-capture shell wrapper that emits `FLEET_PID:<pid>` as the first stdout line
2. **T3** ensures `buildAgentPromptCommand` applies this wrapper for all providers
3. **T4** intercepts `execCommand` output, parses the PID line, stores it, and strips it from stdout
4. **T2** provides the `killPid` command interface and in-memory PID store
5. **T5** uses `tryKillPid` to clean up zombie processes before new prompts and before retries
6. **T6** replaces wall-clock timeout with rolling inactivity timer + optional hard ceiling in both SSH and Local strategies
7. **T7** exposes both timeout controls in `executePromptSchema` and threads them through all execution paths

No gaps identified. The implementation is minimal, focused, and correctly scoped.

## Verdict

**APPROVED** — Phases 1, 2, and 3 are all correct, backward-compatible, and well-tested. The sprint's session lifecycle improvements (PID capture → kill → inactivity timer → hard ceiling) form a coherent whole.
