# Requirements — Sprint 2: Credential & Trust Model (Cluster C)

## Base Branch
`sprint/session-lifecycle-oob-fix` — continue on this branch (Sprint 1 branch); do NOT create a new branch from main.

## Goal
Harden apra-fleet's credential and permission model so that secrets have member-scoped access controls, configurable TTL, isolated VCS auth files per identity, and permission bypass can only be set at the member level — never per-dispatch.

## Issues Covered

### #163 — `provision_vcs_auth` credential file isolation and provider coverage

**Background:** `provision_vcs_auth` deploys git credentials to fleet members for HTTPS git ops. The current implementation writes to a single hardcoded file (`~/.fleet-git-credential.bat` / `~/.fleet-git-credential`) and registers it at host scope in `.gitconfig`. This fails in any multi-identity scenario — a second `provision_vcs_auth` call silently overwrites the first credential.

**Bug: Credential identity collision.** Git supports URL-prefix scoping (most specific prefix wins), but the current implementation never uses it. Examples of broken scenarios:
- Work GitHub + Personal GitHub: second call overwrites first credential
- GitHub + Bitbucket: same file serves both hosts
- Two Bitbucket workspaces with different logins: no differentiation at all

**Additional bug: Path encoding on Windows + bash/WSL.** Windows backslashes written to `.gitconfig` are stripped by bash. The helper call fails silently and git falls back to `credential.helper=store`.

**Proposed fix:**
1. Add `label` parameter to `provision_vcs_auth` — short slug identifying this registration (e.g. `work-github`, `bitbucket-main`). Defaults to provider name for backwards compat.
2. Add `scope_url` parameter (optional) — URL prefix for gitconfig entry. Defaults to `https://<host>` (current behaviour). For org-scoped: `https://github.com/my-org`.
3. Per-label credential files: `~/.fleet-git-credential-<label>.bat` (Windows) / `~/.fleet-git-credential-<label>` (Linux/macOS). Each call writes its own file — no collision.
4. `revoke_vcs_auth` accepts `label` and removes only the matching file + gitconfig entry.
5. Migration: on any `provision_vcs_auth` call, detect and remove legacy `~/.fleet-git-credential.bat` / `~/.fleet-git-credential` if present.
6. Path encoding fix: use forward slashes in gitconfig values when writing from bash contexts.

**Key files:** `src/tools/provision-vcs-auth.ts`, `src/tools/revoke-vcs-auth.ts`, and any credential-helper write utilities (e.g. `src/services/credential-cleanup.ts`).

