# apra-fleet Sprint 2 — Final Code Review (All Phases)

**Reviewer:** fleet-rev
**Date:** 2026-04-24 08:55:00-0400
**Verdict:** CHANGES NEEDED

---

## Phase 1 (APPROVED — regression check only)

Phase 1 tests still pass. `npm run build` exits 0. `npm test`: **980 passed, 6 skipped, 0 failures** (59 test files). `callingMember` threading verified intact: `execute-command.ts:57,76,135` passes `agent.friendlyName` to `credentialResolve()`; `provision-vcs-auth.ts:19,26,106` passes `callingMember` through `resolveSecureField()` to `credentialResolve()`. T2b wiring untouched by Phase 2 and Phase 3 commits. No regressions. **PASS.**

## Phase 2 (APPROVED — regression check only)

Label isolation intact. `provision-vcs-auth.ts:138` defaults label to provider name. `gitCredentialHelperWrite` constructs per-label credential files and gitconfig entries. `scope_url` used as gitconfig key. Forward-slash fix in `windows.ts` present. Legacy migration at `provision-vcs-auth.ts:156-159` intact. No Phase 2 files modified by Phase 3 commits. **PASS.**

## Phase 3 Review: Unattended Mode + Deprecation (#54)

### 1. Unattended persistence

**PASS.** `register-member.ts:164`: `unattended: input.unattended ?? false` — correctly persists with `false` default. `update-member.ts:121`: `if (input.unattended !== undefined) updates.unattended = input.unattended` — updates only when explicitly provided, preserves existing value on unrelated updates. `types.ts:32`: `unattended?: false | 'auto' | 'dangerous'` — correct union type. Both Zod schemas validate `z.union([z.literal(false), z.literal('auto'), z.literal('dangerous')]).optional()`. **PASS.**

### 2. Provider wiring correctness

**PASS (Linux/macOS). FAIL (Windows) — see blocking finding below.**

- **Claude** (`claude.ts:42-46`): `'auto'` → `--permission-mode auto`; `'dangerous'` → `--dangerously-skip-permissions`; `false` → no flags. **PASS.**
- **Codex** (`codex.ts:40-44`): `'auto'` → `--ask-for-approval auto-edit`; `'dangerous'` → `console.warn`, no flags. **PASS.**
- **Gemini** (`gemini.ts:39-44`): Both modes → `console.warn`, no flags. **PASS.**
- **Copilot** (`copilot.ts:43-48`): Both modes → `console.warn`, no flags. **PASS.**

All warnings are clear and do NOT append CLI flags for unsupported modes. **PASS.**

### 3. Deprecation correctness

**PASS.**

- `execute-prompt.ts:30`: `dangerously_skip_permissions` remains in schema with `DEPRECATED` description — not a breaking removal. **PASS.**
- `execute-prompt.ts:123-125`: Deprecation warning prepended when `input.dangerously_skip_permissions` is `true`. **PASS.**
- `execute-prompt.ts:127-133`: `promptOpts` uses `unattended: agent.unattended` — the deprecated flag is NOT forwarded to the CLI. **PASS.**
- Warning is actionable: `"Use update_member(unattended="dangerous") instead."` **PASS.**

### 4. SKILL.md accuracy

**PASS (with note).** SKILL.md does not have a dedicated "Unattended Mode" section, but the Zod schema descriptions on `register_member` and `update_member` tools are self-documenting and surfaced to MCP clients as tool parameter descriptions. The `execute_prompt` schema's deprecation description directs users to `update_member`. No stale references to the old `dangerously_skip_permissions` pattern in SKILL.md. **PASS.**

**Non-blocking note:** A SKILL.md section on "Unattended Mode" would improve discoverability for human readers. Deferred to docs backlog.

### 5. Test quality (T8)

**PASS.** 16 new tests across Phase 3: 12 in `unattended-mode.test.ts` + 4 in `providers.test.ts`.

