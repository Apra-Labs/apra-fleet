# claude-code-fleet-mcp v0.0.1 — Implementation Plan

> Unified VCS auth (GitHub/Bitbucket/Azure DevOps), agent onboarding flow, versioning, CI packaging, and installer. Replaces `provision_git_auth`/`revoke_git_auth` with provider-aware `provision_vcs_auth`/`revoke_vcs_auth`. Adds PMO skill onboarding docs, PostToolUse hook, version.json, release tarball, and install.sh.

---

## Phases & Tasks

### Phase 1: Foundation — Design Finalization & VCS Types

**Risk front-loaded**: The VCS provider abstraction is the riskiest design decision. If the types or credential storage model are wrong, everything downstream needs rework.

#### Task 1: Finalize design doc — tarball-only deployment model
- **Files**: `docs/design-vcs-auth-onboarding.md`
- **What**: Remove symlink mode and repo-checkout mode from Workstream 3. `install.sh` extracts tarball to `~/.claude-fleet-mcp/`, copies skills, registers MCP server. No symlinks, no `--from-checkout`.
- **Acceptance**: Design doc references tarball-only in all distribution/install sections. No mention of symlinks or checkout mode.
- **Blocker**: None.

#### Task 2: Commit pending design doc + SKILL.md changes
- **Files**: `docs/design-vcs-auth-onboarding.md`, `skills/pmo/SKILL.md`
- **What**: Stage and commit dirty files so we have a clean baseline.
- **Acceptance**: `git status` clean after commit.
- **Blocker**: None.

#### Task 3: Create VCS types and provider interface
- **Files**: `src/services/vcs/types.ts` (new)
- **What**: Define:
  - `VcsProvider` union: `'github' | 'bitbucket' | 'azure-devops'`
  - `VcsCredentials` discriminated union per provider:
    - GitHub: `{ type: 'github-app' }` | `{ type: 'pat', token: string }`
    - Bitbucket: `{ email, api_token, workspace }`
    - Azure DevOps: `{ org_url, pat }`
  - `VcsDeployResult` interface (success, message, optional metadata)
  - `VcsProviderService` interface: `deploy()`, `revoke()`, `testConnectivity()`
- **Acceptance**: File compiles. Discriminated union narrows correctly.
- **Blocker**: None.

#### VERIFY: Phase 1
- `npm run build` succeeds
- Design doc updated and committed
- VCS types compile and are importable

---

### Phase 2: VCS Provider Implementations

**Core logic**: Each provider implements `VcsProviderService`. These are building blocks for the tools.

#### Task 4: Implement GitHub provider
- **Files**: `src/services/vcs/github.ts` (new)
- **What**: Two credential modes:
  - `github-app`: Reuses `mintGitToken()` from `src/services/github-app.ts`. Loads app config, mints token, deploys via `cmds.gitCredentialHelperWrite('github.com', 'x-access-token', token)`.
  - `pat`: Deploys PAT directly via `cmds.gitCredentialHelperWrite('github.com', 'x-access-token', pat)`.
  - `testConnectivity`: `git ls-remote https://github.com/<first-repo>.git HEAD`
  - `revoke`: `cmds.gitCredentialHelperRemove()`
- **Acceptance**: Compiles. Reuses existing `github-app.ts` — no duplication.
- **Blocker**: Task 3.

#### Task 5: Implement Bitbucket provider
- **Files**: `src/services/vcs/bitbucket.ts` (new)
- **What**:
  - `deploy`: `cmds.gitCredentialHelperWrite('bitbucket.org', email, api_token)`
  - `testConnectivity`: `curl -sf -u email:token https://api.bitbucket.org/2.0/repositories/{workspace}?pagelen=1`
  - `revoke`: `cmds.gitCredentialHelperRemove()`
- **Acceptance**: Compiles. Connectivity test uses curl.
- **Blocker**: Task 3. **Note**: Single-provider-at-a-time means overwriting `~/.fleet-git-credential` per call is correct.

