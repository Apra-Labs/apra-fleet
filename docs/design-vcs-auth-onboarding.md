# Design: VCS Auth & Agent Onboarding

## Overview

This document describes two complementary workstreams that improve how fleet agents authenticate with version control systems (VCS) and how new agents are onboarded into the PMO workflow.

**Workstream 1** adds a unified `provision_vcs_auth` MCP server tool that deploys VCS credentials to any fleet agent, supporting GitHub, Bitbucket, and Azure DevOps. It replaces the existing `provision_git_auth` and `revoke_git_auth` tools.

**Workstream 2** adds an agent onboarding flow as a PMO skill that automatically detects the VCS provider, determines required permissions based on the agent's role, and guides credential setup.

## Motivation

The PMO (Project Management Office) coordinates work across fleet agents. Currently GitHub auth is handled via a GitHub App (`setup_git_app` + `provision_git_auth`), but there is no support for Bitbucket or Azure DevOps. We also lack an agent onboarding flow that automatically sets up VCS auth and skills after registration.

Key pain points:
- **No Bitbucket/Azure DevOps support** — agents working on non-GitHub repos must have credentials manually configured
- **No onboarding automation** — after `register_agent`, the PMO must manually remember to set up VCS auth, install skills, and verify connectivity
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

## Workstream 2: PMO Skill — Agent Onboarding Flow

### Trigger

**PostToolUse hook on `mcp__fleet__register_agent`** — hook output injects instructions into the conversation telling the PMO to run the onboarding checklist. The hook is just a nudge; all intelligence lives in the skill docs.

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
- Bitbucket: Go to https://id.atlassian.com/manage-profile/security/api-tokens, create token with required scopes, provide to PMO
- GitHub: `gh auth login` on agent, or provide PAT
- Azure DevOps: Go to `https://dev.azure.com/{org}/_usersSettings/tokens`, create PAT with required scopes

**Step 6: Deploy credentials** — call `provision_vcs_auth` with the token user provides

**Step 7: Check/install required skills** based on project + role:
- Bitbucket + (devops OR code-review) → `bitbucket-devops` skill
- ApraPipes project + devops → `aprapipes-devops` skill
- GitHub + anything → no extra skill (gh CLI is sufficient, Claude already knows it)
- Azure DevOps + (devops OR code-review) → `azdevops-devops` skill (future, document the intent)

**Step 8: Update agent status file** — add `## Agent Profile` section:
```markdown
## Agent Profile
- VCS: Bitbucket (kumaakh/apra-lic-mgr)
- Roles: development, code-review
- Auth: Bitbucket API token (verified)
- Skills: bitbucket-devops (installed)
```

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
| `.claude/hooks/post-register-agent.sh` | PostToolUse hook for onboarding trigger |
| `skills/pmo/docs/agent-onboarding.md` | Full onboarding flow (steps 1-8) + decision tree |
| `skills/pmo/docs/bitbucket-auth.md` | Bitbucket-specific: scope table, token creation steps, test commands, troubleshooting |
| `skills/pmo/docs/github-auth.md` | GitHub-specific: gh CLI setup, GitHub App vs PAT, scope mapping |
| `skills/pmo/docs/azure-devops-auth.md` | Azure DevOps-specific: PAT creation, scope table, test commands |
| `skills/pmo/docs/skill-matrix.md` | Project type + role to required skills mapping |

### Modified Files

| File | Change |
|------|--------|
| `src/index.ts` | Register `provision_vcs_auth` / `revoke_vcs_auth`, remove old `provision_git_auth` / `revoke_git_auth` |
| `src/services/git-auth.ts` | Refactor shared logic into `src/services/vcs/` modules |
| `skills/pmo/SKILL.md` | Add brief `## Agent Onboarding` section that references `docs/agent-onboarding.md` |

### Skill Docs Structure

Onboarding intelligence lives in optional docs, not in the core SKILL.md (avoid bloat):

```
skills/pmo/
  SKILL.md                         ← add brief ## Agent Onboarding pointer
  docs/
    agent-onboarding.md            ← full onboarding flow (steps 1-8) + decision tree
    bitbucket-auth.md              ← Bitbucket-specific: scope table, token creation steps at id.atlassian.com, test commands, troubleshooting
    github-auth.md                 ← GitHub-specific: gh CLI setup, GitHub App vs PAT, scope mapping
    azure-devops-auth.md           ← Azure DevOps-specific: PAT creation at dev.azure.com, scope table, test commands
    skill-matrix.md                ← project type + role → required skills mapping (bitbucket-devops, aprapipes-devops, etc.)
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
- **Onboarding flow** — register new agent, verify hook fires and PMO runs checklist

### Manual Testing

- Verify `revoke_vcs_auth` cleanly removes credentials without affecting other providers
- Test with agents on all three OS platforms (Linux, macOS, Windows)

## Recommended Workflow: Two-Context Design Review Loop

When designing new features using this pattern (PMO + fleet agent), use the two-context design review loop:

1. **PMO brainstorms with user** — captures intent, constraints, and design decisions in conversation context
2. **Fleet agent generates artifact** — has codebase context, writes the design doc / code / plan
3. **PMO reviews output** — catches gaps between what was agreed in brainstorm and what the agent produced
4. **Fleet agent revises** — incorporates corrections with full codebase awareness
5. Repeat until converged

This works because the two contexts have complementary strengths:
- **PMO context** holds the *what* — user intent, cross-project awareness, strategic decisions
- **Agent context** holds the *where* — codebase structure, existing patterns, file locations

Neither context alone produces the right output. The review loop bridges them. This should be the default workflow for design docs, architecture decisions, and any artifact that needs both user alignment and codebase grounding.

## Open Questions

1. **Credential storage location** — unified location (e.g., `~/.fleet/credentials/`) or provider-specific paths? Unified is simpler but may conflict with provider CLIs that expect specific locations.

2. **Token rotation** — should `provision_vcs_auth` support automatic token renewal for GitHub App tokens (which expire after 1 hour)? The existing `setup_git_app` flow handles minting; wrapping renewal adds complexity.

3. **Onboarding hook scope** — should the PostToolUse hook trigger for all registered agents, or only PMO-managed ones? Non-PMO agents may not need the full onboarding flow.
