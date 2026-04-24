# Sprint 2 — Plan Review

**Reviewer:** fleet-rev
**Date:** 2026-04-24 12:00:00+00:00
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review.

---

## Standard Plan Review

### 1. Does every task have clear "done" criteria?

**PASS.** Every task has a "Done when" section with testable exit conditions. Task 1 specifies four unit test assertions (stores allowedMembers/expiresAt, re-set resets TTL, defaults). Task 2 specifies resolution rejection behavior, list output format, and startup sweep. Tasks 5-8 follow the same pattern. The VERIFY checkpoints are also well-defined: build, test suite, manual check, push, stop.

### 2. High cohesion within each task, low coupling between tasks?

**PASS.** Phase 1 groups credential schema (Task 1), enforcement (Task 2), and test coverage (Task 3) — all in `credential-store.ts` and its consumers. Phase 2 isolates VCS auth changes. Phase 3 isolates permission model changes. Cross-phase coupling is minimal: Phase 2 and Phase 3 share no code paths with Phase 1 beyond the general credential store, and the plan correctly notes Phases 2 and 3 are independent of Phase 1. Within each phase, tasks are vertically sliced (schema → enforcement → tests).

### 3. Are key abstractions and shared interfaces in the earliest tasks?

**PASS.** Task 1 defines the unified `CredentialMeta` extensions (`allowedMembers`, `expiresAt`) and the `credentialSet()` signature changes — both are the foundation that Tasks 2 and 3 build on. Task 6 defines the `Agent.unattended` type before Task 7 wires it into providers. The plan follows the correct pattern: schema/type first, then enforcement, then tests.

### 4. Is the riskiest assumption validated in Task 1?

**PASS.** The riskiest assumption is backward compatibility of the credential store schema change — users have existing `credentials.json` files with no `allowedMembers` or `expiresAt` fields. Task 1 explicitly addresses this: "existing `credentials.json` files without `allowedMembers`/`expiresAt` default to `allowedMembers: '*'` and no expiry on load." The done criteria include "existing credential store tests still pass," which validates that assumption early.

### 5. Later tasks reuse early abstractions (DRY)?

**PASS.** Task 2 reuses the `allowedMembers` and `expiresAt` fields from Task 1's schema for enforcement. Task 3 tests the enforcement from Task 2 using the schema from Task 1. Task 5 reuses the `label` parameter infrastructure from Task 4. Task 7 reads the `Agent.unattended` field defined in Task 6. No task re-invents what an earlier task provided. The startup sweep in Task 2 explicitly says "reuse `cleanupStaleTasks` pattern from `task-cleanup.ts`."

### 6. 2-3 work tasks per phase, then a VERIFY checkpoint?

**PASS.** Phase 1: 3 tasks + VERIFY. Phase 2: 2 tasks + VERIFY. Phase 3: 3 tasks + VERIFY. All within the 2-3 range. Each VERIFY checkpoint includes build, test, manual verification, push, and stop — consistent across phases.

### 7. Each task completable in one session?

**FAIL.** Task 2 touches 7 files (`credential-store.ts`, `credential-store-list.ts`, `provision-vcs-auth.ts`, `execute-command.ts`, `register-member.ts`, `update-member.ts`, `index.ts`) with 5 distinct change items including a new `purgeExpiredCredentials()` function, a startup sweep hook, updating all `credentialResolve` call sites, and formatting `credential_store_list` output. This is a premium-tier task, but the breadth is high — any issue in one call site blocks the whole task.

Task 4 similarly touches 8 files across OS layers (`linux.ts`, `windows.ts`, `os-commands.ts`), VCS providers (`github.ts`, `bitbucket.ts`, `azure-devops.ts`), tool schema, and types. It includes a legacy migration step and a platform-specific path fix.

**Recommendation:** Consider splitting Task 2 into (2a) scoping + TTL enforcement in `credential-store.ts` and (2b) call site updates + startup sweep + list formatting. This keeps the core enforcement logic in one task and the integration plumbing in another. Task 4 is borderline but acceptable since the OS/provider changes are formulaic.

