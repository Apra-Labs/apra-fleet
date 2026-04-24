# Sprint 2 — Plan Review (Re-review)

**Reviewer:** fleet-rev
**Date:** 2026-04-24 02:15:00-0400
**Verdict:** APPROVED

> Prior review: 4df354d. Doer addressed findings in commit 3b43283.

---

## Standard Plan Review

### 1. Does every task have clear "done" criteria?

**PASS.** Unchanged from prior review. All tasks (including the new T2a/T2b split) have verifiable exit conditions. T2a specifies three observable behaviors: scoped resolution rejection, expired credential purge, and `credentialList()` metadata inclusion. T2b specifies four: all 6 call sites pass `callingMember`, list output includes members/expiry, startup sweep removes expired credentials, and all existing tests pass with new wiring tests.

### 2. High cohesion within each task, low coupling between tasks?

**PASS.** The T2 split improved this. T2a is now purely `credential-store.ts` — enforcement logic in a single file. T2b is integration plumbing: threading `callingMember` through 6 call sites, adding startup sweep, and formatting list output. The two concerns are cleanly separated. The T2a → T2b dependency is explicit and correct. Cross-phase coupling via `provision-vcs-auth.ts` (T2b/T4) is now explicitly acknowledged with ordering constraints in both tasks.

### 3. Are key abstractions and shared interfaces in the earliest tasks?

**PASS.** Unchanged. T1 defines schema, T2a defines enforcement API (`credentialResolve` with `callingMember` parameter), T2b wires it through consumers. The abstraction-first pattern is preserved.

### 4. Is the riskiest assumption validated in Task 1?

**PASS.** Unchanged. Backward compatibility of credential store schema migration is validated in T1 before enforcement code is written.

### 5. Later tasks reuse early abstractions (DRY)?

**PASS.** Unchanged. T2a's `credentialResolve(name, callingMember)` signature is what T2b wires into all 6 call sites. T2b's startup sweep reuses `cleanupStaleTasks` pattern.

### 6. 2-3 work tasks per phase, then a VERIFY checkpoint?

**PASS with note.** Phase 1 now has 4 work tasks (T1, T2a, T2b, T3) — technically exceeding the 2-3 guideline. However, this is a direct result of the reviewer-recommended T2 split. T2a is a small, focused task (single file) that could arguably be part of T1 if the guideline were strict. The alternative — moving T2b or T3 to Phase 2 — would create worse coupling (credential enforcement half-wired). Phase 2 (2 tasks) and Phase 3 (3 tasks) remain within bounds. VERIFY checkpoints are unchanged. Acceptable deviation.

### 7. Each task completable in one session?

**PASS.** Previously FAIL — Task 2 was overloaded (7 files, 5 concerns).

**What changed:** Task 2 split into:
- **T2a** (enforcement core): `credential-store.ts` only. Three changes: `credentialResolve` signature update, scoping check, TTL check. Single file, high cohesion. Completable in one session.
- **T2b** (wiring): 8 files, but the changes are formulaic — each call site gets the same `callingMember` parameter threading. Plus startup sweep (small) and list formatting (small). Tier correctly set to `premium` to acknowledge breadth. The work is mechanical, not conceptually challenging.

Both sub-tasks are completable in one session. T4 (8 files across OS/VCS layers) remains borderline acceptable — same formulaic pattern across implementations.

### 8. Dependencies satisfied in order?

**PASS.** Unchanged, plus: the new T1 → T2a → T2b → T3 chain is correctly ordered. T2b explicitly requires T2a (enforcement logic must exist before wiring call sites). The T2b → T4 ordering constraint is also correctly stated.

### 9. Any vague tasks that two developers would interpret differently?

**PASS.** Previously FAIL — two areas of ambiguity.

**What changed:**

**(a) Call-site enumeration:** Task 2b now lists all 6 `credentialResolve` call sites with exact file paths and line numbers:
- `execute-command.ts` (line ~75)
- `provision-vcs-auth.ts` (line ~26)
- `provision-auth.ts` (line ~250)
- `register-member.ts` (line ~74)
- `update-member.ts` (line ~93)
- `setup-git-app.ts` (line ~28)

I verified these against the codebase — all 6 match exactly. No call sites are missing.

