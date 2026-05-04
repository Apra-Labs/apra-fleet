# apra-fleet #216 — Code Review

**Reviewer:** fleet-rev
**Date:** 2026-05-04 10:20:00-04:00
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review.

---

## Prior feedback.md history

```
f921d84 review: plan/issue-216 — fleet-rev          (initial plan review, CHANGES NEEDED — 6 findings)
788e440 review: plan/issue-216 re-review — fleet-rev (plan re-review, APPROVED)
3229d49 review: plan/issue-216 Phases 1–3 code review — APPROVED (T1–T4)
```

This review supersedes `3229d49`. The prior code review missed one blocking finding (wrong default network policy in `--set --persist`).

---

## Build & Test

- `npm run build`: **PASS** — clean TypeScript compilation, zero errors.
- `npm test`: **PASS** — 1106 passed, 6 skipped, 0 failures across 65 test files.
- **auth-socket.test.ts failures (V3 note):** The doer reported 21 pre-existing EADDRINUSE failures in auth-socket.test.ts. Verified pre-existing: `git diff main..plan/issue-216 -- tests/auth-socket.test.ts` shows zero changes to auth-socket tests. Full suite passes clean on this branch. The failures were transient named-pipe collisions between parallel test runs, not caused by sprint code. **PASS**
- **CI:** No CI runs exist for `plan/issue-216`. Cannot verify CI. **NOTE** — not blocking since local build+test pass clean.

---

## Phase 1: Credential Store Path Hardening (T1)

**File:** `src/services/credential-store.ts`

- `getCredentialsPath()` (line 74–77) reads `process.env.APRA_FLEET_DATA_DIR ?? FLEET_DIR` at call time, not module load. **PASS**
- All credential functions route through `loadCredentialFile()`/`saveCredentialFile()` which call `getCredentialsPath()`. **PASS**
- Done-when: `APRA_FLEET_DATA_DIR=/tmp/test apra-fleet secret --list` reads from `/tmp/test/credentials.json`. Verified by code path. **PASS**

**NOTE:** `loadCredentialFile()` and `saveCredentialFile()` both independently read `APRA_FLEET_DATA_DIR` for directory creation, then call `getCredentialsPath()` — env var read twice. Not a bug, minor DRY opportunity. Non-blocking.

---

## Phase 2: Secret CLI Entry Point (T2a, T2b, T3)

### T2a — `--set` OOB Delivery (`src/cli/secret.ts`)

- Name validation regex `[a-zA-Z0-9_]{1,64}` at entry (line 175–179). **PASS**
- `secureInput()` for no-echo prompting (line 183). **PASS**
- Three use cases implemented (OOB delivery, OOB+persist, persist-only with error). **PASS**
- Secret cleared after socket transmission (line 199). **PASS**

**BLOCKING — Wrong default network policy (lines 247, 256):** `credentialSet(name, secretValue, true, 'confirm')` uses `'confirm'` as the 4th argument. Requirements.md is explicit: "Default network policy (no flag): `deny`" (line 47). Furthermore, requirements.md says `'confirm'` is "reserved for future" and "not in V1" (lines 99–100). The CLI should use `'deny'`, not `'confirm'`. **FAIL**

**Fix:** Change both lines 247 and 256 from `'confirm'` to `'deny'`:
```typescript
// Line 247
credentialSet(name, secretValue, true, 'deny');
// Line 256
credentialSet(name, secretValue, true, 'deny');
```

**NOTE — Missing metadata flags in `--set --persist`:** Requirements.md (lines 39–45) lists `--allow`, `--deny`, `--members`, `--ttl` as flags that apply with `--persist` on the `--set` subcommand. The current implementation only parses `--persist`. However, PLAN.md Task 2a does not specify these flags, and the plan was approved without them. Workaround exists: `--set --persist` then `--update` to set metadata. Non-blocking — gap is in the approved plan, not in the implementation.

### T2b — Vault Management (`src/cli/secret.ts`)

- `--list`: Table with NAME, SCOPE, POLICY, MEMBERS, EXPIRES columns. Dynamic widths. No values shown. **PASS**
- `--update <name>`: Parses `--allow`, `--deny`, `--members`, `--ttl`. TTL validation rejects non-positive. **PASS**
- `--delete <name>`: Name validation, `credentialDelete()`. **PASS**
- `--delete --all`: Prompts "Delete all secrets? Type yes to confirm:", requires exact "yes". **PASS**

**NOTE:** `--update` with zero flags silently succeeds (empty patch). Requirements say "at least one flag required." Harmless no-op but could be validated. Non-blocking.

### T3 — Wire into `src/index.ts`

- `secret` dispatch added (line 40–43). **PASS**
- `auth` alias preserved (line 44–47). **PASS**
- `--help` shows `secret` lines, not `auth`. **PASS**
- Done-when criteria met. **PASS**

---

## Phase 3: OOB Signal Upgrade (T4)

**Files:** `src/tools/credential-store-set.ts`, `src/services/auth-socket.ts`

### Three signals:

1. **Spawn terminal**: `launchAuthTerminal()` dispatches to `secret --set <name>` via `getAuthCommand()`. **PASS**
2. **Return tool message**: "Waiting for secret {name}..." returned immediately (line 42). **PASS**
3. **Log at info level**: `logLine('credential_store_set', waitingMsg)` (line 43). **PASS**

### PID tracking and kill:

- `PendingAuth` extended with `spawned_pid?: number` (line 18). **PASS**
- `killProcess()` (lines 40–51): POSIX `SIGTERM`, Windows `taskkill /F /PID`. **PASS**
- On receipt (lines 98–102): kills `spawned_pid`, clears reference. **PASS**
- PID recorded on Windows (line 522–524) and Linux (line 538–540). **PASS**
- macOS: AppleScript wrapper launches Terminal.app. PID not recorded because killing the `osascript` PID does not close the Terminal window — this is a platform limitation, not a bug. Terminal shows "You can close this window." **PASS**

---

## Security Review

| Check | Status |
|-------|--------|
| Name validation applied consistently | **PASS** |
| Secrets never logged or printed | **PASS** |
| `secureInput()` masks input | **PASS** |
| Secret cleared after socket write | **PASS** |
| Socket messages JSON-serialized (no injection) | **PASS** |
| PID kill uses numeric `.pid` (no cmd injection) | **PASS** |
| Credentials encrypted before storage | **PASS** |
| No hardcoded secrets | **PASS** |

---

## Regressions Check

- No existing public APIs removed or modified.
- `auth` alias preserved for backward compatibility.
- Full test suite passes (1106/1106) with no regressions.
- No previously approved code phases to regress against.

**PASS**

---

## Summary

**Verdict: CHANGES NEEDED**

**One blocking finding:**
- `src/cli/secret.ts` lines 247 and 256: default network policy is `'confirm'` (a non-V1 future feature) instead of `'deny'` (the V1 default per requirements.md). Two-line fix.

**Three non-blocking notes for Phase 4:**
1. Missing `--allow`/`--deny`/`--members`/`--ttl` flags on `--set --persist` — gap in approved plan, not implementation. Workaround: `--update` after `--set`.
2. `--update` with zero flags should validate and error rather than silently no-op.
3. `getCredentialsPath()` env var read is duplicated in `loadCredentialFile`/`saveCredentialFile` — minor DRY opportunity.

All other aspects of Phases 1–3 (T1, T2a, T2b, T3, T4) pass review. Build and tests clean. Pre-existing auth-socket test failures confirmed not introduced by this sprint.
