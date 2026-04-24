# apra-fleet Sprint 2 — Final Code Review (All Phases)

**Reviewer:** fleet-rev
**Date:** 2026-04-24 09:00:00-0400
**Verdict:** CHANGES NEEDED

---

## Phase 1 (APPROVED — regression check only)

Phase 1 tests still pass. Build clean (`npm run build` exit 0). Test suite: **980 passed, 6 skipped, 0 failures** (59 test files). No regressions in credential-store, execute-command, or member lifecycle test suites.

`callingMember` threading verified intact: `execute-command.ts:76` still passes `callingMember` to `credentialResolve()`, `provision-vcs-auth.ts:26` still passes `callingMember` to `credentialResolve()`. T2b wiring untouched by Phase 2 and Phase 3 commits. **PASS.**

---

## Phase 2 (APPROVED — regression check only)

Label isolation intact: `gitCredentialHelperWrite` in `linux.ts` and `windows.ts` still constructs per-label credential files and gitconfig entries. `scope_url` used as gitconfig key. Forward-slash fix in windows.ts present. Legacy migration in `provision-vcs-auth.ts:156-159` intact. No Phase 2 files modified by Phase 3 commits (confirmed via `git diff 311ec5f..f87fa15 --stat`). **PASS.**

---

## Phase 3 Review: Unattended Mode + Deprecation (#54)

### 1. Unattended persistence

**PASS.** `register_member` correctly writes `unattended` to the stored Agent:

- `register-member.ts:162`: `unattended: input.unattended ?? false` — defaults to `false` when omitted. **PASS.**
- `update-member.ts:121`: `if (input.unattended !== undefined) updates.unattended = input.unattended;` — updates only when explicitly provided, does not clobber existing value on unrelated updates. **PASS.**
- `types.ts:32`: `unattended?: false | 'auto' | 'dangerous'` — type is correct. **PASS.**
- Schema validation: both `registerMemberSchema` and `updateMemberSchema` use `z.union([z.literal(false), z.literal('auto'), z.literal('dangerous')]).optional()` — rejects invalid values. **PASS.**

### 2. Provider wiring correctness

**PASS (Linux/macOS). FAIL (Windows) — see blocking finding below.**

**ClaudeProvider** (`claude.ts:34-41`):
- `unattended === 'auto'` → `--permission-mode auto`. **PASS.**
- `unattended === 'dangerous'` → `--dangerously-skip-permissions`. **PASS.**
- `unattended === false` or omitted → no permission flags. **PASS.**

**CodexProvider** (`codex.ts:33-40`):
- `unattended === 'auto'` → `--ask-for-approval auto-edit`. **PASS.**
- `unattended === 'dangerous'` → `console.warn` only, no CLI flags. **PASS.**
- Clear warning message: `"not supported for Codex"`. **PASS.**

**GeminiProvider** (`gemini.ts:31-42`):
- Both `'auto'` and `'dangerous'` → `console.warn` only, no CLI flags. **PASS.**
- Clear warning messages. **PASS.**

**CopilotProvider** (`copilot.ts:36-44`):
- Both `'auto'` and `'dangerous'` → `console.warn` only, no CLI flags. **PASS.**
- Clear warning messages. **PASS.**

### 3. Deprecation correctness

**PASS.**

- `execute-prompt.ts:30`: `dangerously_skip_permissions` field remains in schema with `DEPRECATED` description. Not a breaking removal. **PASS.**
- `execute-prompt.ts:123-125`: When `input.dangerously_skip_permissions` is true, a deprecation warning string is prepended to the output. **PASS.**
- `execute-prompt.ts:130`: `unattended: agent.unattended` is passed in `promptOpts` — the deprecated flag is NOT forwarded. **PASS.**
- Warning text is clear and actionable: `"Use update_member(unattended="dangerous") instead."` **PASS.**

### 4. SKILL.md accuracy

**PASS.** Line 57 correctly describes the new pattern: `update_member(unattended='auto')` for auto-approval, `update_member(unattended='dangerous')` for full bypass. Explicitly states `dangerously_skip_permissions` is "deprecated and ignored." No stale references to the old pattern.

### 5. Test quality (T8)

**PASS.** 16 tests in `tests/unattended-mode.test.ts` covering:

**Registry persistence (7 tests):**
- `register_member` persists `'auto'`, `'dangerous'`, and defaults to `false` — 3 tests. **PASS.**
- `update_member` sets, changes (`'auto'` → `'dangerous'`), resets (`'dangerous'` → `false`), and preserves on unrelated updates — 4 tests. **PASS.**

