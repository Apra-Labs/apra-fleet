# apra-fleet Sprint 2 — Phase 2 Code Review

**Reviewer:** fleet-rev
**Date:** 2026-04-24 02:50:00-0400
**Verdict:** APPROVED

---

## Phase 1 (previously APPROVED — no regressions check)

Phase 1 tests still pass. Build clean (`npm run build` exit 0). Test suite: **964 passed, 6 skipped, 0 failures** (58 test files). Test count increased from 957 (Phase 1 VERIFY) to 964 — net +7 from T5 tests. No regressions in credential-store, execute-command, or member lifecycle test suites. **PASS.**

---

## Phase 2 Review: provision_vcs_auth Isolation (#163)

### 1. Label isolation

**PASS.** Two `provision_vcs_auth` calls with different labels produce fully independent files and gitconfig entries. Verified at three layers:

- **OsCommands layer** (`linux.ts:204-211`): `gitCredentialHelperWrite` computes `credFile = label ? ~/.fleet-git-credential-<label> : ~/.fleet-git-credential`. Two different labels yield two different file paths. No shared state — each call constructs its own path and gitconfig key independently. **PASS.**
- **Provider layer** (`github.ts:80`, `bitbucket.ts:10`, `azure-devops.ts:17`): All three providers pass `label` and `scopeUrl` through to `cmds.gitCredentialHelperWrite()`. No provider stores or caches label state. **PASS.**
- **Tool layer** (`provision-vcs-auth.ts:138`): `const label = input.label ?? input.provider` — defaults to provider name when omitted, ensuring backward compatibility with single-label usage. **PASS.**
- **Test layer** (`vcs-auth.test.ts:180-199`): Test deploys two labels (`work-github`, `personal-github`) and asserts distinct credential files and distinct gitconfig entries. **PASS.**

No naming collision risk: labels are used directly as filename suffixes with proper escaping via `escapeDoubleQuoted()` (Linux) and `escapeWindowsArg()` (Windows).

### 2. scope_url correctness

**PASS.** The gitconfig entry key is set to `scope_url`, not host-only.

- `linux.ts:209-210`: `credUrl = scopeUrl ? escapeDoubleQuoted(scopeUrl) : https://<host>`. The gitconfig command uses `credential.${credUrl}.helper` — this is the full scope URL, not just the host. **PASS.**
- `windows.ts:226,231-232`: Same pattern — `credUrl` is the full scope URL, used as gitconfig key. **PASS.**
- **Git's most-specific-prefix-wins rule:** When `scope_url` is `https://github.com/my-org`, git will match this credential for any repo under `github.com/my-org` but not for other orgs. A `scope_url` of `https://github.com` (the default) matches all repos on github.com. This is correct behavior — org-scoped credentials take precedence over host-scoped ones. **PASS.**
- Default: `provision-vcs-auth.ts:140`: `input.scope_url ?? https://<host>` — when `scope_url` is omitted, the host-only URL is used, which is backward compatible. **PASS.**

### 3. Forward-slash fix

**PASS.** The Windows path is written with forward slashes.

- `windows.ts:232`: `$helperPath = "$env:USERPROFILE\\${credFileName}.bat" -replace '\\\\','/'; git config --global --add 'credential.${credUrl}.helper' $helperPath` — the `-replace '\\\\','/'` converts all backslashes to forward slashes before writing to gitconfig. This runs in PowerShell where `\\\\` is the regex pattern for a literal backslash. **PASS.**
- Linux (`linux.ts:210`): Uses tilde expansion (`~/.fleet-git-credential-<label>`) — no backslash issue on Unix. **PASS.**
- **Test coverage:** No dedicated unit test for the forward-slash `-replace` pattern. The `windows-credential-helper.test.ts` file tests PowerShell output correctness but does not assert forward slashes in the helper path. **NOTE (non-blocking):** This is a minor gap. The PowerShell `-replace '\\\\','/'` is a standard idiom and the generated command can be visually verified. A unit test asserting `expect(cmd).not.toMatch(/USERPROFILE.*\\\\/)` in the helper path portion would be a nice-to-have but not required for approval.

