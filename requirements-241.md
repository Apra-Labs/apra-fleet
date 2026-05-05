# Requirements — #241 Smart Stall Detector / Session Activity Monitor

## Base Branch
`main` — branch to fork from and merge back to

## Goal

Replace the current error-prone stall detection (which false-positives constantly) with a
single, centralised `StallDetector` that monitors all members currently running
`execute_prompt`. The detector reads the provider's conversation log files to compute a
real "last LLM activity" timestamp, drives the member's `busy` status, and removes members
from monitoring automatically and fool-proof when their session ends.

## Background — why the current approach fails

The fleet server dispatches `execute_prompt` to a member and currently tries to detect
stalls by watching stdout silence from the CLI process. A member running `npm test` for
3 minutes produces no stdout but is NOT stalled — the LLM is waiting for the test runner.
This causes the majority of stall triggers to be false positives.

Each LLM provider writes structured conversation logs keyed by session ID:

- **Claude**: `~/.claude/projects/<project-path-encoded>/<sessionId>.jsonl`
  Each line is a JSON object with a `type` field. LLM turns have entries like
  `{"type":"assistant","message":{...},"timestamp":"..."}`. Tool calls, tool results, and
  text blocks all appear here.
- **Gemini**: `~/.gemini/tmp/<project>/<sessionId>.jsonl` (similar structure)

The session ID is already returned in `execute_prompt` output footer (`session: <sessionId>`),
so the fleet server already knows which log file to tail.

## Proposed Design (user's vision — planner should refine)

### Single StallDetector service (not N timers)

When `execute_prompt` is dispatched to a member:
1. The member is added to a `stallCheckList` (keyed by `memberId`), storing the session
   log path and a baseline `lastActivityAt` timestamp.
2. A **single** `StallDetector` loop wakes up on a configurable interval (e.g. 15s) and
   iterates all entries in `stallCheckList`.
3. For each entry it reads the last entry in the session log file and compares its
   timestamp to the stored `lastActivityAt`. If the timestamp advanced → update
   `lastActivityAt` and reset the stall counter. If unchanged for `stallThresholdMs` →
   fire a stall event for that member.
4. The detector also updates the member's `lastLlmActivityAt` field (visible in
   `member_detail` / `fleet_status`) on every successful log read.

### Fool-proof removal

A member must be removed from `stallCheckList` exactly once, either:
- When `execute_prompt` exits normally (session ended or CLI process exited)
- When `stop_prompt` is called on that member
- When the member is unregistered

Design must prevent double-remove (no-op, not a crash) and must prevent a member staying
stuck in the list after its session is gone. Consider using a `Map<memberId, handle>` with
guards.

### Busy status driven by StallDetector

Currently `busy` state is set when `execute_prompt` starts and cleared when it exits. The
StallDetector should also be the source of truth for `busy` — if the CLI process exited
but the detector has not yet cleaned up, `busy` should still read correctly. No race
conditions between process exit handler and detector cleanup.

### Stall event

When a genuine stall is detected:
- Log a structured event: `{event: "stall_detected", memberId, memberName, idleSecs, lastActivityAt}`
- Surface it in `monitor_task` or a new tool response
- Do NOT auto-kill the session — stall detection is observational only; the PM decides
  what to do

### lastLlmActivityAt field

Add `lastLlmActivityAt: ISO8601 | null` to the member record, updated by the StallDetector
on every poll cycle. Visible in `member_detail` and `fleet_status` (JSON format). This
replaces the vague "last seen" with a precise "last LLM token produced" timestamp.

## Scope

- `StallDetector` class/module: single polling loop, manages `stallCheckList`
- Add/remove hooks in `execute_prompt` lifecycle (start → add, exit → remove)
- Add/remove hook in `stop_prompt` (cancel → remove)
- `lastLlmActivityAt` field on member record, persisted or at least in-memory
- Log file path resolver: given `(provider, sessionId, workFolder)` → full path to JSONL log
- `busy` status stays consistent with `StallDetector` state
- Stall logging to fleet JSONL log (structured)
- Unit tests for StallDetector: add, poll, remove, double-remove guard, stall trigger
- Stall info surfaced in `monitor_task` response (add `lastLlmActivityAt`, `idleSecs`)

## Out of Scope

- Auto-killing a stalled session (PM decides action)
- Changing how `execute_prompt` output streaming works
- New MCP tool for viewing full session logs (that's a separate issue — #241 is detection only)
- Modifying provider log formats

## Constraints

- Must not require N timers for N concurrent sessions — exactly one polling loop
- Must work across Claude, Gemini providers (log path resolution must be provider-aware)
- No new npm dependencies unless strictly necessary
- TypeScript — must compile cleanly, no `any` escape hatches for the new code
- Stall threshold and poll interval configurable (env var or config, not hardcoded)

## Acceptance Criteria

- [ ] Dispatching 10 concurrent `execute_prompt` sessions → exactly one StallDetector loop running
- [ ] After `execute_prompt` exits → member removed from stallCheckList within one poll cycle
- [ ] `stop_prompt` → member removed from stallCheckList immediately, no crash on double-remove
- [ ] `member_detail` returns `lastLlmActivityAt` updated to within the last poll interval while session is active
- [ ] `fleet_status --format json` includes `lastLlmActivityAt` per member
- [ ] When a member is genuinely idle for `stallThresholdMs`, a stall event appears in fleet log
- [ ] No false stall when member is running a long tool call (e.g. `npm test` for 3 min)
- [ ] Unit tests pass for StallDetector