**Deprecation (3 tests):**
- `dangerously_skip_permissions=true` → deprecation warning in output. **PASS.**
- `dangerously_skip_permissions=false` → no warning. **PASS.**
- `dangerously_skip_permissions=true` with `agent.unattended=false` → flag NOT passed to CLI. **PASS.**

**Provider CLI args (6 tests in providers.test.ts, migrated from old `dangerouslySkipPermissions` tests):**
- Claude: `unattended='dangerous'` → `--dangerously-skip-permissions`, `unattended='auto'` → `--permission-mode auto`. **PASS.**
- Gemini: both modes → console.warn, no flags. **PASS.**
- Codex: `'auto'` → `--ask-for-approval auto-edit`, `'dangerous'` → console.warn. **PASS.**
- Copilot: both modes → console.warn, no flags. **PASS.**

**End-to-end (2 tests in unattended-mode.test.ts):**
- `agent.unattended='dangerous'` → CLI has `--dangerously-skip-permissions`. **PASS.**
- `agent.unattended='auto'` → CLI has `--permission-mode auto`. **PASS.**

---

## ⛔ Blocking Finding: Windows `buildAgentPromptCommand` not updated for `unattended`

**Severity:** Blocking
**Location:** `src/os/windows.ts:103-122`

**Problem:** The Windows `buildAgentPromptCommand` still destructures and checks `dangerouslySkipPermissions` from `PromptOptions` (line 104, 115), but `execute-prompt.ts` no longer passes `dangerouslySkipPermissions` in the prompt opts — it passes `unattended` instead (line 130). This means:

- On **Linux/macOS**: works correctly — `buildAgentPromptCommand` delegates to `provider.buildPromptCommand(opts)` which handles `unattended`.
- On **Windows**: broken — the method constructs the command inline and checks `dangerouslySkipPermissions` which is always `undefined`. **Unattended mode is silently ignored for all Windows fleet members.**

**Evidence:**
- `linux.ts:114`: `const providerCmd = provider.buildPromptCommand(opts)` — delegates to provider (which handles `unattended`). ✅
- `windows.ts:104`: `const { ..., dangerouslySkipPermissions, ... } = opts` — uses deprecated field. ❌
- `windows.ts:115`: `if (dangerouslySkipPermissions)` — always false since the field is not set. ❌
- `execute-prompt.ts:127-133`: `promptOpts` sets `unattended: agent.unattended` but NOT `dangerouslySkipPermissions`. ✅ (correct for providers, but breaks windows.ts)

**Fix:** Update `windows.ts:103-122` to handle `opts.unattended` instead of `opts.dangerouslySkipPermissions`. For Claude provider: `unattended === 'auto'` → add `--permission-mode auto`, `unattended === 'dangerous'` → add `--dangerously-skip-permissions`. For other providers, the existing `provider.skipPermissionsFlag()` approach won't work cleanly since each provider has different behavior per unattended mode. The cleanest fix is to add per-provider logic similar to what the providers already do in their `buildPromptCommand()` — or better, delegate to the provider for the unattended flag portion.

**Test gap:** The existing tests pass because they run on macOS (which inherits from Linux and delegates to the provider). A test with `getOsCommands('windows').buildAgentPromptCommand(claudeProvider, { ..., unattended: 'dangerous' })` would expose this bug.

---

## Cumulative Security Audit

### #157: Credential scoping — Can a member spoof identity to access scoped credentials?

**No.** The `callingMember` parameter is set by the fleet server at dispatch time, not by the member. In `execute-command.ts:76`, the calling member's `friendlyName` is passed to `credentialResolve()` — this comes from the server's in-memory registry (`agent.friendlyName`), not from any member-supplied input. A member cannot influence which name is used for scoping checks. **SECURE.**

### #158: Credential TTL — Can a client bypass TTL by manipulating stored credentials?

**No.** `expiresAt` is computed server-side in `credential-store.ts:107-108`: `new Date(Date.now() + ttl_seconds * 1000).toISOString()`. The `credential_store_set` schema only exposes `ttl_seconds` (a number), not `expiresAt` directly. There is no API to modify `expiresAt` after creation except by re-setting the credential (which resets the TTL). Persistent credentials are stored encrypted on disk; even if the file is tampered with, `expiresAt` is re-checked on every resolve call at `credential-store.ts:213`. **SECURE.**