**(b) Member identity mechanism:** Now concrete: "`resolveMember(input.member_id, input.member_name).friendlyName` → `callingMember` param on `credentialResolve`." For `setup-git-app.ts` (server-level, no member context): pass `'*'` to bypass scoping. Two developers would implement this identically.

**(c) Provider auto-mode flags:** Now pinned with exact values from the codebase:
- Claude: `--permission-mode auto`
- Codex: `--ask-for-approval auto-edit`
- Gemini: **not supported** as CLI flag (config-file only via `auto_edit` mode in `.gemini/settings.json`). Log warning.
- Copilot: **not supported** as CLI flag (config-file only). Log warning.

I verified: Gemini's `gemini.ts:126` confirms `auto_edit` is config-file-based. Codex's `--ask-for-approval` flag exists in the codebase. Claude's `--permission-mode` is standard. No ambiguity remains.

### 10. Any hidden dependencies between tasks?

**PASS.** Previously FAIL — two hidden dependencies.

**What changed:**

**(a) T2b/T4 `provision-vcs-auth.ts` overlap:** Both tasks now carry explicit ordering constraints:
- T2b: "Task 2b MUST be completed first. Task 2b touches ONLY the `resolveSecureField` → `credentialResolve` call site to thread `callingMember`. Do not touch label/scope_url structure in Task 2b."
- T4: "Task 2b's `callingMember` change is already in place — preserve it during the restructure. Do not duplicate or clobber it."
- `progress.json` T2b and T4 notes both reference the overlap.

The constraint is stated in three places (PLAN.md T2b, PLAN.md T4, progress.json). A developer cannot miss this.

**(b) Missing call sites:** `setup-git-app.ts` and `provision-auth.ts` are now explicitly listed in T2b's call-site inventory (items 6 and 3 respectively). The security bypass risk identified in the prior review is fully mitigated.

### 11. Does the plan include a risk register?

**PASS.** Unchanged from prior review. 8 risks with concrete mitigations. The prior gap (incomplete call-site audit risk) is now mitigated by design — T2b exhaustively enumerates all call sites, making an incomplete audit impossible if the plan is followed.

### 12. Does the plan align with requirements.md intent?

**PASS.** Unchanged. All four issues (#157, #158, #163, #54) addressed. Phasing matches requirements.md recommendation. The T2 split does not change requirements alignment — it's an implementation structure change, not a scope change.

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

**12 of 12 checks pass.** All three previously-failed checks are resolved:

1. **Check 7 (Task size):** Task 2 split into T2a (enforcement core, `credential-store.ts` only) and T2b (wiring 6 call sites + startup sweep + list display). Both are completable in one session. T2a has high cohesion (single file); T2b is mechanical integration work correctly tiered as premium.

2. **Check 9 (Vagueness):** All 6 `credentialResolve` call sites enumerated with file paths and line numbers — verified against codebase, all match. Member identity mechanism is concrete: `resolveMember().friendlyName` → `callingMember` param, with `'*'` for server-level `setup-git-app.ts`. Provider auto-mode flags pinned: Claude `--permission-mode auto`, Codex `--ask-for-approval auto-edit`, Gemini/Copilot explicitly marked "not supported" with warning-log fallback.

3. **Check 10 (Hidden dependencies):** T2b/T4 `provision-vcs-auth.ts` overlap explicitly acknowledged in both tasks with ordering constraint ("T2b MUST be completed first") and scope boundaries ("T2b touches ONLY the `credentialResolve` call site"). Mirrored in `progress.json` notes.

**Minor note (non-blocking):** Phase 1 now has 4 work tasks (T1, T2a, T2b, T3) — slightly above the 2-3 guideline. This is an acceptable deviation caused by the reviewer-recommended split; the alternative would create worse coupling.

**Integration test plan:** Complete and intact — 6 sections, 28 test cases covering credential scoping, TTL, VCS isolation, permission mode migration, regressions, and combined defence-in-depth. No changes needed from the plan revisions (tests target final behavior, not task structure).

**Deferred from prior review:** `requirements.md` references `skills/fleet/SKILL.md` for #54 but actual reference is `skills/pm/SKILL.md:57`. Plan correctly targets the right file — requirements.md correction is separate.
