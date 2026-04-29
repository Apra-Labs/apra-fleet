# `execute_prompt` Tool API Reference

Dispatches a prompt to the LLM agent running on a registered fleet member.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `member_id` | `string` | one of | — | UUID of the target member |
| `member_name` | `string` | one of | — | Friendly name of the target member |
| `prompt` | `string` | yes | — | The prompt to send to the LLM |
| `resume` | `boolean` | no | `true` | Resume previous session if one exists |
| `timeout_s` | `number` | no | `300` | **Inactivity timeout** in seconds |
| `max_total_s` | `number` | no | none | **Hard ceiling** in seconds |
| `max_turns` | `number` | no | `50` | Max turns for the LLM session (1–500) |
| `dangerously_skip_permissions` | `boolean` | no | `false` | Run with `--dangerously-skip-permissions` |
| `model` | `string` | no | standard tier | Model tier or specific model ID |

Either `member_id` or `member_name` must be provided.

---

## Timeout Semantics

### `timeout_s` — Inactivity Timeout

`timeout_s` is an **inactivity timeout**, not a wall-clock deadline.

The timer resets every time stdout or stderr produces output. The process is killed only when no output has arrived for `timeout_s` seconds — i.e., true inactivity.

A member actively writing code, running tests, or executing tool calls that produce output will not be killed when `timeout_s` elapses, as long as output keeps flowing.

Default: **300s (5 minutes)**.

### `max_total_s` — Hard Ceiling (Optional)

`max_total_s` is a **hard ceiling** that is never reset regardless of activity.

If provided, the session is killed after `max_total_s` seconds of total elapsed time from when `execCommand` is called, even if the member is actively producing output.

Use cases:
- Preventing runaway sessions
- Enforcing budget limits on token-intensive tasks

If omitted (default), there is no total time limit.

### Relationship between the two timeouts

Both timers run concurrently. Whichever fires first kills the process:
- `timeout_s` fires if there is a silence gap longer than the threshold
- `max_total_s` fires if the total duration exceeds the ceiling

---

## Session Management

### PID tracking

When a session starts, the fleet server captures the LLM process PID via a shell wrapper that emits `FLEET_PID:<pid>` on stdout before the LLM produces any output. The PID is stored in an in-memory registry keyed by member ID.

### Kill-before-spawn

At the start of every `execute_prompt` call, the fleet server kills any stored PID for the target member before spawning the new session. This also applies before each internal retry. This prevents zombie processes from accumulating when:
- SSH connections drop mid-run
- Network blips trigger retries
- The caller dispatches a new prompt before the previous one completes

### Stopped flag

If `stop_prompt` has been called for a member, `execute_prompt` returns an error and does **not** spawn a session. The error message indicates the member was stopped by the PM. The stopped flag is cleared when `execute_prompt` is called again — the next call after a stop will spawn normally (after killing the previous PID).

---

## Model Parameter

`model` accepts either a **tier name** or a **specific model ID**:

| Value | Behavior |
|-------|----------|
| `"cheap"` | Resolves to the cheapest model for the member's provider |
| `"standard"` | Default — resolves to the standard model for the member's provider |
| `"premium"` | Resolves to the highest-capability model for the member's provider |
| Specific ID | Passed directly to the provider (e.g., `"claude-opus-4-7"`) |

Model applies to both new and resumed sessions.

---

## Return Value

Returns a string containing the LLM's output. On failure, returns an error string describing the failure. Internal retries are handled transparently — the caller receives either a success response or a final error.

---

## Examples

```json
{
  "member_name": "dev-worker",
  "prompt": "Run the test suite and fix any failures",
  "timeout_s": 600,
  "max_total_s": 3600
}
```

```json
{
  "member_id": "a1b2c3d4-...",
  "prompt": "Commit all staged changes",
  "resume": false,
  "model": "premium"
}
```
