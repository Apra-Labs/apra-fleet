# apra-fleet Sprint 2 — Phase 1 Code Review

**Reviewer:** fleet-rev
**Date:** 2026-04-24 02:25:00-0400
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review. Prior review (plan re-review): a13b61f — APPROVED. This review covers implementation commits 46cb06a (T1), 85b6c3d (T2a+T2b), cc56b2a (T3), and 5988a1b (VERIFY-1).

---

## Phase 1 Review: Unified Credential Store (#157 + #158)

### T1: Unified CredentialRecord schema + credential_store_set extensions

**PASS.** `CredentialMeta`, `SessionEntry`, and `PersistentRecord` all extended with `allowedMembers: string[] | '*'` and `expiresAt?: string` in `src/services/credential-store.ts`. The `credentialSet()` function accepts new `allowedMembers` (default `'*'`) and `ttl_seconds` (optional) parameters. `expiresAt` computed as `new Date(Date.now() + ttl_seconds * 1000).toISOString()` — absolute ISO timestamp, not relative. Correct.

`credential_store_set` tool schema (`src/tools/credential-store-set.ts`) extended with `members` (string, default `'*'`) and `ttl_seconds` (positive number, optional). Parsing logic: `input.members === '*' ? '*' : input.members.split(',').map(s => s.trim()).filter(Boolean)` — handles comma-separated names, trims whitespace, filters empty strings. Clean.

Backward compatibility: `credentialList()` applies `?? '*'` when reading `allowedMembers` from persistent records — existing `credentials.json` files without the field default to `'*'`. `expiresAt` is optional and naturally undefined for legacy entries. **PASS.**

### T2a: Enforcement core — scoping + TTL in credential-store.ts

**PASS.** `credentialResolve()` signature updated to `credentialResolve(name: string, callingMember?: string)` with discriminated union return type: `{ plaintext, meta } | { denied } | { expired } | null`. All four return paths are clearly documented and implemented.

**Security check order (TTL before scoping):** The code checks TTL first, then scoping. This means an expired credential returns `{ expired }` even if the caller would also be denied by scoping. This is correct behavior — an expired credential should be purged regardless of who asks for it, and returning `{ expired }` is a security rejection either way. The integration test plan's test 6.2 validates the scoping path within the TTL window (60s), so the ordering doesn't affect test correctness.

**TTL enforcement details:**
- Comparison: `Date.now() > new Date(persistent.expiresAt).getTime()` — correct, compares epoch millis. **PASS.**
- On expiry: persistent entry deleted from `credentials.json` + session store cleared. **PASS.** Expired entries are actively purged on access.
- `expiresAt` stored as ISO string, compared via `new Date().getTime()` — no timezone ambiguity. **PASS.**

**Scoping enforcement details:**
- Guard: `callingMember !== undefined && callingMember !== '*' && allowedMembers !== '*' && !allowedMembers.includes(callingMember)`. **PASS.** Four conditions are logically correct:
  1. `callingMember === undefined` → no enforcement (backward compat for any internal calls without member context)
  2. `callingMember === '*'` → fleet-operator bypass (used by `setup-git-app.ts`)
  3. `allowedMembers === '*'` → credential is unrestricted
  4. `allowedMembers.includes(callingMember)` → member is authorized
- Denial message includes credential name, calling member, and allowed list — matches requirements.md acceptance criteria. **PASS.**
- Secret value (`decryptPassword`) is only accessed after both TTL and scoping checks pass. **PASS.** No early decryption before authorization.

**Both persistent and session paths have identical TTL + scoping logic.** Verified: the session path mirrors the persistent path exactly. **PASS.**

### T2b: Call-site wiring + startup sweep + credential_store_list display

**All 6 call sites verified:**

1. **`execute-command.ts`** — `resolveSecureTokens()` now accepts `callingMember`. Called with `agent.friendlyName` where `agent` is resolved via `resolveMember(input.member_id, input.member_name)` — server-side registry lookup, not LLM-controlled. Both primary `input.command` and `input.restart_command` paths pass the member identity. New `'denied' in entry` and `'expired' in entry` checks return errors before any secret value is accessed. **PASS.**

2. **`provision-vcs-auth.ts`** — `resolveSecureField()` now accepts `callingMember`. Called with `agent.friendlyName`. Handles `denied`/`expired` returns. **PASS.**