#### Task 6: Implement Azure DevOps provider
- **Files**: `src/services/vcs/azure-devops.ts` (new)
- **What**:
  - `deploy`: `cmds.gitCredentialHelperWrite('dev.azure.com', '', pat)` (empty username + PAT as password)
  - `testConnectivity`: `curl -sf -u :pat https://dev.azure.com/{org}/_apis/projects?api-version=7.1&$top=1`
  - `revoke`: `cmds.gitCredentialHelperRemove()`
- **Acceptance**: Compiles. Auth pattern matches Azure DevOps docs.
- **Blocker**: Task 3.

#### Task 7: Verify OsCommands credential helper works for all VCS hosts
- **Files**: `src/os/linux.ts`, `src/os/windows.ts` (read-only verify, modify if needed)
- **What**: Current `gitCredentialHelperWrite(host, username, token)` already parameterizes host. Verify it works for `bitbucket.org` and `dev.azure.com` (not just `github.com`). Check host-specific escaping. Add test in `tests/platform.test.ts` for all three hosts.
- **Acceptance**: Credential helper correct for all three hosts on Linux/macOS/Windows. Existing tests pass.
- **Blocker**: None.

#### VERIFY: Phase 2
- `npm run build` succeeds
- All three provider modules compile
- Credential helper verified for all three hosts

---

### Phase 3: VCS Auth Tools

**Tools layer**: Wire providers into MCP tools with Zod schemas.

#### Task 8: Implement `provision_vcs_auth` tool
- **Files**: `src/tools/provision-vcs-auth.ts` (new)
- **What**: Zod schema: `agent_id`, `provider` enum, provider-specific credential fields (discriminated union or flat with optional fields). Handler: lookup agent → resolve provider service from map `{ github, bitbucket, 'azure-devops' }` → `service.deploy()` → `service.testConnectivity()` → return result.
  - GitHub `github-app` mode: uses `git_access`/`repos` from input or agent config
  - GitHub `pat` mode: requires `token`
  - Bitbucket: requires `email`, `api_token`, `workspace`
  - Azure DevOps: requires `org_url`, `pat`
- **Acceptance**: Compiles. Schema validates all three provider formats.
- **Blocker**: Tasks 4-7.

#### Task 9: Implement `revoke_vcs_auth` tool
- **Files**: `src/tools/revoke-vcs-auth.ts` (new)
- **What**: Zod schema: `agent_id`, `provider` enum. Handler: lookup agent → resolve provider → `service.revoke()`.
- **Acceptance**: Compiles. Removes credential helper and git config.
- **Blocker**: Tasks 4-7.

#### Task 10: Register new tools in `src/index.ts`
- **Files**: `src/index.ts`
- **What**: Import and register `provision_vcs_auth`/`revoke_vcs_auth`. Add under "Authentication & SSH" section. **Keep old tools for now** — removed in Phase 5.
- **Acceptance**: Both new and old tools appear. Server starts.
- **Blocker**: Tasks 8-9.

#### VERIFY: Phase 3
- `npm run build` succeeds
- `npm test` passes (existing tests unbroken)
- Server starts, lists both old and new tools

---

### Phase 4: Unit Tests for VCS Auth

#### Task 11: Unit tests for VCS provider modules
- **Files**: `tests/vcs-auth.test.ts` (new)
- **What**: Mock `strategy.execCommand()`. Verify per provider:
  - Correct commands (host, username, password)
  - Connectivity test parses success/failure
  - Revocation calls `gitCredentialHelperRemove()`
  - GitHub `github-app` calls `mintGitToken` (mocked)
  - GitHub `pat` deploys without minting
  - Error cases: offline agent, invalid creds, API errors
- **Acceptance**: All tests pass. Happy path + error paths for all 3 providers.
- **Blocker**: None.

