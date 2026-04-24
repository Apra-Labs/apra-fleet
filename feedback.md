# apra-fleet Sprint 2 — Final Code Review (Re-review)

**Reviewer:** fleet-rev
**Date:** 2026-04-24 09:10:00-0400
**Verdict:** APPROVED

> Prior review: ec753de. Blocking finding addressed in commit 7cd7545.

---

## Blocking Finding Resolution

**PASS — all 3 flag cases verified.**

The doer's fix in `7cd7545` correctly resolves the blocking finding:

1. **Destructuring fix** (`windows.ts:104`): Changed from `dangerouslySkipPermissions` to `unattended`. The function now reads the correct property from `PromptOptions`. **PASS.**
2. **`unattended === 'auto'`** (`windows.ts:115-116`): Emits `--permission-mode auto`. **PASS.**
3. **`unattended === 'dangerous'`** (`windows.ts:117-118`): Delegates to `provider.skipPermissionsFlag()`, which is provider-aware (same pattern as the `'dangerous'` path on Linux). **PASS.**
4. **`unattended === false` / `undefined`** (no else branch): No permission flag emitted. **PASS.**

Four Windows-specific unit tests (`tests/unattended-mode.test.ts:277-310`) cover all four `unattended` values (`'auto'`, `'dangerous'`, `false`, `undefined`), each asserting correct flag presence/absence.

**Note (deferred, non-blocking):** The `'auto'` branch hardcodes `--permission-mode auto` rather than delegating to a provider method. On Linux, `LinuxCommands.buildAgentPromptCommand` delegates entirely to `provider.buildPromptCommand(opts)`, which handles `'auto'` per-provider (Claude: `--permission-mode auto`, Codex: `--ask-for-approval auto-edit`, Gemini/Copilot: no-op with warning). If multi-provider Windows support becomes a priority, a follow-up issue should add an `autoModeFlag()` abstraction to `ProviderAdapter` and use it here. Today, all Windows fleet members use Claude, so this has no practical impact.

## All Phases — Previously APPROVED (no regression)
Build: PASS (npm run build clean)
Tests: PASS (all 984 tests pass, 6 skipped, 0 failures — 59 test files)

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

### 4. Unattended Mode (#54)

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
| 5.2 | Build complete | `npm test` | All 984 tests pass, 0 failures | vitest summary: 0 failed |
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

**Verdict: APPROVED.** The blocking finding from ec753de is fully resolved. Commit 7cd7545 correctly replaces `dangerouslySkipPermissions` with `unattended` in the Windows `buildAgentPromptCommand` destructuring, and implements the three-way branching (`'auto'` → `--permission-mode auto`, `'dangerous'` → `provider.skipPermissionsFlag()`, default → no flag). Four unit tests confirm all cases. Build and all 984 tests pass with no regressions.

**Deferred item:** The `'auto'` path hardcodes `--permission-mode auto` rather than delegating to a provider-specific method. This has no practical impact today (all Windows members use Claude) but should be addressed if multi-provider Windows support is needed. Recommend a follow-up issue to add `autoModeFlag()` to `ProviderAdapter`.
