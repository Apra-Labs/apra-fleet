# Design: VCS Auth & Member Onboarding

## Overview

This document describes two complementary workstreams that improve how fleet agents authenticate with version control systems (VCS) and how new members are onboarded into the PM workflow.

**Workstream 1** adds a unified `provision_vcs_auth` MCP server tool that deploys VCS credentials to any fleet agent, supporting GitHub, Bitbucket, and Azure DevOps. It replaces the existing `provision_git_auth` and `revoke_git_auth` tools.

**Workstream 2** adds a member onboarding flow as a PM skill that automatically detects the VCS provider, determines required permissions based on the agent's role, and guides credential setup.

## Motivation

The PM coordinates work across fleet agents. Currently GitHub auth is handled via a GitHub App (`setup_git_app` + `provision_git_auth`), but there is no support for Bitbucket or Azure DevOps. We also lack a member onboarding flow that automatically sets up VCS auth and skills after registration.

Key pain points:
- **No Bitbucket/Azure DevOps support** — agents working on non-GitHub repos must have credentials manually configured
- **No onboarding automation** — after `register_agent`, the PM must manually remember to set up VCS auth, install skills, and verify connectivity
- **Role-based scoping is ad hoc** — there is no systematic mapping from agent roles to required VCS permissions

## Workstream 1: MCP Server — `provision_vcs_auth` Tool

Replaces `provision_git_auth` and `revoke_git_auth`. `setup_git_app` stays as a GitHub-specific prerequisite for the GitHub App flow.

### Tool Signature

```typescript
provision_vcs_auth(
  agent_id: string,
  provider: github | bitbucket | azure-devops,
  credentials: { /* Provider-specific fields */ }
)

revoke_vcs_auth(agent_id: string, provider: github | bitbucket | azure-devops)
```

### Provider Credential Schemas

**GitHub** — two modes:
```typescript
{ type: github-app }           // Mints short-lived token via pre-configured app from setup_git_app
{ type: pat, token: string }   // Deploys a personal access token directly
```

**Bitbucket**:
```typescript
{ email: string, api_token: string, workspace: string }
```

**Azure DevOps**:
```typescript
{ org_url: string, pat: string }  // org_url e.g. https://dev.azure.com/myorg
```

### What the Tool Does on the Agent

1. **Deploys credentials** to the appropriate location on the agent filesystem
2. **Configures git credential helper** so `git clone/pull/push` works without interactive prompts
3. **Tests connectivity** via lightweight API call:
   - GitHub: `gh auth status` or API call to `/user`
   - Bitbucket: `curl -u email:token https://api.bitbucket.org/2.0/repositories/{workspace}`
   - Azure DevOps: `curl -u :pat https://dev.azure.com/{org}/_apis/projects`
4. **Returns status** — success/failure with details (authenticated user, accessible repos)

### Constraints

Each agent supports a single VCS provider at a time. Multi-provider configurations are out of scope for this design.

## Workstream 2: PM Skill — Member Onboarding Flow

### Trigger

**PostToolUse hook on `mcp__fleet__register_agent`** — hook output injects instructions into the conversation telling the PM to run the onboarding checklist. The hook is just a nudge; all intelligence lives in the skill docs.

### Onboarding Steps

**Step 1: Detect VCS** — run `git remote -v` on agent via `execute_command`
- 90% case: existing workspace with repos checked out — parse URLs to detect github.com / bitbucket.org / dev.azure.com
- 10% case: empty work folder — ask user which VCS provider and repo URL

**Step 2: Determine role(s)** — ask user. Roles are ADDITIVE (an agent can have multiple):
- `development` — write code, create branches, push commits
- `code-review` — read PRs, post review comments
- `testing` — read repo, read CI/pipeline results
- `devops` — admin repo, manage pipelines, merge PRs
- `debugging` — read-only repo access

**Step 3: Map role(s) to required scopes** (union of all selected roles):

| Role | Bitbucket Scopes | GitHub (gh CLI) | Azure DevOps PAT Scopes |
|------|-----------------|-----------------|------------------------|
| development | repository:write, pullrequest:write | repo | Code: R&W, PR: R&W |
| code-review | pullrequest:read, repository:read | repo:read | Code: Read, PR: R&W |
| testing | repository:read, pipeline:read | repo:read, actions:read | Code: Read, Build: Read |
| devops | repository:admin, pipeline:write, pullrequest:write | repo, actions:write | Full access or Code+Build+Release: R&W |
| debugging | repository:read | repo:read | Code: Read |