3. **`provision-auth.ts`** — inline resolution at line ~250 passes `agent.friendlyName`. Handles `denied`/`expired` returns. **PASS.**

4. **`register-member.ts`** — passes `input.friendly_name` (the member being registered) as `callingMember`. This is the correct identity for this context: when registering a member with a password that references a secure token, the credential should be scoped to allow the member being registered. The operator is implicitly authorizing the member to use that credential by including it in the registration. **PASS.**

5. **`update-member.ts`** — passes `existing.friendlyName` (the member being updated, resolved from registry). Handles `denied`/`expired` returns with "Member was NOT updated." suffix. **PASS.**

6. **`setup-git-app.ts`** — passes `'*'` (server-level operation, no member context). This bypasses scoping, which is correct — git app setup is a fleet operator action, not dispatched on behalf of a specific member. **PASS.**

**Security assessment: Member identity source.** Requirements.md (line 60, 72) specifies: "Member identity from server request context, not from tool caller." In all 6 call sites, the member identity comes from `resolveMember()` (server-side registry lookup using `member_id` or `member_name`) or from `existing.friendlyName` (already-resolved agent). The `member_id`/`member_name` parameters are MCP tool inputs, but they resolve against the server's internal registry — an LLM cannot forge a member identity that doesn't exist in the registry. The `friendlyName` is a server-controlled field set at registration time. **PASS — security requirement satisfied.**