### 8. Dependencies satisfied in order?

**PASS.** Task 1 → Task 2 → Task 3 (schema → enforcement → tests). Task 4 → Task 5 (label provision → label revoke). Task 6 → Task 7 → Task 8 (type → wiring → tests). The plan correctly notes that Phases 2 and 3 have no blockers on Phase 1, allowing potential parallelism. No circular dependencies.

### 9. Any vague tasks that two developers would interpret differently?

**FAIL.** Task 2, item 2: "Update all call sites of `credentialResolve` to pass the calling member identity from request context." Two developers would disagree on:
- **Which call sites?** The plan lists `resolveSecureField` in `provision-vcs-auth.ts`, `executeCommand`, `register-member.ts`, and `update-member.ts`. But `credentialResolve` is also called in `setup-git-app.ts:28` and `provision-auth.ts:250` — these are not mentioned. A developer following the plan would miss them.
- **How to obtain member identity?** The plan says "from request context" but doesn't specify the mechanism. Is it a parameter passed down from the MCP handler? Is it a global/singleton? Does the tool handler already receive the member name? Different developers would wire this differently.

Task 7, item 4: "In `src/providers/gemini.ts`: handle `permissionMode === 'auto'` → append equivalent flag (e.g. `--auto-approve` or map to `--yolo` based on Gemini CLI capabilities)." The parenthetical "e.g." means the implementer must research Gemini's actual CLI flags. Two developers would choose different flags, or one might implement a placeholder. The plan should state the definitive flag or add an explicit research subtask.

**Recommendation:** Task 2 should enumerate *all* call sites explicitly, including `setup-git-app.ts` and `provision-auth.ts`. It should also specify the member identity propagation mechanism (e.g., "add `callingMember: string` parameter to `credentialResolve`; obtain from `input.member` or `resolveMember()` at each call site"). Task 7 should pin down the Gemini/Codex/Copilot flag names or add a research step.

### 10. Any hidden dependencies between tasks?

**FAIL.** Task 2 lists files `provision-vcs-auth.ts` (for updating `resolveSecureField` call site). But Task 4 also modifies `provision-vcs-auth.ts` (adding `label` and `scope_url` params, restructuring the function). If a developer implements Phase 1 and then Phase 2, the merge is clean only if Task 2's changes to `provision-vcs-auth.ts` don't conflict with Task 4's structural changes. The plan does not acknowledge this shared-file dependency or specify merge order.

Additionally, `setup-git-app.ts` and `provision-auth.ts` are `credentialResolve` call sites (Task 2 scope) but are not listed in Task 2's file list. These are hidden dependencies — if a developer only modifies the listed files, scoping enforcement will be incomplete and those call sites will bypass member checks.

**Recommendation:** Add `setup-git-app.ts` and `provision-auth.ts` to Task 2's file list and change items. Note the `provision-vcs-auth.ts` overlap between Task 2 and Task 4, and specify that Task 2's changes are limited to the `resolveSecureField` helper (which Task 4 does not modify).

### 11. Does the plan include a risk register?

**PASS.** The risk register identifies 8 risks with impact and mitigation for each. Key risks are covered: schema migration backward compat, caller identity unavailability (fail-closed), VCS signature changes, legacy file race conditions, provider flag support gaps, deprecation breakage, TTL mid-task deletion, and Windows path encoding. The mitigations are concrete (not just "monitor" — they specify actual approaches like "fail-closed," "best-effort removal," "deprecation warning only").

