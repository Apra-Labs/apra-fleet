# Requirements — Sprint 1: Session Lifecycle + Auth UX

## Sprint Overview

**Clusters:** A (Session Lifecycle) + D (Auth UX)
**Branch:** `sprint/session-lifecycle-oob-fix`
**Base branch:** `main`
**Repo:** Apra-Labs/apra-fleet

**Issues:** #147, #160, #148 (Cluster A — must ship together, high cohesion) + #106 (Cluster D — standalone hotfix)

**Dependency order within Cluster A:**
```
#147 (PID registry + kill) → #160 (activity-aware timeout uses streaming infra from #147)
                           → #148 (cancellation uses PID registry from #147)
```
#106 is independent — can be done in any order.

---

## Issue #147 — execute_prompt: kill previous agent instances before new session

**Source:** https://github.com/Apra-Labs/apra-fleet/issues/147
**Priority:** Critical (core reliability)

### Problem

When `execute_prompt` is called on a member, it can silently spawn multiple LLM processes that never terminate. Two compounding root causes:

**Root cause 1 — Internal retries don't kill the previous process (`src/tools/execute-prompt.ts` lines ~139–152)**

```typescript
// Retry 1: stale session
if (result.code !== 0 && input.resume && agent.sessionId) {
  result = await strategy.execCommand(retryCmd, timeoutMs); // spawns 2nd process
}

// Retry 2: server/overload error
if (result.code !== 0 && isRetryable(classifyError(stderr || stdout))) {
  result = await strategy.execCommand(retryCmd, timeoutMs); // spawns 3rd process
}
```

Each `execute_prompt` call can spawn up to 3 LLM processes. Neither retry kills the previous process before starting the next.

**Root cause 2 — SSH exit code ≠ LLM exit code**

`result.code` comes from `strategy.execCommand` (SSH exec), not from the LLM process. In all real failure modes:
- SSH drops mid-run → non-zero SSH exit, LLM still running on remote machine
- Process killed externally → SSH pipe closes, non-zero, LLM may be gone
- SSH timeout → SSH exits, LLM keeps running
- Network blip → non-zero SSH, LLM unaffected

The stale session retry fires on ANY non-zero SSH exit — including kills and network drops where the LLM is still alive. The retry spawns a 2nd process on top of a live one.

**Observed impact:** 5 LLM processes running simultaneously on `odm-ssdev`, all blocked in long-running `Bash` tool calls (`vstest` with no timeout), all running conflicting work against the same cameras.

### Implementation

**Step 1 — Capture PID at launch via shell wrapper in `buildAgentPromptCommand`**

The shell wrapper must announce the PID to stdout BEFORE the LLM does any work:

Unix:
```bash
claude -p "..." --output-format json --max-turns 80 & echo "FLEET_PID:$!"; wait $!; exit $?
```

Windows (PowerShell or cmd, depending on member OS):
```powershell
$p = Start-Process claude.exe -ArgumentList ("-p","...","--output-format","json",...) -PassThru -NoNewWindow -Wait:$false
Write-Host "FLEET_PID:$($p.Id)"
$p.WaitForExit()
exit $p.ExitCode
```

This is provider-agnostic — lives in the OS commands layer.

**Step 2 — Stream stdout in `execCommand`, parse PID line early**

`execCommand` must stream stdout rather than buffer it. On receiving a line matching `/^FLEET_PID:(\d+)$/`:
1. Extract PID
2. Persist to member registry (survives fleet server restart)
3. Continue reading stdout normally

**Step 3 — Kill stored PID before any retry (in `executePrompt`)**

```typescript
const prevPid = getStoredPid(agent.id);
if (prevPid) {
  await tryKillPid(agent, prevPid); // non-blocking, handles "not found" gracefully
  clearStoredPid(agent.id);
}
// now safe to spawn retry
result = await strategy.execCommand(retryCmd, timeoutMs);
```

`tryKillPid` uses `getOsCommands().killPid(pid)`:
- Unix: `kill -9 <pid>`
- Windows: `taskkill /F /PID <pid>`

Non-blocking — if process is already gone, no-op.

**Step 4 — Kill stored PID at start of every new `execute_prompt` call**

At the top of `executePrompt`, before writing the prompt file:
```typescript
const prevPid = getStoredPid(agent.id);
if (prevPid) {
  await tryKillPid(agent, prevPid);
  clearStoredPid(agent.id);
}
```