#### Task 12: Unit tests for tool handlers
- **Files**: `tests/provision-vcs-auth.test.ts` (new), `tests/revoke-vcs-auth.test.ts` (new)
- **What**: Test tool-level behavior:
  - Schema validation (missing fields, invalid provider, wrong cred type)
  - Agent not found / agent offline
  - Successful provision per provider
  - Successful revocation
  - Follow patterns from existing `tests/provision-git-auth.test.ts`
- **Acceptance**: All tests pass.
- **Blocker**: Tasks 8-9.

#### VERIFY: Phase 4
- `npm test` passes (all tests, old + new)
- Report: test count increase, coverage gaps

---

### Phase 5: Remove Old Tools & Cleanup

**Safe removal**: New tools proven in Phases 3-4. `setup_git_app` stays. `Agent.gitAccess`/`gitRepos` stay (used by GitHub App mode).

#### Task 13: Remove old `provision_git_auth` and `revoke_git_auth`
- **Delete**: `src/tools/provision-git-auth.ts`, `src/tools/revoke-git-auth.ts`
- **Delete**: `tests/provision-git-auth.test.ts`, `tests/revoke-git-auth.test.ts`
- **Modify**: `src/index.ts` — remove imports and registrations
- **Acceptance**: Build succeeds. Tests pass. Only new VCS tools + `setup_git_app` in tool list.
- **Blocker**: Phase 4 complete.

