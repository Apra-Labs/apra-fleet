# Sprint 2 — Plan Review

**Reviewer:** fleet-rev
**Date:** 2026-04-24 01:28:29-0400
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review.

---

## Standard Plan Review

### 1. Does every task have clear "done" criteria?

**PASS.** All 8 tasks include a "Done when" section with verifiable exit conditions. Task 1 specifies four discrete unit test assertions (stores `allowedMembers`/`expiresAt`, re-set resets TTL, defaults to `*`, omitting `ttl_seconds` stores no `expiresAt`). Task 2 specifies observable behaviors: resolution rejection, expiry error + purge, list output format, startup sweep. Tasks 3-8 follow the same pattern. The VERIFY checkpoints are consistent across all three phases: build, full test suite, manual check, push, stop. No task leaves the implementer guessing what "done" looks like.

### 2. High cohesion within each task, low coupling between tasks?

**PASS.** Phase 1 groups credential schema definition (Task 1), enforcement + integration (Task 2), and test coverage (Task 3) — all centered on `credential-store.ts` and its direct consumers. Phase 2 isolates VCS auth file isolation changes. Phase 3 isolates the permission model migration. Cross-phase coupling is minimal: the only shared file between phases is `provision-vcs-auth.ts` (touched by both Task 2 and Task 4 — see Check 10 for the problem this creates). Within each phase, tasks follow a clean vertical slice: schema/type first, enforcement/wiring second, tests third.

### 3. Are key abstractions and shared interfaces in the earliest tasks?

**PASS.** Task 1 defines the unified `CredentialMeta` extensions (`allowedMembers: string[] | '*'` and `expiresAt?: string`) and the `credentialSet()` signature changes — these are the foundation that Tasks 2 and 3 build on. Task 4 defines the `label` parameter and per-label file naming convention before Task 5 builds revocation on top. Task 6 defines `Agent.unattended` on the type system before Task 7 wires it into provider dispatch. The pattern is consistent: abstraction → enforcement → tests.

### 4. Is the riskiest assumption validated in Task 1?

**PASS.** The riskiest assumption is backward compatibility of the credential store schema change. Users have existing `credentials.json` files with no `allowedMembers` or `expiresAt` fields. Task 1 explicitly addresses this with load-time defaults: "existing `credentials.json` files without `allowedMembers`/`expiresAt` default to `allowedMembers: '*'` and no expiry on load." The done criteria include "existing credential store tests still pass," which forces validation of this assumption before any enforcement code is written. This is the right ordering — a schema migration that silently breaks existing credentials would be catastrophic.

### 5. Later tasks reuse early abstractions (DRY)?

**PASS.** Task 2 reuses the `allowedMembers` and `expiresAt` fields from Task 1's schema for enforcement logic. Task 3 tests enforcement using the schema from Task 1 and the logic from Task 2. Task 5 reuses Task 4's `label` parameter infrastructure for revocation. Task 7 reads the `Agent.unattended` field defined in Task 6. The startup sweep in Task 2 explicitly says "reuse `cleanupStaleTasks` pattern from `task-cleanup.ts`" — referencing existing codebase patterns rather than reinventing. No task duplicates what a prior task provided.

### 6. 2-3 work tasks per phase, then a VERIFY checkpoint?

**PASS.** Phase 1: 3 tasks (1, 2, 3) + VERIFY. Phase 2: 2 tasks (4, 5) + VERIFY. Phase 3: 3 tasks (6, 7, 8) + VERIFY. All within the prescribed 2-3 range. Each VERIFY checkpoint includes the same four gates: build, test suite, manual verification, push, and stop — providing consistent quality gates across phases.

### 7. Each task completable in one session?

**FAIL.** Task 2 is overloaded. It touches 7 files (`credential-store.ts`, `credential-store-list.ts`, `provision-vcs-auth.ts`, `execute-command.ts`, `register-member.ts`, `update-member.ts`, `index.ts`) with 5 distinct change items spanning:
- Core enforcement logic (scoping check + TTL check in `credentialResolve`)
- Call-site audit and update across 4+ consumer files
- New `purgeExpiredCredentials()` function
- Startup sweep integration in `index.ts`
- `credential_store_list` output formatting

These are two distinct concerns: (a) the enforcement logic inside `credential-store.ts`, and (b) the integration plumbing across all consumer files. If the implementer hits an issue threading member identity through one call site, the entire task blocks — including the unrelated list formatting and startup sweep work.