**Persistence:** PID stored in member registry (same store as `sessionId`, `tokenUsage`). Field name: `activePid?: number`. Cleared on kill and on normal exit.

### Files to change

| File | Change |
|------|--------|
| `src/os/os-commands.ts` | Add `killPid(pid)` to OS command interface + Unix/Windows implementations |
| `src/providers/claude.ts` (and other providers) | `buildPromptCommand` emits PID-announcing shell wrapper |
| `src/tools/execute-prompt.ts` | Kill stored PID before each retry and at start of new call; clear PID on success |
| `src/utils/agent-helpers.ts` | Add `getStoredPid` / `setStoredPid` / `clearStoredPid` helpers |
| `src/types.ts` | Add `activePid?: number` to `Agent` type |
| `src/services/strategy.ts` (SSH + local) | Stream stdout; parse and callback on `FLEET_PID:` line before returning |

### Acceptance criteria

- [ ] `execute_prompt` kills any previously-running LLM process for that member before starting a new session
- [ ] PID is captured from shell wrapper output before LLM does any work
- [ ] PID is persisted in member registry and survives fleet server restart
- [ ] Internal retries kill the previous process before spawning the next
- [ ] `tryKillPid` is non-blocking and handles "process not found" gracefully
- [ ] Works on both Unix and Windows members
- [ ] Unit tests for PID capture parsing and kill logic
- [ ] Integration test: spawn a process, call execute_prompt again, verify old process is gone

---

## Issue #160 — Activity-aware timeout for execute_prompt

**Source:** https://github.com/Apra-Labs/apra-fleet/issues/160
**Priority:** High
**Dependency:** Requires #147's streaming infrastructure (stdout is already being streamed to capture PID)

### Problem

The current `timeout_ms` is a hard wall-clock deadline. A member actively writing code, running tests, or making tool calls gets killed the moment the clock expires, regardless of progress. This causes:

- Legitimate long-running tasks silently killed mid-work
- Partial commits / incomplete states left on the member
- PM forced to detect failure, check what was done, and re-dispatch

Recent examples: fleet-dev stalled on Feature A and E dispatch — stream watchdog fired at 600s even though the member had already done meaningful work (commits were found on the branch after the "failure").

### Desired behaviour

`timeout_ms` should mean **inactivity for X milliseconds**, not total elapsed time.

- Member's agent is actively producing output (tool calls, text, results) → keep session alive
- Member goes silent for `timeout_ms` with no new activity → kill
- Optional hard ceiling `max_total_ms` for tasks that must not run forever

### Implementation

**Option 2 — Tool-call awareness (preferred)**

When the member invokes a tool (detectable from stream event type), reset the inactivity timer. Tool result arrival also resets it. Silence is only "inactivity" if no tool call is in flight.

This directly solves the `npm install` / long build problem (no tokens flowing while tool executes).

**Option 1 — Rolling inactivity timer (fallback if Option 2 is too complex)**

Reset a `lastActivityAt` timestamp every time a new chunk arrives on the stream. If `now - lastActivityAt > timeout_ms` → kill.

Limitation: doesn't handle blocking tool calls with no token flow.

**Proposed API change:**

```typescript
execute_prompt({
  prompt: "...",
  timeout_ms: 600000,       // inactivity timeout (current param, new semantics)
  max_total_ms: 3600000,    // hard ceiling (new, optional — default unlimited)
})
```

This is a fleet-server-level change — member agent is unaware. Enhancement of existing stream watchdog, not a replacement.

### Files to change

| File | Change |
|------|--------|
| `src/services/strategy.ts` | Modify stream watchdog: reset timer on each chunk (Option 1) or on tool call events (Option 2) |
| `src/tools/execute-prompt.ts` | Accept `max_total_ms`; pass both timeouts to strategy |
| `src/types.ts` | Add `max_total_ms?: number` to `ExecutePromptInput` |
| Tests | Unit tests for inactivity timer reset; integration test for extended session on activity |

### Acceptance criteria

- [ ] A session producing continuous output is not killed after `timeout_ms` wall-clock time
- [ ] A session that goes truly silent for `timeout_ms` IS killed (inactivity kill works)
- [ ] If `max_total_ms` is provided, session is killed after that regardless of activity
- [ ] Tool call events (if implemented as Option 2) reset the inactivity timer
- [ ] Existing `timeout_ms` semantics are preserved as inactivity timeout (backward compatible)
- [ ] Unit tests for the timer reset logic
- [ ] Documentation updated in execute_prompt schema description

