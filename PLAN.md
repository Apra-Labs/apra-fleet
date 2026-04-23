# Sprint 1: Session Lifecycle + OOB Auth Fix — Implementation Plan

> Fix execute_prompt's zombie-process problem (#147), add activity-aware timeouts (#160), add background-agent cancellation (#148), and fix misleading OOB auth errors on SSH/headless terminals (#106).

**Branch:** `sprint/session-lifecycle-oob-fix`
**Base:** `main`
**Issues:** #147, #160, #148, #106

---

## Tasks

### Phase 1: PID Capture Foundation (#147 — Steps 1–2)

#### Task 1: Validate PID-capture shell wrapper on Unix and Windows
- **Change:** Write a standalone test script that validates the shell wrapper emits `FLEET_PID:<pid>` to stdout before the wrapped command produces any output. Test both Unix (`cmd & echo FLEET_PID:$!; wait $!`) and Windows PowerShell (`Start-Process -PassThru`). This is the riskiest assumption — if PID isn't first on stdout, the entire approach fails.
- **Files:** `src/os/linux.ts`, `src/os/windows.ts`, `tests/unit/pid-wrapper.test.ts` (new)
- **Tier:** cheap
- **Done when:** Unit tests confirm: (a) `FLEET_PID:\d+` appears as the first line of stdout, (b) the wrapped command's own stdout follows after the PID line, (c) exit code of the wrapper matches the inner command's exit code — on both Unix and Windows wrapper formats.
- **Blockers:** If stdout buffering delays the PID line past LLM output, we need to switch to stderr or a side-channel file.

#### Task 2: Add `killPid` to OsCommands interface + implementations
- **Change:** Add `killPid(pid: number): string` to the `OsCommands` interface. Linux/macOS: `kill -9 <pid>`. Windows: `taskkill /F /PID <pid>`. Add `activePid?: number` to the `Agent` type. Add `getStoredPid`, `setStoredPid`, `clearStoredPid` helpers to `agent-helpers.ts`.
- **Files:** `src/os/os-commands.ts`, `src/os/linux.ts`, `src/os/macos.ts`, `src/os/windows.ts`, `src/types.ts`, `src/utils/agent-helpers.ts`
- **Tier:** cheap
- **Done when:** `killPid` returns correct platform command strings. `Agent` type includes `activePid`. PID helpers read/write from registry. Unit tests pass for all three.

#### Task 3: Wrap provider commands with PID-announcing shell wrapper
- **Change:** Modify `buildAgentPromptCommand` in `linux.ts`, `macos.ts`, and `windows.ts` to wrap the provider command in the PID-capture shell wrapper. Unix: `<provider-cmd> & echo "FLEET_PID:$!"; wait $!; exit $?`. Windows: PowerShell `Start-Process` wrapper that emits `FLEET_PID:<id>` then `WaitForExit()`. The wrapper must be provider-agnostic — it wraps whatever command the provider builds.
- **Files:** `src/os/linux.ts`, `src/os/macos.ts`, `src/os/windows.ts`
- **Tier:** standard
- **Done when:** `buildAgentPromptCommand` output for all providers includes the PID wrapper. Existing tests still pass. Manual inspection confirms wrapper syntax is correct for each OS.

#### VERIFY: Phase 1 — PID Capture Foundation
- Run `npm run build && npm test`
- Confirm: PID wrapper emits PID first on both OS families, `killPid` commands are correct, `Agent` type compiles, PID helpers work
- Report: tests passing, any regressions, any issues found

---

### Phase 2: PID Streaming + Kill-Before-Retry (#147 — Steps 3–4)

#### Task 4: Stream stdout in `execCommand` and parse PID line
- **Change:** Modify both `RemoteStrategy.execCommand` (SSH path in `src/services/ssh.ts`) and `LocalStrategy.execCommand` (`src/services/strategy.ts`) to detect the `FLEET_PID:<pid>` line from stdout during streaming. On detection: call `setStoredPid(agentId, pid)`. Strip the PID line from the returned `stdout` so downstream consumers (provider `parseResponse`) don't see it. Both strategies already stream stdout via `data` events — this adds a line-scan on the first chunk. Requires passing `agentId` through to `execCommand` (add optional param or callback).
- **Files:** `src/services/ssh.ts`, `src/services/strategy.ts`, `src/types.ts` (if `SSHExecResult` needs `pid` field)
- **Tier:** standard
- **Done when:** After `execCommand` returns, `getStoredPid(agentId)` returns the captured PID. The PID line is stripped from `stdout`. Existing `parseResponse` tests still pass (no unexpected prefix in stdout).

