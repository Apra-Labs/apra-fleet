# apra-fleet Sprint 2 — Phase 2 Code Review

**Reviewer:** fleet-rev
**Date:** 2026-04-24 03:05:00-0400
**Verdict:** CHANGES NEEDED

> Prior review history: `git log --oneline -- feedback.md` shows Phase 1 review at bec977d (APPROVED). This review covers Phase 2 commits b8d72f0 (T4) and eab2944 (T5), plus VERIFY-2 at b24773d.

---

## Phase 1 (previously APPROVED — no regressions check)

**PASS.** All Phase 1 tests continue to pass — 964 total tests, 6 skipped, 0 failures across 58 test files. The credential scoping + TTL tests in `tests/credential-scoping-ttl.test.ts` all pass. No regressions detected in any existing suite.

---

## Phase 2 Review: provision_vcs_auth Isolation (#163)

### 1. Label isolation — PASS

Two `provision_vcs_auth` calls with different labels produce independent files and gitconfig entries. Verified in code and tests:

- **linux.ts:204-207**: `credFile = label ? ~/.fleet-git-credential-${label} : ~/.fleet-git-credential` — each label produces a distinct file path.
- **gitconfig entry uses `scopeUrl` as key**: `git config --global --add "credential.${credUrl}.helper" ${credFile}` — each label's `scopeUrl` creates a separate gitconfig section.
- **Test confirmation**: `vcs-auth.test.ts` "deploy with different labels creates distinct credential files" — asserts `execCalls[0]` contains `fleet-git-credential-work-github` with `credential.https://github.com/work-org.helper`, and `execCalls[1]` contains `fleet-git-credential-personal-github` with `credential.https://github.com/personal.helper`. **PASS.**
- **Cross-provider coexistence tested**: "two providers with different labels coexist in gitconfig" — GitHub + Azure DevOps deploy with different labels and scope URLs, verified independent. **PASS.**
- No shared state or naming collision — each label is independently named, gitconfig keyed by distinct scope URL.

### 2. scope_url correctness — PASS

- **provision-vcs-auth.ts:140**: `scopeUrl = input.scope_url ?? https://${host}` — defaults to host-level URL if not specified, allows org-scoped override.
- **linux.ts:207**: `git config --global --replace-all "credential.${credUrl}.helper" ""` followed by `--add` — uses `scopeUrl` as the gitconfig credential URL key, not just the host.
- **Git's most-specific-prefix-wins rule**: A `scope_url` of `https://github.com/my-org` will take priority over a broader `https://github.com` entry for any repo under `my-org`. This is correct per `git-credential` documentation.
- **Test**: `vcs-auth.test.ts` asserts `credential.https://github.com/work-org.helper` in the command output. **PASS.**

### 3. Forward-slash fix — PASS

- **windows.ts:237**: `$helperPath = "$env:USERPROFILE\\${credFileName}.bat" -replace '\\\\','/'; git config --global --add 'credential.${credUrl}.helper' $helperPath`
- The PowerShell `-replace '\\\\','/'` regex replaces all backslashes with forward slashes in the path before writing to gitconfig. This is correct — Windows native git and WSL git both accept forward slashes.
- **Linux/macOS**: `linux.ts` uses `~/.fleet-git-credential-<label>` which is already forward-slash (Unix paths). No fix needed. **PASS.**
- **No dedicated test for forward-slash on Windows.** However, the Windows path construction in the code is explicit via `-replace`. The `windows-credential-helper.test.ts` file exists but doesn't specifically test the forward-slash replacement in the Phase 2 addition. **Non-blocking** — the fix is a single PowerShell `-replace` and is straightforward.

### 4. Legacy migration — PASS with one finding

- **provision-vcs-auth.ts:156-159**: Before deploying, calls `cmds.gitCredentialHelperRemove(host)` (no label, no scopeUrl) which removes the legacy `~/.fleet-git-credential` file and the old `credential.https://<host>.helper` gitconfig entry.
- **Best-effort**: wrapped in `try/catch { /* best-effort */ }` — if the legacy file doesn't exist, no error.
- **Both file AND gitconfig entry removed**: `gitCredentialHelperRemove` without label/scopeUrl targets the old unnamed file path and the `https://<host>` gitconfig key. **PASS.**
- **Windows legacy**: `windows.ts gitCredentialHelperRemove` without label targets `.fleet-git-credential.bat` (the old Windows name). **PASS.**

### 5. callingMember preservation — PASS

- **provision-vcs-auth.ts:19**: `function resolveSecureField(value: string, callingMember: string)` — T2b signature preserved.
- **provision-vcs-auth.ts:26**: `credentialResolve(name, callingMember)` — passes member identity through.
- **provision-vcs-auth.ts:106**: `resolveSecureField(resolvedInput[field]!, agent.friendlyName)` — calls with `agent.friendlyName` from T2b.
- T4 restructured the file but did NOT overwrite or remove the T2b callingMember threading. **PASS.**

### 6. revoke_vcs_auth correctness — **BLOCKING FINDING**

**File isolation: PASS.** Revoking label A correctly targets only `~/.fleet-git-credential-<labelA>` — the revoke test at `revoke-vcs-auth.test.ts:61-73` asserts `fleet-git-credential-work-gh` in the command and `not.toMatch(/fleet-git-credential[^-]/)` to confirm no old-style file is targeted. Label B's file is untouched.

