# apra-fleet — Stall Detector Implementation Plan

> A single centralized `StallDetector` polling loop monitors all active `execute_prompt` sessions by reading provider JSONL conversation logs to compute real "last LLM activity" timestamps — replacing the current stdout-silence heuristic that false-positives on long tool calls.

## Exploration Findings

### Key Code Patterns
- **`inFlightAgents`** (`src/tools/execute-prompt.ts:91`): A `Set<string>` tracks active sessions; added at line 121, removed in finally at line 252.
- **Session ID**: Extracted from provider response (`parseResponse().sessionId`) and persisted via `touchAgent(agentId, sessionId)` at line 216.
- **`stop_prompt`** (`src/tools/stop-prompt.ts`): Kills PID, polls `inFlightAgents` for up to 2s, then unconditionally deletes from the set + clears statusline.
- **Statusline**: `writeStatusline(Map<agentId, status>)` persists to `statusline-state.json`; states are `busy | idle | offline | verify | blocked`.
- **Fleet log**: Custom JSONL via `LogScope` / `logLine()` in `src/utils/log-helpers.ts`.
- **Idle manager pattern** (`src/services/cloud/idle-manager.ts`): Uses `setIdleTouchHook()` to get called on every `touchAgent`. Good precedent for StallDetector integration.
- **Agent type** (`src/types.ts`): Has `sessionId?: string`, `lastUsed?: string`, `llmProvider?: LlmProvider`, `workFolder: string`.
- **No existing stall detection**: Only hard timeouts (timeout_s, max_total_s) exist.

### Provider Log Paths (from requirements + provider code)
- **Claude**: `~/.claude/projects/<project-path-encoded>/<sessionId>.jsonl`
- **Gemini**: `~/.gemini/tmp/<project>/<sessionId>.jsonl`

### Assumptions Verified
1. ✅ `sessionId` is available in-memory on the Agent after `touchAgent()` — confirmed at execute-prompt.ts:216
2. ✅ `inFlightAgents` Set reliably tracks active sessions — confirmed with 7 documented exit paths
3. ✅ `workFolder` is always present on Agent — required field in types.ts
4. ✅ `llmProvider` defaults to `'claude'` per comment in types.ts:27
5. ⚠️ **Log file path encoding**: Claude encodes the project path in the log directory name — exact encoding scheme (slash → dash? URL-encode?) needs verification on a live system
6. ⚠️ **Gemini log path**: `~/.gemini/tmp/<project>/<sessionId>.jsonl` — structure needs verification

### Constraints
- Tests use **vitest** (confirmed by imports in test files)
- Must not add N timers — one `setInterval` loop
- TypeScript strict — no `any`
- StallDetector hooks into execute_prompt lifecycle without modifying its core logic heavily

---

## Tasks

### Phase 1: Foundation — StallDetector Class & Log Path Resolver

#### Task 1: Log File Path Resolver
- **Change:** Create `src/services/stall/log-path-resolver.ts` exporting `resolveSessionLogPath(provider: LlmProvider, sessionId: string, workFolder: string, homeDir?: string): string`. Handles Claude and Gemini path conventions. Returns the expected JSONL log path.
- **Files:** `src/services/stall/log-path-resolver.ts` (new)
- **Tier:** cheap
- **Done when:** Function compiles, handles both providers, unit test passes with mocked paths
- **Blockers:** Claude's project-path encoding scheme — implement best-guess (replace `/` and `\` with URL-encode-style) with a TODO comment for verification

#### Task 2: StallEntry Type & StallDetector Class Skeleton
- **Change:** Create `src/services/stall/stall-detector.ts` with:
  - `StallEntry` interface: `{ sessionId, logFilePath, lastActivityAt: number, consecutiveIdleCycles: number, memberId, memberName }`
  - `StallDetector` class: `stallCheckList: Map<string, StallEntry>`, `add(memberId, entry)`, `remove(memberId)` (idempotent), `start()`, `stop()`, `getEntry(memberId)`
  - Singleton export pattern (like IdleManager)