#### Task 5: Kill stored PID before retries and at start of new `executePrompt`
- **Change:** In `executePrompt` (`src/tools/execute-prompt.ts`): (1) At the top, before `writePromptFile`, kill any stored PID for this agent. (2) Before each retry (`strategy.execCommand(retryCmd, ...)`), kill the stored PID. Use `tryKillPid(agent, pid)` which runs `strategy.execCommand(cmds.killPid(pid))` with a short timeout, swallowing errors. Clear stored PID after kill. Clear stored PID on successful completion.
- **Files:** `src/tools/execute-prompt.ts`, `src/utils/agent-helpers.ts` (add `tryKillPid`)
- **Tier:** standard
- **Done when:** `executePrompt` kills previous PID before every spawn. Unit test confirms: mock a stored PID → call `executePrompt` → verify `killPid` command was issued before the new command. PID is cleared on success.

#### VERIFY: Phase 2 — PID Kill-Before-Retry
- Run `npm run build && npm test`
- Confirm: PID streaming works end-to-end (captured, stored, stripped), kill-before-retry fires correctly, no regressions in existing execute_prompt behavior
- Report: tests passing, any regressions, any issues found

---

### Phase 3: Activity-Aware Timeout (#160)

#### Task 6: Implement rolling inactivity timer in stream watchdog
- **Change:** Replace the hard wall-clock timeout in both SSH and local `execCommand` with a rolling inactivity timer. Each `data` event on stdout or stderr resets a `lastActivityAt` timestamp. The timeout fires only when `now - lastActivityAt > timeoutMs`. Add `max_total_ms` support as a separate hard ceiling timer that is never reset. Update `ExecutePromptInput` schema to add `max_total_ms?: number`.
- **Files:** `src/services/ssh.ts`, `src/services/strategy.ts`, `src/tools/execute-prompt.ts` (schema + pass-through), `src/types.ts`
- **Tier:** standard
- **Done when:** Unit test: a command that emits output every 200ms with a 500ms inactivity timeout runs to completion (not killed). A command that goes silent for >500ms is killed. `max_total_ms` kills regardless of activity. Schema updated.

#### Task 7: Update execute_prompt schema description and pass `max_total_ms`
- **Change:** Update the `timeout_ms` description in `executePromptSchema` to say "inactivity timeout" instead of "timeout". Add `max_total_ms` optional param. Pass both values through to `strategy.execCommand`. Update any documentation strings.
- **Files:** `src/tools/execute-prompt.ts`
- **Tier:** cheap
- **Done when:** Schema reflects new semantics. `max_total_ms` is accepted and forwarded. Existing callers that don't pass `max_total_ms` behave identically to before (unlimited total time, inactivity-based kill).

#### VERIFY: Phase 3 — Activity-Aware Timeout
- Run `npm run build && npm test`
- Confirm: inactivity timer resets on output, hard ceiling works, backward compatibility preserved
- Report: tests passing, any regressions, any issues found

---

### Phase 4: Background Agent Cancellation (#148)

#### Task 8: Add `stop_agent` tool to fleet-mcp server
- **Change:** Create `src/tools/stop-agent.ts` exposing a `stop_agent` MCP tool. Input: `member_id` or `member_name`. Logic: look up stored PID for the member via `getStoredPid`, issue `tryKillPid`, clear stored PID, return status. If no PID stored, return "no active session". Register the tool in the MCP server tool list.
- **Files:** `src/tools/stop-agent.ts` (new), `src/server.ts` or tool registry (to register the new tool)
- **Tier:** standard
- **Done when:** `stop_agent` tool is callable via MCP. Unit test: mock a stored PID → call `stop_agent` → verify kill issued and PID cleared. Calling `stop_agent` when no PID exists returns a clean no-op message.

#### Task 9: Prevent stopped agents from re-dispatching
- **Change:** Add a `stopped` flag to the agent's runtime state (not persisted — only lives during the server process). When `stop_agent` is called, set the flag. In `executePrompt`, check the flag at entry — if set, return an error message like "Agent was stopped by PM. Clear with a new execute_prompt call." The flag is cleared on the next successful `execute_prompt` start (after the kill-previous-PID step).
- **Files:** `src/tools/execute-prompt.ts`, `src/tools/stop-agent.ts`, `src/utils/agent-helpers.ts`
- **Tier:** cheap
- **Done when:** After `stop_agent`, subsequent `execute_prompt` calls return the stopped message without spawning. A fresh `execute_prompt` with explicit intent clears the flag.

#### VERIFY: Phase 4 — Background Agent Cancellation
- Run `npm run build && npm test`
- Confirm: stop_agent kills active session, prevents re-dispatch, clears on fresh start
- Report: tests passing, any regressions, any issues found

---

### Phase 5: OOB Auth SSH/Headless Fix (#106)