**Key comment from author (#163):**
> Implementation order: (1) add label param → name credential file, (2) add scope_url → use as gitconfig key, (3) update gitCredentialHelperWrite to write forward-slash paths, (4) update revoke_vcs_auth to accept label, (5) migration: remove legacy files on any provision call, (6) credential_store_list — add allowed_members display (prerequisite for #157 too). Azure DevOps Entra ID minting and Bitbucket workspace token support are OUT OF SCOPE for this sprint.

**Acceptance criteria (#163):**
- [ ] `provision_vcs_auth` accepts `label` (slug, default: provider name) and optional `scope_url` (default: `https://<host>`)
- [ ] Credential file named `~/.fleet-git-credential-<label>.bat` / `~/.fleet-git-credential-<label>`
- [ ] gitconfig entry uses `scope_url` as the credential URL key
- [ ] Multiple calls with different labels coexist without collision
- [ ] `revoke_vcs_auth` removes by label (file + gitconfig entry)
- [ ] Path written to `.gitconfig` uses forward slashes (bash/WSL compatible)
- [ ] Legacy `~/.fleet-git-credential.bat` / `~/.fleet-git-credential` cleaned up on any `provision_vcs_auth` call
- [ ] Azure DevOps and Bitbucket changes are NOT included (deferred)

---

### #157 — Credential scoping: restrict secret access to 1, N, or all members

**Background:** Today `credential_store_set` credentials are accessible to all fleet members equally. A rogue or compromised member can use any credential. We need member-scoped credentials.

**Proposed API:**
```
credential_store_set  name=github_pat  members=fleet-dev          # single member
credential_store_set  name=shared_key  members=fleet-dev,fleet-rev # N members
credential_store_set  name=pub_token   members=*                   # all (current default)
```

**Enforcement:** When `{{secure.NAME}}` is resolved in any tool (`execute_command`, `register_member`, etc.):
1. Look up credential's allowed member set
2. Identify calling member from request context (NOT from tool caller — cannot be spoofed)
3. If calling member not in allowed set → reject with clear error: `"Credential 'github_pat' is not accessible to member 'fleet-rev'. Allowed: fleet-dev"`

**Key files:** `src/tools/credential-store-set.ts`, `src/services/credential-store.ts`, `src/tools/credential-store-list.ts`.

**Key comment from author (#157):**
> (1) Schema: add optional `members` param — comma-separated names or `*` (default). Parse to string[] at input validation. (2) Store scope alongside the encrypted credential value — add `allowedMembers: string[] | '*'` to credential record. (3) Enforce at resolution time — check `allowedMembers` against calling member's name/ID from request context. (4) `credential_store_list` includes members column. (5) `credential_store_set` on existing name replaces scope. Member identity must come from server request context, not LLM prompt.

**Acceptance criteria (#157):**
- [ ] `credential_store_set` accepts optional `members` param (comma-separated or `*`; default: `*`)
- [ ] Scope stored alongside encrypted credential value in `credential-store.ts`
- [ ] `{{secure.NAME}}` resolution rejects calls from members not in allowed set with clear error
- [ ] Member identity from server request context, not from tool caller
- [ ] `credential_store_list` shows `members` column per credential
- [ ] `credential_store_set` on existing name replaces scope
- [ ] Backward compat: omitting `members` defaults to `*` (all)

---

### #158 — Credential TTL: auto-expire persistent credentials after configurable duration

**Background:** Persistent credentials live forever until explicitly deleted. A forgotten or leaked credential has unlimited lifetime. TTL support reduces blast radius.

**Proposed API:**
```
credential_store_set  name=session_token  ttl_seconds=3600   # expires in 1 hour
credential_store_set  name=long_lived_key ttl_seconds=604800  # expires in 7 days
credential_store_set  name=permanent_key                       # no TTL (current default)
```

**Behaviour:**
- Expiry timestamp stored as `expiresAt` (ISO timestamp) alongside credential at set time
- At resolution time: `if (expiresAt && Date.now() > new Date(expiresAt).getTime())` → reject: `"Credential 'session_token' has expired. Re-set with credential_store_set."`
- `credential_store_list` shows `expiresAt` and computed remaining time per credential
- Startup sweep (and/or on list call): purge expired persistent credentials from disk
- Session-scoped credentials already expire on server restart — TTL only applies to persistent tier
- `credential_store_set` on existing name resets the clock

**Key files:** `src/tools/credential-store-set.ts`, `src/services/credential-store.ts`, `src/tools/credential-store-list.ts`, `src/index.ts` (startup sweep).

**Key comment from author (#158):**
> Add `ttl_seconds` to `credential-store-set.ts` schema. In `credential-store.ts`, extend stored credential object with `expiresAt?: string`. Enforce at read time. Display remaining TTL in `credential-store-list.ts`. Startup sweep can reuse `cleanupStaleTasks` pattern from `src/services/task-cleanup.ts`.

**Acceptance criteria (#158):**
- [ ] `credential_store_set` accepts optional `ttl_seconds`
- [ ] `expiresAt` stored alongside credential; `credential_store_set` on existing name resets clock
- [ ] Resolution rejects expired credentials with clear error (no silent expiry)
- [ ] `credential_store_list` shows `expiresAt` and remaining time
- [ ] Startup sweep purges expired persistent credentials
- [ ] Session-scoped credentials unaffected (already ephemeral)

---

### #54 — Remove `dangerously_skip_permissions` from `execute_prompt`; move to member-level

**Background:** `execute_prompt` currently exposes `dangerously_skip_permissions` as a per-dispatch boolean. Two risks: (1) agents reading the schema may enable it autonomously without user knowledge; (2) any caller can escalate permissions at dispatch time with no explicit user consent.

**Proposed change:**
- Remove `dangerously_skip_permissions` from `execute_prompt` — passing it should log a deprecation warning (not break callers immediately), then be removed
- Add `unattended` field to `register_member` and `update_member`:
  - `unattended: false` (default) — interactive, prompts for approval
  - `unattended: "auto"` — `--permission-mode auto`; model still exercises judgment on risky ops
  - `unattended: "dangerous"` — `--dangerously-skip-permissions`; full bypass, no safety net

**Key principle:** Permission mode is a per-member decision made by the user at registration or via `update_member` — never a per-prompt decision made by an agent at dispatch time.

**Key files:** `src/tools/execute-prompt.ts`, `src/types.ts`, `src/tools/register-member.ts`, `src/tools/update-member.ts`, `src/providers/claude.ts`, `src/providers/gemini.ts`, `skills/fleet/SKILL.md`.

**Note from author (#54):**
> This should be implemented together with #90 (unattended mode via register/update_member) — they are two sides of the same design. Remove from `executePromptSchema` (deprecation warning first), add `unattended` to `Agent` type and register/update schemas. In `claude.ts` and `gemini.ts`, read `agent.unattended` at dispatch time to set the appropriate CLI flag. Update SKILL.md to remove references to `dangerously_skip_permissions` in `execute_prompt`. The CLAUDE.md memory rule ("never use dangerously_skip_permissions=true") will now be enforceable at the server level.

**Acceptance criteria (#54):**
- [ ] `dangerously_skip_permissions` removed from `execute_prompt` schema (with deprecation warning if passed)
- [ ] `unattended` field added to `register_member` and `update_member` schemas: `false | "auto" | "dangerous"`
- [ ] `Agent` type in `src/types.ts` includes `unattended`
- [ ] `claude.ts` and `gemini.ts` read `agent.unattended` at dispatch time → set correct CLI flag
- [ ] `skills/fleet/SKILL.md` and permission docs updated — no references to `dangerously_skip_permissions` in `execute_prompt`
- [ ] Default (`unattended` omitted) is `false` — backward compatible

---

## Shared Credential Store Architecture

Issues #157 and #158 both require extending the same `credential-store.ts` record structure. The stored credential object must include both `allowedMembers` (#157) and `expiresAt` (#158) in the same schema change. Implement as a single unified credential record:

```typescript
interface CredentialRecord {
  value: string;           // encrypted
  tier: 'session' | 'persistent';
  allowedMembers: string[] | '*';  // #157
  expiresAt?: string;              // #158 — ISO timestamp
}
```

The doer must design this unified schema before implementing either issue separately — they share the same store write path.

`credential_store_list` must surface all fields: name, tier, allowed members, expiry/remaining time.

---

## Dependency Order

1. **Unified credential record schema** (#157 + #158 together) — design first, then implement
2. **#157 scoping enforcement** — on top of unified schema
3. **#158 TTL enforcement** — on top of unified schema
4. **#163 provision_vcs_auth isolation** — independent, can run in parallel or after schema work
5. **#54 unattended mode** — independent of credential store, but shares `execute-prompt.ts`

All four issues can land in the same branch. Recommended phase split:
- **Phase 1:** Unified credential schema + #157 scoping + #158 TTL (all in `credential-store.ts` and related tools)
- **Phase 2:** #163 `provision_vcs_auth` isolation + path fix + `revoke_vcs_auth` update
- **Phase 3:** #54 `dangerously_skip_permissions` removal + `unattended` mode + provider dispatch

---

## Out of Scope
- Azure DevOps Entra ID token minting (#163 deferred item)
- Bitbucket workspace token support (#163 deferred item)
- Issue #90 beyond what #54 directly requires (unattended mode design)
- Inter-fleet messaging (#75, #152) — Sprint 3
- Glob patterns in send/receive_files (#98) — Sprint 3

## Constraints
- All changes on branch `sprint/session-lifecycle-oob-fix` — no new branch
- Must not break existing 906 passing tests
- TypeScript strict mode compliance
- No raw secrets in prompts or logs
- Backward compatibility: all new params optional with safe defaults (`members=*`, `ttl` absent = no expiry, `label` = provider name, `unattended` = false)

## Acceptance Criteria (Sprint-level)
- [ ] All four issues (#163, #157, #158, #54) fully implemented per their acceptance criteria above
- [ ] Build clean: `npm run build` exits 0
- [ ] All existing tests pass + new tests for each issue
- [ ] `credential_store_list` displays: name, tier, allowed members, expiry/remaining time
- [ ] Security audit: no new vectors for credential exfiltration or permission escalation
- [ ] Documentation: SKILL.md, README, or equivalent updated for new params
