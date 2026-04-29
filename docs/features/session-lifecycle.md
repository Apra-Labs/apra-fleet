# Session Lifecycle — PID Registry, Activity Timeout, and Cancellation

Covers the design decisions behind three related features shipped in Sprint 1:

- **#147** — Kill previous agent instances before a new session
- **#160** — Activity-aware (rolling inactivity) timeout
- **#148** — Background agent cancellation via `stop_prompt`

---

## Problem These Features Solve

`execute_prompt` can be called while a previous LLM process is still running on the member machine. Before Sprint 1 this produced silent zombie processes — up to three per call (initial + two internal retries) — because:

1. Each retry in `executePrompt` called `strategy.execCommand` without killing the previous process.
2. `result.code` reflects the SSH/local exec exit code, not the LLM process exit code. Any network blip or SSH timeout causes a non-zero code, triggering the retry path even when the LLM is still alive and running.

Observed impact: five LLM processes running concurrently on one member, all doing conflicting work against the same resources.

---

## Shell Wrapper — PID Capture (#147)

### Design decision

PID capture happens at the OS command layer (`buildAgentPromptCommand`), not inside the provider adapter. This keeps it provider-agnostic: the wrapper wraps whatever command a provider builds, without requiring each provider to know about PID tracking.

**Unix wrapper:**
```bash
{ <provider-cmd>; } & _fleet_pid=$!; printf 'FLEET_PID:%s\n' "$_fleet_pid"; wait "$_fleet_pid"; exit $?
```
The backgrounded process emits its PID to stdout immediately via `printf` before the LLM produces any output, then `wait` blocks until it exits and propagates its exit code.

**Windows wrapper (PowerShell):**
```powershell
$p = Start-Process ... -PassThru -NoNewWindow -Wait:$false
Write-Host "FLEET_PID:$($p.Id)"
$p.WaitForExit()
exit $p.ExitCode
```

### Why this approach

The PID line must arrive on stdout **before** the LLM produces any output — this was validated as the riskiest assumption in Task 1. The backgrounded-then-waited Unix pattern guarantees ordering because the `echo` runs synchronously in the outer shell before `wait` yields control to the child.

The alternative — writing the PID to a side-channel file — was ruled out because it requires coordination on both write and read timing. The alternative of using stderr was viable but complicates output handling.

---

## In-Memory PID Store (#147)

### Design decision

PIDs are stored in a `Map<string, number>` keyed by agent ID, scoped to the fleet server process lifetime (`src/utils/agent-helpers.ts`).

```
_activePids: Map<agentId → pid>
```

Three operations: `getStoredPid`, `setStoredPid`, `clearStoredPid`.

### Why in-memory, not persisted

The `Agent` type includes an `activePid?: number` field defined for type purposes, but the runtime store is in-memory only. The rationale:

- A PID is only meaningful on the machine that spawned the process. Persisted PIDs that survive a fleet server restart refer to processes that may no longer exist or may have been reassigned by the OS.
- In-memory semantics are correct: if the fleet server restarts, the previous LLM process either finished or is now unreachable. There is nothing to kill.
- Persistence would add complexity (registry writes, stale-PID cleanup on startup) with no benefit.

The `activePid` field on `Agent` is a type-level remnant from early design; the authoritative store is `_activePids` in `agent-helpers.ts`.

### Kill-before-spawn

`tryKillPid` is called at two points in `executePrompt`:

1. **At call entry** — before writing the prompt file, kill any PID stored from a previous call.
2. **Before each retry** — kill the stored PID before spawning the retry command.

`tryKillPid` is non-blocking and swallows "process not found" errors. Kill commands:
- Unix: `kill -9 <pid>`
- Windows: `taskkill /F /T /PID <pid>`

---

## Rolling Inactivity Timer (#160)

### Design decision

`timeout_s` was resemanticised from a hard wall-clock deadline to an **inactivity timeout** — the process is killed only when no stdout/stderr output has arrived for `timeout_s` seconds.

The implementation is Option 1 (rolling `lastActivityAt` timestamp) rather than Option 2 (tool-call awareness). Each `data` event on the stream resets `lastActivityAt`. The watchdog fires when `now - lastActivityAt > timeout_s * 1000`.

### Why not tool-call awareness

Tool-call awareness (Option 2) would require parsing the streaming JSON event types to detect when a tool call is in flight. This is significantly more complex and requires the fleet server to understand provider-specific streaming formats. The rolling timer is simpler, more robust, and sufficient for the primary use case: preventing kills during long builds or test runs where the LLM is still producing output.

Limitation: a blocking tool call that produces no output (no tokens flowing during tool execution) is treated as inactivity. This is an acceptable trade-off; the `max_total_s` ceiling handles runaway sessions.

### The `max_total_s` ceiling

An optional second timer, `max_total_s`, provides a hard ceiling that is **never reset** regardless of activity. Use cases:
- Preventing runaway sessions that continuously produce output
- Budget enforcement for token-intensive tasks

If `max_total_s` is omitted, there is no total time limit — only inactivity kills apply.

### Backward compatibility

Callers that set only `timeout_s` behave identically to before (activity-based kill, no ceiling). The new default is: inactivity timeout with no ceiling.

---

## Cancellation via `stop_prompt`

`stop_prompt` kills the LLM process running **on the member machine** (the process tracked in the PID registry) and clears the PID store. It does not directly terminate the local Claude Code background agent that dispatched the work.

The next `execute_prompt` call after a `stop_prompt` proceeds immediately — there is no interlock or error gate. Always follow `stop_prompt` with `resume=false` to start a fresh session, since session state after a kill is unreliable.

If the background agent is in a retry loop (stale-session or server-overload retry), the retry may still fire after the kill — whether it does depends on the exit code and error text of the killed process. In practice a kill produces empty stdout/stderr, which is not classified as a retriable error, so retries do not fire.
