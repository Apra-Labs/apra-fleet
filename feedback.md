# Cumulative Review — Sprint 1 (Phase 1 + Phase 2)

**Reviewer:** Claude (sprint review agent)
**Date:** 2026-04-23
**Branch:** sprint/session-lifecycle-oob-fix
**Verdict:** APPROVED

## Phase 1 Recap (previously approved)

T1 (PID wrapper), T2 (killPid interface + PID store), T3 (buildAgentPromptCommand wraps all providers) — all correct and well-tested. See prior review commit `8e0d4b5` for full details.

## Phase 2 Review

### T4: extractAndStorePid — PASS

**Location:** `src/services/strategy.ts:15-23`

Implementation correctly:
- Scans stdout line-by-line for `FLEET_PID:\d+` using `findIndex` — not just first line, handles truncation headers or other output before the PID line
- Strips `\r` for Windows CRLF compatibility
- Calls `setStoredPid` immediately on detection
- Removes the PID line from stdout via `splice` so `parseResponse` never sees it
- Returns original result object unchanged when no PID line is present (identity fast path)
- Integrated into both `RemoteStrategy.execCommand` (line 43-44) and `LocalStrategy.execCommand` (line 84, 112) — all exec traffic goes through extraction

**Test coverage:** 7 unit tests in `tests/unit/pid-extraction.test.ts` — stores PID, strips line, no-op without PID, CRLF handling, non-first-line PID, preserves stderr/code, empty stdout. Thorough.

### T5: tryKillPid + executePrompt integration — PASS

**Location:** `src/utils/pid-helpers.ts` (22 lines), `src/tools/execute-prompt.ts` (6 lines added)

`tryKillPid`:
- Guards on `getStoredPid` returning undefined — no-ops cleanly for agents without a stored PID
- Clears PID from store BEFORE issuing kill — correct order to prevent double-kill if another call races
- 5000ms timeout on kill command — sensible; won't block the prompt for long
- Errors swallowed — kill targets may already be dead, unreachable, or the PID recycled

`executePrompt` integration:
- Kill fires at TOP (line 138), before `writePromptFile` — catches zombie processes from crashed/timed-out prior calls
- Kill fires before stale-session retry (line 152) — prevents overlapping sessions
- Kill fires before server-error retry (line 160) — same rationale
- `clearStoredPid` on success (line 173) — cleans up after normal completion

**Test coverage:** 4 tests in `tests/execute-prompt.test.ts` `kill-before-retry` describe block — kill issued as first execCommand call, PID cleared on success, no kill when no PID stored, kill uses short 5000ms timeout. All meaningful assertions on mock call order and arguments.

### Observation (non-blocking)

On the terminal failure path (line 167-168, `result.code !== 0` after all retries exhausted), the PID is not explicitly cleared. The process has already exited at that point (execCommand completed), so the stored PID is stale. This is harmless — the next `tryKillPid` at the top of a future call will attempt to kill a dead PID, fail silently, and clear it. No action needed, but worth noting for future maintainers.

## Verification Checklist

| # | Check | Result |
|---|-------|--------|
| 1 | FLEET_PID line parsed and stripped from stdout before parseResponse | PASS |
| 2 | PID stored immediately on detection | PASS |
| 3 | Works for both SSH (Remote) and Local strategies | PASS |
| 4 | Kill fires at top of executePrompt, before writePromptFile | PASS |
| 5 | Kill fires before each retry (stale session + server error) | PASS |
| 6 | tryKillPid is non-blocking — errors swallowed | PASS |
| 7 | PID cleared on kill and on successful completion | PASS |
| 8 | No regression — sessions without stored PID work as before | PASS |
| 9 | Phase 1 + Phase 2 form coherent end-to-end implementation of #147 | PASS |
| 10 | `npm run build` clean | PASS |
| 11 | `npm test` — 904 passed, 6 skipped (platform-gated), 0 failures | PASS |

## End-to-End Coherence (Phase 1 + Phase 2)

The full chain for issue #147 is now complete:

1. **T1** wraps the LLM command in a PID-capture shell wrapper that emits `FLEET_PID:<pid>` as the first stdout line
2. **T3** ensures `buildAgentPromptCommand` applies this wrapper for all providers
3. **T4** intercepts `execCommand` output, parses the PID line, stores it, and strips it from stdout
4. **T2** provides the `killPid` command interface and in-memory PID store
5. **T5** uses `tryKillPid` to clean up zombie processes before new prompts and before retries

No gaps identified. The implementation is minimal, focused, and correctly scoped.

## Verdict

**APPROVED** — Phase 2 implementation is correct, well-tested, and integrates cleanly with Phase 1. The sprint's core PID lifecycle (capture → store → kill → clear) is complete and ready for V2 verification.
