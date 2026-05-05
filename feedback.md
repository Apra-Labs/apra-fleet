# #241 Stall Detector — Implementation Review

**Reviewer:** fleet-rev
**Date:** 2026-05-05
**Verdict:** APPROVED

> Clean, well-structured implementation that follows the plan and resilience doc faithfully. No blocking issues found.

---

## Phase 1: Foundation

### `log-path-resolver.ts` — PASS
- Correctly resolves Claude and Gemini log paths with appropriate TODO comments for unverified encoding.
- Claude path: `~/.claude/projects/<encoded>/<sessionId>.jsonl` with `/` → `%2F`, `\` → `%5C` encoding.
- Gemini path: `~/.gemini/tmp/<project-basename>/<sessionId>.jsonl`.
- Accepts optional `homeDir` override for testability.
- Throws on unknown provider — correct fail-fast behavior.

### `stall-detector.ts` — PASS
- `StallEntry` interface is fully typed (no `any`), all required fields present including `provisional` flag.
- Map keyed by `memberId` — single entry per member as required.
- `add()` is idempotent with overwrite + warning log.
- `update()` merges partial fields, warns on non-existent entry.
- `remove()` uses `Map.delete()` — idempotent no-op if absent.
- `start()`/`stop()` lifecycle correct: single `setInterval`, `.unref()` to avoid blocking exit, `stop()` clears both interval and Map.
- Singleton pattern via `getStallDetector()`.

### `read-log-tail.ts` — PASS
- Uses `getStrategy(agent).execCommand(cmd, 5000)` — no direct `fs.stat`/`fs.readFile`.
- Calls `logLine('stall_log_read', ...)` before each read — observable in fleet JSONL log.
- Windows vs POSIX branching: PowerShell `Get-Content -Tail 5` vs `tail -c 512`.
- Missing file detection via stderr regex matching (covers multiple OS error patterns).
- Timeout/exception caught and returned as `{ lastTimestamp: null, error }`.
- JSON parse failure handled gracefully (returns `null` timestamp, no throw).

### Polling loop — PASS
- Provisional entries: skips log reading, still checks baseline timeout → detects hangs before sessionId.
- Non-provisional: reads log, compares timestamp to `lastActivityAt`.
- Activity advanced → update entry + `updateAgent()` (only on change — avoids unnecessary disk I/O).
- Read error → increment `consecutiveReadFailures`, warn at 3, do NOT count as stall cycle.
- Null timestamp (file not created) → do NOT count as stall cycle.
- Stale timestamp → increment idle cycles, emit `stall_detected` if threshold exceeded.
- Env vars `STALL_POLL_INTERVAL_MS` / `STALL_THRESHOLD_MS` honored with correct defaults (15s / 120s).

---

## Phase 2: Integration

### `execute-prompt.ts` — PASS
- Two-phase add: provisional entry created at line 124 (immediately after `inFlightAgents.add`).
- Upgrade to full entry at line 230 when `parsed.sessionId` is available.
- `stallDetector.remove(agent.id)` in `finally` block (line 272) — covers ALL exit paths: success, error, timeout, abort, stale-session retry, server-overload retry.
- Early return before `inFlightAgents.add` (busy check at line 119) correctly avoids adding to stall list.

### `stop-prompt.ts` — PASS
- `getStallDetector().remove(agent.id)` called at line 29, immediately after kill.
- Idempotent — safe with execute_prompt's finally block also calling remove.

### `remove-member.ts` — PASS
- `getStallDetector().remove(agent.id)` called at line 122, after registry removal.
- Handles case where no active session exists (idempotent remove).

### `src/index.ts` — PASS
- `stallDetector.start()` at line 253 (after server connect).
- `stallDetector.stop()` in both SIGINT and SIGTERM handlers (line 266–267).
- MCP clientInfo + ppid logged in startup line (lines 255–258).
- In-memory list starts empty on server restart — no stale entry resurrection.

---

## Phase 3: Surface

### `member-detail.ts` — PASS
- `lastLlmActivityAt` included in session object (line 159): `agent.lastLlmActivityAt ?? null`.
- `idleSecs` computed at read time (line 170–171): `Math.round((Date.now() - new Date(...).getTime()) / 1000)`.
- `idleSecs` only present when session status is `busy` — correct per requirements.

### `check-status.ts` — PASS
- `AgentStatusRow` interface includes `lastLlmActivityAt?: string` (line 37).
- Field populated from `agent.lastLlmActivityAt` at line 65.
- Present in JSON output via the `rows` array serialization.

### Integration tests — PASS
- Covers full lifecycle: provisional add → upgrade → remove.
- `stop_prompt` double-remove idempotency tested.
- Member unregister removal tested.
- Process exit before sessionId tested.
- `member_detail` returns `lastLlmActivityAt` + `idleSecs` when busy, omits `idleSecs` when idle.
- `fleet_status` JSON includes `lastLlmActivityAt` per member.
- `updateAgent` persistence of `lastLlmActivityAt` verified.

---

## Cross-cutting concerns

| Concern | Status |
|---------|--------|
| No `any` types in new stall code | PASS — grep confirms zero matches in `src/services/stall/` |
| No direct `fs.stat`/`fs.readFile` in stall code | PASS — grep confirms zero matches |
| `monitor_task` untouched | PASS — no stall references, no commits on this branch modify it |
| Stall detection is observational only (no auto-kill) | PASS — no kill/terminate/abort in stall service code |
| Resilience doc alignment | PASS — all 6 edge cases documented and implementation matches decisions faithfully |

---

## Summary

**Passed:** All phases (Foundation, Integration, Surface) and all cross-cutting checks.

**No blocking changes required.**

**Minor observations (non-blocking, informational):**
1. The Claude project-path encoding (`%2F`/`%5C`) is marked with a TODO — correct approach given it needs live verification.
2. The Gemini path uses only the last path segment (`workFolder.split(/[\\/]/).pop()`) — also has a TODO, appropriate for unverified format.
3. `src/index.ts:125` uses `any` for `capturedClientInfo` — this is pre-existing code outside the stall detector scope, not new stall code.

**Deferred:** Path encoding verification for Claude and Gemini log paths (requires live system testing, documented as TODOs).
