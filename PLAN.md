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
- **`execute_command`** (`src/tools/execute-command.ts`): Runs commands on a member — works for both local and remote members uniformly.

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
- Log reading via `execute_command` — no direct `fs.stat`/`fs.readFile` on member logs

---

## Tasks

### Phase 0: Resilience Analysis (Design-Only — No Code)

#### Task 0: Resilience & Edge Case Design Document
- **Change:** Create `docs/stall-detector-resilience.md` documenting explicit decisions for every edge case BEFORE implementation begins. This is a design artifact, not code.
- **Decisions to document:**

  | Edge Case | Decision |
  |-----------|----------|
  | Log file not yet created when first poll fires | Treat as "no activity yet" — do not count as stall cycle. `lastActivityAt` remains at baseline (time of add). |
  | `execute_command` for log read fails or times out | Log the failure as a structured event. Do NOT update `lastActivityAt`. Do NOT count as a stall cycle. Increment a separate `consecutiveReadFailures` counter; emit warning after 3 consecutive failures. |
  | Member process exits between "add to list" and first poll | The exit handler calls `remove()` immediately. Next poll iteration sees no entry — nothing to do. |
  | Concurrent dispatches on same member (server rejects 2nd) | Server already rejects concurrent `execute_prompt` on same member. Stall list is keyed by memberId — only one entry can exist. If a second add is attempted (shouldn't happen), log a warning and overwrite. |
  | Log file pre-exists from prior session with same session ID | Log path includes session ID which is unique per session. If the file pre-exists, its last entry timestamp may be old — baseline `lastActivityAt` is set to `Date.now()` at add time, so a stale file won't trigger immediate stall. |

- **Files:** `docs/stall-detector-resilience.md` (new)
- **Tier:** cheap
- **Done when:** Document reviewed and each edge case has an explicit decision
- **Blockers:** None — this is the first task, blocks all implementation

#### VERIFY: Phase 0
- [ ] All five edge cases have explicit, documented decisions
- [ ] Decisions are consistent with each other (no contradictions)
- [ ] Document is committed to the branch before any implementation begins

---

### Phase 1: Foundation — StallDetector Class, Log Path Resolver & Internal Command Wrapper

#### Task 1: Log File Path Resolver
- **Change:** Create `src/services/stall/log-path-resolver.ts` exporting `resolveSessionLogPath(provider: LlmProvider, sessionId: string, workFolder: string, homeDir?: string): string`. Handles Claude and Gemini path conventions. Returns the expected JSONL log path.
- **Files:** `src/services/stall/log-path-resolver.ts` (new)
- **Tier:** cheap
- **Done when:** Function compiles, handles both providers, unit test passes with mocked paths
- **Blockers:** Claude's project-path encoding scheme — implement best-guess (replace `/` and `\` with URL-encode-style) with a TODO comment for verification

#### Task 2: StallEntry Type & StallDetector Class Skeleton
- **Change:** Create `src/services/stall/stall-detector.ts` with:
  - `StallEntry` interface: `{ sessionId, logFilePath, lastActivityAt: number, consecutiveIdleCycles: number, consecutiveReadFailures: number, memberId, memberName }`
  - `StallDetector` class: `stallCheckList: Map<string, StallEntry>`, `add(memberId, entry)` (idempotent overwrite with warning), `remove(memberId)` (idempotent no-op if absent), `start()`, `stop()`, `getEntry(memberId)`
  - Singleton export pattern (like IdleManager)
- **Files:** `src/services/stall/stall-detector.ts` (new), `src/services/stall/index.ts` (barrel)
- **Tier:** cheap
- **Done when:** Class compiles, add/remove/double-remove work in unit test
- **Blockers:** None

#### Task 3: Internal execute_command Wrapper for Log Reading
- **Change:** Create `src/services/stall/read-log-tail.ts` exporting an async function `readLogTail(memberId: string, logFilePath: string): Promise<{ lastTimestamp: string | null, error?: string }>`. This function:
  - Issues an internal `execute_command` to the member (e.g. `tail -c 512 <logFilePath>`) to read the last portion of the log file
  - Parses the output to extract the last JSON entry's timestamp
  - Returns `null` for lastTimestamp if the file doesn't exist or is empty (not an error — per resilience decision)
  - Returns `{ lastTimestamp: null, error: <message> }` if execute_command fails or times out
  - The execute_command invocation must appear in the fleet server's structured JSONL log (uses existing logLine infrastructure)
  - No direct `fs.stat`, `fs.readFile`, or any filesystem API — all access goes through execute_command
- **Files:** `src/services/stall/read-log-tail.ts` (new)
- **Tier:** standard
- **Done when:** Function compiles, unit test verifies it calls execute_command (mocked), handles missing file and timeout gracefully
- **Blockers:** Need to identify how to invoke execute_command internally (not as MCP tool call). Likely call the underlying function that `execute_command` tool delegates to.

#### Task 4: Polling Loop Implementation
- **Change:** Implement `_poll()` method on StallDetector:
  - Iterates `stallCheckList`
  - For each entry: calls `readLogTail(memberId, logFilePath)` to get last activity timestamp
  - If `lastTimestamp > lastActivityAt` → update `lastActivityAt`, reset `consecutiveIdleCycles`, reset `consecutiveReadFailures`
  - If `readLogTail` returns error → increment `consecutiveReadFailures`, log warning, do NOT count as stall cycle (per resilience decision)
  - If `readLogTail` returns null timestamp (file not yet created) → do NOT count as stall cycle (per resilience decision)
  - If idle for `STALL_THRESHOLD_MS` → emit stall event via structured log: `{event: "stall_detected", memberId, memberName, idleSecs, lastActivityAt}`
  - Update `lastLlmActivityAt` on the member record via `updateAgent()`
  - Log each poll cycle: `{event: "stall_poll", memberId, logPath, lastActivityAt}`
  - Uses `setInterval(STALL_POLL_INTERVAL_MS)` — env vars: `STALL_POLL_INTERVAL_MS` (default 15000), `STALL_THRESHOLD_MS` (default 120000)
- **Files:** `src/services/stall/stall-detector.ts`
- **Tier:** standard
- **Done when:** Poll loop detects stall after threshold in unit test with fake timers; missing file and read failures handled per resilience doc
- **Blockers:** None (resilience decisions made in Phase 0)

#### Task 5: Unit Tests for StallDetector
- **Change:** Create `tests/stall-detector.test.ts` covering:
  - add entry
  - remove entry
  - double-remove (no-op, no error)
  - poll with advancing timestamp (no stall)
  - poll with stale timestamp triggering stall event
  - poll with missing log file (no false stall)
  - poll with execute_command failure (no false stall, consecutiveReadFailures incremented)
  - start/stop lifecycle
- **Files:** `tests/stall-detector.test.ts` (new)
- **Tier:** standard
- **Done when:** All tests pass via `npm test`
- **Blockers:** None

#### VERIFY: Phase 1
- [ ] `StallDetector` compiles with no `any` types
- [ ] Unit tests pass: add, remove, double-remove, stall detection, no false positive on missing file, no false stall on read failure
- [ ] `resolveSessionLogPath` returns correct paths for claude and gemini providers
- [ ] Single `setInterval` — not per-member timers
- [ ] Log reading goes through `readLogTail` → `execute_command`, never direct filesystem access
- [ ] Log read commands appear in fleet JSONL log

---

### Phase 2: Integration — Hook into execute_prompt & stop_prompt Lifecycle

#### Task 6: Add `lastLlmActivityAt` to Agent Type
- **Change:** Add `lastLlmActivityAt?: string` (ISO 8601) to the `Agent` interface in `src/types.ts`
- **Files:** `src/types.ts`
- **Tier:** cheap
- **Done when:** Type compiles, no downstream type errors
- **Blockers:** None

#### Task 7: Hook StallDetector into execute_prompt — All Exit Paths
- **Change:** In `src/tools/execute-prompt.ts`:
  - After sessionId is known (line ~216): call `stallDetector.add(agent.id, { ... })`
  - **Removal hooks for EVERY termination condition:**

    | Exit Path | Where removal happens |
    |-----------|----------------------|
    | Normal exit (success) | finally block (line ~252) |
    | Error exit / non-zero exit code | finally block (line ~252) |
    | Inactivity timeout (timeout_s fires) | finally block — timeout kills process, control reaches finally |
    | Hard ceiling timeout (max_total_s fires) | finally block — same as above |
    | `stop_prompt` kills the process | Handled in Task 8 (stop_prompt hook) |
    | Member unregistered while session active | Handled in Task 9 (unregister hook) |

  - The finally block calls `stallDetector.remove(agent.id)` — covers exit paths 1–4
  - `remove()` is idempotent — double-remove from multiple paths is a no-op
- **Files:** `src/tools/execute-prompt.ts`
- **Tier:** standard
- **Done when:** StallDetector entry created on session start, removed on every exit condition
- **Blockers:** Session ID is only known after the first successful response — add to stall check at that point, not at process spawn. Baseline `lastActivityAt = Date.now()` at add time.

#### Task 8: Hook StallDetector into stop_prompt
- **Change:** In `src/tools/stop-prompt.ts`, after killing the PID: call `stallDetector.remove(agent.id)` — idempotent, so double-remove from both stop_prompt and execute_prompt's finally is safe.
- **Files:** `src/tools/stop-prompt.ts`
- **Tier:** cheap
- **Done when:** `stop_prompt` removes member immediately (doesn't wait for poll)
- **Blockers:** None

#### Task 9: Hook StallDetector into Member Unregister
- **Change:** In the member unregister path (wherever `remove_member` is implemented): call `stallDetector.remove(memberId)` if the member has an active session. Idempotent — safe even if no entry exists.
- **Files:** `src/tools/remove-member.ts` (or equivalent)
- **Tier:** cheap
- **Done when:** Unregistering a member with an active session removes it from stallCheckList
- **Blockers:** None

#### Task 10: Initialize StallDetector on Server Start
- **Change:** In the server startup path (wherever MCP server is initialized), call `stallDetector.start()`. On shutdown, call `stallDetector.stop()`.
- **Files:** `src/index.ts` or equivalent server entry point
- **Tier:** cheap
- **Done when:** StallDetector loop starts when server starts, stops cleanly on exit
- **Blockers:** Need to identify exact server lifecycle hooks

#### VERIFY: Phase 2
- [ ] Starting an execute_prompt adds member to stallCheckList
- [ ] ALL exit paths remove member from stallCheckList:
  - [ ] Normal exit (success)
  - [ ] Error exit / non-zero code
  - [ ] Inactivity timeout (timeout_s)
  - [ ] Hard ceiling timeout (max_total_s)
  - [ ] stop_prompt kills process
  - [ ] Member unregistered mid-session
- [ ] Double-remove (e.g. stop_prompt then execute_prompt finally) is a no-op — no error
- [ ] StallDetector starts/stops with server
- [ ] In-memory list starts empty on server restart — no stale entries resurrected

---

### Phase 3: Surface — Expose lastLlmActivityAt in Status Tools

#### Task 11: Surface `lastLlmActivityAt` in `member_detail`
- **Change:** In `src/tools/member-detail.ts`, include `lastLlmActivityAt` from the agent record in the returned JSON. Also compute and include `idleSecs` (time since lastLlmActivityAt) if the member is busy.
- **Files:** `src/tools/member-detail.ts`
- **Tier:** standard
- **Done when:** `member_detail` JSON response includes `lastLlmActivityAt` and `idleSecs` fields
- **Blockers:** None

#### Task 12: Surface `lastLlmActivityAt` in `fleet_status`
- **Change:** In `src/tools/check-status.ts` (fleet_status), include `lastLlmActivityAt` per member in JSON output.
- **Files:** `src/tools/check-status.ts`
- **Tier:** standard
- **Done when:** `fleet_status --format json` includes `lastLlmActivityAt` per member
- **Blockers:** None

#### Task 13: Integration Tests
- **Change:** Create `tests/stall-detector-integration.test.ts` — test the full lifecycle: mock execute_prompt adding to stallCheckList, poll cycle updating lastLlmActivityAt via execute_command, stop_prompt removing, unregister removing, member_detail returning the field.
- **Files:** `tests/stall-detector-integration.test.ts` (new)
- **Tier:** premium
- **Done when:** Integration tests pass, covering acceptance criteria
- **Blockers:** None

#### VERIFY: Phase 3
- [ ] `member_detail` returns `lastLlmActivityAt` updated within last poll interval
- [ ] `member_detail` returns `idleSecs` derived at read time
- [ ] `fleet_status` includes `lastLlmActivityAt` per member
- [ ] Stall event logged when member idle > threshold
- [ ] No auto-kill — detection is observational only
- [ ] `monitor_task` is NOT modified — stall data surfaces only via `member_detail` and `fleet_status`

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Claude project-path encoding unknown | Log file not found → no stall detection (but no false positive either) | `readLogTail` returns null; stall counter not incremented; log warning; verify encoding on live system in Phase 1 |
| Gemini log path structure unverified | Same as above | Same mitigation; provider-specific resolver allows easy fix |
| Session ID only available after first response | Gap between process spawn and first poll where stall can't be detected | Add entry with `lastActivityAt = now` on spawn (uses process start as baseline); add with real logFilePath when sessionId arrives |
| Log file written infrequently by LLM (e.g. batched writes) | Log tail doesn't show new timestamp even though LLM is active → false stall | Use generous default threshold (120s); make it configurable; document that threshold should exceed typical tool-call duration |
| `execute_command` for log tail adds latency to each poll | Poll cycle takes longer with many members | Set short timeout on internal execute_command (5s); parallelize reads across members within a single poll |
| `updateAgent()` writes to disk on every poll cycle | Disk I/O overhead with many members | Only write if `lastLlmActivityAt` actually changed; batch updates per poll cycle |

## Notes
- Base branch: main
- Implementation branch: feat/stall-detector
- Test framework: vitest
- Design uses `execute_command` to tail the log file and extract last timestamp — works uniformly for local and remote members, no special-casing
- Log reads are observable in the fleet server's structured JSONL log
- StallDetector is observational only — logs events, never kills processes
- `monitor_task` has NO role in this feature — stall state surfaces via `member_detail` and `fleet_status` only
- Env vars: `STALL_POLL_INTERVAL_MS` (default 15000), `STALL_THRESHOLD_MS` (default 120000)
