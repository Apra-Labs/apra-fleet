# Requirements: OOB Credential Collection Unification

## Context

Secret/password collection from the user currently has two divergent code paths:

1. `src/cli/secret.ts` — `apra-fleet secret --set NAME` — has the full reveal UX (already implemented)
2. `src/cli/auth.ts` — `apra-fleet auth <name>` — bare `secureInput()`, no reveal UX

Both are spawned as OOB terminal subprocesses by `auth-socket.ts`. The split is arbitrary:
- The fleet server blocks in both cases (via socket wait)
- API keys already route through `secret --set`; SSH passwords route through `auth` — inconsistent
- The reveal UX lives inline in `handleSet()` in `secret.ts` rather than as a shared utility

**Goal:** One shared `collectSecret()` function used by all credential collection paths. The `auth` subcommand handles `--confirm` (network egress yes/no) only — it is NOT a credential collection path.

---

## Credential Cases

### Named / Persistent
User explicitly sets or updates a stored credential.
- Entry: `apra-fleet secret --set <NAME>`
- After collection: stored in credential vault

### Anonymous / Transient
A tool call needs a credential inline (SSH password, API key, token). Collected OOB, delivered over socket, discarded.
- Entry: OOB terminal spawned automatically → `apra-fleet secret --set <NAME> --prompt "<context>"`
- `--prompt` overrides the display text so the user sees human-readable context:
  - SSH: `"SSH password for akhil@192.168.1.102"`
  - GitHub PAT: `"Enter your GitHub PAT"`
  - API key: `"Enter API key for claude"`

---

## UX — Already Implemented in `secret.ts`

The reveal loop (v/Esc/Enter, in-place ANSI, dim hints) is already built and working in `handleSet()`. This is the reference implementation to extract into `collectSecret()` — do not change the behaviour.

---

## What Needs to Be Built

### 1. `src/utils/oob-timeout.ts` — new
```typescript
export const OOB_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
```
Single source of truth. Imported by both `auth-socket.ts` and `collect-secret.ts`. No other timeout values for OOB credential collection may be hardcoded.

### 2. `src/utils/collect-secret.ts` — new
Extract the reveal loop out of `handleSet()` verbatim into:
```typescript
export async function collectSecret(prompt: string): Promise<string>
```
Add one thing not currently in `handleSet()`: an inactivity timeout using `OOB_TIMEOUT_MS`:
```typescript
const timeout = setTimeout(() => {
  process.stderr.write('\n  ⏱ Timed out. Closing.\n');
  process.exit(1); // treated identically to Ctrl+C by the server
}, OOB_TIMEOUT_MS);
// ... collect ...
clearTimeout(timeout); // clear on successful entry
```

### 3. `src/cli/secret.ts` — two changes
- Add `--prompt <text>` flag: when present, use it as the display prompt instead of `"Enter value for <NAME>: "`
- Replace the inline reveal loop in `handleSet()` with `collectSecret(prompt)`
- Everything else (persist logic, socket delivery) unchanged

### 4. `src/cli/auth.ts` — strip to `--confirm` only
Remove the password/API key collection branches entirely. Only the `--confirm` (network egress yes/no) handler remains.

### 5. `src/services/auth-socket.ts` — three changes

**a) `getAuthCommand()` — unify routing**
Currently routes SSH passwords to `auth <name>` and API keys to `secret --set <name>`. Route ALL credential collection to:
```
secret --set <name> [--prompt "<context>"] [--ask-persist]
```
Remove the `auth` routing for password/API key modes.

**b) `waitForPassword()` — kill PID on timeout**
When the timeout fires, kill the spawned terminal before rejecting:
```typescript
const pending = pendingRequests.get(memberName);
if (pending?.spawned_pid) killProcess(pending.spawned_pid);
```
Also fix existing bug: `spawned_pid` is currently only stored for API key mode (lines 584, 600). Store it for ALL credential collection modes.

**c) Add `cancelPendingAuth(memberName)` — new export**
```typescript
export function cancelPendingAuth(memberName: string): void {
  const pending = pendingRequests.get(memberName);
  if (pending?.spawned_pid) killProcess(pending.spawned_pid);
  const waiter = passwordWaiters.get(memberName);
  if (waiter) { clearTimeout(waiter.timer); waiter.reject(new Error('cancelled')); }
  passwordWaiters.delete(memberName);
  pendingRequests.delete(memberName);
}
```

### 6. `src/tools/stop-prompt.ts`
Call `cancelPendingAuth(memberName)` when stopping a member's prompt session, so any waiting OOB terminal is also killed.

---

## OOB Wait Exit Conditions

All conditions reduce to: **kill spawned PID → waiter resolved/rejected → pending request cleared**.

| # | Condition | Who handles it |
|---|-----------|----------------|
| 1 | User enters value | Subprocess delivers via socket → waiter resolved |
| 2 | User Ctrl+C | Subprocess exits code 1 → cancellationPromise rejects |
| 3 | `secret --set` from another terminal | Any process delivers via socket → waiter resolved |
| 4 | Server-side timeout | `waitForPassword` timer → `killProcess(spawned_pid)` → waiter rejected |
| 5 | LLM StopTask / MCP disconnect | `cancelPendingAuth()` → `killProcess(spawned_pid)` → waiter rejected |
| 6 | Subprocess inactivity | `setTimeout(process.exit(1), OOB_TIMEOUT_MS)` in `collectSecret()` → same as case 2 |

---

## Files to Change

| File | Change |
|------|--------|
| `src/utils/oob-timeout.ts` | **new** — `OOB_TIMEOUT_MS` constant |
| `src/utils/collect-secret.ts` | **new** — extract reveal loop + add inactivity timeout |
| `src/cli/secret.ts` | add `--prompt` flag; call `collectSecret()` |
| `src/cli/auth.ts` | strip to `--confirm` only |
| `src/services/auth-socket.ts` | unify routing; store `spawned_pid` always; kill PID on timeout; add `cancelPendingAuth` |
| `src/tools/stop-prompt.ts` | call `cancelPendingAuth` on stop |
| `tests/secret-cli.test.ts` | mock `collectSecret` instead of inline stdin stubs |
| `tests/auth-socket.test.ts` | update command assertions; add tests for `cancelPendingAuth`, PID kill on timeout |

---

## What Does NOT Change

- The reveal UX behaviour (already correct in `secret.ts`)
- The socket protocol (IPC between subprocess and server)
- The `--confirm` (network egress) flow
- The `--persist` and `--ask-persist` flags on `secret --set`
