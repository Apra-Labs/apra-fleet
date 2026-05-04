# Plan: PR #183 Review Response
**Branch:** `sprint/session-lifecycle-oob-fix`
**Date:** 2026-04-26
**Reviewer findings:** 15 issues (#1–#15)

---

## Disposition Summary

| # | Title | Disposition | Rationale |
|---|-------|-------------|-----------|
| 1 | Label injection in shell commands | **FIX** | `credFile` interpolated bare; `escapeDoubleQuoted` doesn't escape spaces/semicolons |
| 2 | `revoke_vcs_auth` ignores `scope_url` | **FIX** | Custom-scope credentials orphaned on revoke; schema needs `scope_url` field |
| 3 | PID check-then-kill race | **FIX** | Async gap allows second call to overwrite PID before first is killed |
| 4 | `dangerouslySkipPermissions` dead field | **FIX** | Never read by any provider; confirmed by grep |
| 5 | `activePid` on Agent type dead weight | **FIX** | No `.activePid` access anywhere in src; separate `_activePids` Map handles this |
| 6 | Duplicated `PROVIDER_HOSTS` map | **FIX** | Identical map in two files; trivial to extract |
| 7 | Duplicated inactivity timer logic | **REBUTTAL** | See below |
| 8 | `credentialSet` accepts negative `ttl_seconds` | **REBUTTAL** | See below |
| 9 | `pidWrapUnix` PID capture fragile | **REBUTTAL** | See below |
| 10 | `LocalStrategy` sends SIGTERM not SIGKILL | **FIX** | SSH path uses `kill -9`; `child.kill()` sends SIGTERM; inconsistency is real |
| 11 | `LocalStrategy` timers not `.unref()`'d | **FIX** | SSH timers have `.unref()` (ssh.ts:149, 159); local doesn't; blocks server shutdown |
| 12 | `.gitignore` adds `CLAUDE.md` | **FIX** | `CLAUDE.md` is tracked (committed since commit `0a01b8f`); gitignore entry is misleading/harmful |
| 13 | `feedback.md` at repo root | **FIX** | Stray review artifact; remove |
| 14 | `console.warn` invisible in MCP | **REBUTTAL** | See below |
| 15 | Empty `afterEach` in test | **FIX** | Credentials leak on test throw; add cleanup |

---

## Fixes — Detail

### #1 — Label injection (BLOCKING)
**Files:** `src/tools/provision-vcs-auth.ts`, `src/tools/revoke-vcs-auth.ts`
**Approach:** Add regex constraint to both schemas:
```typescript
label: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional()
```
This blocks spaces, semicolons, and other shell metacharacters at the API boundary before they reach `gitCredentialHelperWrite`/`gitCredentialHelperRemove` on both Linux and Windows.

### #2 — `revoke_vcs_auth` ignores `scope_url`
**File:** `src/tools/revoke-vcs-auth.ts`
**Approach:** Add `scope_url` to `revokeVcsAuthSchema` (optional, matching provision schema). Replace the hardcoded `scopeUrl = \`https://${host}\`` with `input.scope_url ?? \`https://${host}\``. Pass it through to `service.revoke()`.

### #3 — PID race condition
**File:** `src/tools/execute-prompt.ts`
**Approach:** Add a per-agent in-flight `Set<string>` (agent IDs). Before `tryKillPid`, check if agent ID is already in the set and return an error if so. Add on entry, delete in `finally`. This is a single-module Map mutation — no locks needed given Node.js single-threaded event loop; the guard just prevents the async gap from creating a second spawn.

### #4 — `dangerouslySkipPermissions` dead field
**File:** `src/providers/provider.ts:25`
**Approach:** Remove the field from `PromptOptions`. Grep confirms no provider reads it.

### #5 — `activePid` dead field on Agent type
**File:** `src/types.ts:31`
**Approach:** Remove `activePid?: number` from the `Agent` interface. The in-memory `_activePids` Map in `agent-helpers.ts` is the actual mechanism; the type field is vestigial.

### #6 — Duplicated `PROVIDER_HOSTS`
**Files:** `src/tools/provision-vcs-auth.ts:41-45`, `src/tools/revoke-vcs-auth.ts:18-22`
**Approach:** Create `src/tools/vcs-providers.ts` exporting `PROVIDER_HOSTS`. Both files import from it.

### #10 — SIGTERM vs SIGKILL
**File:** `src/services/strategy.ts:104, 114`
**Approach:** Replace `child.kill()` with `child.kill('SIGKILL')` at both timeout callsites in `LocalStrategy.execCommand`.

### #11 — Timers not `.unref()`'d in LocalStrategy
**File:** `src/services/strategy.ts:103, 113`
**Approach:** Add `inactivityTimer.unref()` after line 103, and `maxTotalTimer.unref()` after line 113, mirroring the SSH implementation at `ssh.ts:149, 159`.

### #12 — `CLAUDE.md` in `.gitignore`
**File:** `.gitignore:14`
**Approach:** Remove the `CLAUDE.md` line. The file is tracked (committed in `0a01b8f`); the gitignore entry creates false confidence that it's untracked and could mislead a future `git rm --cached` cleanup pass.

### #13 — `feedback.md` at repo root
**File:** `feedback.md`
**Approach:** Delete it. It's a stale review artifact not referenced anywhere.

### #15 — Empty `afterEach` in credential test
**File:** `src/tests/credential-scoping-ttl.test.ts` (around line 2423)
**Approach:** Populate `afterEach` with cleanup that deletes any credentials created during the test (call the credential store's delete API or clear the in-memory store). Pattern should match existing `afterEach` blocks elsewhere in the test suite.

---

## Rebuttals

### #7 — Duplicated inactivity timer logic
The two implementations differ materially:
- `ssh.ts`: timer calls `.unref()` and rejects a Promise around stream events from an SSH channel; no process handle.
- `strategy.ts`: timer calls `child.kill()` on a `ChildProcess`; no `.unref()` (issue #11 fixes that).

A shared utility would need to abstract over both "kill a process" and "reject a stream promise" — a forced abstraction. Three similar lines is better than a premature abstraction. The right fix is #11 (add `.unref()`), not extraction.

### #8 — `credentialSet` negative `ttl_seconds` guard
The `ttl_seconds` parameter is validated `positive()` at the Zod schema level in the tool handler before `credentialSet` is ever called. Adding an internal guard would be defensive programming for a scenario that can't happen — exactly the pattern the project conventions prohibit. Trust internal code and framework guarantees; validate at system boundaries only.

### #9 — `pidWrapUnix` fragile PID capture
The current shell snippet:
```sh
{ ${cmd}; } & _fleet_pid=$!; printf 'FLEET_PID:%s\n' "$_fleet_pid"; wait "$_fleet_pid"; exit $?
```
`$!` captures the PID of the last backgrounded job — the braced command group — which IS the correct PID to kill. The reviewer's concern ("fragile if provider command structure changes") is speculative; no such change is planned. A fix without a concrete failure mode is gold-plating.

### #14 — `console.warn` in Gemini/Copilot providers
Surfacing warnings through return values would require changing function signatures across multiple providers and their callers — a refactor larger than this PR's scope. The warnings do reach stderr in non-MCP contexts (dev, test). Addressing this properly belongs in a dedicated observability pass, not bolted onto this session-lifecycle fix.

---

## Blocked Items (need info before acting)

None — all items have enough information to act or rebuttal.

---

## Order of Operations

1. **#1** (blocking security fix) — schema regex in both provision + revoke schemas
2. **#2** — revoke schema + scope_url passthrough
3. **#3** — in-flight agent guard in execute-prompt
4. **#6** — extract PROVIDER_HOSTS (prerequisite untangles #2)
5. **#10, #11** — SIGKILL + .unref() in LocalStrategy
6. **#4, #5** — remove dead fields
7. **#12, #13** — gitignore cleanup, delete feedback.md
8. **#15** — afterEach cleanup in test
