# apra-fleet — Backlog

## Deferred from Sprint 1

### MEDIUM — PM-side background agent cannot be stopped by stop_agent
`stop_agent` kills the member-side LLM process and sets a stopped flag, but a misbehaving PM-side background agent (spawned via `Agent(run_in_background=true)`) remains alive and can theoretically retry dispatches. The stopped flag starves it of successful dispatches, but it does not terminate the local agent process. True fix requires Claude Code framework support for SendMessage stop signal — tracked in #148 risk register. Deferred to Sprint 3 (Cluster B).

### LOW — Windows git credential helper path warning on fleet-dev
`git push` emits `C:\Users\akhil\.fleet-git-credential.bat: command not found` (bash path mangling). Push still succeeds via fallback. Root cause is the `provision_vcs_auth` single-identity credential file design — full fix tracked in #163 (Sprint 2, Cluster C).

### MEDIUM — Dispatch agent stream watchdog fires at 600s before execute_prompt returns
PM-side background agents dispatching long execute_prompt calls stall at 600s inactivity. Root cause: `execute_prompt` holds the MCP connection open for the full LLM session duration — the tool call doesn't return until the LLM finishes. The PM agent emits zero tokens while blocked on the tool call. The watchdog fires on that silence.

**Real fix (fleet-side):** `execute_prompt` should return immediately with a task handle and let the LLM run asynchronously in the background. Cloud members already have `monitor_task` for this pattern — local members need parity. This eliminates the long-held connection entirely and makes the watchdog irrelevant. Dedicated sprint required.

## Deferred from Sprint 2

### LOW — No dedicated unit test for Windows forward-slash path fix (#163)
The `provision_vcs_auth` T4 fix converts backslashes to forward slashes before writing the helper path to `.gitconfig` (via `-replace '\\','/`). This is covered implicitly by integration tests but has no targeted unit assertion. A focused test would catch regressions from future `.gitconfig` write refactors.

### LOW — No unit tests for log-helpers.ts (maskSecrets, truncateForLog)
Added in Sprint 3 T9. fleet-rev flagged as non-blocking advisory. Add dedicated unit tests for edge cases: nested secure refs, uppercase patterns, empty string, null-ish inputs.

## PM Skill Improvements

### #182 — Tier-aware dispatch: read planned.json to select model, club same-tier tasks, derive resume
Full spec at https://github.com/Apra-Labs/apra-fleet/issues/182. Changes: cohesion-based phase boundaries, monotonic tier ordering within phases, one-task-at-a-time dispatch at correct tier, data-driven resume from phase numbers.
