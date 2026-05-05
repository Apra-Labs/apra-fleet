# #241 Stall Detector — Implementation Review

**Reviewer:** fleet-rev
**Date:** 2026-05-05
**Verdict:** APPROVED

> Clean, well-structured implementation that faithfully follows the plan and resilience doc — no `any` types, no direct fs access, no auto-kill, monitor_task untouched. All 27 tests pass.

---

## Phase 1: Foundation

### `log-path-resolver.ts` — PASS
- Correctly resolves Claude (`~/.claude/projects/<encoded>/<sessionId>.jsonl`) and Gemini (`~/.gemini/tmp/<project>/<sessionId>.jsonl`) paths.
- Claude project-path encoding uses `%2F`/`%5C` substitution with an appropriate TODO for live verification.
- Gemini uses last path segment as project name — reasonable default with a TODO for verification.
- Throws on unknown provider (fail-fast, no silent fallback).
- Accepts optional `homeDir` override for testability.

### `stall-detector.ts` — PASS
- `StallEntry` interface is fully typed — no `any`.
- Map keyed by `memberId` — one entry per member as required.
- `add()` logs warning on overwrite (defensive, per resilience doc).
- `update()` merges partial fields; logs warning on non-existent entry.
- `remove()` is idempotent — `Map.delete()` on absent key is a no-op, never throws.
- `start()`/`stop()` lifecycle: single `setInterval`, guards against double-start, `unref()` so timer doesn't keep process alive, `stop()` clears the map.
- Env vars `STALL_POLL_INTERVAL_MS` and `STALL_THRESHOLD_MS` read per-poll (runtime tunable).
- Singleton pattern matches IdleManager precedent.

### `read-log-tail.ts` — PASS
- Uses `getStrategy(agent).execCommand(cmd, 5000)` — no `fs.stat`/`fs.readFile`.
- Calls `logLine('stall_log_read', ...)` before each read — observable in fleet JSONL log.
- Windows vs POSIX branching: `powershell Get-Content -Tail 5` vs `tail -c 512`.
- Missing file: regex matches "No such file", "cannot access", "ItemNotFoundException" — returns `{ lastTimestamp: null }` (no error).
- Timeout/exception: caught, returns `{ lastTimestamp: null, error: msg }`.
- JSON parse failure on garbled output: caught, returns `{ lastTimestamp: null }`.

### Polling loop — PASS
- Provisional entries: skips log reading, checks baseline timeout only.
- Full entries: reads log tail, advances `lastActivityAt` only when timestamp is newer.
- `updateAgent()` called only when `lastActivityAt` actually changes (avoids unnecessary disk writes).
- Read failures: increments `consecutiveReadFailures`, warns at 3+, does NOT count as stall cycle.
- Null timestamp (file not created): does NOT count as stall cycle.
- Stall emission: only after `STALL_THRESHOLD_MS` exceeded since last activity.

---

## Phase 2: Integration

### `execute-prompt.ts` — PASS
- **Phase A (provisional add):** Immediately after `inFlightAgents.add()` (line 124), adds provisional entry with `sessionId: null`, `logFilePath: null`, `provisional: true`.
- **Phase B (upgrade):** After `parseResponse().sessionId` (line 230), calls `stallDetector.update()` with real `sessionId`, `logFilePath`, and `provisional: false`.
- **Finally block:** `stallDetector.remove(agent.id)` (line 272) covers ALL exit paths:
  - Normal exit (success)
  - Error exit / non-zero code
  - Inactivity timeout (timeout_s)
  - Hard ceiling timeout (max_total_s)
  - Process exits before sessionId arrives
  - Abort/cancellation
  - Stale session retry
  - Server overload retry
- `remove()` is idempotent — safe for double-remove from `stop_prompt` + `finally`.
- Early return before `inFlightAgents.add` (busy check at line 119) correctly avoids adding to stall list.

### `stop-prompt.ts` — PASS
- Calls `getStallDetector().remove(agent.id)` (line 29) immediately after killing PID.
- Positioned before the `inFlightAgents` poll loop — removal is instant, not deferred.

### `remove-member.ts` — PASS
- Calls `getStallDetector().remove(agent.id)` (line 122) after `removeFromRegistry()`.
- Idempotent — safe even if no active session exists.

### `src/index.ts` — PASS
- `stallDetector.start()` at line 253 (after server connect).
- `stallDetector.stop()` in both `SIGINT` and `SIGTERM` handlers (lines 266-267).
- Startup log includes `client=`, `version=`, `pid=`, `ppid=` (lines 255-258).
- In-memory map starts empty on restart — no stale entry resurrection.

---

## Phase 3: Surface

### `member-detail.ts` — PASS
- `lastLlmActivityAt` included in session object (line 159): `agent.lastLlmActivityAt ?? null`.
- `idleSecs` computed at read time (lines 170-171): `Math.round((Date.now() - new Date(...).getTime()) / 1000)`.
- `idleSecs` only present when session status is `busy` — not stored, derived. Correct per requirements.

### `check-status.ts` — PASS
- `AgentStatusRow` interface includes `lastLlmActivityAt?: string` (line 37).
- Field populated from `agent.lastLlmActivityAt` in `checkAgent()` (line 65).
- Present in JSON output via the `rows` array serialization.

### Integration tests — PASS (27/27 green)
- Full lifecycle: provisional add → upgrade on sessionId → remove on exit.
- `stop_prompt` double-remove idempotency.
- Member unregister removes entry.
- Process exit before sessionId — provisional removed cleanly.
- `member_detail` returns `lastLlmActivityAt` + `idleSecs` when busy, omits `idleSecs` when idle.
- `fleet_status` JSON includes `lastLlmActivityAt` per member.
- `updateAgent` persistence of `lastLlmActivityAt` verified.

---

## Cross-cutting concerns

| Concern | Status |
|---------|--------|
| No `any` types in new stall code | PASS — grep confirms zero matches in `src/services/stall/` |
| No direct `fs.stat`/`fs.readFile` in stall code | PASS — grep confirms zero matches |
| `monitor_task` untouched | PASS — no commits modify `src/tools/monitor-task.ts` on this branch |
| Stall detection is observational only (no auto-kill) | PASS — no kill/terminate/abort in stall service code |
| Resilience doc alignment | PASS — all 6 edge cases implemented as documented in `docs/stall-detector-resilience.md` |

---

## Summary

**Passed:** All three phases (Foundation, Integration, Surface) and all cross-cutting checks.

**No blocking changes required.**

**Deferred (known TODOs, acceptable — fail safely):**
- Claude project-path encoding (`%2F`/`%5C`) needs verification on a live system.
- Gemini log path structure needs verification on a live system.
- Both are documented with TODO comments and fail safely (return null timestamp → no false stall).

**Minor observation (non-blocking):**
- `src/index.ts:125` uses `any` for `capturedClientInfo` — this is pre-existing code outside the stall detector scope.