**`unattended-mode.test.ts` — 12 tests in 3 describe blocks:**

*Register persistence (3 tests):*
1. Persists `unattended="auto"` on registered Agent record. **PASS.**
2. Persists `unattended="dangerous"` on registered Agent record. **PASS.**
3. Defaults to `false` when `unattended` not provided. **PASS.**

*Update mutations (4 tests):*
4. Sets `"auto"` on a member that previously had `false`. **PASS.**
5. Changes from `"auto"` to `"dangerous"`. **PASS.**
6. Resets from `"dangerous"` to `false`. **PASS.**
7. Does not change when field not provided (preserves existing `"auto"`). **PASS.**

*Deprecation + CLI arg generation (5 tests):*
8. Returns deprecation warning when `dangerously_skip_permissions=true`. **PASS.**
9. No warning when `dangerously_skip_permissions=false`. **PASS.**
10. Does NOT pass `--dangerously-skip-permissions` to CLI when deprecated flag=true but `agent.unattended=false`. **PASS.**
11. Passes `--dangerously-skip-permissions` when `agent.unattended="dangerous"`. **PASS.**
12. Passes `--permission-mode auto` when `agent.unattended="auto"`. **PASS.**

**`providers.test.ts` — 4 new tests** (T6/T7): Provider `buildPromptCommand` output for unattended values across Claude, Codex, Gemini, Copilot. **PASS.**

**Coverage assessment:** Full surface covered — persistence, update mutations, CLI flag generation, and deprecation (positive + negative). **PASS.**

---

## Blocking Finding: Windows `buildAgentPromptCommand` not updated for `unattended`

**Severity:** Blocking
**Location:** `src/os/windows.ts:103-122`

**Problem:** The Windows `buildAgentPromptCommand` destructures `dangerouslySkipPermissions` from `PromptOptions` (line 104) and uses it to conditionally append `provider.skipPermissionsFlag()` (line 115-117). However, `execute-prompt.ts:127-133` no longer sets `dangerouslySkipPermissions` in `promptOpts` — it sets `unattended: agent.unattended` instead.

**Impact:**
- On **Linux/macOS** (`linux.ts:111-125`): `buildAgentPromptCommand` delegates to `provider.buildPromptCommand(opts)` which correctly handles the `unattended` field. Works correctly.
- On **Windows** (`windows.ts:103-122`): `buildAgentPromptCommand` constructs the command inline using individual provider methods. It checks `dangerouslySkipPermissions` (always `undefined`) and ignores `unattended`. **Unattended mode is silently ignored for all Windows fleet members.**

**Evidence chain:**
1. `execute-prompt.ts:130`: `unattended: agent.unattended` — `promptOpts` has `unattended`, not `dangerouslySkipPermissions`.
2. `windows.ts:104`: `const { ..., dangerouslySkipPermissions, ... } = opts` — destructures the wrong field.
3. `windows.ts:115`: `if (dangerouslySkipPermissions)` — always `false` since the field is never set.
4. `provider.ts:25-26`: Both fields exist in `PromptOptions` — TypeScript doesn't catch the missing usage.

**Fix:** Update `windows.ts:103-122` to destructure and handle `opts.unattended` instead of `opts.dangerouslySkipPermissions`. For Claude: `'auto'` → add `--permission-mode auto`; `'dangerous'` → add `--dangerously-skip-permissions`. For Codex: `'auto'` → `--ask-for-approval auto-edit`. For Gemini/Copilot: warn but add no flags. Alternatively, refactor Windows to delegate to `provider.buildPromptCommand(opts)` like Linux does, then wrap with the PowerShell envelope.

**Test gap:** Existing tests pass because they run on macOS (Linux path). Add a test: `getOsCommands('windows').buildAgentPromptCommand(claudeProvider, { ..., unattended: 'dangerous' })` → assert `--dangerously-skip-permissions` in output.

---

