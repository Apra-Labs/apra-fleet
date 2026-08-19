# StallDetector -- Resilience & Edge Case Design

## Overview

StallDetector is a centralized polling loop that monitors all active `execute_prompt` sessions by reading provider JSONL conversation logs to compute real "last LLM activity" timestamps. This document captures explicit decisions for each edge case, ensuring the design is resilient, consistent, and implementable without ambiguity.

---

## Edge Cases & Decisions

### 1. Log File Not Yet Created When First Poll Fires

**Scenario:** A member is added to the stall check list and poll fires before the provider (Claude/Antigravity) has written the first JSONL log entry to disk.

**Decision:** Treat as "no activity yet" and do not count as a stall cycle.
- `readLogTail()` attempts to read the log file, gets "file not found" or similar error from `execute_command`.
- `readLogTail()` returns `{ lastTimestamp: null }` (not an error condition per resilience contract).
- Poll loop does NOT update `lastActivityAt` and does NOT increment `consecutiveIdleCycles`.
- `lastActivityAt` remains set to the baseline timestamp (time the member was added to the list).
- Once the log file is created and the first line is written, the next poll will read it and update `lastActivityAt` to the LLM's actual first activity.

**Rationale:** The absence of a log file is expected during the startup window before the first API call. Treating it as idle would create false stalls during normal startup. The baseline `lastActivityAt` is already set to the current time, so a genuine stall will still be detected after the threshold elapses.

---

### 2. `execute_command` for Log Read Fails or Times Out

**Scenario:** The command to tail the log file returns non-zero exit code, times out, or throws a connection/network error.

**Decision:** Log the failure as a structured event, do NOT update `lastActivityAt`, do NOT count as stall cycle, and track consecutive failures.
- `readLogTail()` catches any error (timeout, command failure, parse error) and returns `{ lastTimestamp: null, error: <message> }`.
- Poll loop detects the error (non-null `error` field) and:
  - Increments the member's `consecutiveReadFailures` counter.
  - Logs a structured event: `{ event: "stall_log_read_failure", memberId, logFilePath, error }`.
  - Does NOT update `lastActivityAt`.
  - Does NOT count as stall cycle; continues with next entry.
- After 3 consecutive read failures, emit a warning to the fleet JSONL log: `{ event: "stall_log_read_warning", memberId, consecutiveFailures: 3 }`.
- When `readLogTail()` succeeds again (even with null timestamp), reset `consecutiveReadFailures` to 0.

**Rationale:** A single network hiccup or timeout should not cause false stalls or incorrect idle tracking. Tracking consecutive failures lets operators know if there's a persistent connectivity issue without alarming on transient glitches. The warning at 3 consecutive failures gives visibility without spam.

---

### 3. Member Process Exits Between "Add to List" and First Poll

**Scenario:** A member is provisionally added to the stall check list (before sessionId is available), but the process exits or the member fails to produce a sessionId before the first poll cycle completes.

**Decision:** Use two-phase add; remove from the list immediately in the finally block if the process exits.
- When `execute_prompt` spawns a child process, immediately call `stallDetector.add(memberId, provisionalEntry)` with:
  - `sessionId: null`
  - `logFilePath: null`
  - `provisional: true`
  - `lastActivityAt: Date.now()`
  - All counters set to 0
