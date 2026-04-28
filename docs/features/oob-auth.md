# OOB Auth — Terminal Mechanism and SSH/Headless Fallback

Covers the design of the out-of-band credential collection system and the SSH/headless fix shipped in Sprint 1 (#106).

---

## Background: Why OOB Auth Exists

Credentials (passwords, API keys, confirmation prompts) must not pass through the LLM — the model must never see plaintext secrets. The OOB (out-of-band) mechanism collects credentials in a separate UI context, passes them over a local socket, and delivers them to the fleet server without them appearing in the prompt stream.

---

## Unix Domain Socket (UDS) Architecture

The fleet server creates a socket at `~/.apra-fleet/data/auth.sock` (Linux/macOS) or a Windows named pipe equivalent. This is a filesystem object — any process running as the same user on the same machine can reach it.

**Flow:**

1. A tool requiring a credential calls `collectOobInput()` (in `src/services/auth-socket.ts`).
2. `collectOobInput` registers a pending auth request with a 10-minute TTL via `createPendingAuth()`.
3. It calls `launchAuthTerminal()` to open a terminal window running `apra-fleet auth <memberName>`.
4. The launched process prompts the user, reads input with masked display (LLM cannot see it), and sends the value over the UDS as a JSON message.
5. `waitForPassword()` races the socket delivery against a cancellation signal.
6. On receipt, the credential is consumed from the pending store and returned to the caller.

**Key property:** The UDS socket is a filesystem object — no GUI or display server is required to write to it. Any process on the machine, including one launched in a second SSH terminal, can deliver credentials.

---

## Display Detection — The #106 Fix

### Problem

`launchAuthTerminal` attempted GUI terminal emulators in order (`gnome-terminal → xterm → x-terminal-emulator`) on Linux. On SSH sessions:

- `which gnome-terminal` succeeds even when `$DISPLAY` is unset (the binary exists but can't connect).
- Spawn succeeds → process exits immediately → **"❌ Password entry cancelled"** error fires.
- The error implies the user cancelled, not that the environment is headless.

The same issue on Windows: `start /wait cmd.exe` opens a window on the physical console, invisible to the SSH user.

### Solution

Two environment-variable checks added to `auth-socket.ts`:

```typescript
// Returns true when X11 or Wayland display is available
export function hasGraphicalDisplay(): boolean {
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

// Returns true when running on an interactive Windows desktop session
// SSH sessions and service contexts have SESSIONNAME !== 'Console'
export function hasInteractiveDesktop(): boolean {
  return process.env.SESSIONNAME === 'Console';
}
```

`launchAuthTerminal` checks these **before** attempting any terminal emulator:

- **Linux, `$DISPLAY` and `$WAYLAND_DISPLAY` both unset:** Skip all GUI terminal emulators. Return actionable fallback message.
- **Windows, `SESSIONNAME !== 'Console'`:** Skip `cmd.exe start /wait`. Return actionable fallback message.
- **GUI desktop (display available):** Unchanged — auto-launches terminal as before.

### Why check env vars rather than probing the socket

Probing (attempting a spawn and checking exit code) is what caused the misleading error in the first place. Env var checks are fast, zero-side-effect, and accurate for the cases that matter: X11/Wayland forwarding sets `$DISPLAY`, and Windows service contexts have a distinct `SESSIONNAME`.

Edge case accepted: X11 forwarding where `$DISPLAY` is set but the forwarded display is unreachable. This is acceptable — if the terminal fails to launch, existing fallback logic catches it, and a user with X11 forwarding active almost certainly has a working display.

---

## The `! apra-fleet auth <name>` Pattern

On headless environments, the fallback message instructs the user to run:

```
! apra-fleet auth <actual-member-name>
```

The `!` prefix is the Claude Code "run in shell" operator — it executes the command in the user's terminal without passing it to the LLM. This is the **single-terminal approach**: the user does not need to open a second window; they run the auth command inline in the same Claude Code session.

The message includes the **actual member name** (not a placeholder). The member name is available at the point `launchAuthTerminal` is called — it is passed as the `memberName` parameter.

**Full fallback message text (Linux headless):**
```
fallback:No graphical display detected (SSH or headless session).

Run this in a separate terminal:
  ! apra-fleet auth <memberName>

Alternatively, pre-store the value with credential_store_set and reference it as {{secure.NAME}} in the credential field.
```

The `fallback:` prefix is a protocol marker consumed by `collectOobInput` to distinguish the fallback path from a successful terminal launch. It is stripped before the message reaches the user.

---

## Fallback: Second Terminal

When the `!` operator isn't available or the user is in a non-Claude Code context, the fallback instruction is to open a second terminal and run `apra-fleet auth <memberName>` there. Because the UDS socket is a filesystem object, the second terminal's `apra-fleet auth` process connects to the same socket and delivers the credential to the waiting fleet server — no GUI required.

---

## Re-entrancy and Stale State

If a terminal launch fails (fallback path), `collectOobInput` cleans up the pending auth state:
- Clears the `passwordWaiters` entry for the member
- Without this, `hasPendingAuth()` returns `true` on the next call, the re-entrant path skips `launchAuthTerminal`, and the call hangs waiting for a credential that will never arrive.

This cleanup ensures retries always start fresh.