**Step 4: Check existing auth** — run test API call via `execute_command`:
- GitHub: `gh auth status`
- Bitbucket: `curl -u email:token https://api.bitbucket.org/2.0/repositories/{workspace}`
- Azure DevOps: `curl -u :pat https://dev.azure.com/{org}/_apis/projects`
- If empty work folder with no remotes: ask user for VCS details first

**Step 5: Guide token setup if insufficient** — provider-specific instructions:
- Bitbucket: Go to https://id.atlassian.com/manage-profile/security/api-tokens, create token with required scopes, provide to PM
- GitHub: `gh auth login` on agent, or provide PAT
- Azure DevOps: Go to `https://dev.azure.com/{org}/_usersSettings/tokens`, create PAT with required scopes

**Step 6: Deploy credentials** — call `provision_vcs_auth` with the token user provides

**Step 7: Check/install required skills** based on project + role:
- Bitbucket + (devops OR code-review) → `bitbucket-devops` skill
- ApraPipes project + devops → `aprapipes-devops` skill
- GitHub + anything → no extra skill (gh CLI is sufficient, Claude already knows it)
- Azure DevOps + (devops OR code-review) → `azdevops-devops` skill (future, document the intent)

**Step 8: Update member status file** — add `## Member Profile` section:
```markdown
## Member Profile
- VCS: Bitbucket (kumaakh/apra-lic-mgr)
- Roles: development, code-review
- Auth: Bitbucket API token (verified)
- Skills: bitbucket-devops (installed)
```

## Workstream 3: Versioning, CI & Distribution

The MCP server and PM skill live in the same repository and share a single version. This workstream adds consistent versioning, CI artifact generation, and a unified installer.

### Version Format

`v0.5.0_<githash>` — semantic version + short git hash for traceability. Both the MCP server and PM skill share this version since they live in the same repo and are released together.

### Where Version Appears

- `version.json` at repo root — single source of truth: `{ version: 0.5.0 }`
- **MCP server**: reads `version.json`, reports version in `fleet_status` output so users can see what version is running
- **PM skill**: `SKILL.md` header includes version, so the PM knows which skill version it's using
- **Member status files**: record the PM/MCP version at time of last interaction, so you can tell which member is running which version
- **Git tag**: CI tags releases as `v0.5.0`

### CI Pipeline (`ci.yml`)

Improve the existing CI workflow to:

1. **Build** — `npm install && npm run build` (existing)
2. **Test** — `npm test` (existing)
3. **Version** — read `version.json`, append short git hash to produce `v0.5.0_abc1234`
4. **Package** — create a tarball `apra-fleet-v0.5.0_abc1234.tar.gz` containing:
   - Built MCP server (`dist/`, `package.json`, `node_modules/` or install step)
   - PM skill files (`skills/pm/`)
   - `install.sh`
5. **Release** — upload tarball as a GitHub release artifact (on tagged commits)

### `install.sh`

A tarball-only installer that:
1. Extracts the tarball to `~/.apra-fleet/` (copies dist + package files)
2. Runs `npm ci --omit=dev` for runtime dependencies
3. Copies PM skill files to `~/.claude/skills/pm/`
4. Installs PostToolUse hook from `hooks/` to user's `~/.claude/settings.json`
5. Registers the MCP server in Claude Code config if not already present
6. Prints the installed version

No symlinks, no `--from-checkout` mode. Pure copy. Works on Linux, macOS, and Windows (Git Bash/WSL).

## File Changes

### New Files

| File | Description |
|------|-------------|
| `src/tools/provision-vcs-auth.ts` | Tool handler for `provision_vcs_auth` |
| `src/tools/revoke-vcs-auth.ts` | Tool handler for `revoke_vcs_auth` |
| `src/services/vcs/github.ts` | GitHub credential deployment logic |
| `src/services/vcs/bitbucket.ts` | Bitbucket credential deployment logic |
| `src/services/vcs/azure-devops.ts` | Azure DevOps credential deployment logic |
| `src/services/vcs/types.ts` | Shared VCS types and interfaces |
| `tests/vcs-auth.test.ts` | Unit tests for VCS auth tools |
| `hooks/post-register-agent.sh` | PostToolUse hook for onboarding trigger (installed to user config by `install.sh`) |
| `skills/pm/onboarding.md` | Full onboarding flow (steps 1-8) + decision tree |
| `skills/pm/bitbucket-auth.md` | Bitbucket-specific: scope table, token creation steps, test commands, troubleshooting |
| `skills/pm/github-auth.md` | GitHub-specific: gh CLI setup, GitHub App vs PAT, scope mapping |
| `skills/pm/azure-devops-auth.md` | Azure DevOps-specific: PAT creation, scope table, test commands |
| `skills/pm/skill-matrix.md` | Project type + role to required skills mapping |
| `version.json` | Single source of truth for version number |
| `install.sh` | Unified installer for MCP server + PM skill |
| `.github/workflows/ci.yml` | Updated CI pipeline with packaging and release |