One minor gap: the register does not mention the risk of `credentialResolve` call sites being missed during the audit (which is exactly what happened — see check #10). A "missed call site → scoping bypass" risk with mitigation "exhaustive grep for `credentialResolve` before implementation" would have been appropriate.

### 12. Does the plan align with requirements.md intent?

**PASS with note.** The plan addresses all four issues (#157, #158, #163, #54) and follows the phasing recommended in requirements.md. The unified credential schema is designed first (matching the "Shared Credential Store Architecture" section). All acceptance criteria from requirements.md are traceable to plan tasks.

Minor discrepancy: requirements.md references `skills/fleet/SKILL.md` for the #54 documentation update, but the actual `dangerously_skip_permissions` reference lives in `skills/pm/SKILL.md` line 57. The plan correctly targets `skills/pm/SKILL.md`. This is a requirements.md error, not a plan error, but the implementer should confirm which file(s) need updating and potentially update both.

---

## Integration Test Plan — Sprint 2

### 1. Credential Scoping (#157)

| # | Precondition | Action | Expected Result | Verify |
|---|-------------|--------|-----------------|--------|
| 1.1 | Fleet running with members `fleet-dev` and `fleet-rev` registered | `credential_store_set name=dev_secret value=s3cret members=fleet-dev` | Credential stored with `allowedMembers: ['fleet-dev']` | `credential_store_list` shows `members: fleet-dev` for `dev_secret` |
| 1.2 | 1.1 complete | Resolve `{{secure.dev_secret}}` in an `execute_command` dispatched to `fleet-rev` | Rejection error: `"Credential 'dev_secret' is not accessible to member 'fleet-rev'. Allowed: fleet-dev"` | Check execute_command return value contains denial message |
| 1.3 | Fleet running with members `fleet-dev` and `fleet-rev` | `credential_store_set name=shared_key value=abc members=*` | Credential stored with `allowedMembers: '*'` | Both `fleet-dev` and `fleet-rev` can resolve `{{secure.shared_key}}` in execute_command — no error |
| 1.4 | Fleet running with members `fleet-dev`, `fleet-rev`, and `fleet-qa` | `credential_store_set name=pair_key value=xyz members=fleet-dev,fleet-rev` | Credential stored with `allowedMembers: ['fleet-dev', 'fleet-rev']` | `fleet-dev` resolves OK; `fleet-rev` resolves OK; `fleet-qa` receives denial error |
| 1.5 | 1.1 complete (`dev_secret` scoped to `fleet-dev`) | `credential_store_set name=dev_secret value=updated members=fleet-dev,fleet-rev` | Scope replaced to `['fleet-dev', 'fleet-rev']` | `credential_store_list` shows updated members; `fleet-rev` can now resolve `dev_secret` |
| 1.6 | Fresh fleet, no prior credentials | `credential_store_set name=legacy_cred value=old123` (no `members` param) | Credential stored with `allowedMembers: '*'` (default) | Any member can resolve `{{secure.legacy_cred}}`; `credential_store_list` shows `members: *` |

### 2. Credential TTL (#158)

| # | Precondition | Action | Expected Result | Verify |
|---|-------------|--------|-----------------|--------|
| 2.1 | Fleet running | `credential_store_set name=temp_tok value=t0k ttl_seconds=5` | Credential stored with `expiresAt` ~5 seconds from now | Immediately resolve `{{secure.temp_tok}}` — returns `t0k`. Wait 6 seconds, resolve again — returns expiry error: `"Credential 'temp_tok' has expired."` |
| 2.2 | 2.1 complete (before expiry) | `credential_store_list` | `temp_tok` row shows `expiresAt` timestamp and remaining time (e.g., "4s remaining") | Parse list output; verify `expiresAt` is present and remaining time is > 0 and <= 5s |
| 2.3 | `temp_tok` exists with TTL | `credential_store_set name=temp_tok value=refreshed ttl_seconds=60` | Credential updated, `expiresAt` reset to ~60s from now | `credential_store_list` shows new `expiresAt` ~60s ahead; old expiry is replaced |
| 2.4 | Session-scoped credential exists (set without `persistent=true`) | Set session credential with no `ttl_seconds` | Session credential persists until server restart, no `expiresAt` field | Resolve session credential — succeeds; verify no `expiresAt` in internal state; TTL logic does not affect session lifecycle |
| 2.5 | Persistent credentials exist: one expired (`expiresAt` in the past), one valid | Restart the fleet server | Startup sweep runs `purgeExpiredCredentials()` | After restart: `credential_store_list` does not show the expired credential; valid credential still present and resolvable |

### 3. provision_vcs_auth Isolation (#163)

| # | Precondition | Action | Expected Result | Verify |
|---|-------------|--------|-----------------|--------|
| 3.1 | Member `fleet-dev` registered, no VCS credentials provisioned | `provision_vcs_auth member=fleet-dev provider=github label=work-github token=ghp_work` then `provision_vcs_auth member=fleet-dev provider=github label=personal-gh token=ghp_personal` | Two credential files created: `~/.fleet-git-credential-work-github` and `~/.fleet-git-credential-personal-gh`; two gitconfig entries registered | `ls ~/.fleet-git-credential-*` shows both files; `git config --global --list \| grep credential` shows two helper entries with different scope URLs |
| 3.2 | 3.1 complete (two labels provisioned) | `revoke_vcs_auth member=fleet-dev provider=github label=work-github` | Only `~/.fleet-git-credential-work-github` removed; `personal-gh` file and gitconfig entry remain | `ls ~/.fleet-git-credential-*` shows only `personal-gh`; `git config --global --list \| grep credential` shows only `personal-gh` entry |
| 3.3 | Windows/WSL environment or mock | `provision_vcs_auth` with any label | gitconfig path uses forward slashes (e.g., `/home/user/.fleet-git-credential-label`, not `\home\user\...`) | Read `.gitconfig` credential helper path; assert no backslash characters in the value |
| 3.4 | Legacy `~/.fleet-git-credential.bat` or `~/.fleet-git-credential` file exists (pre-sprint state) | `provision_vcs_auth member=fleet-dev provider=github label=new-label token=ghp_new` | Legacy files cleaned up; new per-label file created | `ls ~/.fleet-git-credential` and `ls ~/.fleet-git-credential.bat` both return "not found"; `ls ~/.fleet-git-credential-new-label` exists |

### 4. dangerously_skip_permissions Removal (#54)

| # | Precondition | Action | Expected Result | Verify |
|---|-------------|--------|-----------------|--------|
| 4.1 | Member `fleet-dev` registered with default settings (no `unattended`) | `execute_prompt member=fleet-dev prompt="echo hello" dangerously_skip_permissions=true` | Deprecation warning logged; `dangerously_skip_permissions` is **not** applied to the CLI invocation | Check server logs for deprecation warning message; inspect spawned CLI command — no `--dangerously-skip-permissions` flag present |
| 4.2 | None | `register_member name=auto-agent ... unattended=auto` | Member registered with `unattended: 'auto'` | `member_detail name=auto-agent` shows `unattended: "auto"` |
| 4.3 | `auto-agent` registered with `unattended: "auto"` | `execute_prompt member=auto-agent prompt="echo hello"` | CLI launched with `--permission-mode auto` (Claude provider) | Inspect spawned command args; assert `--permission-mode auto` is present and `--dangerously-skip-permissions` is absent |
| 4.4 | None | `register_member name=danger-agent ... unattended=dangerous` | Member registered with `unattended: 'dangerous'` | `member_detail name=danger-agent` shows `unattended: "dangerous"` |
| 4.5 | `danger-agent` registered with `unattended: "dangerous"` | `execute_prompt member=danger-agent prompt="echo hello"` | CLI launched with `--dangerously-skip-permissions` | Inspect spawned command args; assert `--dangerously-skip-permissions` is present |
| 4.6 | Member registered with default (no `unattended` param) | `execute_prompt member=default-agent prompt="echo hello"` | CLI launched with no permission override flags | Inspect spawned command args; assert neither `--permission-mode auto` nor `--dangerously-skip-permissions` is present |

### 5. Regression

| # | Precondition | Action | Expected Result | Verify |
|---|-------------|--------|-----------------|--------|
| 5.1 | Clean checkout on `sprint/session-lifecycle-oob-fix` | `npm run build` | Exit code 0, no TypeScript errors | Check exit code |
| 5.2 | Build complete | `npm test` | All 906+ tests pass, 0 failures | Check vitest summary output |
| 5.3 | Tests pass | Run existing `execute_prompt` test suite | No regressions in session lifecycle, timeout, OOB handling | All execute-prompt tests pass |
| 5.4 | Tests pass | Run existing `credential-store-and-execute` test suite | No regressions in credential resolution, set/get/list | All credential tests pass |
| 5.5 | Tests pass | Run existing VCS auth tests | No regressions in provision/revoke flows | All VCS tests pass |
| 5.6 | Tests pass | Run existing register/update member tests | No regressions in member lifecycle | All register/update tests pass |

### 6. Combined Defence-in-Depth Scenario

| # | Precondition | Action | Expected Result | Verify |
|---|-------------|--------|-----------------|--------|
| 6.1 | Fleet running with `fleet-dev` and `fleet-rev` registered | `credential_store_set name=scoped_ttl value=s3cret members=fleet-dev ttl_seconds=60` | Credential stored: scoped to `fleet-dev`, expires in 60s | `credential_store_list` shows `members: fleet-dev`, `expiresAt` ~60s from now |
| 6.2 | 6.1 complete | Resolve `{{secure.scoped_ttl}}` via `execute_command` dispatched to `fleet-rev` | Denial error: not accessible to `fleet-rev` | Return value contains scoping denial message |
| 6.3 | 6.1 complete, within 60s window | Resolve `{{secure.scoped_ttl}}` via `execute_command` dispatched to `fleet-dev` | Success: returns `s3cret` | Return value contains resolved credential, no error |
| 6.4 | 6.1 complete, wait 61+ seconds | Resolve `{{secure.scoped_ttl}}` via `execute_command` dispatched to `fleet-dev` | Expiry error: credential has expired | Return value contains expiry error message; credential purged from store |

---

## Summary

**3 checks failed** out of 12:

1. **Check 7 (Session size):** Task 2 is too large — 7 files, 5 change items, and includes both enforcement logic and integration plumbing. Recommend splitting into enforcement core (credential-store.ts) and call-site wiring (6 consumer files + startup sweep).

2. **Check 9 (Vagueness):** Task 2 does not enumerate all `credentialResolve` call sites — `setup-git-app.ts` and `provision-auth.ts` are missing from the plan. The member identity propagation mechanism ("from request context") is unspecified. Task 7 leaves Gemini/Codex/Copilot CLI flag names as a research exercise rather than pinning them down.

3. **Check 10 (Hidden dependencies):** `provision-vcs-auth.ts` is modified in both Task 2 (call-site update) and Task 4 (structural rewrite) with no acknowledgment of the overlap. Two unlisted `credentialResolve` call sites (`setup-git-app.ts`, `provision-auth.ts`) would be missed by a developer following the file lists literally — leaving scoping enforcement incomplete and creating a security bypass.

**What passed:** Done criteria clarity, cohesion/coupling, abstraction ordering, risk-first validation, DRY reuse, phase structure, dependency ordering, risk register completeness, and requirements alignment.

**Required changes before implementation:**
- Add `setup-git-app.ts` and `provision-auth.ts` to Task 2's file list and change items
- Specify the member identity propagation mechanism in Task 2 (parameter threading vs. context object)
- Acknowledge `provision-vcs-auth.ts` overlap between Task 2 and Task 4
- Pin down provider CLI flags in Task 7 (or add explicit research subtask)
- Consider splitting Task 2 for session-size feasibility

**Deferred:** requirements.md references `skills/fleet/SKILL.md` for #54 documentation update, but the actual `dangerously_skip_permissions` reference is in `skills/pm/SKILL.md` line 57. The plan correctly targets `skills/pm/SKILL.md`. No plan change needed — the requirements file should be updated separately.