- If the process exits (for any reason) before `sessionId` is available, the finally block calls `stallDetector.remove(memberId)`.
- If `sessionId` arrives before exit, call `stallDetector.update(memberId, { sessionId, logFilePath, provisional: false })` to upgrade the provisional entry.
- Next poll iteration will see either:
  - No entry (because the process exited) -> nothing to do.
  - A full entry (because sessionId arrived) -> proceed with log reading.
  - A provisional entry (rare, but sessionId hasn't arrived yet) -> skip log reading, check baseline timeout only.

**Rationale:** Two-phase add ensures no gap where active processes aren't tracked. Immediate removal on exit prevents dangling entries. The finally block is guaranteed to run on all exit paths (success, error, timeout, or explicit kill).

---

### 4. Gap Between Process Spawn and SessionId Arrival

**Scenario:** A child process is running and the operator initiates `stop_prompt` or other actions, but sessionId hasn't been produced yet, so the log file path is unknown.

**Decision:** Provisional entries skip log reading but still detect hangs via baseline timeout.
- A provisional entry (with `logFilePath: null`) remains in the stall check list.
- Poll loop detects `provisional: true` and does NOT call `readLogTail()`.
- Poll loop DOES check: if `Date.now() - entry.lastActivityAt > STALL_THRESHOLD_MS`, emit a stall event:
  - `{ event: "stall_detected", memberId, memberName, idleSecs: (Date.now() - lastActivityAt) / 1000, note: "provisional_entry_timeout" }`
  - This detects hangs before sessionId is ever produced (e.g., if the LLM process crashes before the first response).
- Once sessionId arrives, the entry is upgraded to non-provisional and subsequent polls use log reading.

**Rationale:** The baseline timeout protection (checking elapsed time since add) ensures we still detect stalls during the sessionId gap. Skipping log reading for provisional entries avoids "file not found" noise before the log file is created.

---

### 5. Concurrent Dispatches on Same Member (Server Rejects 2nd)

**Scenario:** The server receives two concurrent `execute_prompt` requests on the same member, but the server's concurrency guard rejects the second one.

**Decision:** Server-side guard prevents concurrent entries; stall detector maps entries by memberId (one per member).
- The MCP `execute_prompt` handler (in `src/tools/execute-prompt.ts`) already rejects concurrent calls on the same member and returns an error to the caller.
- The stall detector's `stallCheckList` is keyed by `memberId` -- only one entry can exist per member.
- If, due to a bug, a second `stallDetector.add(memberId, entry2)` is called for an already-tracked member:
  - `add()` logs a warning: `{ event: "stall_detector_duplicate_add", memberId, memberName }`.
  - `add()` overwrites the existing entry with the new one (idempotent semantics).
  - This is safe because the old entry would be from a failed/completed session; the new entry represents the current session.

**Rationale:** This edge case is a defense-in-depth safeguard. The server's concurrency guard should prevent it, but if it ever happens, the stall detector gracefully handles it with a warning and recovery.

---

### 6. Log File Pre-Exists from Prior Session with Same Session ID

**Scenario:** A member runs multiple `execute_prompt` sessions sequentially. A session ID is reused (unlikely but possible), and the log file from the prior session with that ID still exists on disk.

**Decision:** Baseline `lastActivityAt` is set at add time, not at log-file-creation time, so stale files don't trigger immediate stalls.
- When a member is added, `lastActivityAt` is set to `Date.now()` (current timestamp).
- The log file path is derived from the sessionId: `~/.claude/projects/<encoded>/<sessionId>.jsonl` or `~/.gemini/antigravity-cli/brain/<sessionId>/.system_generated/logs/transcript.jsonl` (AGY).
- If the file pre-exists from a prior session with the same ID, its timestamps are old.
- Poll loop reads the tail of the file, extracts the last entry's timestamp, and compares it to `entry.lastActivityAt` (set at add time, not read time).
- Since the log file's timestamp is older than `entry.lastActivityAt`, the comparison detects no new activity -> `lastActivityAt` is not updated.
- Stall counter advances only if the entry remains idle longer than `STALL_THRESHOLD_MS` from the `lastActivityAt` baseline.

**Rationale:** By anchoring `lastActivityAt` to the add time, we avoid interpreting stale log entries as current activity. Session IDs are intended to be unique per session; if reuse happens, the stale file is irrelevant because the baseline timeout already accounts for normal startup latency.

---

### 7. Transcript-Mtime Cross-Check

**Scenario:** The content-based timestamp extraction (edge cases 1-6 above) depends on the transcript's JSONL shape parsing correctly. Prior incidents shipped because that shape assumption was subtly wrong for a real transcript, and a content-parsing gap silently degrades to "no activity ever seen" -- indistinguishable from a genuinely dead session. Conversely, a session that WAS dead (hit `max_turns_reached` and stopped, but whose terminal-event detection missed the signal -- see the terminal-signal detection note in the provider abstraction docs) sat unkilled for tens of minutes because the only backstop was the multi-thousand-second hard dispatch ceiling.

**Decision:** Every poll also fetches the transcript file's own OS last-modified time (`mtimeMs`), independent of and in addition to the content scan, and the two signals are cross-checked before the poll loop commits to either "activity happened" or "no activity happened":
- `pollLogFile()` (`stall-poller.ts`) issues a `stat -c %Y`/`stat -f %m` (Unix) or PowerShell `LastWriteTimeUtc` (Windows) read of the transcript file alongside the existing tail read, and returns it as `mtimeMs` (epoch ms). Any failure to obtain it (file missing, stat unsupported, non-numeric output) yields `null` -- treated as "no additional signal," never as "confirmed no activity."
- If the content scan finds a fresh timestamp, OR the file's mtime is newer than the entry's `lastActivityAt` baseline, that counts as activity (`lastActivityAt` advances to whichever signal is newer). This means a transcript whose current shape the content parser cannot yet handle still cannot manufacture a false stall as long as the file is genuinely still being written -- the mtime is ground truth, independent of any JSON/regex assumption.
- The stall threshold (`_poll()`'s `now - entry.lastActivityAt > stallThresholdMs` check) only fires once BOTH signals agree there has been no advancement -- i.e. the threshold check is genuinely mtime-corroborated, not a pure content-parsing artifact. This is what lets a dead session (mtime frozen, no content advancing) be caught within the configured window instead of only at the 3630s ceiling, while a long silent tool call whose transcript is still being appended to (by either signal) is never falsely killed.
- Every existing caller/test that mocks `pollLogFile()`'s return value without an `mtimeMs` field gets `undefined`, which is treated identically to `null` -- this is a pure superset of the prior content-only behavior; it can only convert what would have been a false stall into recognized activity, never the reverse.

**Configuration:** `STALL_THRESHOLD_MS` (default 120000 = 2 minutes) is the single configurable inactivity window used for both the content-based and mtime-based signals -- there is no separate mtime threshold. `STALL_POLL_INTERVAL_MS` (default 30000) governs how often both signals are re-checked.

**Rationale:** Content parsing and OS mtime are two independent observations of the same underlying fact ("did this file change"). Requiring stall-only-if-neither-agrees strictly reduces false positives versus content-parsing alone (it is a superset check), while requiring an mtime-confirmed freeze before treating a missing/unparseable terminal signal (e.g. a missed `max_turns_reached` event) as fatal is exactly the defense-in-depth this design needs: even if the terminal-event detection is wrong again, a genuinely dead session (frozen mtime) still dies within the configured window rather than the multi-thousand-second ceiling.

---

### 8. Confirmed Stall Must Cancel the In-Flight Dispatch, Not Just the Remote Process

**Scenario:** The poller confirms a stall (edge cases 1-7 above all agree there has been no activity past the threshold) and needs to actually end the hung dispatch.

**Decision:** Killing the remote pid is necessary but not sufficient. The `onStall` callback also carries an `AbortController` wired into the same `execCommand()` abort-signal path remote strategies already accept, so a confirmed stall rejects the pending MCP `tools/call` immediately with a typed `stalled` error -- it does not leave the client waiting out its own independent hard deadline for a server-side process that is already dead. See `docs/architecture.md`'s "Terminal-Signal and Dead-Session Detection Invariants" section for how this fits alongside the other dispatch-termination invariants (max-turns detection, busy-lock liveness checks) as defense-in-depth against a hung dispatch surviving past its detection.

**Rationale:** Without this, a confirmed stall detection (which exists specifically to catch a hang within a bounded window) degraded back into the exact multi-thousand-second wait it was built to avoid, because the detector and the dispatch's own promise were two independent things and only one of them knew the session was dead.

---

## Consistency Checks

### Invariants
1. **`lastActivityAt` is always initialized at add time** to the current timestamp, even if the log file doesn't exist yet. Stall detection is always relative to this baseline.
2. **Provisional entries (no log file) are removed immediately on process exit**, preventing dangling state.
3. **Read failures do not update `lastActivityAt`** and do not count as idle cycles; only successful log reads with new timestamps update the field.
4. **`consecutive ReadFailures` is incremented only on read errors, reset only on read success** (even if the log file doesn't exist yet).
5. **Stall events are emitted only after `STALL_THRESHOLD_MS` elapses** without a successful log read that finds new activity.

### Cross-Case Scenarios
- **Spawn -> quick exit (before sessionId):** Two-phase add + immediate remove. Entry never reaches poll phase.
- **Spawn -> sessionId arrives -> stale log file:**  Entry is upgraded to non-provisional. Log is read; stale timestamp is ignored because `lastActivityAt` is newer. No false stall.
- **Spawn -> poll (no log yet) -> log created -> poll again:** First poll: provisional, no log read, baseline timeout check. Log file created. Second poll: entry is upgraded (if sessionId arrived), log is read, real timestamp extracted.
- **Concurrent adds (rare bug):** Warning logged, new entry overwrites old. Safe recovery.

---

## Implementation Guidelines

1. **Use structured logging** for all stall detector events (reads, failures, stalls, debug). Event names: `stall_poll`, `stall_log_read`, `stall_log_read_failure`, `stall_log_read_warning`, `stall_detected`.
2. **Idempotent operations:** `remove()` is a no-op if entry doesn't exist; `update()` merges fields; `add()` overwrites with a warning.
3. **Environment variables:**
   - `STALL_POLL_INTERVAL_MS` (default 15000): Polling frequency.
   - `STALL_THRESHOLD_MS` (default 120000): Idle threshold before stall event is emitted.
4. **Timeout for log reads:** `readLogTail()` uses 5000ms timeout for the tail command. This is short enough to avoid blocking the poll loop but long enough for most file reads.
5. **No direct filesystem access:** All log file reads go through `execute_command` via the strategy abstraction. This ensures the same code path works for local and remote members.

---

## Summary Table

| Edge Case | Behavior | Stall Counter | `lastActivityAt` Update | Log Event |
|-----------|----------|---------------|----|-----------|
| Log file not yet created | Treat as no activity, continue | Not incremented | Not updated | `stall_poll` (status: pending) |
| Read fails / timeout | Increment failure counter, warn at 3 | Not incremented | Not updated | `stall_log_read_failure` |
| Process exits before sessionId | Remove immediately from list | N/A (removed) | N/A (removed) | N/A (cleanup) |
| Gap (provisional entry timeout) | Check baseline timeout, detect stall | Incremented if timeout exceeded | Not updated (no log) | `stall_detected` (provisional) |
| Concurrent add (rare) | Warn and overwrite | Depends on new entry | Depends on new entry | `stall_detector_duplicate_add` |
| Stale pre-existing log | Ignore stale timestamp (newer baseline) | Not incremented | Not updated | `stall_poll` (status: idle) |
| Mtime advanced but content unparseable | Treat as activity (mtime is ground truth) | Not incremented | Updated to mtime | `stall_poll` (status: idle) |
| Content stale AND mtime stale | Confirmed frozen -- eligible for stall | Incremented | Not updated | `stall_detected` |