## Cumulative Security Audit

### #157: Credential scoping — Can a member spoof identity to access scoped credentials?

**No.** `callingMember` is set server-side from `agent.friendlyName` (sourced from the registry via `resolveMember()`), not from client input. A member cannot influence which name is used in `credentialResolve()`. The `allowedMembers` check compares against this server-authoritative value. **SECURE.**

### #158: Credential TTL — Can a client bypass TTL by manipulating stored credentials?

**No.** `expiresAt` is computed server-side from `ttl_seconds` in `credentialSet()`. The schema exposes only `ttl_seconds`, not `expiresAt`. Re-setting a credential resets the TTL (intentional refresh flow). `purgeExpiredCredentials()` runs at server startup (`index.ts:207`). `expiresAt` is re-checked on every resolve call. **SECURE.**

### #163: Label injection — Can a malicious label create a dangerous gitconfig entry?

**Low risk.** Labels are filename suffixes (`~/.fleet-git-credential-<label>`) passed through `escapeDoubleQuoted()` (Linux) and `escapeWindowsArg()` (Windows). The gitconfig key uses `scope_url`, not the label. Path traversal attempts fail without intermediate directories. Labels come from the PM (trusted), not from fleet members.

**Non-blocking note:** `z.string().regex(/^[a-zA-Z0-9_-]+$/)` on the label schema would provide defense-in-depth. Not blocking — labels are operator-controlled.

### #54: Unattended self-escalation — Can a member set `unattended='dangerous'` on itself?

**No — by design.** Fleet members communicate via SSH and cannot call MCP tools. Only the PM (human's LLM via MCP) can call `update_member`. A member would need MCP server access to self-escalate, implying the server is already compromised. **SECURE by architecture.**

---

## Documentation Completeness

| Parameter | Documented in schema | Discoverable via MCP | Notes |
|-----------|---------------------|---------------------|-------|
| `members` (credential_store_set) | Yes | Yes | |
| `ttl_seconds` (credential_store_set) | Yes | Yes | |
| `label` (provision_vcs_auth) | Yes | Yes | |
| `scope_url` (provision_vcs_auth) | Yes | Yes | |
| `unattended` (register/update_member) | Yes | Yes | |
| `dangerously_skip_permissions` deprecation | Yes (schema + runtime warning) | Yes | Migration path in warning text |

Error messages are user-friendly and actionable:
- Credential scoping denial: names credential, denied member, and allowed members. **PASS.**
- Credential expiry: clear message. **PASS.**
- Deprecation warning: prescriptive migration path. **PASS.**

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

**Phase 3:** 4 of 5 checklist items PASS. Unattended persistence, deprecation, SKILL.md (via schema descriptions), and test quality are all correct. Provider wiring is correct on Linux/macOS but broken on Windows.

**1 blocking finding:**
- `windows.ts:buildAgentPromptCommand` (line 104, 115) still references `dangerouslySkipPermissions` instead of `unattended`. Unattended mode is silently ignored for all Windows fleet members. Fix: update Windows path to handle `unattended`, or refactor to delegate to `provider.buildPromptCommand(opts)` like Linux does. Add a Windows-specific test.

**Security audit — all 4 issues SECURE:**
- #157: Identity is server-authoritative; no spoofing vector
- #158: TTL computed server-side; no bypass path
- #163: Labels escaped; gitconfig key uses `scope_url` not label
- #54: `update_member` only accessible to PM, not to members

**Non-blocking notes (deferred):**
1. SKILL.md could add an "Unattended Mode" section for human readers
2. `revoke_vcs_auth` still does not accept `scope_url` (Phase 2 note, still applicable)
3. Console warnings from unsupported providers go to server stdout, not to tool response — users may not see them

**Verdict: CHANGES NEEDED** — fix the Windows `buildAgentPromptCommand` unattended handling and add a Windows-specific test. Once fixed, this sprint is ready for PR.