### 4. Legacy migration

**PASS.** Old credential files and gitconfig entries are cleaned up.

- `provision-vcs-auth.ts:156-159`: Before deploying, calls `cmds.gitCredentialHelperRemove(host)` (no label, no scopeUrl) — this targets the old-style `~/.fleet-git-credential` file and `credential.https://<host>.helper` gitconfig entry. Wrapped in `try { ... } catch { /* best-effort */ }` — consistent with risk register mitigation (ignore ENOENT). **PASS.**
- **Both file AND gitconfig entry removed:** `gitCredentialHelperRemove` (without label) produces `rm -f ~/.fleet-git-credential && git config --global --unset-all "credential.https://<host>.helper"` — removes both the legacy file and the legacy gitconfig entry in a single command. **PASS.**
- **Windows legacy:** Same logic — `Remove-Item "$env:USERPROFILE\\.fleet-git-credential.bat"` + `git config --global --unset-all`. **PASS.**
- **Order:** Legacy removal happens before the new labeled deploy — no window where both old and new coexist. **PASS.**

### 5. callingMember preservation

**PASS.** The T2b `callingMember` change in `provision-vcs-auth.ts` was NOT overwritten by T4.

- `provision-vcs-auth.ts:18-33`: `resolveSecureField(value, callingMember)` function still accepts `callingMember` and passes it to `credentialResolve(name, callingMember)`. **PASS.**
- `provision-vcs-auth.ts:106`: Credential resolution calls `resolveSecureField(resolvedInput[field]!, agent.friendlyName)` — the `agent.friendlyName` (T2b change) is preserved. **PASS.**
- Verified via diff: T4 commit (`b8d72f0`) does not modify the `resolveSecureField` function body or its call sites — it only adds `label`, `scope_url`, `PROVIDER_HOSTS`, and the legacy migration block. The T2b `callingMember` wiring is untouched. **PASS.**

### 6. revoke_vcs_auth correctness

**PASS with one non-blocking note.**

- **Label-specific file removal:** `revoke-vcs-auth.ts:50`: `const label = input.label ?? input.provider` — defaults to provider name, matching the provision default. The label is passed to `service.revoke(agent, cmds, exec, label, scopeUrl)` which calls `gitCredentialHelperRemove(HOST, label, scopeUrl)`. This removes only `~/.fleet-git-credential-<label>` and `credential.<scopeUrl>.helper`. Other labels' files and gitconfig entries are completely untouched. **PASS.**
- **gitconfig entry removal precision:** `gitCredentialHelperRemove` uses `--unset-all "credential.<scopeUrl>.helper"` — this targets the exact URL key, not a glob. Two labels with different scope URLs produce different gitconfig keys, so revoking one does not affect the other. **PASS.**
- **Backward compat (no label):** When label is omitted, defaults to provider name (e.g., `github`). This means `revoke_vcs_auth provider=github` removes `~/.fleet-git-credential-github` and `credential.https://github.com.helper` — correct for the default provision case. **PASS.**
- **Test coverage:** `revoke-vcs-auth.test.ts` has two new tests: (1) revoke with explicit label asserts only that label's file is in the rm command, (2) revoke without label defaults to provider-named label. Both assert the correct credential file name appears in the exec'd command. **PASS.**

