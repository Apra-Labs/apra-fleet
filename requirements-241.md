# Requirements — #241 Smart Stall Detector / Session Activity Monitor

## Base Branch
`main` — branch to fork from and merge back to

## Goal

Replace the current error-prone stall detection (which false-positives constantly) with a
single, centralised `StallDetector` that monitors all members currently running
`execute_prompt`. The detector reads the provider's conversation log files to compute a
real "last LLM activity" timestamp, drives the member's `busy` status, and automatically
handles all termination conditions (normal exit, failure, stop_prompt kill, unregister).

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

## Proposed Design

### Single StallDetector service (not N timers)

When `execute_prompt` is dispatched to a member:
1. The member is added to a `stallCheckList` (keyed by `memberId`), storing the session
   log path and a baseline `lastActivityAt` timestamp.
2. A **single** `StallDetector` loop wakes on a configurable interval (e.g. 15s) and
   iterates all entries in `stallCheckList`.
3. For each entry it reads the last entry in the session log file and compares its
   timestamp to `lastActivityAt`. If the timestamp advanced → update `lastActivityAt` and
   reset the stall counter. If unchanged for `stallThresholdMs` → fire a stall event.
4. On every poll the detector updates the member's `lastLlmActivityAt` field.

### Log file access via execute_command (no local/remote split)

Log file reading must be done via the fleet server's own `execute_command` interface
(invoked internally, not as an MCP tool call from outside). This means:

- The server issues an internal `execute_command` to tail the session log file on the
  member's machine, exactly like external callers do.
- This works uniformly for both local and remote members — no special-casing.
- The log read itself must appear in the fleet server's structured JSONL log
  (e.g. `{event: "stall_poll", memberId, logPath, mtime}`), making the detector's
  activity fully observable.
- No direct `fs.readFile` or `fs.stat` calls on the log path — the indirection through
  `execute_command` is the contract.

### Always-on, automatic coverage

The StallDetector is not an opt-in tool the PM must call. It is an internal server
service that starts with the server and automatically covers every `execute_prompt`
dispatched via MCP. The PM never needs to invoke any new MCP tool to activate monitoring.
Stall events surface in the fleet log and as updated fields on existing tools
(`member_detail`, `fleet_status`).

### All termination conditions handled

The stall check list entry for a member must be cleaned up under ALL of these conditions:

| Condition | Expected behaviour |
|-----------|-------------------|
| `execute_prompt` exits normally (success) | Remove from list immediately |
| `execute_prompt` exits with error / non-zero exit code | Remove from list immediately |
| `execute_prompt` times out (inactivity or max_total_s) | Remove from list immediately |
| `stop_prompt` is called (session killed) | Remove from list immediately |
| Member is unregistered while session is active | Remove from list immediately |
| Server restarts (stale entries from prior run) | List is in-memory — starts empty; no resurrection of stale entries |

Duplicate removes (e.g. process exit fires AND stop_prompt is called) must be no-ops,
never errors or double-frees.

### Resilience requirements (fool-proof design analysis)

Analyse the full feature for edge cases and failure modes before coding:

- What if the log file doesn't exist yet (session just started, first token not written)?
  → treat as "no activity yet", do not treat as stall on first poll.
- What if `execute_command` to read the log times out or fails?
  → log the failure, do not update `lastActivityAt`, do not count as stall cycle.
- What if the member's process exits between "add to list" and the first poll?
  → the exit handler fires remove(); poll sees nothing to do.
- What if two concurrent `execute_prompt` dispatches race on the same member (server
  rejects the second, but what about cleanup state)?
  → server already rejects concurrent dispatches; list entry should only exist for the
  one in-flight session.
- What if `lastActivityAt` is never updated because the log file grows but the session
  never moves (e.g. log file pre-exists from a prior session with the same session ID)?
  → log path must include the session ID so re-use is impossible across sessions.

These must be explicitly decided in the design — not deferred to implementation.

### Stall event

When a genuine stall is detected:
- Log a structured event: `{event: "stall_detected", memberId, memberName, idleSecs, lastActivityAt}`
- **No MCP call required** — this surfaces automatically in `member_detail` and `fleet_status`
  (via `lastLlmActivityAt` + derived `idleSecs` field)
- Do NOT auto-kill the session — stall detection is observational only

### monitor_task has no role in this feature

`monitor_task` is an existing tool for checking background task status. The stall
detector does not integrate with `monitor_task` — it is a separate, always-on internal
service. Do NOT add stall data to `monitor_task` responses. The PM discovers stall
state by reading `member_detail` or `fleet_status`, not by calling `monitor_task`.

### lastLlmActivityAt field

Add `lastLlmActivityAt: ISO8601 | null` to the member record, updated on every poll.
Visible in `member_detail` and `fleet_status --format json`. `null` when no session is
active or no activity has been recorded yet. Derive `idleSecs` at read time
(`now - lastLlmActivityAt`) rather than storing it.

## Scope

- `StallDetector` class/module: single polling loop, manages `stallCheckList`
- Internal log-reading via `execute_command` (uniform local/remote, appears in fleet log)
- Lifecycle hooks in `execute_prompt`: all exit conditions (success, error, timeout) → remove
- Hook in `stop_prompt` → remove
- Hook in member unregister → remove if present
- `lastLlmActivityAt: ISO8601 | null` field on member record
- `idleSecs: number | null` derived field in `member_detail` / `fleet_status` JSON output
- Stall event logging to fleet JSONL log (structured pino entry)
- Resilience analysis documented in design (not deferred to implementation)
- Unit tests covering: add, poll-with-activity, poll-no-activity, stall trigger, all
  remove paths (success exit, error exit, stop_prompt, unregister), double-remove no-op,
  missing log file on first poll, execute_command failure during poll

## Out of Scope

- Auto-killing a stalled session
- New MCP tool exposed to callers (no new MCP tool)
- `monitor_task` changes
- Viewing full session log content via MCP (separate issue)
- Modifying provider log formats

## Constraints

- Exactly one polling loop regardless of how many concurrent sessions are active
- Log reading goes through `execute_command` — no direct filesystem access to member logs
- Must work uniformly for local and remote members
- TypeScript, no `any` escape hatches for new code
- `STALL_POLL_INTERVAL_MS` and `STALL_THRESHOLD_MS` configurable via env var

## Acceptance Criteria

- [ ] 10 concurrent `execute_prompt` sessions → exactly one StallDetector loop running
- [ ] `execute_prompt` exits (success or error) → member removed from stallCheckList
- [ ] `stop_prompt` → member removed immediately, double-remove is a no-op
- [ ] Member unregistered mid-session → removed from stallCheckList
- [ ] `member_detail` returns `lastLlmActivityAt` + `idleSecs` while session is active
- [ ] `fleet_status --format json` includes `lastLlmActivityAt` per member
- [ ] Genuine stall → structured pino event in fleet log
- [ ] No false stall when member runs a long tool call (e.g. `npm test` for 3 min)
- [ ] Log read commands appear in fleet server log (observable via fleet JSONL log)
- [ ] Unit tests pass for all StallDetector paths
- [ ] No local/remote-specific code paths in the detector
