# `stop_agent` Tool API Reference

Terminates the active LLM session for a fleet member and prevents further dispatches until the next explicit `execute_prompt`.

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
   - Windows: `taskkill /F /PID <pid>`
   Kill errors (e.g., process already gone) are swallowed — the operation always proceeds to step 2.

2. **Set stopped flag** — marks the member as stopped in an in-memory registry. This flag prevents subsequent `execute_prompt` calls from spawning until explicitly cleared.

3. **Return status** — returns a human-readable string indicating what happened.

---

## Return Values

| Condition | Return message |
|-----------|---------------|
| Active PID found and killed | `🛑 Agent "<name>" stopped (killed PID <pid>). Next execute_prompt will require explicit intent.` |
| No active session | `🛑 Agent "<name>" marked stopped (no active session was running). Next execute_prompt will require explicit intent.` |
| Member not found | Error string describing the lookup failure |

---

## Effect on `execute_prompt`

After `stop_agent` is called, any `execute_prompt` call for that member returns an error message indicating the member was stopped, without spawning a session.

The stopped flag is cleared automatically when the next `execute_prompt` call is made. The call that clears the flag **does** spawn normally — there is no confirmation step.

This means `stop_agent` acts as a **single-prompt interlock**: the PM must explicitly re-dispatch (issue a new `execute_prompt`) to resume the member.

---

## What This Stops

`stop_agent` kills the LLM process running on the **member machine** (the process tracked in the PID registry). It does not directly terminate the local Claude Code background agent that issued the dispatches.

The stopped flag handles the background agent case indirectly: once set, the background agent's subsequent `execute_prompt` calls return errors rather than spawning new sessions, which terminates the dispatch loop.

---

## No-op Safety

Calling `stop_agent` when no session is active is safe — it simply sets the stopped flag and returns the "no active session" message. There is no error condition for a clean no-op call.

---

## Example

```json
{
  "member_name": "dev-worker"
}
```

Response:
```
🛑 Agent "dev-worker" stopped (killed PID 48291). Next execute_prompt will require explicit intent.
```