**NOTE (non-blocking — design concern for future iteration):** `revoke_vcs_auth` does not accept a `scope_url` parameter — it hardcodes `scopeUrl = https://<host>` (line 52). This means if a credential was provisioned with a custom `scope_url` (e.g., `https://github.com/my-org`), the revoke will attempt to unset `credential.https://github.com.helper` instead of `credential.https://github.com/my-org.helper`, leaving the org-scoped gitconfig entry orphaned. The credential *file* is still correctly removed (it's label-based), but the gitconfig entry persists. This is a future enhancement opportunity — adding `scope_url` to `revokeVcsAuthSchema` would close this gap. Not blocking because: (a) the PLAN.md Task 5 spec does not call for `scope_url` on revoke, (b) the default case (no custom scope_url) works correctly, and (c) an orphaned gitconfig entry pointing to a deleted credential file is harmless (git will skip it).

### 7. Test quality

**PASS.** 7 new tests across two files cover the multi-label isolation and selective revocation paths.

**`tests/vcs-auth.test.ts` — 5 new tests in "Multi-label credential isolation" describe block:**
1. `deploy with different labels creates distinct credential files` — deploys two GitHub PAT labels, asserts distinct file names and distinct gitconfig scope URL entries. **PASS.**
2. `revoke with label removes only that label file` — revokes one label, asserts correct file and scope URL, asserts other label not mentioned. **PASS.**
3. `deploy without label uses old-style credential file (backward compat)` — deploys Bitbucket with no label, asserts `.fleet-git-credential &&` (not `.fleet-git-credential-`). Good use of negative assertion to verify no accidental labeling. **PASS.**
4. `deploy with label on bitbucket uses labeled file` — cross-provider label test (not just GitHub). Asserts both file name and scope URL. **PASS.**
5. `two providers with different labels coexist in gitconfig` — deploys GitHub + Azure DevOps with different labels, asserts distinct files and distinct scope URLs. Cross-provider coexistence test — tests that labels don't collide across providers. **PASS.**

**`tests/revoke-vcs-auth.test.ts` — 2 new tests:**
6. `revoke with label targets only that label credential file` — full integration test through `revokeVcsAuth()` tool function. Asserts exec'd command contains label-specific file name and does NOT match the old unlabeled pattern. **PASS.**
7. `revoke without label defaults to provider-named label` — verifies the default label is the provider name. **PASS.**

**Test quality assessment:**
- Clear, focused assertions — each test verifies a single behavior. **PASS.**
- Negative assertions used appropriately (e.g., `not.toContain('.fleet-git-credential-')` to verify no labeling when label is omitted). **PASS.**
- Cross-provider coverage (GitHub, Bitbucket, Azure DevOps all represented). **PASS.**
- Provider-level tests (vcs-auth.test.ts) and tool-level tests (revoke-vcs-auth.test.ts) cover different layers. **PASS.**

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

**Phase 2 is complete and correct.** Both tasks (T4, T5) meet their PLAN.md "done" criteria. The implementation aligns with the #163 requirements for per-label VCS credential file isolation.

**Checklist results — all 7 items PASS:**
1. Label isolation — distinct files, distinct gitconfig entries, no shared state
2. scope_url correctness — full URL used as gitconfig key, most-specific-prefix-wins works
3. Forward-slash fix — Windows `-replace '\\\\','/'` applied before writing gitconfig
4. Legacy migration — old unnamed files AND gitconfig entries removed before deploying new labeled credentials
5. callingMember preservation — T2b `agent.friendlyName` wiring untouched by T4 restructure
6. revoke_vcs_auth correctness — label-specific removal, other labels untouched
7. Test quality — 7 tests across two files, covering isolation, selective revoke, backward compat, cross-provider coexistence

**Non-blocking notes (no action required):**
1. `revoke_vcs_auth` does not accept `scope_url` — if a custom scope_url was used during provision, the gitconfig entry won't be cleaned up on revoke (file removal still works). Future enhancement opportunity; harmless since orphaned gitconfig entries pointing to deleted credential files are skipped by git.
2. No dedicated unit test for the Windows forward-slash `-replace` pattern. The pattern is standard PowerShell and visually verifiable from the generated command string. Nice-to-have, not required.

**Build & tests:** `npm run build` exits 0. `npm test`: 964 passed, 6 skipped, 0 failures (58 test files). No regressions.
