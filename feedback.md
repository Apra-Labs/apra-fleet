# Phase 1 Review — Sprint 1 Session Lifecycle OOB Fix

**Reviewer:** Claude (sprint review agent)
**Date:** 2026-04-23
**Branch:** sprint/session-lifecycle-oob-fix
**Verdict:** APPROVED

## Scope Reviewed

- T1: PID-capture shell wrapper helpers + validation tests
- T2: killPid interface + implementations + activePid type + PID store helpers
- T3: buildAgentPromptCommand wraps all providers with PID wrapper

## Verification Checklist

| # | Check | Result |
|---|-------|--------|
| 1 | PID wrapper emits `FLEET_PID:<pid>` as FIRST stdout line before LLM output | PASS — Unix backgrounds `{ cmd; } &`, prints PID, then waits; Windows `Write-Output` before command. Execution tests confirm first-line contract. |
| 2 | killPid correct per platform | PASS — Linux `kill -9`, Windows `taskkill /F /T /PID`, macOS inherits Linux via class extension |
| 3 | `activePid` typed as optional number on Agent | PASS — `activePid?: number` in types.ts |
| 4 | PID store helpers use in-memory Map (not registry/disk) | PASS — transient `Map<string, number>`, correct for OS-scoped PIDs |
| 5 | Tests are meaningful, not smoke tests | PASS — execution tests (actual shell runs), string structure checks, exit code propagation, edge cases (no-op clear, overwrite) |
| 6 | `npm run build && npm test` pass | PASS — 52 test files, 893 passed, 6 skipped (platform-gated), 0 failures |

## Implementation Notes

**PID wrapper (Unix):** `{ ${cmd}; } & _fleet_pid=$!; printf 'FLEET_PID:%s\n' "$_fleet_pid"; wait "$_fleet_pid"; exit $?` — backgrounds the inner command, captures `$!`, prints PID immediately (before any LLM output), then waits and propagates exit code. Correct.

**PID wrapper (Windows):** `Write-Output "FLEET_PID:$PID"; ${cmd}` — synchronous execution, `$PID` is the PowerShell session PID (the killable handle). Correct for Windows model.

**killPid interface:** Clean addition to `OsCommands`, returns shell command string consistent with all other methods in the interface.

**PID store:** In-memory Map with get/set/clear helpers. Architecturally correct — PIDs are ephemeral and must not survive server restart. Tests cover happy path, overwrite, clear, and no-op clear.

**Test quality:** 21 tests in pid-wrapper.test.ts (2 platform-skipped), 5 PID store tests in agent-helpers.test.ts, 3 integration assertions in platform.test.ts. Tests validate runtime behavior (actual shell execution), not just string matching.

## Issues Found

None.

## Verdict

**APPROVED** — Phase 1 implementation is correct, well-tested, and ready to build on.
