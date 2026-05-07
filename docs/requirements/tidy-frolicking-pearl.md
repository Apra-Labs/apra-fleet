# Plan: Unify credential collection into `collectSecret()`

## Context
Secret/password collection from the user currently has two divergent CLI entry points:
- `secret.ts` (`apra-fleet secret --set NAME`) — has the full reveal UX
- `auth.ts` (`apra-fleet auth <name>`) — bare `secureInput()`, no reveal UX

Both are spawned as OOB terminal subprocesses by `auth-socket.ts`. The split is arbitrary — the server blocks in both cases. API keys already use `secret --set`; only SSH passwords use `auth`. This inconsistency is the bug.

The fix: one shared utility, one CLI entry point. `auth.ts` is deleted (confirm-only stub remains).

## Design

### Two credential cases, same UX
- **Named/persistent** (`secret --set MyPass`): collect → persist
- **Anonymous/transient** (`register_member`, `provision-*`): collect → deliver via socket → discard

Both show identical UX. The `prompt` string carries the human-readable context:
- Named: `"Enter value for MyPass: "`
- SSH: `"SSH password for akhil@192.168.1.102: "`
- GitHub PAT: `"Enter your GitHub PAT: "`

The reveal line mirrors the prompt exactly:
```
√ SSH password for akhil@192.168.1.102:  *****
```

### OOB wait exit conditions
All exit conditions reduce to: **kill spawned PID → server sees exit ≠0 → single cleanup path**.

| # | Condition | Mechanism |
|---|-----------|-----------|
| 1 | User enters value | Socket delivers → waiter resolved |
| 2 | User Ctrl+C | Subprocess exits code 1 → cancellationPromise rejects |
| 3 | `secret --set` from another terminal | Same socket path, any process delivers |
| 4 | Timeout | `waitForPassword` timer fires → `killProcess(spawned_pid)` → reject waiter |
| 5 | LLM StopTask / MCP disconnect | `cancelPendingAuth(name)` → `killProcess(spawned_pid)` → reject waiter |
| 6 | Subprocess inactivity timeout | `setTimeout(process.exit(1), OOB_TIMEOUT_MS)` in `collectSecret()` → same as Ctrl+C |

### Single timeout constant (DRY)
```typescript
// src/utils/oob-timeout.ts
export const OOB_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
```
Imported by both `auth-socket.ts` (server wait) and `collect-secret.ts` (subprocess inactivity).

### `--confirm` (network egress yes/no) is NOT credential collection
Stays as a separate thin handler — not part of `collectSecret()`.

## Changes

### 1. `src/utils/oob-timeout.ts` — new
Single exported constant `OOB_TIMEOUT_MS = 5 * 60 * 1000`.

### 2. `src/utils/collect-secret.ts` — new
```typescript
export async function collectSecret(prompt: string): Promise<string>
```
Contains:
- `readKey()` helper (raw stdin, single keypress)
- Inactivity timeout: `setTimeout(process.exit(1), OOB_TIMEOUT_MS)` — cleared on successful entry
- `while(true)` loop with `secureInput({ prompt })`
- Hint: `[Enter] proceed  [v] view  [Esc] re-enter` (dim)
- v/V in-place reveal + `[Enter] confirm  [Esc] re-enter` (dim)
- ANSI cursor-up/clear sequences
- Returns confirmed plaintext value

### 3. `src/cli/secret.ts` — refactor `handleSet()`
- Add `--prompt <text>` flag to override display prompt (used by OOB spawner for context strings)
- Replace inline reveal loop with `collectSecret(prompt)`
- Rest unchanged (persist logic, socket delivery)

### 4. `src/cli/auth.ts` — strip to `--confirm` only
Remove password/API key collection entirely. Only `--confirm` (egress yes/no) remains.

### 5. `src/services/auth-socket.ts` — three changes
**a) `getAuthCommand()`** — route ALL credential collection to `secret --set`:
```
secret --set <name> [--prompt "<context>"] [--ask-persist]
```
Remove `auth` routing for password mode.

**b) `waitForPassword()`** — on timeout, kill spawned PID before rejecting:
```typescript
if (pending?.spawned_pid) killProcess(pending.spawned_pid);
```
Also fix bug: `spawned_pid` currently only stored for API key mode — store it always.

**c) Add `cancelPendingAuth(memberName)`** — new export:
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
Wire to `stop_prompt` tool and MCP disconnect handler.

### 6. Tests
- `tests/secret-cli.test.ts` — mock `collectSecret` instead of inline stdin stubs
- `tests/auth-socket.test.ts` — update command string assertions (`auth` → `secret --set`); add tests for `cancelPendingAuth`, PID kill on timeout, subprocess timeout constant

## Files touched
| File | Change |
|------|--------|
| `src/utils/oob-timeout.ts` | new — single timeout constant |
| `src/utils/collect-secret.ts` | new — shared collect+reveal UX |
| `src/cli/secret.ts` | add `--prompt` flag; replace inline loop with `collectSecret()` |
| `src/cli/auth.ts` | strip to `--confirm` only |
| `src/services/auth-socket.ts` | unify routing; fix PID storage; add `cancelPendingAuth`; kill PID on timeout |
| `src/tools/stop-prompt.ts` | call `cancelPendingAuth` on stop |
| `tests/secret-cli.test.ts` | mock update |
| `tests/auth-socket.test.ts` | command + cancel + timeout tests |

## Verification
1. `npm test` — full suite green
2. Manual: `apra-fleet secret --set TestPass` — reveal UX, same as before
3. Manual: register remote member `auth_type=password`, no password → OOB terminal opens → shows `"SSH password for akhil@192.168.1.102"` → same reveal UX
4. Manual: open OOB terminal, wait 5 min without typing → auto-closes
5. Manual: open OOB terminal, call `stop_prompt` → terminal killed immediately
6. `npm run build:binary` — SEA binary clean