**Gitconfig entry removal: BUG.** `revoke-vcs-auth.ts:52` hardcodes `scopeUrl = https://${host}` — **it does NOT accept a `scope_url` parameter**. When a credential was provisioned with a custom `scope_url` (e.g., `https://github.com/my-org`), the gitconfig entry is keyed as `credential.https://github.com/my-org.helper`. But revoke tries to `--unset-all "credential.https://github.com.helper"` — which doesn't match. **The gitconfig entry is orphaned.**

Concrete reproduction:
1. `provision_vcs_auth provider=github label=work scope_url=https://github.com/my-org token=ghp_xxx`
   → Creates gitconfig: `credential.https://github.com/my-org.helper = ~/.fleet-git-credential-work`
2. `revoke_vcs_auth provider=github label=work`
   → Runs: `git config --global --unset-all "credential.https://github.com.helper"` — **wrong key, no match**
   → The file `~/.fleet-git-credential-work` IS deleted, but the gitconfig entry for `credential.https://github.com/my-org.helper` is NOT.

**Fix:** Add `scope_url` as an optional parameter to `revokeVcsAuthSchema` (same as `provisionVcsAuthSchema`), and use `input.scope_url ?? https://${host}` for `scopeUrl` computation (same pattern as provision). This is a one-line schema addition + one-line logic change.

### 7. Test quality — PASS (7 tests)

**T5 tests — `vcs-auth.test.ts` "Multi-label credential isolation" (5 tests):**

1. "deploy with different labels creates distinct credential files" — Two deploys, asserts each creates a unique file name and gitconfig scope URL entry. Clear, correct. **PASS.**
2. "revoke with label removes only that label file" — Revokes `work-github`, asserts file and gitconfig key match, asserts `personal-github` not in command. **PASS.**
3. "deploy without label uses old-style credential file (backward compat)" — Deploys without label, asserts `.fleet-git-credential &&` (no `-` suffix). **PASS.** Good backward-compat coverage.
4. "deploy with label on bitbucket uses labeled file" — Cross-provider test with Bitbucket. **PASS.**
5. "two providers with different labels coexist in gitconfig" — GitHub + Azure DevOps, different labels and scope URLs. Verifies independent gitconfig entries. **PASS.**

**T5 tests — `revoke-vcs-auth.test.ts` (2 new tests):**

6. "revoke with label targets only that label credential file" — Asserts `fleet-git-credential-work-gh` in command and no old-style file reference. **PASS.**
7. "revoke without label defaults to provider-named label" — Asserts `fleet-git-credential-bitbucket` in command when no label given. **PASS.**

All 7 tests have clear assertions and cover the key isolation and backward-compat paths. No overlapping tests. **PASS.**

**Missing test (related to blocking finding):** No test covers revoke with a custom `scope_url` — which is why the bug in finding #6 wasn't caught.

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

### Build & Tests
- `npm run build` (`tsc --noEmit`): **Exit 0, no errors.** PASS.
- `npm test`: **964 passed, 6 skipped, 0 failures** (58 test files). PASS.
- No regressions in Phase 1 tests or any other existing suite.

### Blocking Finding

**1. `revoke_vcs_auth` does not accept `scope_url` — orphans gitconfig entries for custom-scoped credentials.**

`revoke-vcs-auth.ts:52` hardcodes `scopeUrl = https://${host}`. When a credential was provisioned with a custom `scope_url` (e.g., `https://github.com/my-org`), the gitconfig entry is keyed as `credential.https://github.com/my-org.helper`. Revoke targets `credential.https://github.com.helper` — wrong key, no match, gitconfig entry orphaned.

**Fix:** Add `scope_url: z.string().optional()` to `revokeVcsAuthSchema`. Change line 52 to `const scopeUrl = input.scope_url ?? https://${host}`. Add a test for revoke with custom scope_url.

### Non-blocking Findings

1. **No dedicated test for Windows forward-slash fix.** The `-replace '\\\\','/'` logic in `windows.ts:237` is correct but untested. The existing `windows-credential-helper.test.ts` doesn't cover the Phase 2 additions. Low risk.

2. **`revoke_vcs_auth` default label vs backward compat.** When `label` is omitted, `revoke_vcs_auth` defaults to the provider name (e.g., `github`), which targets `~/.fleet-git-credential-github`. However, `provision_vcs_auth` *also* defaults label to the provider name, so the default case is consistent. For truly legacy credentials (pre-label, `~/.fleet-git-credential` without suffix), there is no revoke path — but legacy migration in `provision_vcs_auth` removes these on the next provision call, so they're transitional.

### What's correct
- Label isolation: two labels produce independent files and gitconfig entries. No shared state.
- scope_url correctly used as gitconfig credential key for git's prefix-matching.
- Forward-slash fix applied to Windows gitconfig values.
- Legacy migration removes both old files and old gitconfig entries before deploying.
- callingMember from T2b preserved through T4 restructure — `resolveSecureField` passes `agent.friendlyName` to `credentialResolve`.
- All 3 VCS providers (GitHub, Bitbucket, Azure DevOps) updated with label/scopeUrl in both deploy and revoke.
- 7 new tests with clear assertions covering isolation, selective revoke, backward compat, and cross-provider coexistence.