Task 4 also touches 8 files across OS layers (`linux.ts`, `windows.ts`, `os-commands.ts`), VCS providers (`github.ts`, `bitbucket.ts`, `azure-devops.ts`), tool schema, and types. However, the OS and provider changes are formulaic (same signature change replicated across implementations), so Task 4 is borderline acceptable.

**Recommendation:** Split Task 2 into:
- **Task 2a:** Scoping + TTL enforcement in `credential-store.ts` — add member check and expiry check to `credentialResolve`, add `purgeExpiredCredentials()`.
- **Task 2b:** Call-site wiring + startup sweep + list formatting — update all `credentialResolve` consumers to pass `callingMember`, wire `purgeExpiredCredentials()` into `index.ts` startup, format `credential_store_list` output.

### 8. Dependencies satisfied in order?

**PASS.** Task 1 → Task 2 → Task 3 (schema → enforcement → tests). Task 4 → Task 5 (provision with label → revoke by label). Task 6 → Task 7 → Task 8 (type definition → provider wiring → tests). The plan correctly notes that Phases 2 and 3 have no blockers on Phase 1, enabling potential parallelism. No circular dependencies exist.

### 9. Any vague tasks that two developers would interpret differently?

**FAIL.** Two areas of ambiguity would produce different implementations:

**Task 2, item 2:** "Update all call sites of `credentialResolve` to pass the calling member identity from request context." I verified the codebase — `credentialResolve` is called in **6** consumer files: `execute-command.ts`, `register-member.ts`, `update-member.ts`, `provision-vcs-auth.ts`, `setup-git-app.ts` (line 28), and `provision-auth.ts` (line 250). The plan's file list omits `setup-git-app.ts` and `provision-auth.ts`. A developer following the file list literally would leave two call sites without member identity checks — creating a scoping bypass where credentials intended for one member are accessible through `setup-git-app` or `provision-auth` by any member.

Additionally, "from request context" is unspecified as a mechanism. Does the implementer add a `callingMember: string` parameter to `credentialResolve`? Use a context object? Read from a global/singleton? Two developers would wire this differently, producing incompatible implementations.

**Task 7, item 4:** "In `src/providers/gemini.ts`: handle `permissionMode === 'auto'` → append equivalent flag (e.g. `--auto-approve` or map to `--yolo` based on Gemini CLI capabilities)." I verified the codebase — Gemini currently uses `--yolo` for full bypass (`gemini.ts:40`). But `--yolo` is the full-bypass equivalent of `dangerouslySkipPermissions`, not an auto-approve middle ground. The plan does not specify whether Gemini even supports an `auto` mode. Similar ambiguity exists for Codex and Copilot, which currently have `dangerouslySkipPermissions` handling but no auto-mode equivalent.

**Recommendations:**
- Task 2: Enumerate all 6 call sites explicitly. Specify the member identity propagation mechanism (e.g., "add `callingMember: string` parameter to `credentialResolve`; obtain from `input.member` at each tool handler call site").
- Task 7: Pin down the exact flag for each provider. If Gemini/Codex/Copilot don't support an `auto` mode, say so explicitly and state the fallback behavior (e.g., "fall back to interactive/no-flag when `unattended: 'auto'` is set for a non-Claude provider").

### 10. Any hidden dependencies between tasks?

**FAIL.** Two hidden dependencies exist:

**Shared file conflict:** `provision-vcs-auth.ts` is modified in Task 2 (updating `resolveSecureField` / `credentialResolve` call site to pass member identity) and in Task 4 (structural rewrite: adding `label` and `scope_url` params, restructuring the `provisionVcsAuth()` function). If the implementer completes Phase 1 then starts Phase 2, Task 4's structural changes to `provision-vcs-auth.ts` will conflict with Task 2's changes in the same file. The plan does not acknowledge this overlap or specify which portions of the file each task touches. The mitigation is straightforward (Task 2's change is limited to the `credentialResolve` call inside `resolveSecureField`, which Task 4 does not modify), but this should be stated explicitly.

**Missing call sites as unlisted dependencies:** `setup-git-app.ts` and `provision-auth.ts` both import and call `credentialResolve` (verified at `setup-git-app.ts:28` and `provision-auth.ts:250`). These files are absent from Task 2's file list. A developer following the plan would not modify them, leaving scoping enforcement incomplete. Any credential resolved through these paths would bypass member access checks entirely — a security gap that contradicts the sprint's goal of hardening the trust model.

**Recommendations:**
- Add `setup-git-app.ts` and `provision-auth.ts` to Task 2's file list and change items.
- Add a note to Task 4 acknowledging the `provision-vcs-auth.ts` overlap with Task 2, specifying that Task 2 only touches the `credentialResolve` call in `resolveSecureField`, while Task 4 restructures the surrounding provisioning logic.

### 11. Does the plan include a risk register?

**PASS with gap.** The risk register identifies 8 risks with concrete mitigations: schema migration backward compat (load-time defaults), caller identity unavailability (fail-closed), VCS signature breakage (same-task update), legacy file races (ignore ENOENT), provider flag gaps (document support matrix), deprecation breakage (warning-only), TTL mid-task deletion (resolution-time-only check), and Windows path fix (forward slashes accepted by native git).

The mitigations are actionable rather than generic — "fail-closed (require member identity) rather than fail-open" is a design decision, not a platitude. However, the register misses one risk directly exposed by Check 10: **incomplete call-site audit leading to scoping bypass**. The `credentialResolve` function is called in files not listed in the plan, meaning a developer following the plan would leave unenforced code paths. The mitigation is simple ("exhaustive grep for `credentialResolve` before implementation; fail-closed: require `callingMember` parameter"), but its absence from the register means it won't be systematically checked.

### 12. Does the plan align with requirements.md intent?

**PASS.** The plan addresses all four issues (#157, #158, #163, #54) and follows the phasing recommended in requirements.md (Phase 1: unified credential schema + scoping + TTL; Phase 2: VCS isolation; Phase 3: permission model). The unified credential record schema matches the `CredentialRecord` interface specified in requirements.md's "Shared Credential Store Architecture" section. All acceptance criteria from requirements.md are traceable to specific plan tasks and done criteria.

Minor note: requirements.md references `skills/fleet/SKILL.md` for the #54 documentation update, but the actual `dangerously_skip_permissions` reference lives in `skills/pm/SKILL.md` line 57 (verified). The plan correctly targets `skills/pm/SKILL.md`. This is a requirements.md inaccuracy, not a plan defect — but the implementer should verify both files and update whichever contains the reference.

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

**3 of 12 checks failed:**

1. **Check 7 (Session size):** Task 2 bundles enforcement logic, call-site wiring across 6+ consumer files, a new `purgeExpiredCredentials()` function, startup sweep integration, and list output formatting into a single task touching 7 files. Recommend splitting into enforcement core (Task 2a: `credential-store.ts` only) and integration plumbing (Task 2b: consumer files + `index.ts` startup + list formatting).

2. **Check 9 (Vagueness):** Task 2 does not enumerate all `credentialResolve` call sites — `setup-git-app.ts:28` and `provision-auth.ts:250` are confirmed call sites missing from the plan's file list. The member identity propagation mechanism ("from request context") is unspecified. Task 7 leaves Gemini/Codex/Copilot auto-mode flag names unresolved — Gemini uses `--yolo` for full bypass but has no documented `auto` equivalent; the plan should state the definitive flag or document the fallback.

3. **Check 10 (Hidden dependencies):** `provision-vcs-auth.ts` is modified by both Task 2 (call-site scoping update) and Task 4 (structural rewrite for label/scope_url) with no acknowledgment of overlap. Two `credentialResolve` call sites (`setup-git-app.ts`, `provision-auth.ts`) are unlisted, meaning a developer following the file lists would leave scoping enforcement incomplete — a security bypass that directly contradicts the sprint's hardening goal.

**What passed:** Done criteria (1), cohesion/coupling (2), early abstractions (3), risk-first validation (4), DRY reuse (5), phase structure (6), dependency ordering (8), risk register (11, with minor gap), and requirements alignment (12).

**Required changes before implementation:**
- Add `src/tools/setup-git-app.ts` and `src/tools/provision-auth.ts` to Task 2's file list and change items
- Specify the member identity propagation mechanism in Task 2 (e.g., add `callingMember: string` parameter to `credentialResolve`)
- Acknowledge `provision-vcs-auth.ts` overlap between Task 2 and Task 4; specify which portions each task touches
- Pin down provider CLI flags in Task 7 or add explicit research subtask; document fallback for providers without `auto` mode
- Consider splitting Task 2 into enforcement core + integration plumbing

**Deferred:** `requirements.md` references `skills/fleet/SKILL.md` for #54 docs but the actual reference is in `skills/pm/SKILL.md:57`. The plan correctly targets `skills/pm/SKILL.md` — no plan change needed; the requirements file should be corrected separately.