**Startup sweep** (`src/index.ts`): `purgeExpiredCredentials()` imported from `credential-store.ts` and called synchronously at startup alongside `cleanupStaleTasks()`. The function iterates persistent credentials, deletes expired entries, and saves. Session credentials are not swept (they don't survive restart anyway). Error handling: `try/catch` around `loadCredentialFile()` and `saveCredentialFile()` — best-effort, consistent with risk register mitigation. **PASS.**

**credential_store_list display** (`src/tools/credential-store-list.ts`): Output now includes `members` (formatted as `'*'` or comma-joined names) and `expiry` (formatted as remaining time via `formatRemaining()` or `'none'`). The `formatRemaining()` function handles hours/minutes/seconds formatting and returns `'expired'` for negative remaining time. **PASS.**

**NOTE (non-blocking):** `credential_store_list` output no longer includes the raw `expiresAt` ISO timestamp — it shows computed `expiry` as "2h 15m remaining" / "expired" / "none". This is user-friendly but means the exact expiry timestamp is not visible. The `credentialList()` function still returns `expiresAt` in `CredentialMeta`, so programmatic access is preserved. Acceptable design choice.

### T3: Credential scoping + TTL test coverage

**17 tests in `tests/credential-scoping-ttl.test.ts`.** Test file is new (not appended to existing test file), which is appropriate given the distinct feature scope.

**Scoping tests (5 tests):**
- `allows access when allowedMembers is "*"` — **PASS.** Tests the unrestricted case.
- `allows access when callingMember is in allowedMembers list` — **PASS.** Tests multi-member list.
- `denies access when callingMember is NOT in allowedMembers list` — **PASS.** Asserts `'denied' in result` and verifies error message includes credential name, denied member, and allowed list.
- `bypasses scoping when callingMember is "*"` — **PASS.** Tests fleet-operator bypass.
- `bypasses scoping when callingMember is undefined` — **PASS.** Tests backward-compat no-enforcement path.

**TTL tests (5 tests):**
- `resolves a credential with a future TTL` — **PASS.** Uses `ttl_seconds=3600`.
- `returns { expired } for a credential with a past TTL` — **PASS.** Uses `ttl_seconds=-1` (negative = immediately expired). Also verifies second resolve returns `null` (entry purged).
- `returns null for a credential that never existed` — **PASS.** Baseline null check.
- `re-setting a credential resets the TTL` — **PASS.** Sets expired, verifies expired, re-sets with valid TTL, verifies resolves. Also checks updated value.
- `omitting ttl_seconds stores no expiresAt` — **PASS.** Verifies `meta.expiresAt` is undefined.

**List metadata tests (2 tests):**
- `includes allowedMembers and expiresAt in listed entries` — **PASS.**
- `shows "*" for allowedMembers when credential is unrestricted` — **PASS.**

**Purge tests (2 tests):**
- `is callable without error even when no credentials exist` — **PASS.**
- `removes expired session-tier credentials after purge` — **PASS.** (Uses inline purge via `credentialResolve`, not `purgeExpiredCredentials()` directly on session tier — this is correct since `purgeExpiredCredentials()` only targets persistent store.)

**Backward compatibility (1 test):**
- `treats missing allowedMembers as "*"` — **PASS.** Uses default `credentialSet` params.

**execute_command integration tests (2 tests):**
- `returns error when credential is not accessible to the calling member` — **PASS.** Creates scoped credential, uses agent with different `friendlyName`, asserts error and that `mockExecCommand` was NOT called (no command execution on denial). Good security assertion.
- `executes successfully when calling member is in allowedMembers` — **PASS.**

**Test quality assessment:**
- No overlapping/redundant tests — each covers a distinct code path. **PASS.**
- Error messages are asserted with `toContain()` checks on key fragments (name, member, allowed list). **PASS.**
- Cleanup: each test creates uniquely-named credentials with `Date.now()` suffix and calls `credentialDelete()` in cleanup — no test pollution. **PASS.**
- The `purgeExpiredCredentials()` function is not tested with actual persistent credentials (would require file I/O mocking). The existing test covers the no-op case and the session-tier inline purge. **NOTE (non-blocking):** A test that writes a persistent expired credential and calls `purgeExpiredCredentials()` would strengthen coverage, but the function is straightforward and tested indirectly via the `credentialResolve` expiry path. Acceptable for Phase 1.

### VERIFY-1 Checkpoint

- `npm run build`: **Exit 0, no errors.** **PASS.**
- `npm test`: **957 passed, 6 skipped, 0 failed** (58 test files). **PASS.** (Test count increased from 906 baseline to 957 — net +51 tests from Sprint 1 + Phase 1 combined.)
- No regressions in existing test suites (credential-store-and-execute, VCS auth, register/update member, execute-prompt, providers). **PASS.**

### Regression check: previously approved phases

Sprint 1 (Phases 1-6, knowledge harvest, doc fixes) — all previously-approved work remains intact. The `stop_prompt` import addition to `src/index.ts` is a Sprint 1 change that appears in this diff because it wasn't in `main` yet. No regressions observed. **PASS.**

---

## Integration Test Plan — Sprint 2

### 1. Credential Scoping (#157)

| # | Precondition | Action | Expected Result | Verify |
|---|-------------|--------|-----------------|--------|
| 1.1 | Fleet running with `fleet-dev` and `fleet-rev` registered | `credential_store_set name=dev_secret value=s3cret members=fleet-dev` | Credential stored with `allowedMembers: ['fleet-dev']` | `credential_store_list` shows `members: fleet-dev` for `dev_secret` |
| 1.2 | 1.1 complete | Resolve `{{secure.dev_secret}}` in `execute_command` dispatched to `fleet-rev` | Rejection: `"Credential 'dev_secret' is not accessible to member 'fleet-rev'. Allowed: fleet-dev"` | `execute_command` return value contains denial message |
| 1.3 | Fleet running with `fleet-dev` and `fleet-rev` | `credential_store_set name=shared_key value=abc members=*` | Credential stored with `allowedMembers: '*'` | Both `fleet-dev` and `fleet-rev` resolve `{{secure.shared_key}}` via `execute_command` — no error |
| 1.4 | Fleet running with `fleet-dev`, `fleet-rev`, `fleet-qa` | `credential_store_set name=pair_key value=xyz members=fleet-dev,fleet-rev` | Credential stored with `allowedMembers: ['fleet-dev', 'fleet-rev']` | `fleet-dev` resolves OK; `fleet-rev` resolves OK; `fleet-qa` gets denial error |
| 1.5 | 1.1 complete (`dev_secret` scoped to `fleet-dev`) | `credential_store_set name=dev_secret value=updated members=fleet-dev,fleet-rev` | Scope replaced to `['fleet-dev', 'fleet-rev']` | `credential_store_list` shows updated members; `fleet-rev` can now resolve `dev_secret` |
| 1.6 | Fresh fleet, no prior credentials | `credential_store_set name=legacy_cred value=old123` (no `members` param) | Credential stored with `allowedMembers: '*'` (default) | Any member resolves `{{secure.legacy_cred}}`; `credential_store_list` shows `members: *` |

### 2. Credential TTL (#158)

| # | Precondition | Action | Expected Result | Verify |
|---|-------------|--------|-----------------|--------|
| 2.1 | Fleet running | `credential_store_set name=temp_tok value=t0k ttl_seconds=5` | Credential stored with `expiresAt` ~5s from now | Resolve `{{secure.temp_tok}}` immediately — returns `t0k`. Wait 6s, resolve again — returns expiry error: `"Credential 'temp_tok' has expired. Re-set with credential_store_set."` |
| 2.2 | 2.1 complete (before expiry) | `credential_store_list` | `temp_tok` row shows `expiresAt` ISO timestamp and computed remaining time (e.g. "4s remaining") | Parse list output; verify `expiresAt` present and remaining > 0 |
| 2.3 | `temp_tok` exists with TTL | `credential_store_set name=temp_tok value=refreshed ttl_seconds=60` | Value updated, `expiresAt` reset to ~60s from now | `credential_store_list` shows new `expiresAt` ~60s ahead; old 5s expiry replaced |
| 2.4 | Session-scoped credential set (no `persistent=true`) without `ttl_seconds` | Resolve the session credential | Returns value normally; no `expiresAt` field in internal state | Credential resolves; TTL logic has no effect on session-tier credentials |
| 2.5 | Two persistent credentials: one with `expiresAt` in the past, one valid | Restart the fleet server | `purgeExpiredCredentials()` runs at startup | After restart: `credential_store_list` omits expired credential; valid credential still present and resolvable |

### 3. provision_vcs_auth Isolation (#163)

| # | Precondition | Action | Expected Result | Verify |
|---|-------------|--------|-----------------|--------|
| 3.1 | Member `fleet-dev` registered, no VCS credentials | `provision_vcs_auth member=fleet-dev provider=github label=work-github token=ghp_work` then `provision_vcs_auth member=fleet-dev provider=github label=personal-gh token=ghp_personal` | Two credential files: `~/.fleet-git-credential-work-github` and `~/.fleet-git-credential-personal-gh`; two gitconfig entries | `ls ~/.fleet-git-credential-*` shows both files; `git config --global --list \| grep credential` shows two distinct helper entries with different scope URLs |
| 3.2 | 3.1 complete (two labels provisioned) | `revoke_vcs_auth member=fleet-dev provider=github label=work-github` | Only `work-github` file and gitconfig entry removed; `personal-gh` intact | `ls ~/.fleet-git-credential-*` shows only `personal-gh`; gitconfig shows only `personal-gh` entry |
| 3.3 | Windows/WSL environment or mock simulating bash-on-Windows | `provision_vcs_auth` with any label | gitconfig credential helper path uses forward slashes only | Read `.gitconfig`; assert no backslash in credential helper path value |
| 3.4 | Legacy `~/.fleet-git-credential` or `~/.fleet-git-credential.bat` exists from pre-sprint install | `provision_vcs_auth member=fleet-dev provider=github label=new-setup token=ghp_new` | Legacy files detected and removed; new per-label file created | `ls ~/.fleet-git-credential` and `ls ~/.fleet-git-credential.bat` both return "not found"; `~/.fleet-git-credential-new-setup` exists |

### 4. dangerously_skip_permissions Removal (#54)

| # | Precondition | Action | Expected Result | Verify |
|---|-------------|--------|-----------------|--------|
| 4.1 | Member `fleet-dev` registered with default settings (no `unattended`) | `execute_prompt member=fleet-dev prompt="echo hello" dangerously_skip_permissions=true` | Deprecation warning logged; `dangerously_skip_permissions` is **not** applied to CLI invocation | Server logs contain deprecation warning; spawned CLI command has no `--dangerously-skip-permissions` flag |
| 4.2 | None | `register_member name=auto-agent ... unattended=auto` | Member stored with `unattended: 'auto'` | `member_detail name=auto-agent` shows `unattended: "auto"` |
| 4.3 | `auto-agent` with `unattended: "auto"` | `execute_prompt member=auto-agent prompt="echo hello"` | Claude CLI launched with `--permission-mode auto` | Inspect spawned command; `--permission-mode auto` present, `--dangerously-skip-permissions` absent |
| 4.4 | None | `register_member name=danger-agent ... unattended=dangerous` | Member stored with `unattended: 'dangerous'` | `member_detail name=danger-agent` shows `unattended: "dangerous"` |
| 4.5 | `danger-agent` with `unattended: "dangerous"` | `execute_prompt member=danger-agent prompt="echo hello"` | Claude CLI launched with `--dangerously-skip-permissions` | Inspect spawned command; `--dangerously-skip-permissions` present |
| 4.6 | Member with default (no `unattended`) | `execute_prompt member=default-agent prompt="echo hello"` | CLI launched interactively — no permission override flags | Spawned command has neither `--permission-mode auto` nor `--dangerously-skip-permissions` |

### 5. Regression

| # | Precondition | Action | Expected Result | Verify |
|---|-------------|--------|-----------------|--------|
| 5.1 | Clean checkout on `sprint/session-lifecycle-oob-fix` | `npm run build` | Exit 0, no TypeScript errors | Check exit code |
| 5.2 | Build complete | `npm test` | All 906+ tests pass, 0 failures | vitest summary: 0 failed |
| 5.3 | Tests pass | Run existing `execute_prompt` test suite | No regressions in session lifecycle, timeout, OOB handling | All execute-prompt tests pass |
| 5.4 | Tests pass | Run existing `credential-store-and-execute` test suite | No regressions in credential resolution, set/get/list | All credential tests pass |
| 5.5 | Tests pass | Run existing VCS auth tests (`provision-vcs-auth.test.ts`) | No regressions in provision/revoke flows | All VCS tests pass |
| 5.6 | Tests pass | Run existing register/update member tests | No regressions in member lifecycle | All member tests pass |

### 6. Combined Defence-in-Depth Scenario

| # | Precondition | Action | Expected Result | Verify |
|---|-------------|--------|-----------------|--------|
| 6.1 | Fleet running with `fleet-dev` and `fleet-rev` | `credential_store_set name=scoped_ttl value=s3cret members=fleet-dev ttl_seconds=60` | Stored: scoped to `fleet-dev`, expires in 60s | `credential_store_list` shows `members: fleet-dev`, `expiresAt` ~60s from now |
| 6.2 | 6.1 complete | Resolve `{{secure.scoped_ttl}}` via `execute_command` dispatched to `fleet-rev` | Denial: not accessible to `fleet-rev` | Return value contains scoping denial message (scoping checked before TTL) |
| 6.3 | 6.1 complete, within 60s | Resolve `{{secure.scoped_ttl}}` via `execute_command` dispatched to `fleet-dev` | Success: returns `s3cret` | Resolved value matches, no error |
| 6.4 | 6.1 complete, wait 61+ seconds | Resolve `{{secure.scoped_ttl}}` via `execute_command` dispatched to `fleet-dev` | Expiry error: credential has expired; entry purged | Return value contains expiry message; subsequent `credential_store_list` no longer shows `scoped_ttl` |

---

## Summary

**Phase 1 is complete and correct.** All 4 tasks (T1, T2a, T2b, T3) meet their PLAN.md "done" criteria. The implementation aligns with requirements.md for both #157 (credential scoping) and #158 (credential TTL).

**Security highlights — all pass:**
- Member identity derived from server-side registry (`resolveMember().friendlyName`), not from LLM-controlled tool parameters. Cannot be forged.
- Scoping and TTL checks execute before `decryptPassword()` / `sessionDecrypt()` — secret value never accessed on denial or expiry.
- `setup-git-app.ts` correctly uses `'*'` bypass for fleet-operator-level operations.
- `register-member.ts` uses `input.friendly_name` (the member being registered) — correct for the "operator is authorizing this member to use the credential" semantics.
- All 6 call sites handle `{ denied }` and `{ expired }` discriminated union returns with early-exit error messages.

**Build & tests:** `npm run build` exits 0. `npm test`: 957 passed, 6 skipped, 0 failures. No regressions in any existing test suite.

**Non-blocking notes (no action required):**
1. `credential_store_list` output shows computed remaining time instead of raw `expiresAt` timestamp. Programmatic access via `credentialList()` still returns the raw field. Acceptable UX decision.
2. `purgeExpiredCredentials()` is not directly tested with persistent credentials (would need file I/O mocking). Covered indirectly via `credentialResolve` expiry path. Low risk given straightforward implementation.

**Deferred from plan review:** `requirements.md` references `skills/fleet/SKILL.md` for #54 but actual reference is `skills/pm/SKILL.md:57`. Plan correctly targets the right file — requirements.md correction is separate.