- **Files:** `src/services/stall/stall-detector.ts` (new), `src/services/stall/index.ts` (barrel)
- **Tier:** cheap
- **Done when:** Class compiles, add/remove/double-remove work in unit test
- **Blockers:** None

#### Task 3: Polling Loop — Log File Stat Check
- **Change:** Implement `_poll()` method on StallDetector:
  - Iterates `stallCheckList`
  - For each entry: `fs.stat(logFilePath)` to get `mtime`
  - If `mtime > lastActivityAt` → update `lastActivityAt`, reset `consecutiveIdleCycles`
  - If idle for `STALL_THRESHOLD_MS` → emit stall event (log via `logWarn`)
  - Update `lastLlmActivityAt` on the member record via `updateAgent()`
  - Uses `setInterval(STALL_POLL_INTERVAL_MS)` — env vars: `STALL_POLL_INTERVAL_MS` (default 15000), `STALL_THRESHOLD_MS` (default 120000)
- **Files:** `src/services/stall/stall-detector.ts`
- **Tier:** standard
- **Done when:** Poll loop detects stall after threshold in unit test with fake timers
- **Blockers:** Log file may not exist yet at session start — handle gracefully (skip, don't count as stall)

#### Task 4: Unit Tests for StallDetector
- **Change:** Create `tests/stall-detector.test.ts` covering: add, remove, double-remove (no-op), poll with advancing mtime, poll with stale mtime triggering stall, poll with missing log file (no false stall), start/stop lifecycle
- **Files:** `tests/stall-detector.test.ts` (new)
- **Tier:** standard
- **Done when:** All tests pass via `npm test`
- **Blockers:** None

#### VERIFY: Phase 1
- [ ] `StallDetector` compiles with no `any` types
- [ ] Unit tests pass: add, remove, double-remove, stall detection, no false positive on missing file
- [ ] `resolveSessionLogPath` returns correct paths for claude and gemini providers
- [ ] Single `setInterval` — not per-member timers

---

### Phase 2: Integration — Hook into execute_prompt & stop_prompt Lifecycle

#### Task 5: Add `lastLlmActivityAt` to Agent Type
- **Change:** Add `lastLlmActivityAt?: string` (ISO 8601) to the `Agent` interface in `src/types.ts`
- **Files:** `src/types.ts`
- **Tier:** cheap
- **Done when:** Type compiles, no downstream type errors
- **Blockers:** None

#### Task 6: Hook StallDetector into execute_prompt
- **Change:** In `src/tools/execute-prompt.ts`:
  - After `inFlightAgents.add(agent.id)` + after sessionId is known (line ~216): call `stallDetector.add(agent.id, { sessionId, logFilePath, lastActivityAt: Date.now(), consecutiveIdleCycles: 0, memberId: agent.id, memberName: agent.friendlyName })`
  - In finally block (line ~252): call `stallDetector.remove(agent.id)`
  - Import stallDetector singleton
- **Files:** `src/tools/execute-prompt.ts`
- **Tier:** standard
- **Done when:** StallDetector entry created on session start, removed on session end (both normal exit and error)
- **Blockers:** Session ID is only known after the first successful response — add to stall check at that point, not at process spawn. Consider adding with partial info first (logPath computed from workFolder only) then updating when sessionId arrives.

#### Task 7: Hook StallDetector into stop_prompt
- **Change:** In `src/tools/stop-prompt.ts`, after killing the PID (line ~27): call `stallDetector.remove(agent.id)` — idempotent, so double-remove from both stop_prompt and execute_prompt's finally is safe.
- **Files:** `src/tools/stop-prompt.ts`
- **Tier:** cheap
- **Done when:** `stop_prompt` removes member immediately (doesn't wait for poll)
- **Blockers:** None

#### Task 8: Initialize StallDetector on Server Start
- **Change:** In the server startup path (wherever MCP server is initialized), call `stallDetector.start()`. On shutdown, call `stallDetector.stop()`.
- **Files:** `src/index.ts` or equivalent server entry point
- **Tier:** cheap
- **Done when:** StallDetector loop starts when server starts, stops cleanly on exit
- **Blockers:** Need to identify exact server lifecycle hooks

#### VERIFY: Phase 2
- [ ] Starting an execute_prompt adds member to stallCheckList
- [ ] Ending an execute_prompt removes member from stallCheckList
- [ ] `stop_prompt` removes member immediately
- [ ] Double-remove (stop_prompt then execute_prompt finally) doesn't crash
- [ ] StallDetector starts/stops with server

---

### Phase 3: Surface — Expose lastLlmActivityAt in Status Tools

#### Task 9: Surface `lastLlmActivityAt` in `member_detail`
- **Change:** In `src/tools/member-detail.ts`, include `lastLlmActivityAt` from the agent record in the returned JSON. Also compute and include `idleSecs` (time since lastLlmActivityAt) if the member is busy.
- **Files:** `src/tools/member-detail.ts`
- **Tier:** standard
- **Done when:** `member_detail` JSON response includes `lastLlmActivityAt` and `idleSecs` fields
- **Blockers:** None

#### Task 10: Surface `lastLlmActivityAt` in `fleet_status`
- **Change:** In `src/tools/check-status.ts` (fleet_status), include `lastLlmActivityAt` per member in JSON output.
- **Files:** `src/tools/check-status.ts`
- **Tier:** standard
- **Done when:** `fleet_status --format json` includes `lastLlmActivityAt` per member
- **Blockers:** None

#### Task 11: Surface stall info in `monitor_task`
- **Change:** In `src/tools/monitor-task.ts`, if the monitored task's member has a stall entry, include `lastLlmActivityAt` and `idleSecs` in the response.
- **Files:** `src/tools/monitor-task.ts`
- **Tier:** standard
- **Done when:** monitor_task response includes LLM activity info when available
- **Blockers:** Need to map taskId → memberId (check if this mapping exists)

#### Task 12: Integration Tests
- **Change:** Create `tests/stall-detector-integration.test.ts` — test the full lifecycle: mock execute_prompt adding to stallCheckList, poll cycle updating lastLlmActivityAt, stop_prompt removing, member_detail returning the field.
- **Files:** `tests/stall-detector-integration.test.ts` (new)
- **Tier:** premium
- **Done when:** Integration tests pass, covering acceptance criteria
- **Blockers:** None

#### VERIFY: Phase 3
- [ ] `member_detail` returns `lastLlmActivityAt` updated within last poll interval
- [ ] `fleet_status` includes `lastLlmActivityAt` per member
- [ ] Stall event logged when member idle > threshold
- [ ] No auto-kill — detection is observational only

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Claude project-path encoding unknown | Log file not found → no stall detection (but no false positive either) | Use `fs.stat` approach (file existence check); log warning if file not found; verify encoding on live system in Phase 1 |
| Gemini log path structure unverified | Same as above | Same mitigation; provider-specific resolver allows easy fix |
| Session ID only available after first response | Gap between process spawn and first poll where stall can't be detected | Add entry with `lastActivityAt = now` on spawn (uses process start as baseline); update logFilePath when sessionId arrives |
| Log file written infrequently by LLM (e.g. batched writes) | File mtime doesn't advance even though LLM is active → false stall | Use generous default threshold (120s); make it configurable; document that threshold should exceed typical tool-call duration |
| Remote members — log file is on remote host | Can't `fs.stat` a remote file directly | Phase 1 targets local members only; remote support requires SSH stat command — flag as future enhancement |
| `updateAgent()` writes to disk on every poll cycle | Disk I/O overhead with many members | Only write if `lastLlmActivityAt` actually changed; batch updates per poll cycle |

## Notes
- Base branch: main
- Implementation branch: feat/stall-detector
- Test framework: vitest
- Design uses `fs.stat` (mtime) rather than reading/parsing JSONL content — simpler, avoids file locking, and mtime advancing is sufficient signal of LLM activity
- StallDetector is observational only — logs events, never kills processes
- Env vars: `STALL_POLL_INTERVAL_MS` (default 15000), `STALL_THRESHOLD_MS` (default 120000)
