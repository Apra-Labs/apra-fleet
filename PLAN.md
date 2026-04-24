# apra-fleet Sprint 2 — Credential & Trust Model

> Harden apra-fleet's credential and permission model with member-scoped access controls, configurable TTL, isolated VCS auth files per identity, and per-member permission mode (replacing per-dispatch bypass).

---

## Tasks

### Phase 1: Unified Credential Store (#157 + #158)

#### Task 1: Unified credential record schema + credential_store_set extensions
- **Change:**
  1. In `src/services/credential-store.ts`: extend `CredentialMeta` with `allowedMembers: string[] | '*'` and `expiresAt?: string`. Extend `PersistentRecord` with `allowedMembers` and `expiresAt`. Extend `SessionEntry` with `allowedMembers`.
  2. Update `credentialSet()` signature to accept `allowedMembers` (default `'*'`) and `ttl_seconds` (optional). Compute `expiresAt` as `new Date(Date.now() + ttl_seconds * 1000).toISOString()` when `ttl_seconds` is provided. Store both fields in session and persistent entries.
  3. In `src/tools/credential-store-set.ts`: add `members` param (string, comma-separated or `*`, default `'*'`) and `ttl_seconds` param (optional positive number) to `credentialStoreSetSchema`. Parse `members` to `string[] | '*'` and pass to `credentialSet()`.
  4. Backward compat: existing `credentials.json` files without `allowedMembers`/`expiresAt` default to `allowedMembers: '*'` and no expiry on load.
- **Files:** `src/services/credential-store.ts`, `src/tools/credential-store-set.ts`
- **Tier:** standard
- **Done when:**
  - `npm run build` exits 0
  - Existing credential store tests still pass
  - New unit tests verify: (a) `credentialSet` stores `allowedMembers` and `expiresAt`, (b) re-setting resets TTL clock, (c) omitting `members` defaults to `*`, (d) omitting `ttl_seconds` stores no `expiresAt`
- **Blockers:** None — this is the foundation task

#### Task 2: Scoping enforcement + TTL enforcement + credential_store_list update
- **Change:**
  1. In `src/services/credential-store.ts`: update `credentialResolve(name, callingMember?: string)` to check `allowedMembers` — if not `'*'` and `callingMember` not in the array, return an error object `{ denied: string }`. Also check `expiresAt` — if expired, delete the credential and return `{ expired: string }`.
  2. Update all call sites of `credentialResolve` to pass the calling member identity from request context. Key call sites: `resolveSecureField` in `provision-vcs-auth.ts`, `executeCommand` credential resolution, `register-member.ts` and `update-member.ts` password field resolution.
  3. In `src/services/credential-store.ts`: update `credentialList()` to return `allowedMembers` and `expiresAt` in `CredentialMeta`.
  4. In `src/tools/credential-store-list.ts`: format output to show `members` and `expiresAt` columns, with computed remaining time (e.g. "2h 15m remaining").
  5. Add startup sweep in `src/index.ts`: call a new `purgeExpiredCredentials()` function (in `credential-store.ts`) that iterates persistent credentials and deletes any where `expiresAt < now`. Pattern: reuse `cleanupStaleTasks` approach from `task-cleanup.ts`.
- **Files:** `src/services/credential-store.ts`, `src/tools/credential-store-list.ts`, `src/tools/provision-vcs-auth.ts`, `src/tools/execute-command.ts`, `src/tools/register-member.ts`, `src/tools/update-member.ts`, `src/index.ts`
- **Tier:** premium
- **Done when:**
  - `credentialResolve('secret', 'unauthorized-member')` returns denied error
  - `credentialResolve('expired-secret')` returns expired error and purges entry
  - `credential_store_list` output includes members and expiry/remaining time
  - Startup sweep removes expired credentials from `credentials.json`
  - All existing tests pass + new tests for scoping and TTL enforcement
- **Blockers:** Task 1 (schema must be in place)

#### Task 3: Credential scoping + TTL test coverage
- **Change:**
  1. Add integration-style tests in `tests/credential-store-and-execute.test.ts` (or new file) verifying:
     - `{{secure.NAME}}` resolution rejects unauthorized member with clear error message
     - `{{secure.NAME}}` resolution rejects expired credential with clear error message
     - `credential_store_set` with `members=fleet-dev` → only `fleet-dev` can resolve
     - `credential_store_set` with `ttl_seconds=1` → resolves immediately, fails after 1s delay
     - `credential_store_list` includes members and expiry columns
     - Re-set credential resets TTL and replaces scope
     - Backward compat: credential without `allowedMembers` field treated as `*`
- **Files:** `tests/credential-store-and-execute.test.ts` or `tests/credential-scoping-ttl.test.ts`
- **Tier:** standard
- **Done when:** All new tests pass, no regressions in existing test suite
- **Blockers:** Task 2