#### Task 14: Update integration test for new VCS tools
- **Files**: `tests/integration.test.ts`
- **What**: Replace `provision_git_auth`/`revoke_git_auth` calls with `provision_vcs_auth({ provider: 'github', ... })`/`revoke_vcs_auth({ provider: 'github' })`.
- **Acceptance**: Integration test compiles. (Can't run in CI — needs SSH.)
- **Blocker**: Task 13.

#### VERIFY: Phase 5
- `npm run build` + `npm test` pass
- Old tool files gone
- No orphaned imports in `src/index.ts`

---

### Phase 6: PMO Skill — Onboarding Docs

**Parallel-safe**: No code dependencies. Creates documentation files only. Can run in parallel with Phases 2-5.

#### Task 15: Create `skills/pmo/docs/agent-onboarding.md`
- **Files**: `skills/pmo/docs/agent-onboarding.md` (new)
- **What**: Full onboarding flow (Steps 1-8 from design doc). Decision tree:
  1. Detect VCS via `git remote -v`
  2. Determine role(s) — list with descriptions
  3. Map roles to required scopes (table per provider)
  4. Check existing auth
  5. Guide token setup if insufficient
  6. Deploy credentials via `provision_vcs_auth`
  7. Check/install required skills
  8. Update agent status file with Agent Profile section
- **Acceptance**: Complete, references `provision_vcs_auth` (not old names).
- **Blocker**: None.

#### Task 16: Create provider-specific auth docs
- **Files**:
  - `skills/pmo/docs/github-auth.md` (new)
  - `skills/pmo/docs/bitbucket-auth.md` (new)
  - `skills/pmo/docs/azure-devops-auth.md` (new)
- **What**: Each doc: credential creation steps (URLs), scope/permission table, test commands, troubleshooting. GitHub doc covers App vs PAT decision.
- **Acceptance**: Actionable — human or PMO can follow to set up auth.
- **Blocker**: None.

#### Task 17: Create `skills/pmo/docs/skill-matrix.md`
- **Files**: `skills/pmo/docs/skill-matrix.md` (new)
- **What**: Project type + agent role → required skills mapping table.
- **Acceptance**: Covers all current projects and roles.
- **Blocker**: None.

#### Task 18: Update `skills/pmo/SKILL.md` — onboarding, fixes, and new sections
- **Files**: `skills/pmo/SKILL.md`
- **What**: Multiple subtasks:
  - **18a**: Fix the truncated model selection table (last row got cut off mid-sentence at "use")
  - **18b**: Add per-agent default paragraph and override logic paragraph that were missing
  - **18c**: Replace the credential management section (lines 76-81 referencing `provision_git_auth`/`revoke_git_auth`) with a new **Reactive Auth Pattern** section:
    ```
    ## Reactive Auth Pattern
    When any VCS operation fails with an auth error (401/403, permission denied):
    1. Detect the failure
    2. For GitHub App — re-mint automatically via provision_vcs_auth, no user needed
    3. For Bitbucket/Azure DevOps — ask user to provide a fresh token, then deploy
    4. Retry the failed operation

    Credentials are provisioned when needed and revoked when the user asks or when a project wraps up. No proactive token management or cleanup scheduling.
    ```
  - **18d**: Remove the line `Read [learnings.md](learnings.md) for the full pattern library.` — learnings.md is the user's personal notes, NOT a skill dependency
  - **18e**: Remove `skills/pmo/learnings.md` from the skill package entirely
  - **18f**: Update `/pmo deploy` command description from "Pull, build, and restart" to "Download release artifact, run install.sh"
  - **18g**: Add a **Two-Context Design Review Loop** section:
    ```
    ## Two-Context Design Review Loop
    For design docs and architecture decisions, use the PMO + fleet agent review loop:
    1. PMO brainstorms with user — captures intent, constraints, decisions
    2. Fleet agent generates artifact — has codebase context
    3. PMO reviews output — catches gaps against brainstorm
    4. Fleet agent revises — incorporates corrections
    5. Repeat until converged

    PMO context holds the *what* (user intent). Agent context holds the *where* (codebase). Neither alone produces the right output.
    ```
  - **18h**: Add `## Agent Onboarding` section that links to `docs/agent-onboarding.md`
- **Acceptance**: All subtasks applied. No reference to learnings.md. Old git credential section replaced. Table complete. SKILL.md internally consistent.
- **Blocker**: Task 15.

#### VERIFY: Phase 6
- All doc files exist in `skills/pmo/docs/`
- SKILL.md links to onboarding doc
- Tool names consistent throughout

---

### Phase 7: PostToolUse Hook for Onboarding

#### Task 19: Create PostToolUse hook for `register_agent`
- **Files**: `hooks/post-register-agent.sh` (new in repo root), `.claude/settings.json` or equivalent hook config
- **What**: Shell script fires after `register_agent`. Outputs instruction text nudging PMO to run onboarding checklist. Hook is a nudge — all intelligence in skill docs. Source file lives at `hooks/post-register-agent.sh` in the repo; `install.sh` (Task 22) copies it to the user's `~/.claude/settings.json` hook config during installation.
  - Detect if PMO skill is active (check if SKILL.md is loaded)
  - Output: plain text injected into conversation context
- **Acceptance**: After `register_agent`, hook fires and PMO sees onboarding instructions. Idempotent.
- **Blocker**: Need to verify Claude Code hook mechanism format. Check `.claude/settings.json` hook configuration schema.

#### VERIFY: Phase 7
- Hook file exists and is executable
- Hook config is correct JSON
- Hook fires after `register_agent` (manual test)

---

### Phase 8: Versioning & Fleet Status

#### Task 20: Add `version.json` and version reporting
- **Files**: `version.json` (new), `src/tools/check-status.ts` (modify), `src/index.ts` (modify)
- **What**:
  - Create `version.json`: `{ "version": "0.0.1" }`
  - `check-status.ts`: Read `version.json`, include in output header (e.g., `Fleet v0.0.1_abc123: 3/4 online`)
  - `src/index.ts`: Read version from `version.json` instead of `package.json` (keep both in sync)
- **Acceptance**: `fleet_status` shows version. `version.json` at repo root.
- **Blocker**: None.

#### VERIFY: Phase 8
- `npm run build` succeeds
- `fleet_status` includes version string
- Version format: `v0.0.1_<hash>`

---

### Phase 9: CI Pipeline & Installer

#### Task 21: Update CI workflow for tarball packaging
- **Files**: `.github/workflows/ci.yml`
- **What**: Add steps after test (only on `ubuntu-latest` + `node-22.x`):
  1. Read version from `version.json`
  2. Compute full version: `v{version}_{short-hash}`
  3. Create tarball: `dist/`, `package.json`, `package-lock.json`, `skills/pmo/`, `install.sh`, `version.json`
  4. Upload as workflow artifact (always)
  5. On tag push (`v*`): create GitHub release with tarball
- **Acceptance**: CI produces tarball. Tagged commits create releases.
- **Blocker**: None.

#### Task 22: Create `install.sh` — tarball-only installer
- **Files**: `install.sh` (new)
- **What**: Bash script:
  1. Install to `~/.claude-fleet-mcp/` (copy dist + package files)
  2. Run `npm ci --omit=dev` for runtime deps
  3. Copy `skills/pmo/` to `~/.claude/skills/pmo/`
  4. Install PostToolUse hook from `.claude/hooks/` to user's `.claude/settings.json`
  5. Register MCP server in Claude Code config (`~/.claude.json` or `~/.claude/settings.json`)
  6. Print installed version
  - No symlinks. Pure copy. Works on Linux, macOS, Windows (Git Bash/WSL).
- **Acceptance**: `install.sh` from extracted tarball → working MCP server.
- **Blocker**: Verify Claude Code MCP server registration JSON format.

#### VERIFY: Phase 9
- CI workflow valid YAML
- `install.sh` executable with correct shebang
- Tarball contains expected files
- Report: tarball size, manual install test

---

### Phase 10: Final Cleanup & Release

#### Task 23: Sync package.json version to 0.0.1
- **Files**: `package.json`
- **What**: Set `"version": "0.0.1"` (currently `1.1.0`).
- **Acceptance**: `package.json` and `version.json` match.
- **Blocker**: None.

#### Task 24: Final test run
- **Files**: None (verification only)
- **What**: `npm run build && npm test`. All pass, no warnings, no orphaned imports.
- **Acceptance**: Build clean, all tests green.
- **Blocker**: All previous tasks complete.

#### Task 25: Tag v0.0.1 release
- **Files**: None (git operation)
- **What**: Annotated tag `v0.0.1`. Push to trigger CI release. Verify tarball.
- **Acceptance**: GitHub release exists with tarball. `install.sh` works from extracted tarball.
- **Blocker**: All previous tasks complete.

#### VERIFY: Phase 10 — Release
- Tagged release on GitHub
- Tarball downloads and installs
- MCP server starts from installed location
- `fleet_status` shows `v0.0.1_<hash>`

---

## Dependency Graph

```
Phase 1 (Tasks 1-3)
  └─► Phase 2 (Tasks 4-7)
        └─► Phase 3 (Tasks 8-10)
              └─► Phase 4 (Tasks 11-12)
                    └─► Phase 5 (Tasks 13-14)
                          └─► Phase 10 (Tasks 23-25)

Phase 6 (Tasks 15-18) ─── parallel with Phases 2-5
  └─► Phase 7 (Task 19)

Phase 8 (Task 20) ─── can start after Phase 1
Phase 9 (Tasks 21-22) ─── can start after Phase 8
  └─► Phase 10
```

## Execution Notes

- Each task = one git commit
- VERIFY = stop and report checkpoint — do not proceed without PMO review
- **Phase 6 is best candidate for parallel execution on a second agent** (docs only, no code deps)
- **Critical validation in Task 7**: Confirm credential helper works for all VCS hosts. Current impl already parameterizes host — likely works as-is.
- **Risk areas**: Task 8 Zod schema design for discriminated union across providers; Task 19 hook mechanism (needs manual verification of Claude Code hooks format); Task 22 installer depends on knowing exact MCP server registration format