---

## Issue #148 — Background agents: no cancellation mechanism

**Source:** https://github.com/Apra-Labs/apra-fleet/issues/148
**Priority:** High
**Dependency:** Requires #147 PID registry

### Problem

Once a background agent is launched via the `Agent` tool, there is no way to cancel it. The only interaction is `SendMessage` which resumes the agent — it cannot stop it.

Failure cascade:
1. A dispatch agent is launched but misbehaves (calls `execute_prompt` multiple times)
2. PM kills the fleet sessions to clean up
3. The misbehaving background agent is still alive locally, waiting for `execute_prompt` calls to time out
4. When those calls error out, the agent may retry — firing more `execute_prompt` calls against the same member
5. Two background agents point at the same member simultaneously — PM has no way to stop either

### Proposed fix

Add a `stop` capability to the fleet-mcp server that terminates a running background agent cleanly. Two implementation paths:

**Path A — Fleet-level `stop_agent` command (preferred)**

Add a `stop_agent` MCP tool that:
1. Looks up the background agent process spawned for a given member / task context
2. Sends a graceful stop signal (allow current tool call to complete)
3. Returns status

**Path B — TTL on background agents**

Background agents auto-expire after a configurable TTL. Fleet server tracks their spawned PIDs (already done by #147) and enforces TTL.

**Note:** The cancellation mechanism must not be confused with killing the LLM process on the member (that's #147). This issue is about stopping the PM-side background agent (the local Claude Code background agent that's dispatching work). However, #147's PID registry is the foundation — cancellation needs to know which PID to kill.

### Files to change

| File | Change |
|------|--------|
| `src/tools/` | Add `stop-agent.ts` (or extend execute-prompt.ts with stop=true semantics) |
| `src/services/agent-registry.ts` (new or existing) | Track active background agent PIDs |
| `src/types.ts` | Add agent stop/cancel types |
| Tests | Unit tests for stop signal delivery |

### Acceptance criteria

- [ ] PM can issue a stop signal to a running background agent
- [ ] Background agent stops after completing its current tool call (graceful stop, not hard kill)
- [ ] Stop is a no-op if the agent has already finished
- [ ] Fleet server exposes `stop_agent` tool (or equivalent mechanism)
- [ ] Agent that receives stop does not start new `execute_prompt` dispatches
- [ ] Unit tests for the stop mechanism

---

## Issue #106 — OOB password entry fails with misleading error on SSH/headless terminals

**Source:** https://github.com/Apra-Labs/apra-fleet/issues/106
**Priority:** High (user-facing bug, misleading error)
**Dependency:** None — standalone fix

### Problem

On Linux SSH sessions where `$DISPLAY` / `$WAYLAND_DISPLAY` is unset, `launchAuthTerminal` (`src/services/auth-socket.ts:334-441`) tries GUI terminal emulators in order: `gnome-terminal → xterm → x-terminal-emulator`. When a GUI terminal emulator is installed but `$DISPLAY` is unset, `which gnome-terminal` succeeds → spawn attempted → exits immediately → **misleading "❌ Password entry cancelled" error**, even though the socket mechanism works fine.

### What's broken vs. what works

| Environment | Current behavior | Expected |
|-------------|-----------------|---------|
| GUI desktop (`$DISPLAY` set) | Auto-launches terminal ✅ | — |
| SSH/headless, no terminal emulators | Correctly falls back ✅ | — |
| SSH/Linux, terminal emulators installed but `$DISPLAY` unset | "❌ Password entry cancelled" ❌ | Skip GUI, show actionable instructions |
| SSH/Windows | cmd.exe window on physical console, invisible to SSH user ❌ | Detect no interactive desktop, show instructions |

### UX: What should happen on SSH sessions

The UDS at `~/.apra-fleet/auth.sock` is a filesystem object — any process on the machine can reach it. No GUI needed.

**Preferred: `!` operator approach**
```
No graphical display detected. Run this in your current Claude Code session:
  ! apra-fleet auth <actual-member-name>
The password input is masked — the LLM will not see the value.
```

**Fallback: second terminal**
```
In a second terminal on this machine, run:
  apra-fleet auth <actual-member-name>
Then return here — the password will be received automatically.
```

**Key UX requirements:**
1. Substitute the actual member name (not a `<name>` placeholder) — system knows it at this point
2. `apra-fleet` must be in PATH (it is, same shell as Claude CLI)
3. No misleading "cancelled" error — current error implies user caused the failure

### Proposed code fix

Add display-presence check before attempting GUI terminal emulators:

```typescript
// Linux
function hasGraphicalDisplay(): boolean {
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

// Windows
function hasInteractiveDesktop(): boolean {
  return process.env.SESSIONNAME === 'Console';
}
```

In `launchAuthTerminal`: if no graphical display detected, skip GUI terminal emulator attempt and return fallback with:
- Actual member name substituted
- `! apra-fleet auth <name>` as the preferred action
- Second terminal as fallback

### Files to change

| File | Change |
|------|--------|
| `src/services/auth-socket.ts` | `launchAuthTerminal` function (~line 334–441): add display check, skip GUI on headless, return actionable instructions with actual member name |

### Acceptance criteria

- [ ] On SSH/Linux with `$DISPLAY` unset, even if terminal emulators are installed: shows `! apra-fleet auth <actual-member-name>` instructions, no "cancelled" error
- [ ] On SSH/Windows (SESSIONNAME ≠ 'Console'): shows instructions, does not open cmd.exe window
- [ ] On GUI desktop: behavior unchanged (auto-launches terminal as before)
- [ ] Actual member name is substituted in the instruction message (not placeholder)
- [ ] Preferred instruction is `! apra-fleet auth <name>` (single-terminal approach)
- [ ] Unit tests for `hasGraphicalDisplay()` and `hasInteractiveDesktop()` in various env configurations

---

## Riskiest Assumptions (front-loaded — validate in Task 1)

1. **PID capture timing (#147):** The shell wrapper must emit `FLEET_PID:<pid>` before the LLM produces any output. On some systems, stdout buffering may delay the PID line. Validate this assumption first — test the wrapper on both Windows and Unix to confirm PID arrives before LLM output.

2. **Provider command structure (#147):** Each provider (`claude.ts`, `gemini.ts`, etc.) builds its command differently. The shell wrapper must be applied correctly per-provider without breaking existing command construction. Risk: wrapper syntax incompatibilities across shells.

3. **Streaming compatibility (#147, #160):** `strategy.ts` may not currently support streaming stdout mid-command. Changing from buffered to streaming could affect existing behavior. Validate that streaming is additive and doesn't break non-streaming paths.

4. **Windows PID mechanism (#147):** `Start-Process -PassThru` on Windows gives an immediate PID but the process spawning mechanism differs between PowerShell and cmd. Test Windows path explicitly.

5. **`stop_agent` feasibility (#148):** The PM-side background agent is spawned by the Claude Code framework. Stopping it may require access to the framework's internal process management or SendMessage API. If Claude Code doesn't expose a stop mechanism, a TTL-based approach is the fallback.

---

## Out of Scope

- Cluster B, C, E, F issues — planned for Sprints 2-4
- The `update` flag for `execute_prompt` (#75) — Sprint 3
- Inter-fleet messaging (#152) — Sprint 3
- The partial OOB `{{secure.NAME}}` hint from `fix/credential-store-set-oob-bugs` branch — that partial fix can be checked and incorporated if not yet on main; focus is on the FULL #106 SSH/headless detection fix

---

## Integration Test Plan (reviewer to expand at merge-ready phase)

When the sprint reaches merge-ready state, the reviewer should produce an integration test plan covering:

1. **PID lifecycle (#147):** Start an execute_prompt, drop the SSH connection mid-run, re-call execute_prompt — verify old process killed and new one starts cleanly.
2. **Inactivity timeout (#160):** Dispatch a member with a long-running tool call (no token output during execution) — verify session is NOT killed during the tool call, IS killed after true inactivity.
3. **Cancellation (#148):** Launch a background agent, issue stop signal, verify it stops after current tool call.
4. **OOB SSH (#106):** On a headless environment (SSH session, $DISPLAY unset) — verify correct fallback message with actual member name, no "cancelled" error.
5. **Regression:** All 730+ existing tests must pass; existing execute_prompt behavior on clean sessions must be unchanged.