#### Task 10: Add display-presence detection helpers
- **Change:** Add `hasGraphicalDisplay()` (Linux: checks `$DISPLAY` or `$WAYLAND_DISPLAY`) and `hasInteractiveDesktop()` (Windows: checks `$SESSIONNAME === 'Console'`) to `auth-socket.ts`. These are simple env-var checks.
- **Files:** `src/services/auth-socket.ts`
- **Tier:** cheap
- **Done when:** Unit tests confirm: `hasGraphicalDisplay()` returns false when both env vars are unset, true when either is set. `hasInteractiveDesktop()` returns false when `SESSIONNAME` is not `Console`.

#### Task 11: Skip GUI terminal on headless, show actionable instructions
- **Change:** In `launchAuthTerminal`, before attempting GUI terminal emulators on Linux, check `hasGraphicalDisplay()`. If false, return a fallback message with: (1) `! apra-fleet auth <actual-member-name>` as the preferred action, (2) second-terminal instructions as fallback. On Windows, check `hasInteractiveDesktop()` — if false, skip `cmd.exe start /wait` and return the same style of fallback. The member name is already available as the `memberName` parameter.
- **Files:** `src/services/auth-socket.ts`
- **Tier:** cheap
- **Done when:** On SSH/Linux with `$DISPLAY` unset: no "cancelled" error, shows `! apra-fleet auth <name>` with actual member name. On SSH/Windows (`SESSIONNAME` ≠ `Console`): same. On GUI desktop: unchanged behavior. Unit tests cover all three environments.

#### VERIFY: Phase 5 — OOB Auth Fix
- Run `npm run build && npm test`
- Confirm: headless detection works, fallback messages include actual member name, GUI path unchanged
- Report: tests passing, any regressions, any issues found

---

### Phase 6: Integration Tests

#### Task 12: Integration test — PID lifecycle
- **Change:** Write an integration test that: (1) calls `executePrompt` with a simple command, (2) verifies PID was captured and stored, (3) calls `executePrompt` again for the same member, (4) verifies the first PID was killed before the second command ran, (5) verifies PID is cleared after successful completion.
- **Files:** `tests/integration/pid-lifecycle.test.ts` (new)
- **Tier:** standard
- **Done when:** Test passes. Covers the full spawn → store → kill → re-spawn → clear cycle.

#### Task 13: Integration test — inactivity timeout + cancellation + OOB fallback
- **Change:** Write integration tests for: (1) Activity-aware timeout: a command with periodic output survives past `timeout_ms` wall-clock, a silent command is killed after `timeout_ms` inactivity. (2) Cancellation: `stop_agent` terminates an active session and prevents re-dispatch. (3) OOB SSH fallback: with `DISPLAY` unset, `launchAuthTerminal` returns actionable instructions, not "cancelled".
- **Files:** `tests/integration/session-lifecycle.test.ts` (new)
- **Tier:** standard
- **Done when:** All three integration tests pass. No regressions in existing test suite.

#### VERIFY: Phase 6 — Integration Tests + Final
- Run `npm run build && npm test`
- Confirm: all integration tests pass, full test suite green, no regressions
- Report: final status, ready for review

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| PID line arrives after LLM output due to stdout buffering | High | Task 1 validates this assumption first. Fallback: write PID to a temp file and read it after spawn, or use stderr for the PID announcement. |
| Windows `Start-Process -PassThru` PID doesn't match the actual LLM process (wrapper vs. inner process) | High | Task 1 includes Windows-specific validation. Fallback: use `wmic` or `Get-Process` to find child PID. |
| Streaming stdout breaks `parseResponse` (PID line pollutes JSON output) | Medium | Task 4 strips PID line before returning stdout. Unit tests verify `parseResponse` receives clean JSON. |
| SSH `execCommand` streaming refactor introduces regressions | Medium | Changes are additive — existing buffering logic stays, PID detection is a scan over the first data chunk. Task 4 has verify checkpoint. |
| `stop_agent` can't reach background agent spawned by Claude Code framework | Medium | #148 targets the fleet-server-side PID (the LLM process on the member), not the local Claude Code background agent. If the local agent also needs stopping, TTL-based auto-expiry is the fallback (noted in Task 9). |
| Inactivity timer interacts badly with prompt-file writes (short silence between write and LLM start) | Low | The inactivity timer starts when `execCommand` is called, which is after `writePromptFile`. The first `data` event (PID line) resets the timer immediately. |
| `hasGraphicalDisplay()` false positive on X11 forwarding (DISPLAY set but no actual display) | Low | Acceptable — X11 forwarding implies the user has a display. If the terminal fails to launch, existing fallback logic catches it. |

## Notes
- Each task should result in a git commit
- Verify tasks are checkpoints — stop and report after each one
- Base branch: `main`
- Dependency order: Phase 1–2 (#147) → Phase 3 (#160) + Phase 4 (#148) → Phase 5 (#106, standalone) → Phase 6 (integration tests)
- Phase 5 (#106) has no dependencies and could be reordered earlier, but placing it after the core session-lifecycle work minimizes context switches
