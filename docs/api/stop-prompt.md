# `stop_prompt` Tool API Reference

Terminates the active LLM session for a fleet member.

---

## Input Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `member_id` | `string` | one of | UUID of the target member |
| `member_name` | `string` | one of | Friendly name of the target member |

Either `member_id` or `member_name` must be provided.

---

## Behavior

1. **Kill active process** — if a PID is stored for the member (from a prior `execute_prompt`), issues a platform-appropriate kill command:
   - Unix: `kill -9 <pid>`
   - Windows: `taskkill /F /T /PID <pid>`
   Kill errors (e.g., process already gone) are swallowed — the operation always proceeds to step 2.

2. **Return status** — returns a human-readable string indicating what happened.

---

## Return Values

| Condition | Return message |
|-----------|---------------|
| Active PID found and killed | `🛑 Agent "<name>" stopped (killed PID <pid>).` |
| No active session | `🛑 Agent "<name>" stopped (no active session was running).` |
| Member not found | Error string describing the lookup failure |

---

## Effect on `execute_prompt`

After `stop_prompt` kills the process, the next `execute_prompt` call proceeds immediately.

Always follow `stop_prompt` with `resume=false` to start a fresh session — the session state after a kill is unreliable.

---

## What This Stops

`stop_prompt` kills the LLM process running on the **member machine** (the process tracked in the PID registry). It does not directly terminate the local Claude Code background agent that issued the dispatches. Always call `TaskStop` on the dispatching agent after calling `stop_prompt` — the member process is already dead, and TaskStop prevents the agent from re-dispatching.

---

## No-op Safety

Calling `stop_prompt` when no session is active is safe — it returns the "no active session" message. There is no error condition for a clean no-op call.

---

## Example

```json
{
  "member_name": "dev-worker"
}
```

Response:
```
🛑 Agent "dev-worker" stopped (killed PID 48291).
```