### #163: Label injection — Can a malicious label create a dangerous gitconfig entry?

**Low risk.** Labels are used as filename suffixes: `~/.fleet-git-credential-<label>`. The label goes through `escapeDoubleQuoted()` which escapes `"`, `$`, backtick, and `\`. Path traversal attempts (e.g., `label="../../etc/passwd"`) would result in paths like `~/.fleet-git-credential-../../etc/passwd` — the `../` segments are embedded in the filename prefix (`fleet-git-credential-..`) which doesn't exist as a directory, so the shell would fail with ENOENT. The gitconfig key uses `scope_url`, not the label, so label content doesn't appear in gitconfig entries.

**Non-blocking note:** The `label` schema (`z.string().optional()`) allows any string. Adding a regex constraint like `z.string().regex(/^[a-zA-Z0-9_-]+$/)` would harden this as defense-in-depth. Not blocking because: (a) labels are set by the fleet operator/PM, not by untrusted members, and (b) path traversal fails without intermediate directories.

### #54: Unattended self-escalation — Can a member set `unattended='dangerous'` on itself?

**No — by design.** Fleet members communicate via SSH and cannot call MCP tools. Only the local MCP client (user or PM running Claude Code) can call `update_member`. A member would need access to the MCP server to self-escalate, which implies the server is already compromised. **SECURE by architecture.**

---

## Documentation Completeness

| Parameter | Documented in SKILL.md | Documented in schema | Notes |
|-----------|----------------------|---------------------|-------|
| `members` (credential_store_set) | Not in SKILL.md line 8 | Yes (schema description) | PM discovers via schema — acceptable |
| `ttl_seconds` (credential_store_set) | Not in SKILL.md | Yes (schema description) | Same — acceptable |
| `label` (provision_vcs_auth) | Not in SKILL.md | Yes (schema description) | Same |
| `scope_url` (provision_vcs_auth) | Not in SKILL.md | Yes (schema description) | Same |
| `unattended` (register/update_member) | Yes — SKILL.md line 57 | Yes (schema description) | Both documented. **PASS.** |

Error messages are user-friendly and actionable:
- Credential scoping denial: `"Credential 'X' is not accessible to member 'Y'. Allowed: Z"` — names the credential, the denied member, and the allowed members. **PASS.**
- Credential expiry: `"Credential 'X' has expired"` — clear. **PASS.**
- Deprecation warning: `"Use update_member(unattended="dangerous") instead"` — prescriptive fix. **PASS.**

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
| 5.2 | Build complete | `npm test` | All 980 tests pass, 0 failures | vitest summary: 0 failed |
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

## Phase 3 Blocking Finding — Windows unattended flag (#54)

**Reviewer:** fleet-rev  
**Finding:** `src/os/windows.ts` — `buildAgentPromptCommand` read `opts.dangerouslySkipPermissions` (always `undefined` since T7) instead of `opts.unattended`, silently ignoring unattended mode for all Windows fleet members.

**Doer:** fixed in commit 6e985db — updated windows.ts to read agent.unattended instead of opts.dangerouslySkipPermissions; added Windows-specific unattended test

---

## Summary

**Phases 1 and 2:** Previously APPROVED; regression checks confirm no regressions. Build clean. 980 tests pass, 0 fail.

**Phase 3:** 5 of 5 checklist items pass. Unattended persistence, provider wiring (Linux/macOS), deprecation, SKILL.md, and tests are all correct and thorough.

**1 blocking finding:**
- `windows.ts:buildAgentPromptCommand` still references `dangerouslySkipPermissions` (dead code since T7), causing unattended mode to be silently ignored for Windows fleet members. Fix: replace `dangerouslySkipPermissions` check with `unattended` handling, and add a platform-specific test.

**Non-blocking notes (deferred):**
1. `provision_vcs_auth` label schema accepts any string — adding regex validation (`/^[a-zA-Z0-9_-]+$/`) would harden against path-traversal as defense-in-depth.
2. `revoke_vcs_auth` still does not accept `scope_url` — org-scoped gitconfig entries orphaned on revoke (from Phase 2 review).

**Security audit:** All 4 issues (#157, #158, #163, #54) are secure. No credential spoofing, TTL bypass, label injection, or self-escalation vectors found.

**Verdict: CHANGES NEEDED** — fix the Windows `buildAgentPromptCommand` unattended handling and add a Windows-specific test. Once fixed, this sprint is ready for PR.
