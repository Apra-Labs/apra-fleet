# OOB Credential Collection

Out-of-band (OOB) credential collection is how fleet gathers secrets from the user without ever exposing them to the LLM, chat history, or logs. When a tool needs a secret it doesn't have, fleet opens a separate terminal window on the user's desktop, waits for input, and receives the value over a local socket — the secret never passes through the server's main process or any log file.

---

## When OOB Is Triggered

OOB collection is triggered in two situations:

**Explicit storage** — the user directly asks fleet to store a credential:
```
apra-fleet secret --set MyPass
```

**Implicit / on-demand** — a tool call needs a credential it doesn't have:
- `register_member` with SSH password auth and no password provided → OOB opens with the SSH context as the prompt
- Any `{{secure.NAME}}` reference where `NAME` is not yet in the store → OOB opens, user is asked whether to persist the value after entry
- `credential_store_set` tool call → OOB always opens

In all cases the UX is identical — only the prompt text changes to give the user context about what they're entering.

---

## The Collection UX

A terminal window opens with a masked input field. The prompt describes what is being collected (e.g. `SSH password for akhil@192.168.1.102` or `Enter value for MyPass`).

To avoid typing errors, users can press **v** to reveal the entered value in place before confirming. Pressing **Esc** clears the field and re-enters from scratch. Pressing **Enter** confirms.

If the terminal is left idle for 5 minutes without input it closes automatically — the waiting tool call fails cleanly, the same as if the user had pressed Ctrl+C.

---

## How the Secret Is Delivered

Once confirmed, the value is sent over a local socket directly to the waiting fleet server process. It is never written to disk unencrypted, never appears in any log, and is zeroed from memory immediately after delivery. The terminal closes.

If the user opts to persist the value (either via `--persist` flag or when prompted), it is encrypted and stored in the local credential vault. Persisted credentials are referenced as `{{secure.NAME}}` in subsequent tool calls.

---

## Persistence and Network Policy

A credential can be **session-only** (discarded after delivery) or **persistent** (survives server restarts). When stored persistently, a **network policy** controls how it may be used:

| Policy | Effect |
|--------|--------|
| `allow` (default) | No restriction — credential can be used in any command |
| `confirm` | Fleet prompts before allowing a command that uses this credential to make network calls |
| `deny` | Commands that would make network calls while using this credential are blocked |

The policy can be updated at any time without re-entering the secret:
```
apra-fleet secret --update MyPass --deny
```

---

## Exit Conditions

The OOB wait resolves in any of these ways — all are handled identically by the server:

1. **User enters value** — delivered via socket, waiter resolved, terminal closes
2. **User presses Ctrl+C** — terminal exits, tool call fails with a clear error
3. **Value delivered from another terminal** — another `apra-fleet secret --set NAME` call delivers the value; the auto-spawned terminal is closed automatically
4. **Server-side timeout** — server gives up after 5 minutes, closes the terminal, tool call fails
5. **LLM session stopped** — if the session that triggered OOB is cancelled, the terminal is killed immediately
6. **Subprocess inactivity** — terminal auto-closes after 5 minutes of no input (same outcome as Ctrl+C)