### Modified Files

| File | Change |
|------|--------|
| `src/index.ts` | Register `provision_vcs_auth` / `revoke_vcs_auth`, remove old `provision_git_auth` / `revoke_git_auth` |
| `src/services/git-auth.ts` | Refactor shared logic into `src/services/vcs/` modules |
| `skills/pm/SKILL.md` | Add brief `## Member Onboarding` section that references `onboarding.md` |
| `src/tools/fleet-status.ts` | Include version from `version.json` in status output |

### Skill Docs Structure

Onboarding intelligence lives in optional docs, not in the core SKILL.md (avoid bloat):

```
skills/pm/
  SKILL.md                         ← add brief ## Member Onboarding pointer
  onboarding.md                    ← full onboarding flow (steps 1-8) + decision tree
  bitbucket-auth.md                ← Bitbucket-specific: scope table, token creation steps at id.atlassian.com, test commands, troubleshooting
  github-auth.md                   ← GitHub-specific: gh CLI setup, GitHub App vs PAT, scope mapping
  azure-devops-auth.md             ← Azure DevOps-specific: PAT creation at dev.azure.com, scope table, test commands
  skill-matrix.md                  ← project type + role → required skills mapping (bitbucket-devops, aprapipes-devops, etc.)
```

## Testing Plan

### Unit Tests

- **Provider credential schemas** — validate each provider's credential format is correctly parsed and rejected for invalid input
- **Credential deployment** — mock SSH/local execution, verify correct files written to correct paths per OS
- **Git credential helper configuration** — verify correct `git config` commands generated per provider and per OS
- **Connectivity checks** — mock API responses, verify success/failure detection
- **Revocation** — verify credential files and git config entries are cleaned up

### Integration Tests

- **End-to-end GitHub PAT** — deploy PAT to test agent, verify `git ls-remote` works
- **End-to-end Bitbucket** — deploy Bitbucket credentials, verify API access
- **End-to-end Azure DevOps** — deploy Azure DevOps PAT, verify API access
- **Onboarding flow** — register new agent, verify hook fires and PM runs checklist

### Manual Testing

- Verify `revoke_vcs_auth` cleanly removes credentials without affecting other providers
- Test with agents on all three OS platforms (Linux, macOS, Windows)

## Recommended Workflow: Two-Context Design Review Loop

When designing new features using this pattern (PM + fleet agent), use the two-context design review loop:

1. **PM brainstorms with user** — captures intent, constraints, and design decisions in conversation context
2. **Fleet agent generates artifact** — has codebase context, writes the design doc / code / plan
3. **PM reviews output** — catches gaps between what was agreed in brainstorm and what the agent produced
4. **Fleet agent revises** — incorporates corrections with full codebase awareness
5. Repeat until converged

This works because the two contexts have complementary strengths:
- **PM context** holds the *what* — user intent, cross-project awareness, strategic decisions
- **Agent context** holds the *where* — codebase structure, existing patterns, file locations

Neither context alone produces the right output. The review loop bridges them. This should be the default workflow for design docs, architecture decisions, and any artifact that needs both user alignment and codebase grounding.

## Design Decisions

1. **Credential storage** — single file per agent with templated key names. Keys follow the pattern `{provider}_{field}` (e.g., `bitbucket_workspace`, `bitbucket_email`, `bitbucket_api_token`, `azdevops_org_url`, `azdevops_pat`, `github_pat`). One file, no bloat. Location: `~/.fleet/credentials/{agent_id}.json` on the agent, or the agent's work folder under `.claude/credentials.json`.

2. **Token rotation** — lazy approach. No proactive rotation. When an agent operation fails due to expired/invalid token, the PM detects the auth failure and initiates token refresh — ideally without user involvement (e.g., re-mint GitHub App token automatically) but without compromising security (e.g., don't store long-lived tokens that bypass expiry). For Bitbucket/Azure DevOps API tokens that don't auto-expire, no rotation needed unless the user revokes them.

3. **Onboarding hook scope** — the PostToolUse hook for member onboarding is a PM-specific concept. It is installed as part of the PM skill installation (via `install.sh`), not as a global fleet MCP feature. All agents registered through a PM session get onboarded. There is no concept of "non-PM agents" — if you're using the PM skill, all your agents go through onboarding.