#### VERIFY: Phase 1
- `npm run build` — must exit 0
- `npm test` — all existing tests pass + new tests for credential scoping and TTL
- Manual check: `credential_store_list` shows members + expiry columns
- Push origin sprint/session-lifecycle-oob-fix
- STOP and report

---

### Phase 2: provision_vcs_auth Isolation (#163)

#### Task 4: Per-label credential files + scope_url + forward-slash path fix
- **Change:**
  1. Add `label` param (optional string, default: provider name) and `scope_url` param (optional string, default: `https://<host>`) to `provisionVcsAuthSchema` in `src/tools/provision-vcs-auth.ts`.
  2. In `src/os/linux.ts` and `src/os/windows.ts`: update `gitCredentialHelperWrite(host, username, token)` signature to accept an optional `label` parameter. Change credential file path from `~/.fleet-git-credential` to `~/.fleet-git-credential-<label>` (and `.bat` suffix on Windows). Use `scope_url` as the gitconfig credential key instead of `https://<host>`.
  3. In `src/os/os-commands.ts`: update `OsCommands` interface for the new `label` parameter on `gitCredentialHelperWrite` and `gitCredentialHelperRemove`.
  4. Windows path fix: ensure gitconfig values written from bash/WSL contexts use forward slashes (replace `\` with `/` in the credential helper path written to `.gitconfig`).
  5. Legacy migration: in `provisionVcsAuth()`, before deploying, exec commands to detect and remove legacy `~/.fleet-git-credential` and `~/.fleet-git-credential.bat` files.
  6. Pass `label` through VCS provider `deploy()` calls — update `VcsProviderService.deploy` signature and all three providers (github, bitbucket, azure-devops).
- **Files:** `src/tools/provision-vcs-auth.ts`, `src/os/linux.ts`, `src/os/windows.ts`, `src/os/os-commands.ts`, `src/services/vcs/types.ts`, `src/services/vcs/github.ts`, `src/services/vcs/bitbucket.ts`, `src/services/vcs/azure-devops.ts`
- **Tier:** premium
- **Done when:**
  - `provision_vcs_auth` with `label=work-github` creates `~/.fleet-git-credential-work-github`
  - Two calls with different labels coexist (different files, different gitconfig entries)
  - `scope_url` used as gitconfig credential key
  - Forward slashes in gitconfig paths on Windows
  - Legacy files removed on any provision call
  - Build clean, existing VCS tests updated
- **Blockers:** None (independent of Phase 1)

#### Task 5: revoke_vcs_auth by label + tests
- **Change:**
  1. Add `label` param (optional, default: provider name) to `revokeVcsAuthSchema` in `src/tools/revoke-vcs-auth.ts`.
  2. Update `VcsProviderService.revoke` signature to accept optional `label`.
  3. Update `gitCredentialHelperRemove` in linux.ts and windows.ts to accept `label` and remove the corresponding `~/.fleet-git-credential-<label>` file + matching gitconfig entry.
  4. Update all three VCS providers' `revoke()` implementations.
  5. Add/update tests: revoke by label removes only that label's file; other labels remain.
- **Files:** `src/tools/revoke-vcs-auth.ts`, `src/os/linux.ts`, `src/os/windows.ts`, `src/os/os-commands.ts`, `src/services/vcs/types.ts`, `src/services/vcs/github.ts`, `src/services/vcs/bitbucket.ts`, `src/services/vcs/azure-devops.ts`, `tests/revoke-vcs-auth.test.ts`, `tests/vcs-auth.test.ts`
- **Tier:** standard
- **Done when:**
  - `revoke_vcs_auth label=work-github` removes only that credential file and gitconfig entry
  - Existing revoke tests updated for label-awareness
  - No regressions
- **Blockers:** Task 4 (label-based file naming must exist)

#### VERIFY: Phase 2
- `npm run build` — must exit 0
- `npm test` — all tests pass including updated VCS tests
- Manual scenario: provision two labels, verify two files exist, revoke one, verify other remains
- Push origin sprint/session-lifecycle-oob-fix
- STOP and report

---

### Phase 3: Remove dangerously_skip_permissions + unattended mode (#54)

#### Task 6: Add `unattended` field to Agent type + register/update_member
- **Change:**
  1. In `src/types.ts`: add `unattended?: false | 'auto' | 'dangerous'` to `Agent` interface.
  2. In `src/tools/register-member.ts`: add `unattended` param to `registerMemberSchema` — `z.enum(['false', 'auto', 'dangerous']).default('false')`. Map to the `Agent` field.
  3. In `src/tools/update-member.ts`: add `unattended` param to `updateMemberSchema` (optional). Persist to registry on update.
  4. Default: omitted = `false` (backward compatible).
- **Files:** `src/types.ts`, `src/tools/register-member.ts`, `src/tools/update-member.ts`
- **Tier:** standard
- **Done when:**
  - `register_member` and `update_member` accept `unattended` param
  - Value persisted in agent registry
  - Omitting defaults to `false`
  - Build clean
- **Blockers:** None (independent of Phases 1-2)

#### Task 7: Wire unattended to providers + deprecate dangerously_skip_permissions
- **Change:**
  1. In `src/tools/execute-prompt.ts`: keep `dangerously_skip_permissions` in schema but log a deprecation warning when it's passed as `true`. Ignore its value — read `agent.unattended` instead. Set `dangerouslySkipPermissions` in `promptOpts` based on `agent.unattended === 'dangerous'`. For `agent.unattended === 'auto'`, add `--permission-mode auto` (Claude) or equivalent per provider.
  2. In `src/providers/provider.ts`: add `permissionMode?: 'auto'` to `PromptOptions` (alongside existing `dangerouslySkipPermissions`).
  3. In `src/providers/claude.ts`: handle `permissionMode === 'auto'` → append `--permission-mode auto`. Keep `dangerouslySkipPermissions` → `--dangerously-skip-permissions`.
  4. In `src/providers/gemini.ts`: handle `permissionMode === 'auto'` → append equivalent flag (e.g. `--auto-approve` or map to `--yolo` based on Gemini CLI capabilities).
  5. Update `src/providers/codex.ts` and `src/providers/copilot.ts` similarly.
  6. In `skills/pm/SKILL.md`: replace "never pass `dangerously_skip_permissions=true` to `execute_prompt`" with guidance about `unattended` on `register_member`/`update_member`.
- **Files:** `src/tools/execute-prompt.ts`, `src/providers/provider.ts`, `src/providers/claude.ts`, `src/providers/gemini.ts`, `src/providers/codex.ts`, `src/providers/copilot.ts`, `skills/pm/SKILL.md`
- **Tier:** premium
- **Done when:**
  - `execute_prompt` with `dangerously_skip_permissions=true` logs deprecation warning but does not set the flag
  - Member with `unattended: 'dangerous'` → provider gets `--dangerously-skip-permissions`
  - Member with `unattended: 'auto'` → provider gets `--permission-mode auto` (Claude) or equivalent
  - Member with `unattended: false` (default) → no permission bypass flags
  - Provider tests updated for new flag combinations
  - SKILL.md updated
- **Blockers:** Task 6 (Agent type must have `unattended` field)

#### Task 8: Unattended mode + deprecation test coverage
- **Change:**
  1. Update `tests/providers.test.ts`: add test cases for `permissionMode: 'auto'` generating correct CLI flags per provider.
  2. Add test in execute-prompt test file: verify deprecation warning logged when `dangerously_skip_permissions=true` is passed.
  3. Add test: member with `unattended: 'dangerous'` → prompt command includes skip-permissions flag.
  4. Add test: member with `unattended: 'auto'` → prompt command includes auto-approve flag.
  5. Add test: default member (no `unattended`) → no permission flags.
- **Files:** `tests/providers.test.ts`, `tests/execute-prompt.test.ts` (or similar)
- **Tier:** standard
- **Done when:** All new tests pass, no regressions
- **Blockers:** Task 7

#### VERIFY: Phase 3
- `npm run build` — must exit 0
- `npm test` — all tests pass
- Verify: `execute_prompt` schema still accepts `dangerously_skip_permissions` (deprecation, not removal)
- Verify: `register_member` schema shows `unattended` param
- Push origin sprint/session-lifecycle-oob-fix
- STOP and report

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Credential store schema migration breaks existing `credentials.json` files | Users lose stored credentials | Backward-compat defaults: missing `allowedMembers` → `'*'`, missing `expiresAt` → no expiry. Load-time migration, not destructive. |
| `credentialResolve` caller identity unavailable in some code paths | Scoping silently bypassed | Audit all `credentialResolve` call sites in Task 2; fail-closed (require member identity) rather than fail-open. |
| `gitCredentialHelperWrite` signature change breaks VCS provider implementations | Build failure | All three providers updated in same task (Task 4); build verification before commit. |
| Legacy credential file detection races with concurrent `provision_vcs_auth` calls | File already removed by another call | Best-effort removal (ignore ENOENT); no functional impact. |
| Gemini/Codex/Copilot CLIs may not support `--permission-mode auto` equivalent | `unattended: 'auto'` silently does nothing for non-Claude providers | Document per-provider support matrix in SKILL.md; fall back to no-flag (interactive) if unsupported. |
| Deprecating `dangerously_skip_permissions` breaks existing PM skill workflows | PM dispatches lose permission bypass | Deprecation warning only (not removal); PM skill doc updated to use `unattended` on member registration instead. |
| TTL enforcement deletes credential mid-task | Running task loses access to credential | TTL is checked at resolution time only; in-flight tasks that already resolved the credential are unaffected. Startup sweep only purges persistent store. |
| Windows backslash path fix may break non-WSL Windows git | Git can't find credential helper | Windows native git accepts forward slashes; test on both native cmd and WSL bash. |
